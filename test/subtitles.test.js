'use strict';

// lib/subtitles.js: SRT/WebVTT parsing and writing, and readable cue splitting (no whisper needed).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSubtitles, formatSubtitles, readableCues, parseTimestamp, iso3 } = require('../lib/subtitles');

test('timestamps: SRT, WebVTT and short forms', () => {
  assert.equal(parseTimestamp('00:01:02,345'), 62.345);
  assert.equal(parseTimestamp('01:02.5'), 62.5);
  assert.equal(parseTimestamp('1:00:00.000'), 3600);
  assert.ok(Number.isNaN(parseTimestamp('soon')));
});

test('parses SRT and WebVTT (BOM, CRLF, cue settings, notes) and writes both', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nXin chào\r\nmọi người\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nHai\r\n';
  const cues = parseSubtitles(srt);
  assert.deepEqual(cues, [
    { start: 1, end: 2.5, text: 'Xin chào\nmọi người' },
    { start: 3, end: 4, text: 'Hai' },
  ]);

  const vtt = 'WEBVTT\n\nNOTE made by hand\n\nintro\n00:01.000 --> 00:02.500 align:start line:90%\nXin chào\nmọi người\n\n00:03.000 --> 00:04.000\nHai\n';
  assert.deepEqual(parseSubtitles(vtt), cues);

  assert.equal(formatSubtitles(cues, 'srt'), '1\n00:00:01,000 --> 00:00:02,500\nXin chào\nmọi người\n\n2\n00:00:03,000 --> 00:00:04,000\nHai\n');
  assert.equal(formatSubtitles(cues, 'vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nXin chào\nmọi người\n\n00:00:03.000 --> 00:00:04.000\nHai\n');
  assert.deepEqual(parseSubtitles(formatSubtitles(cues, 'vtt')), cues, 'round trip');
});

test('rejects text that has no cues', () => {
  assert.throws(() => parseSubtitles('just some notes'), /No subtitles found/);
  assert.deepEqual(parseSubtitles(''), []);
});

test('long cues become readable two-line cues, timed by length', () => {
  const long = 'First, drop the file onto the page. Then choose a quality preset, wait a few seconds and download the smaller file when it is done.';
  const out = readableCues([{ start: 10, end: 20, text: long }, { start: 20, end: 21, text: 'Short.' }]);
  assert.ok(out.length >= 2);
  for (const c of out.slice(0, -1)) {
    const lines = c.text.split('\n');
    assert.ok(lines.length <= 2, c.text);
    for (const l of lines) assert.ok(l.length <= 42, `line too long: ${l}`);
  }
  // Times stay in order and cover the original span exactly.
  assert.equal(out[0].start, 10);
  assert.equal(out.at(-2).end, 20);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].end - 1e-9);
  assert.equal(out[0].text.replace(/\n/g, ' '), 'First, drop the file onto the page.', 'breaks after a sentence');
  assert.deepEqual(out.at(-1), { start: 20, end: 21, text: 'Short.' });
  // The words are all still there, in order.
  assert.equal(out.slice(0, -1).map((c) => c.text.replace(/\n/g, ' ')).join(' '), long);
});

test('cues with their own line breaks are kept as written', () => {
  const cue = { start: 0, end: 2, text: 'A deliberately placed\nline break that is long enough to wrap' };
  assert.deepEqual(readableCues([cue]), [cue]);
});

test('track languages use ISO 639-2 codes', () => {
  assert.equal(iso3('vi'), 'vie');
  assert.equal(iso3('en'), 'eng');
  assert.equal(iso3(null), 'und');
});
