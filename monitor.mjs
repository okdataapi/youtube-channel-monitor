#!/usr/bin/env node
// Monitor YouTube channels over time.
//
// Each run records, for every channel you name, its subscriber, video and view totals (one row per channel in
// <out>/channels.csv) and its newest videos with their views, likes and comments (one row per video in
// <out>/videos.csv), then prints a short report: the uploads that are new since the last run, the videos that gained
// the most views, and how each channel's totals moved. With --transcripts N it also saves the transcripts of the
// newest new uploads as text files. Same flags, same CSVs, same files and same report as monitor.py.
//
// Data comes from the okdata API (https://okdata.online/?src=gh-youtube-channel-monitor), $0.002 per call.
// Node 18+, no dependencies. The key goes in the OKDATA_API_KEY environment variable.
//
//   node monitor.mjs --channel @NASA --channel @TED
//   node monitor.mjs --channel https://www.youtube.com/@NASA --videos 20 --transcripts 2 --dry-run

import { randomUUID } from 'node:crypto';
import {
  accessSync, appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const VERSION = '0.1.0';
const SOURCE = 'gh-youtube-channel-monitor';
const SIGN_UP = `https://okdata.online/signup/?src=${SOURCE}`;
const CONSOLE = `https://okdata.online/console/?src=${SOURCE}`;
const CHANNEL = 'youtube.channels.get';
const CHANNEL_VIDEOS = 'youtube.channels.videos.list';
const VIDEO = 'youtube.videos.get';
const TRANSCRIPT = 'youtube.videos.transcript.get';
// Money is kept as whole 1e-8 USD units so sums are exact.
const UNIT = 100_000_000;
// Fallback prices (USD) if the free catalog cannot be read; the live catalog wins.
const PRICES = { [CHANNEL]: '0.002', [CHANNEL_VIDEOS]: '0.002', [VIDEO]: '0.002', [TRANSCRIPT]: '0.004' };
const LIST_PAGE = 30; // videos on one page of a channel's video list
export const CHANNEL_FIELDS = ['run_at', 'channel', 'channel_id', 'name', 'subscribers', 'videos', 'views'];
export const VIDEO_FIELDS = ['run_at', 'channel', 'video_id', 'url', 'title', 'published_at', 'duration_s', 'views',
  'likes', 'comments'];
const CHANNELS_CSV = 'channels.csv';
const VIDEOS_CSV = 'videos.csv';
const TRANSCRIPTS_DIR = 'transcripts';
const TITLE_LIMIT = 200; // characters kept in the CSV
const CAPTION_LIMIT = 60; // characters shown in the report
// Errors that every later call would hit too, so the run stops instead of trying the next channel.
const STOP_CODES = new Set(['unauthorized', 'insufficient_balance', 'key_budget_exceeded', 'cost_cap_exceeded',
  'key_scope_denied', 'account_suspended', 'budget_reached']);
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
// Spelled out (not \s) so Python and Node collapse exactly the same characters.
const WHITESPACE = /[\t\n\v\f\r \u00a0\u2028\u2029]+/g;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
// A handle: no spaces or URL punctuation, and no first character a spreadsheet would read as a formula.
const HANDLE = /^(?![-=+])[^\t\n\v\f\r \u00a0\u2028\u2029\/?#&%@:,;"'<>\\]{1,100}$/u;
const CHANNEL_URL = /youtube\.com\/(@[^/?#]+|channel\/[^/?#]*|c\/|user\/)/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/; // a YouTube video id; ids that look different are skipped
const INTEGER = /^-?[0-9]+$/;
const AMOUNT = /^[0-9]+(\.[0-9]+)?$/;
const AMOUNT_FROM_API = /^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/;
const FORMULA_START = new Set(['=', '+', '-', '@', '\t', '\r']);

export class ApiError extends Error {
  constructor(code, message, { charged = false, retry = 'no', retryAfter = null, amount = null } = {}) {
    super(`${code}: ${message}`);
    Object.assign(this, { code, charged, retry, retryAfter, amount });
  }
}

class UsageError extends Error {}
// A CSV cannot be used: other columns, or not a writable file.
class OutputError extends Error {}
// An error every later call would hit too (bad key, low balance, --budget).
class Stop extends Error {}

// --- money ------------------------------------------------------------------------------------------------------

// An amount from the API ("0.002", 0.002 or 1e-8) in units; null if it is not a sane amount.
export function toUnits(value) {
  const text = String(value ?? '').trim();
  const found = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (found) return Number(found[1]) * UNIT + Number((found[2] || '').slice(0, 8).padEnd(8, '0'));
  const amount = Number(text);
  return AMOUNT_FROM_API.test(text) && Number.isFinite(amount) ? Math.round(amount * UNIT) : null;
}

// 2000000 -> "0.02", 150000000 -> "1.5"; the same text the Python version prints.
export function usd(units) {
  const fraction = String(units % UNIT).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${Math.floor(units / UNIT)}.${fraction}` : String(Math.floor(units / UNIT));
}

// --- the API ----------------------------------------------------------------------------------------------------

// The okdata calls this script needs, with safe retries and a hard spending cap.
class Okdata {
  constructor({ api, key, budget = null, sleep }) {
    // held: calls whose answer was lost, counted at their price when checking the budget
    Object.assign(this, { api, key, budget, sleep, spent: 0, held: 0 });
    this.caps = Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, toUnits(v)]));
  }

  headers(idempotencyKey) {
    const headers = { Accept: 'application/json', 'User-Agent': `${SOURCE}/${VERSION} (node)` };
    if (this.key) headers.Authorization = `Bearer ${this.key}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return headers;
  }

  // Current prices from the free catalog (no key needed); the built-in table if it cannot be read.
  async prices() {
    try {
      const body = await requestJson(`${this.api}/v1/catalog`, this.headers(null), this.sleep);
      const live = new Map(body.data.endpoints.map((e) => [e.id, toUnits(e.maxCharge)]));
      for (const [id, fallback] of Object.entries(PRICES)) this.caps[id] = live.get(id) || toUnits(fallback);
    } catch {
      this.caps = Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, toUnits(v)]));
    }
    return this.caps;
  }

  afford(cap, charged = false) {
    if (this.budget !== null && this.spent + this.held + cap > this.budget) {
      throw new ApiError('budget_reached', `the next call could cost $${usd(cap)} and pass the --budget of $${usd(this.budget)}`, { charged });
    }
  }

  async call(endpoint, params) {
    const cap = this.caps[endpoint] ?? 0;
    this.afford(cap);
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) query.set(k, v);
    const url = `${this.api}/v1/${endpoint.replaceAll('.', '/')}?${query}`;
    const paid = (amount) => { this.spent += toUnits(amount) ?? cap; }; // in step with what the API reports
    const onCharge = (amount, again) => {
      paid(amount);
      if (again) this.afford(cap, true);
    };
    let body;
    try {
      body = await requestJson(url, this.headers(randomUUID()), this.sleep, onCharge);
    } catch (err) {
      if (err instanceof ApiError && err.charged === null) this.held += cap;
      throw err;
    }
    paid(asDict(asDict(body.meta).billing).amount);
    return body;
  }
}

