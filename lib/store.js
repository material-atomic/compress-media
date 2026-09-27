'use strict';

// Where job/upload records and the work queue live, chosen with QUEUE=memory|redis.
//
//   memory  One process: records in Maps, in-process queues. The default; nothing to set up.
//   redis   Records in Redis and queues in BullMQ, so several web servers and workers can share
//           them (REDIS_URL). Run workers anywhere with `compress-media worker` or ROLE=worker.
//
// Both implement the same interface, used by lib/jobs.js and server.js.

/**
 * @typedef {object} Store
 * @property {'memory'|'redis'} kind
 * @property {(id: string) => Promise<any>} getJob
 * @property {(job: any) => Promise<void>} saveJob
 * @property {(id: string, patch: object, ifRun?: number) => Promise<any>} patchJob
 *   merges `patch`; with `ifRun`, only while the record is still on that run. Returns the record or null.
 * @property {(id: string) => Promise<void>} deleteJob
 * @property {() => Promise<string[]>} jobIds
 * @property {(id: string) => Promise<any>} getUpload
 * @property {(u: any) => Promise<void>} saveUpload
 * @property {(id: string) => Promise<void>} deleteUpload
 * @property {() => Promise<string[]>} uploadIds
 * @property {(id: string, n: number) => Promise<void>} addUploadPart
 * @property {(id: string) => Promise<number[]>} uploadParts
 * @property {(job: any) => Promise<void>} enqueue                   queue run `job.run` of the job
 * @property {(job: any, run: number) => Promise<void>} dequeue      drop a queued run that hasn't started
 * @property {(handler: (id: string, run: number) => Promise<void>, c: { media: number, image: number }) => Promise<void>} startWorker
 * @property {(name: string, ttlMs: number) => Promise<boolean>} lock   true if this process got it
 * @property {() => Promise<void>} close
 */

