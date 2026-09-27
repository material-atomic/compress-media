'use strict';

// Job lifecycle, shared by the web server and standalone workers:
// create → queue → process (worker) → done/error; cancel, retry, delete and expiry.
//
// Every run of a job has a number (`job.run`). Cancelling or retrying bumps it, and a worker only
// writes results while the record is still on the run it started, so a cancelled or superseded
// run can never overwrite newer state — in one process or across many (QUEUE=redis).

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { compress, outputName } = require('./media');
const { sendWebhook } = require('./webhook');

const ACTIVE = new Set(['queued', 'processing']);

/** "IMG_0001.HEIC" + "gif" → "IMG_0001-animated.gif" */
function animationName(firstFrame, ext) {
  return `${path.parse(firstFrame).name.replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'animation'}-animated.${ext}`;
}

const safeStem = (name) => path.parse(name).name.replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'file';

// Subtitles: a transcript is kept with the job, so Redo with another output (track, burn, VTT)
// doesn't run speech recognition again. It is redone only when what it heard would change.
const GIVEN = 'given'; // the user's own file or an edited transcript
const transcriptKey = (o = {}) => `${o.language || 'auto'}|${!!o.translate}|${o.model || ''}`;
function reuseTranscript(job) {
  const o = job.options || {};
  if (o.text || !job.transcript) return o;
  if (job.transcriptKey !== GIVEN && job.transcriptKey !== transcriptKey(o)) return o;
  return { ...o, text: job.transcript, language: job.info?.language || o.language }; // keeps a detected language
}

/** The job fields the API exposes. */
function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    name: job.name,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    stage: job.stage || undefined,
    inputSize: job.inputSize,
    outputSize: job.outputSize,
    outputName: job.outputName,
    outputMime: job.outputMime,
    error: job.error,
    info: job.info,
    // An animation's source images, in order (not their storage locations).
    frames: job.inputs?.map((i) => ({ name: i.name, size: i.size })),
    // Subtitle text can be long; it isn't echoed on every status poll (GET …/subtitles has it).
    options: job.options?.text ? { ...job.options, text: undefined } : job.options,
    webhook: job.webhook || undefined,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/**
 * @param {{ store: import('./store').Store, storage: any, uploadDir: string, outputDir: string, ttlMs: number }} deps
 */