function errorFromBody(status, body) {
  if (body && typeof body === 'object' && 'code' in body) {
    return new ApiError(String(body.code), String(body.message || ''), {
      charged: 'charged' in body ? body.charged : false,
      retry: String(body.retry || 'no'),
      retryAfter: body.retry_after_seconds,
      amount: body.amount ?? null,
    });
  }
  return new ApiError(`http_${status}`, 'unexpected answer', { charged: null, retry: RETRY_STATUSES.has(status) ? 'yes' : 'no' });
}

async function attemptOnce(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(90_000) });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const isObject = body !== null && typeof body === 'object';
    if (!res.ok) return { err: errorFromBody(res.status, isObject ? body : null) };
    if (body === undefined) throw new Error('the answer was not JSON');
    if (isObject && body.code === 'ok') return { body };
    if (isObject) return { err: new ApiError(String(body.code), String(body.message || '')) };
    return { err: new ApiError('bad_response', 'unexpected answer', { charged: null, retry: 'same_key' }) };
  } catch (e) { // network, timeout, cut-off or non-JSON body
    return { err: new ApiError('connection_error', String(e?.message ?? e), { charged: null, retry: 'same_key' }) };
  }
}

// GET with up to 2 retries that reuse the same Idempotency-Key, so a lost answer is replayed instead of run twice.
// After a lost answer the call may still be running on the server, so a rate_limited reply is waited out.
// onCharge hears about every attempt the API says it charged, retried ones too, and may throw to stop.
export async function requestJson(url, headers, sleep, onCharge = null) {
  let retries = 0;
  let waits = 0;
  let ambiguous = false;
  let paid = false;
  for (;;) {
    const { body, err } = await attemptOnce(url, headers);
    if (body) return body;
    ambiguous = ambiguous || err.charged === null;
    if (ambiguous && err.code === 'rate_limited' && waits < 5) {
      waits += 1;
      await sleep(waitSeconds(err.retryAfter, 1));
      continue;
    }
    const again = ['yes', 'same_key'].includes(err.retry) && retries < 2;
    if (err.charged === true) {
      paid = true;
      if (onCharge) onCharge(err.amount, again);
    }
    if (!again) {
      if (ambiguous && err.charged === false) err.charged = null; // an earlier attempt may still finish
      if (paid) err.charged = true; // an earlier attempt was charged
      throw err;
    }
    await sleep(waitSeconds(err.retryAfter, 2 ** retries));
    retries += 1;
  }
}