/** @returns {Store} */
function createStore(env = process.env) {
  const kind = (env.QUEUE || 'memory').toLowerCase();
  if (kind === 'memory') return memoryStore();
  if (kind === 'redis') {
    if (!env.REDIS_URL) throw new Error('QUEUE=redis needs REDIS_URL, e.g. redis://localhost:6379');
    return redisStore(env.REDIS_URL, env.REDIS_PREFIX || 'cm');
  }
  throw new Error(`Unknown QUEUE "${env.QUEUE}" — use "memory" or "redis"`);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** @returns {Store} */
function memoryStore() {
  const jobs = new Map();
  const uploads = new Map();
  const parts = new Map();
  /** @type {{ media: any[], image: any[] }} */
  const waiting = { media: [], image: [] };
  const running = { media: 0, image: 0 };
  const limits = { media: 1, image: 3 };
  let handler = null;

  const lane = (job) => (job.kind === 'image' ? 'image' : 'media');
  function pump() {
    if (!handler) return;
    for (const l of /** @type {const} */ (['media', 'image'])) {
      while (running[l] < limits[l] && waiting[l].length) {
        const { id, run } = waiting[l].shift();
        running[l]++;
        handler(id, run).catch((err) => console.error(`[job ${id}]`, err)).finally(() => {
          running[l]--;
          pump();
        });
      }
    }
  }

  return {
    kind: 'memory',
    async getJob(id) { return jobs.get(id) || null; },
    async saveJob(job) { jobs.set(job.id, job); },
    async patchJob(id, patch, ifRun) {
      const job = jobs.get(id);
      if (!job || (ifRun !== undefined && job.run !== ifRun)) return null;
      Object.assign(job, patch);
      return job;
    },
    async deleteJob(id) { jobs.delete(id); },
    async jobIds() { return [...jobs.keys()]; },
    async getUpload(id) { return uploads.get(id) || null; },
    async saveUpload(u) { uploads.set(u.id, u); },
    async deleteUpload(id) { uploads.delete(id); parts.delete(id); },
    async uploadIds() { return [...uploads.keys()]; },
    async addUploadPart(id, n) {
      if (!parts.has(id)) parts.set(id, new Set());
      parts.get(id).add(n);
    },
    async uploadParts(id) { return [...(parts.get(id) || [])].sort((a, b) => a - b); },
    async enqueue(job) {
      waiting[lane(job)].push({ id: job.id, run: job.run });
      pump();
    },
    async dequeue(job, run) {
      const l = lane(job);
      waiting[l] = waiting[l].filter((w) => !(w.id === job.id && w.run === run));
    },
    async startWorker(h, c) {
      handler = h;
      limits.media = c.media;
      limits.image = c.image;
      pump();
    },
    async lock() { return true; },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// Redis + BullMQ
// ---------------------------------------------------------------------------

/** @returns {Store} */
function redisStore(url, prefix) {
  const { Redis: IORedis } = require('ioredis');
  const { Queue, Worker } = require('bullmq');
  const connection = () => new IORedis(url, { maxRetriesPerRequest: null });
  const redis = connection();
  const k = (...parts) => [prefix, ...parts].join(':');
  const queues = {
    media: new Queue(`${prefix}-media`, { connection: connection(), prefix }),
    image: new Queue(`${prefix}-image`, { connection: connection(), prefix }),
  };
  const workers = [];
  const lane = (job) => (job.kind === 'image' ? 'image' : 'media');
  const bullId = (id, run) => `${id}.${run}`; // BullMQ ids can't contain ":"
  // Records outlive the app's own cleanup only as a safety net.
  const recordTtl = 7 * 24 * 3600;

  // Atomic read-merge-write, so progress updates from a worker and a cancel from a web
  // server can't overwrite each other.
  redis.defineCommand('cmPatch', {
    numberOfKeys: 1,
    lua: `local cur = redis.call('GET', KEYS[1])
      if not cur then return nil end
      local obj = cjson.decode(cur)
      if ARGV[2] ~= '' and tostring(obj.run) ~= ARGV[2] then return nil end
      for k, v in pairs(cjson.decode(ARGV[1])) do obj[k] = v end
      local out = cjson.encode(obj)
      redis.call('SET', KEYS[1], out, 'KEEPTTL')
      return out`,
  });

  const read = async (key) => {
    const v = await redis.get(key);
    return v ? JSON.parse(v) : null;
  };

  return {
    kind: 'redis',
    getJob: (id) => read(k('job', id)),
    async saveJob(job) {
      await redis.multi().set(k('job', job.id), JSON.stringify(job), 'EX', recordTtl).zadd(k('jobs'), String(job.createdAt), job.id).exec();
    },
    async patchJob(id, patch, ifRun) {
      const out = await /** @type {any} */ (redis).cmPatch(k('job', id), JSON.stringify(patch), ifRun === undefined ? '' : String(ifRun));
      if (!out) return null;
      const job = JSON.parse(out);
      for (const [key, value] of Object.entries(patch)) if (value === null) job[key] = null;
      return job;
    },
    async deleteJob(id) { await redis.multi().del(k('job', id)).zrem(k('jobs'), id).exec(); },
    jobIds: () => redis.zrange(k('jobs'), '0', '-1'),
    getUpload: (id) => read(k('upload', id)),
    async saveUpload(u) {
      await redis.multi().set(k('upload', u.id), JSON.stringify(u), 'EX', recordTtl).zadd(k('uploads'), String(u.createdAt), u.id).exec();
    },
    async deleteUpload(id) { await redis.multi().del(k('upload', id), k('upload', id, 'parts')).zrem(k('uploads'), id).exec(); },
    uploadIds: () => redis.zrange(k('uploads'), '0', '-1'),
    async addUploadPart(id, n) {
      await redis.multi().sadd(k('upload', id, 'parts'), String(n)).expire(k('upload', id, 'parts'), recordTtl).exec();
    },
    async uploadParts(id) { return (await redis.smembers(k('upload', id, 'parts'))).map(Number).sort((a, b) => a - b); },
    async enqueue(job) {
      await queues[lane(job)].add('compress', { id: job.id, run: job.run }, {
        jobId: bullId(job.id, job.run), removeOnComplete: true, removeOnFail: true,
      });
    },
    async dequeue(job, run) {
      const q = queues[lane(job)];
      const bull = await q.getJob(bullId(job.id, run));
      // A job that already started can't be removed; the worker notices the run changed and stops.
      if (bull && (await bull.isWaiting() || await bull.isDelayed())) await bull.remove().catch(() => {});
    },
    async startWorker(handler, c) {
      for (const l of /** @type {const} */ (['media', 'image'])) {
        const w = new Worker(`${prefix}-${l}`, (bull) => handler(bull.data.id, bull.data.run), {
          connection: connection(), prefix, concurrency: c[l],
          // Encodes can take hours; keep the lock alive rather than treat them as stalled.
          lockDuration: 60_000, stalledInterval: 60_000, maxStalledCount: 1,
        });
        w.on('error', (err) => console.error(`[worker ${l}]`, err.message));
        workers.push(w);
      }
    },
    async lock(name, ttlMs) {
      return (await redis.set(k('lock', name), String(process.pid), 'PX', ttlMs, 'NX')) === 'OK';
    },
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(Object.values(queues).map((q) => q.close()));
      redis.disconnect();
    },
  };
}

module.exports = { createStore };