function createJobs({ store, storage, uploadDir, outputDir, ttlMs }) {
  /** Runs this process is executing: `${id}:${run}` → stop(). Lets a local cancel act at once. */
  const local = new Map();

  const rmPrefix = async (dir, prefix) => {
    const names = await fsp.readdir(dir).catch(() => []);
    await Promise.all(names.filter((n) => n.startsWith(prefix)).map((n) => fsp.rm(path.join(dir, n), { force: true }).catch(() => {})));
  };

  const notify = (job) => {
    if (!job?.webhook || ACTIVE.has(job.status)) return;
    sendWebhook(job.webhook, `job.${job.status}`, publicJob(job));
  };

  /**
   * `inputs` (animation jobs): every frame as { inputPath, inputKey, name, size }, in order.
   * Other jobs have a single inputPath / inputKey.
   */
  async function create({ kind, name, inputPath = null, inputKey = null, inputs = null, inputSize, options, webhook }) {
    const job = {
      id: crypto.randomUUID(),
      kind,
      name,
      inputPath,
      inputKey,
      inputs,
      inputSize,
      options: options || {},
      webhook: webhook || null,
      run: 1,
      status: 'queued',
      progress: 0,
      speed: null,
      eta: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    await store.saveJob(job);
    await store.enqueue(job);
    return job;
  }

  /** Worker side: process run `run` of job `id`, if it's still current. */
  async function processJob(id, run) {
    let job = await store.patchJob(id, { status: 'processing', startedAt: Date.now(), finishedAt: null, progress: 0, speed: null, eta: null, stage: null, error: null }, run);
    if (!job) return; // cancelled, retried or deleted while queued

    let stopped = false;
    /** @type {import('node:child_process').ChildProcess | null} */
    let proc = null;
    const stop = () => {
      stopped = true;
      proc?.kill('SIGKILL');
    };
    local.set(`${id}:${run}`, stop);
    // Another process (a web server with QUEUE=redis) cancels by bumping the run; notice it.
    const watch = setInterval(async () => {
      const cur = await store.getJob(id).catch(() => undefined);
      if (cur === null || (cur && cur.run !== run)) stop();
    }, store.kind === 'memory' ? 250 : 1000);

    /** @type {string[]} local copies of inputs fetched from object storage */
    const fetched = [];
    let lastProgress = 0;
    try {
      // Object storage: inputs live in the bucket; work on local copies.
      const safeExt = (name) => path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '');
      const local = async (src, i) => {
        if (!src.inputKey) return src.inputPath;
        const dest = path.join(uploadDir, `${id}-${run}-input${i}${safeExt(src.name || job.name)}`);
        fetched.push(dest);
        await storage.fetchInput(src, dest);
        return dest;
      };
      const inputs = job.inputs ? await Promise.all(job.inputs.map(local)) : null;
      const input = inputs ? inputs[0] : await local(job, 0);
      // A previous run's result is replaced.
      if (job.outputKey || job.outputPath) await storage.removeOutput(job);

      const out = await compress({
        kind: job.kind,
        input,
        inputs,
        inputName: job.name,
        options: job.kind === 'subtitles' ? reuseTranscript(job) : job.options,
        outputPath: (ext) => path.join(outputDir, `${id}-${run}.${ext}`),
        tempPath: (suffix) => path.join(uploadDir, `${id}-${run}-${suffix}`),
        onSpawn: (p) => {
          proc = p;
          if (stopped) p.kill('SIGKILL');
        },
        onProgress: (p) => {
          const now = Date.now();
          if (stopped || now - lastProgress < 300) return;
          lastProgress = now;
          store.patchJob(id, p, run).catch(() => {});
        },
        isCancelled: () => stopped,
      });
      if (stopped) return void (await fsp.rm(out.file, { force: true }).catch(() => {}));

      const stat = await fsp.stat(out.file);
      const result = {
        outputPath: out.file,
        outputKey: null,
        // Animations are named after the first frame the user uploaded (not the temp file on disk).
        outputName: job.inputs ? animationName(job.inputs[0].name, out.ext)
          : out.suffix ? `${safeStem(job.name)}${out.suffix}` : out.name || outputName(job.name, out.ext),
        outputMime: out.mime,
        outputSize: stat.size,
        info: out.info,
        stage: null,
        ...(out.transcript != null ? { transcript: out.transcript, transcriptKey: job.options?.text ? job.transcriptKey ?? GIVEN : transcriptKey(job.options) } : {}),
      };
      Object.assign(result, await storage.saveOutput({ ...job, ...result }));
      job = await store.patchJob(id, { ...result, status: 'done', progress: 1, eta: 0, finishedAt: Date.now() }, run);
      if (!job) await storage.removeOutput(result); // superseded while saving
      notify(job);
    } catch (err) {
      await rmPrefix(outputDir, `${id}-${run}.`);
      if (stopped) return;
      console.error(`[job ${id}] ${job?.name}:`, err.message);
      notify(await store.patchJob(id, { status: 'error', error: err.message || String(err), finishedAt: Date.now() }, run));
    } finally {
      clearInterval(watch);
      local.delete(`${id}:${run}`);
      await Promise.all(fetched.map((f) => fsp.rm(f, { force: true }).catch(() => {})));
    }
  }

  async function cancel(id) {
    const job = await store.getJob(id);
    if (!job || !ACTIVE.has(job.status)) return job;
    const updated = await store.patchJob(id, { run: job.run + 1, status: 'cancelled', finishedAt: Date.now(), eta: null }, job.run);
    await store.dequeue(job, job.run);
    local.get(`${id}:${job.run}`)?.();
    notify(updated);
    return updated || store.getJob(id);
  }

  async function retry(id, options) {
    const job = await store.getJob(id);
    if (!job) return null;
    const run = job.run + 1;
    const updated = await store.patchJob(id, {
      run, status: 'queued', options: options || job.options,
      progress: 0, speed: null, eta: null, error: null, outputSize: null, startedAt: null, finishedAt: null,
    }, job.run);
    if (!updated) return retry(id, options); // raced with a cancel/retry; try again on the new run
    await store.dequeue(job, job.run);
    local.get(`${id}:${job.run}`)?.();
    await store.enqueue(updated);
    return updated;
  }

  async function remove(id) {
    const job = await store.getJob(id);
    if (!job) return;
    if (ACTIVE.has(job.status)) await cancel(id);
    await store.deleteJob(id);
    await Promise.all([
      ...(job.inputs ? job.inputs.map((i) => storage.removeInput(i)) : [storage.removeInput(job)]),
      storage.removeOutput(job),
      rmPrefix(outputDir, id),
      rmPrefix(uploadDir, `${id}-`),
    ]);
  }

  /** Deletes expired jobs and abandoned uploads. Only one process sweeps at a time. */
  async function sweep() {
    if (!(await store.lock('sweep', 9 * 60 * 1000))) return;
    const cutoff = Date.now() - ttlMs;
    for (const id of await store.jobIds()) {
      const job = await store.getJob(id);
      if (!job) await store.deleteJob(id);
      else if (!ACTIVE.has(job.status) && job.createdAt < cutoff) await remove(id);
    }
    for (const id of await store.uploadIds()) {
      const u = await store.getUpload(id);
      if (!u || u.createdAt < cutoff) {
        if (u) await storage.abortUpload(u).catch(() => {});
        await store.deleteUpload(id);
      }
    }
  }

  /** Stops every run this process is executing (shutdown). */
  function stopAll() {
    for (const stop of local.values()) stop();
  }

  return { create, processJob, cancel, retry, remove, sweep, stopAll, get: (id) => store.getJob(id) };
}

module.exports = { createJobs, publicJob, ACTIVE };