// Seconds to sleep: the server's hint if it is a sane number, capped at 30.
function waitSeconds(value, fallback) {
  const seconds = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(seconds)) return fallback;
  return Math.min(Math.max(seconds, 0), 30);
}

const charged = (err) => (err.charged === true ? 'yes' : err.charged === false ? 'no' : 'unknown');

// --- text helpers -----------------------------------------------------------------------------------------------

const length = (text) => Array.from(text).length;
const trimSpaces = (text) => text.replace(/^ +| +$/g, '');
const asDict = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asList = (value) => (Array.isArray(value) ? value : []);
// Text as it is written to files (a lone surrogate becomes U+FFFD there); anything but text is empty.
const plain = (value) => (typeof value === 'string' ? value : '');

// Text that starts like a spreadsheet formula gets a leading ' so Excel shows it instead of running it.
export const cell = (value) => (typeof value === 'string' && FORMULA_START.has(value[0]) ? `'${value}` : value);

// The text cell() was given back, so ids such as -abc… read back as they were written.
const uncell = (value) => (value[0] === "'" && FORMULA_START.has(value[1]) ? value.slice(1) : value);

// One line, at most `limit` characters, with … where it was cut.
export function clip(text, limit) {
  const line = trimSpaces(plain(text).replace(WHITESPACE, ' '));
  const chars = Array.from(line);
  return chars.length <= limit ? line : `${chars.slice(0, limit - 1).join('').replace(/ +$/, '')}…`;
}

// A count as monitor.py writes it: a whole number or a string of digits; anything else is empty.
const whole = (value) => (Number.isSafeInteger(value) || (typeof value === 'string' && INTEGER.test(value)) ? value : null);

// A short text field (link, time, id) on one line; empty when it is not text.
const textOf = (value) => clip(value, 1000) || null;

const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// --- what to monitor --------------------------------------------------------------------------------------------

// '@NASA', 'NASA', a UC… channel ID or a channel link -> 'nasa' or the channel ID.
export function channel(value) {
  let text = String(value).trim();
  const found = CHANNEL_URL.exec(text);
  if (found) {
    const path = found[1];
    const isHandle = path[0] === '@';
    if (!isHandle && !path.toLowerCase().startsWith('channel/')) {
      throw new UsageError(`use the channel's @handle or its UC… ID instead of: '${value}'`);
    }
    text = isHandle ? path : path.slice('channel/'.length);
    try {
      text = decodeURIComponent(text);
    } catch {
      // the % left in the text makes it fail below
    }
    if (!isHandle && !CHANNEL_ID.test(text)) throw new UsageError(`not a channel ID in this link: '${value}'`);
  }
  if (CHANNEL_ID.test(text)) return text;
  const handle = text[0] === '@' ? text.slice(1) : text;
  if (!HANDLE.test(handle)) throw new UsageError(`not a YouTube handle, channel ID or channel link: '${value}'`);
  return handle.toLowerCase();
}

// How a channel is shown in the log and the report: @handle, or the channel ID.
export const shown = (key) => (CHANNEL_ID.test(key) ? key : `@${key}`);

function planChannels(keys) {
  const unique = new Map();
  for (const key of keys) if (!unique.has(key)) unique.set(key, [key, CHANNEL_ID.test(key) ? { id: key } : { username: key }]);
  return [...unique.values()];
}

const listPages = (videos) => Math.ceil(videos / LIST_PAGE);

function planCost(caps, channels, videos, transcripts) {
  const each = caps[CHANNEL] + caps[CHANNEL_VIDEOS] * listPages(videos) + caps[VIDEO] * videos;
  return each * channels + caps[TRANSCRIPT] * transcripts;
}

// --- fetching ---------------------------------------------------------------------------------------------------

// One call. When the answer is a copy the API fetched a little earlier (meta.cached), its fetch time goes into
// `cached`.
async function callApi(ok, endpoint, cached, params) {
  const body = await ok.call(endpoint, params);
  const meta = asDict(body.meta);
  if (meta.cached) cached.push(String(meta.fetched_at || '?'));
  return body;
}

const itemOf = (body) => asDict(asDict(body.data).item);

async function channelRow(ok, runAt, key, params, cached) {
  const item = itemOf(await callApi(ok, CHANNEL, cached, { ...params, view: 'full' }));
  return {
    run_at: runAt,
    channel: key,
    channel_id: textOf(item.id),
    name: clip(item.name, TITLE_LIMIT),
    subscribers: whole(item.followers),
    videos: whole(item.posts),
    views: whole(asDict(item.ext).views),
  };
}

// The ids of the channel's `newest` newest videos (its list is newest first).
async function newestIds(ok, params, newest, cached) {
  const ids = [];
  let cursor = null;
  for (let page = 0; page < listPages(newest); page += 1) {
    const body = await callApi(ok, CHANNEL_VIDEOS, cached, { ...params, cursor, view: 'brief' });
    for (const item of asList(asDict(body.data).items)) {
      const videoId = asDict(item).id;
      if (typeof videoId === 'string' && VIDEO_ID.test(videoId) && !ids.includes(videoId)) ids.push(videoId);
    }
    cursor = asDict(body.page).next_cursor;
    cursor = typeof cursor === 'string' && cursor ? cursor : null;
    if (ids.length >= newest || !cursor) break;
  }
  return ids.slice(0, newest);
}

export async function videoRow(ok, runAt, key, videoId, cached) {
  const item = itemOf(await callApi(ok, VIDEO, cached, { id: videoId, view: 'full' }));
  const metrics = asDict(item.metrics);
  return {
    run_at: runAt,
    channel: key,
    video_id: videoId,
    url: textOf(item.url),
    title: clip(plain(item.title) || item.text, TITLE_LIMIT),
    published_at: textOf(item.published_at),
    duration_s: whole(asDict(item.ext).length_s), // a JSON 5.0 arrives as 5; monitor.py turns it into 5 too
    views: whole(metrics.views),
    likes: whole(metrics.likes),
    comments: whole(metrics.comments),
  };
}

// A transcript file: what the video is, then the words, one caption line per line, spaces tidied.
export function transcriptText(row, item) {
  const words = plain(item.text).split('\n').map((line) => trimSpaces(line.replace(WHITESPACE, ' ')))
    .filter(Boolean).join('\n');
  if (!words) return '';
  const about = [plain(row.title), plain(row.url),
    `${shown(row.channel)} · published ${row.published_at || '?'} · transcript language ${plain(item.lang) || '?'}`];
  return `${about.join('\n')}\n\n${words}\n`;
}

// --- storing ----------------------------------------------------------------------------------------------------

function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function readRows(path, fields) {
  if (!existsSync(path) || statSync(path).size === 0) return [];
  const [header, ...data] = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  if (!header || header.join(',') !== fields.join(',')) {
    throw new OutputError(`${path} has other columns than this monitor writes; use another --out`);
  }
  return data.map((r) => Object.fromEntries(fields.map((f, i) => [f, uncell(r[i] ?? '')])));
}

// Fail before any paid call if a file could not be written afterwards.
function checkWritable(path, folder = false) {
  mkdirSync(folder ? path : dirname(path), { recursive: true });
  if (existsSync(path) && statSync(path).isDirectory() !== folder) {
    throw new OutputError(`${path} is not a ${folder ? 'folder' : 'file'}`);
  }
  try {
    accessSync(existsSync(path) ? path : dirname(path), constants.W_OK);
  } catch {
    throw new OutputError(`${path} is not writable`);
  }
}

function endsWithNewline(path) {
  const fd = openSync(path, 'r');
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, fstatSync(fd).size - 1);
    return last[0] === 0x0a || last[0] === 0x0d;
  } finally {
    closeSync(fd);
  }
}

export function appendRows(path, fields, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const fresh = !existsSync(path) || statSync(path).size === 0;
  const newlineFirst = !fresh && !endsWithNewline(path); // a file saved without a final newline
  const lines = rows.map((r) => fields.map((f) => csvField(cell(r[f]))).join(','));
  const head = `${newlineFirst ? '\n' : ''}${fresh ? `${fields.join(',')}\n` : ''}`;
  appendFileSync(path, `${head}${lines.join('\n')}\n`, 'utf8');
}

// --- the report -------------------------------------------------------------------------------------------------

const number = (value) => (value !== null && value !== undefined && INTEGER.test(String(value)) ? Number(value) : null);
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const count = (n) => (n === null ? '?' : thousands(n));
const change = (now, before) => (now === null || before === null ? '' : ` (${now >= before ? '+' : '-'}${thousands(Math.abs(now - before))})`);
const byId = (a, b) => (a.video_id < b.video_id ? -1 : a.video_id > b.video_id ? 1 : 0);

// Integer maths, rounded half up, so Python and Node print the same digits.
export function growthPercent(growth, before) {
  if (before <= 0) return '';
  const tenths = Math.floor((growth * 1000 + Math.floor(before / 2)) / before);
  return tenths ? ` (+${Math.floor(tenths / 10)}.${tenths % 10}%)` : ' (<0.1%)';
}

function firstByVideo(rows) {
  const found = new Map();
  for (const row of rows) if (!found.has(row.video_id)) found.set(row.video_id, row);
  return found;
}

// One line per channel in the latest run: its totals and how they moved since its last earlier row.
function channelLines(channels, videos, current) {
  const all = [...channels, ...videos];
  const keys = [...new Set(all.filter((r) => r.run_at === current).map((r) => r.channel))];
  const width = Math.max(...keys.map((key) => length(shown(key))));
  const laterRun = all.some((r) => r.run_at < current);
  return keys.map((key) => {
    const mine = channels.filter((r) => r.channel === key);
    const now = mine.find((r) => r.run_at === current) ?? null;
    const before = mine.findLast((r) => r.run_at < current) ?? null;
    const known = before || videos.some((r) => r.channel === key && r.run_at < current);
    const name = (now ?? before ?? {}).name ?? '';
    const totals = now === null ? ['no channel totals this run'] : ['subscribers', 'videos', 'views'].map(
      (k) => `${count(number(now[k]))} ${k}${change(number(now[k]), before ? number(before[k]) : null)}`,
    );
    const parts = [name, ...totals, laterRun && !known ? 'first snapshot' : ''];
    const label = shown(key);
    return `  ${label}${' '.repeat(width - length(label))}  ${parts.filter(Boolean).join(' · ')}`;
  });
}

function videoLines(lead, row, who, extra) {
  const parts = [lead, who, extra, clip(row.title, CAPTION_LIMIT)];
  return [`  ${parts.filter(Boolean).join(' · ')}`, `    ${row.url}`];
}

// Channel totals, new uploads in the latest run, and the biggest view gains between the last two runs.
export function report(channels, videos, top) {
  const runs = [...new Set([...channels, ...videos].map((r) => r.run_at))].sort();
  if (!runs.length) return '';
  const current = runs[runs.length - 1];
  const previous = runs.length > 1 ? runs[runs.length - 2] : null;
  const lines = [`YouTube monitor run ${current} ${previous ? `(previous run ${previous})` : '(first run)'}`];
  lines.push(...channelLines(channels, videos, current));
  if (previous === null) {
    lines.push('', 'First snapshot saved. Run again later to see new uploads, the biggest movers and how the totals change.');
    return `${lines.join('\n')}\n`;
  }

  const names = new Map(channels.filter((r) => r.name).map((r) => [r.channel, r.name]));
  // @handle, or a channel ID by its name when known
  const who = (r) => (CHANNEL_ID.test(r.channel) ? names.get(r.channel) ?? r.channel : shown(r.channel));
  const latest = firstByVideo(videos.filter((r) => r.run_at === current));
  const earlier = videos.filter((r) => r.run_at < current);
  const seen = new Set(earlier.map((r) => r.video_id));
  const known = new Set(earlier.map((r) => r.channel));
  const fresh = [...latest.values()].filter((r) => !seen.has(r.video_id) && known.has(r.channel))
    .sort((a, b) => (number(b.views) ?? 0) - (number(a.views) ?? 0) || byId(a, b));
  lines.push('', `New uploads since the last run: ${fresh.length}`);
  for (const r of fresh.slice(0, top)) {
    lines.push(...videoLines(`${count(number(r.views))} views`, r, who(r), `posted ${(r.published_at || '?').slice(0, 10)}`));
  }
  if (fresh.length > top) lines.push(`  ...and ${fresh.length - top} more in the CSV`);

  const before = firstByVideo(videos.filter((r) => r.run_at === previous));
  const movers = [];
  for (const r of latest.values()) {
    const after = number(r.views);
    const old = before.has(r.video_id) ? number(before.get(r.video_id).views) : null;
    if (after !== null && old !== null && after > old) movers.push({ growth: after - old, old, after, row: r });
  }
  movers.sort((a, b) => b.growth - a.growth || byId(a.row, b.row));
  lines.push('', 'Biggest movers by views since the last run:');
  if (!movers.length) lines.push('  No video gained views between the last two runs.');
  for (const { growth, old, after, row } of movers.slice(0, top)) {
    lines.push(...videoLines(`+${thousands(growth)} views${growthPercent(growth, old)}`, row, who(row), `${thousands(after)} now`));
  }
  return `${lines.join('\n')}\n`;
}

// --- the command ------------------------------------------------------------------------------------------------

const USAGE_LINE = `usage: node monitor.mjs [--channel CHANNEL]... [--videos N] [--transcripts N] [--out DIR] [--top N]
                        [--budget USD] [--dry-run]
`;
const USAGE = `${USAGE_LINE}
Monitor YouTube channels: append their totals and their newest videos' counts to two CSVs, then report new
uploads, the biggest movers and subscriber changes (okdata API, $0.002 per call).

  --channel CHANNEL  a handle (@NASA), a channel ID (UC…) or a channel link (repeat for more)
  --videos N         newest videos to record per channel, one call each (default 10)
  --transcripts N    save the transcripts of the N newest new uploads to <out>/transcripts (default 0)
  --out DIR          folder for the CSVs (default data)
  --top N            how many new uploads and movers to list (default 5)
  --budget USD       refuse runs that could cost more (USD, default 0.5)
  --dry-run          print the plan and the most it can cost, then stop
`;

function wholeNumber(value, flag, minimum) {
  if (!/^[0-9]+$/.test(value.trim()) || Number(value) < minimum) {
    throw new UsageError(`argument ${flag}: must be ${minimum} or more`);
  }
  return Number(value);
}

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      channel: { type: 'string', multiple: true },
      videos: { type: 'string' },
      transcripts: { type: 'string' },
      out: { type: 'string' },
      top: { type: 'string' },
      budget: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { help: true };
  const channels = (values.channel ?? []).map((value) => {
    try {
      return channel(value);
    } catch (err) {
      throw new UsageError(`argument --channel: ${err.message}`);
    }
  });
  if (!channels.length) throw new UsageError('give at least one --channel');
  const budgetText = (values.budget ?? '0.5').trim();
  if (!AMOUNT.test(budgetText)) throw new UsageError(`argument --budget: not an amount in USD: '${values.budget}'`);
  return {
    channels,
    videos: wholeNumber(values.videos ?? '10', '--videos', 1),
    transcripts: wholeNumber(values.transcripts ?? '0', '--transcripts', 0),
    out: values.out ?? 'data',
    top: wholeNumber(values.top ?? '5', '--top', 1),
    budget: toUnits(budgetText),
    dryRun: Boolean(values['dry-run']),
  };
}

function hint(code) {
  return {
    unauthorized: `Check OKDATA_API_KEY, or get a key at ${SIGN_UP}`,
    insufficient_balance: `Top up at ${CONSOLE} and run again.`,
    key_budget_exceeded: `This key reached the spending limit set for it at ${CONSOLE}`,
    budget_reached: 'Stopped at --budget.',
    cost_cap_exceeded: 'The account reached its daily spending allowance; it resets at the next UTC day.',
    not_found: 'Check the channel handle or ID.',
  }[code] ?? '';
}

// Run one step; on an API error log it and carry on, or throw Stop when every later call would fail too.
async function attempt(what, step, tally, log) {
  try {
    return await step();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    tally.failed += 1;
    log(`${what}: ${err.message} (charged: ${charged(err)}). ${hint(err.code)}`.trimEnd());
    if (STOP_CODES.has(err.code)) throw new Stop(err.message);
    return null;
  }
}

// One channel: its totals, then its newest videos. Each row is saved as soon as it is in, so a failure later in
// the run (or Ctrl-C) keeps what was paid for.
async function monitorChannel(ok, runAt, [key, params], newest, out, tally, log) {
  const label = shown(key);
  const cached = [];
  const totals = await attempt(`${label}: channel totals`, () => channelRow(ok, runAt, key, params, cached), tally, log);
  if (totals) {
    appendRows(join(out, CHANNELS_CSV), CHANNEL_FIELDS, [totals]);
    tally.saved += 1;
  }
  // Only the calls that bring counts go into the "counts as of" note, not the list of ids.
  const ids = (await attempt(`${label}: video list`, () => newestIds(ok, params, newest, []), tally, log)) ?? [];
  const rows = [];
  for (const videoId of ids) {
    const row = await attempt(`${label}: video ${videoId}`, () => videoRow(ok, runAt, key, videoId, cached), tally, log);
    if (row) {
      appendRows(join(out, VIDEOS_CSV), VIDEO_FIELDS, [row]);
      tally.saved += 1;
      rows.push(row);
    }
  }
  const note = cached.length ? ` (counts as of ${cached.sort()[0]})` : '';
  log(`${label}: ${rows.length} videos${note}`);
  return rows;
}

// Transcripts of the `limit` newest videos this run saw for the first time, one text file each.
async function saveTranscripts(ok, rows, seen, limit, folder, tally, log) {
  const newestFirst = (a, b) => {
    const [pa, pb] = [String(a.published_at || ''), String(b.published_at || '')];
    return (pa < pb ? 1 : pa > pb ? -1 : 0) || byId(a, b);
  };
  const fresh = rows.filter((r) => !seen.has(r.video_id)).sort(newestFirst);
  let calls = 0;
  for (const row of fresh) {
    if (calls === limit) return;
    const videoId = row.video_id;
    const path = join(folder, `${videoId}.txt`);
    if (!VIDEO_ID.test(videoId) || existsSync(path)) continue; // never turn odd text into a file name
    calls += 1;
    const item = await attempt(`transcript ${videoId}`, async () => itemOf(await callApi(ok, TRANSCRIPT, [], { id: videoId })), tally, log);
    if (item === null) continue;
    const text = transcriptText(row, item);
    if (!text) {
      log(`transcript ${videoId}: the video has no transcript text`);
      continue;
    }
    writeFileSync(path, text, 'utf8');
    log(`saved ${path}`);
  }
}

function printPlan(args, channels, caps, most, log) {
  const pages = listPages(args.videos);
  const calls = channels.length * (1 + pages + args.videos) + args.transcripts;
  const extra = args.transcripts ? ` + up to ${args.transcripts} transcript(s)` : '';
  log(`plan: ${channels.length} channel(s) x (1 profile + ${pages} list page(s) + up to ${args.videos} video(s))${extra} = up to ${calls} call(s); at most $${usd(most)}`);
  for (const [key] of channels) log(`  ${shown(key)}`);
  const prices = `  ${CHANNEL} $${usd(caps[CHANNEL])}, ${CHANNEL_VIDEOS} $${usd(caps[CHANNEL_VIDEOS])} per page, ${VIDEO} $${usd(caps[VIDEO])} per video`;
  log(prices + (args.transcripts ? `, ${TRANSCRIPT} $${usd(caps[TRANSCRIPT])} per transcript` : ''));
  log(`  appends to ${join(args.out, CHANNELS_CSV)} and ${join(args.out, VIDEOS_CSV)}${args.transcripts ? `; transcripts go to ${join(args.out, TRANSCRIPTS_DIR)}` : ''}`);
}

async function run(args, ok, { now, stdout, log }) {
  const channels = planChannels(args.channels);
  const most = planCost(await ok.prices(), channels.length, args.videos, args.transcripts);
  printPlan(args, channels, ok.caps, most, log);
  if (args.dryRun) return 0;
  if (most > args.budget) {
    log(`over the --budget of $${usd(args.budget)}; raise it or use fewer --videos`);
    return 3;
  }
  if (!ok.key) {
    log(`OKDATA_API_KEY is not set. Get a key at ${SIGN_UP}`);
    return 2;
  }

  const [channelsPath, videosPath] = [join(args.out, CHANNELS_CSV), join(args.out, VIDEOS_CSV)];
  readRows(channelsPath, CHANNEL_FIELDS); // refuse a foreign or unwritable CSV before spending anything
  const seen = new Set(readRows(videosPath, VIDEO_FIELDS).map((r) => r.video_id));
  checkWritable(channelsPath);
  checkWritable(videosPath);
  if (args.transcripts) checkWritable(join(args.out, TRANSCRIPTS_DIR), true);
  const runAt = now();
  const tally = { saved: 0, failed: 0 };
  let stopped = false;
  const rows = [];
  try {
    for (const chan of channels) rows.push(...await monitorChannel(ok, runAt, chan, args.videos, args.out, tally, log));
    if (args.transcripts) await saveTranscripts(ok, rows, seen, args.transcripts, join(args.out, TRANSCRIPTS_DIR), tally, log);
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    stopped = true;
  }
  if (tally.saved) {
    log(`appended ${tally.saved} rows to ${channelsPath} and ${videosPath}`);
    stdout.write(report(readRows(channelsPath, CHANNEL_FIELDS), readRows(videosPath, VIDEO_FIELDS), args.top));
  }
  const lost = ok.held ? ` (and up to $${usd(ok.held)} more on calls whose answers were lost)` : '';
  log(`spent $${usd(ok.spent)}${lost}`);
  if (stopped || (tally.failed && !tally.saved)) return 1;
  return tally.failed ? 4 : 0;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const log = (line) => stderr.write(`${line}\n`);
  let args;
  try {
    args = parseCli(argv);
  } catch (err) {
    if (!(err instanceof UsageError) && !String(err?.code ?? '').startsWith('ERR_PARSE_ARGS')) throw err;
    stderr.write(`${USAGE_LINE}monitor.mjs: error: ${err.message}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }
  const ok = new Okdata({
    api: (env.OKDATA_BASE_URL || 'https://api.okdata.online').replace(/\/+$/, ''),
    key: (env.OKDATA_API_KEY || '').trim() || null,
    budget: args.budget,
    sleep: io.sleep ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))),
  });
  try {
    return await run(args, ok, { now: io.now ?? utcNow, stdout, log });
  } catch (err) {
    if (!(err instanceof OutputError) && !err?.syscall) throw err; // only CSV or file-system trouble is expected
    log(`error: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; });
}
