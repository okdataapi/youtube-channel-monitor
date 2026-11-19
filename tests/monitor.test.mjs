// Runs monitor.mjs against a local mock of the okdata API with canned answers. No network, no real key.
// The fixtures are shared with tests/test_monitor.py, so both versions must write the same CSVs, the same transcript
// files and print the same report. Run with: node --test tests/
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { channel, clip, growthPercent, main, parseCsv, report, toUnits, usd } from '../monitor.mjs';
import { TEST_KEY, error, ok, startMock } from './mock-okdata.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const API = JSON.parse(readFileSync(new URL('api.json', FIXTURES), 'utf8'));
const fixture = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');
const MOON = 'UCMoonLabSpaceChannel123';
const ARGS = ['--channel', '@TrailKit', '--channel', `https://www.youtube.com/channel/${MOON}/videos`, '--videos', '2'];
const CHANNEL_PATH = '/v1/youtube/channels/get';
const LIST_PATH = '/v1/youtube/channels/videos/list';
const VIDEO_PATH = '/v1/youtube/videos/get';
const TRANSCRIPT_PATH = '/v1/youtube/videos/transcript/get';

function sink() {
  const chunks = [];
  return { write: (text) => { chunks.push(text); return true; }, text: () => chunks.join('') };
}

describe('monitor.mjs against a mock API', () => {
  let api;
  let dir;
  let out;
  let runIndex;

  const channelPage = (q) => {
    const item = API.runs[runIndex].channels[q.username ?? q.id];
    return item ? [200, ok('c', { item })] : [404, error('not_found')];
  };
  const listPage = (q) => {
    const pages = API.runs[runIndex].lists[q.username ?? q.id] ?? [[]];
    const index = Number(q.cursor ?? 0);
    return [200, ok('l', { items: pages[index], nextCursor: index + 1 < pages.length ? String(index + 1) : null })];
  };
  const videoPage = (q) => {
    const item = API.runs[runIndex].videos[q.id];
    return item ? [200, ok('v', { item })] : [404, error('not_found')];
  };
  const transcriptPage = (q) => {
    const item = API.transcripts[q.id];
    return item ? [200, ok('t', { item, amount: '0.004' })] : [404, error('not_found')];
  };

  beforeEach(async () => {
    runIndex = 0;
    api = await startMock({
      [CHANNEL_PATH]: channelPage, [LIST_PATH]: listPage, [VIDEO_PATH]: videoPage, [TRANSCRIPT_PATH]: transcriptPage,
    });
    dir = mkdtempSync(join(tmpdir(), 'monitor-'));
    out = join(dir, 'data');
  });

  afterEach(async () => {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function runTool(argv, { key = TEST_KEY, run = 0 } = {}) {
    runIndex = run;
    const stdout = sink();
    const stderr = sink();
    const code = await main([...argv, '--out', out], {
      env: { OKDATA_BASE_URL: api.url, OKDATA_API_KEY: key },
      now: () => API.runs[run].run_at,
      stdout,
      stderr,
      sleep: async () => {},
    });
    return { code, out: stdout.text(), log: stderr.text() };
  }

  const csvText = (name) => readFileSync(join(out, name), 'utf8');
  const calls = (path) => api.paid().filter((c) => c.path === path);

  test('two runs append both CSVs, save transcripts and report, same as the Python version', async () => {
    let r = await runTool([...ARGS, '--transcripts', '1'], { run: 0 });
    assert.equal(r.code, 0, r.log);
    assert.match(r.out, /\(first run\)/);
    assert.match(r.log, /spent \$0\.02\n/);
    r = await runTool([...ARGS, '--transcripts', '1'], { run: 1 });
    assert.equal(r.code, 0, r.log);
    assert.equal(csvText('channels.csv'), fixture('expected-channels.csv'));
    assert.equal(csvText('videos.csv'), fixture('expected-videos.csv'));
    assert.equal(r.out, fixture('expected-report.txt'));
    assert.deepEqual(readdirSync(join(out, 'transcripts')).sort(), ['trail000002.txt', 'trail000003.txt']);
    assert.equal(readFileSync(join(out, 'transcripts', 'trail000002.txt'), 'utf8'), fixture('expected-transcript.txt'));
    const profiles = calls(CHANNEL_PATH).map((c) => c.query);
    assert.deepEqual(profiles[0], { username: 'trailkit', view: 'full' });
    assert.deepEqual(profiles[1], { id: MOON, view: 'full' });
    assert.ok(calls(LIST_PATH).every((c) => c.query.view === 'brief'));
    assert.equal(calls(VIDEO_PATH).length, 8);
  });

  test('CSV rows are clipped and safe for spreadsheets', async () => {
    await runTool(ARGS, { run: 0 });
    const [, ...rows] = parseCsv(csvText('videos.csv'));
    assert.deepEqual(rows.map((r) => r[2]), ['trail000002', 'trail000001', 'moon0000002', 'moon0000001']);
    assert.ok(rows[1][4].startsWith("'=HYPERLINK"));
    assert.equal(rows[1][9], ''); // a hidden count stays empty, not 0
    const long = rows[2][4]; // no title, so the description stands in, on one line
    assert.ok(Array.from(long).length <= 200 && long.endsWith('…') && !long.includes('\n'));
    assert.equal(rows[3][6], '5'); // sent as 5.0
  });

  test('dry run needs no key and spends nothing', async () => {
    api.prices = {
      'youtube.channels.get': '0.002', 'youtube.channels.videos.list': '0.002', 'youtube.videos.get': '0.003',
      'youtube.videos.transcript.get': '0.004',
    };
    const r = await runTool([...ARGS, '--transcripts', '1', '--dry-run'], { key: '' });
    assert.equal(r.code, 0);
    assert.match(r.log, /\+ up to 1 transcript\(s\) = up to 9 call\(s\); at most \$0\.024\n/);
    assert.deepEqual(api.paid(), []);
    assert.equal(existsSync(out), false);
  });

  test('budget and a missing key stop before any call', async () => {
    let r = await runTool([...ARGS, '--transcripts', '1', '--budget', '0.01']);
    assert.equal(r.code, 3);
    assert.match(r.log, /at most \$0\.02\n/);
    r = await runTool(ARGS, { key: '' });
    assert.equal(r.code, 2);
    assert.match(r.log, /signup\/\?src=gh-youtube-channel-monitor/);
    assert.deepEqual(api.paid(), []);
  });

  test('failed channel totals keep the videos, and every charged attempt counts', async () => {
    const failed = { ...error('upstream_failed', { retry: 'yes' }), charged: true, amount: '0.002' };
    api.routes[CHANNEL_PATH] = (q) => (q.id ? [502, failed] : channelPage(q));
    const r = await runTool(ARGS);
    assert.equal(r.code, 4, r.log);
    assert.ok(r.log.includes(`${MOON}: channel totals: upstream_failed: scripted (charged: yes).`));
    assert.ok(r.out.includes(`  ${MOON}  no channel totals this run`));
    assert.ok(r.log.includes(`${MOON}: 2 videos`));
    assert.equal(calls(CHANNEL_PATH).length, 4); // 1 + 3 attempts
    assert.match(r.log, /spent \$0\.02\n/); // 0.008 per channel + 3 charged attempts at 0.002
  });

  test('a failed video is skipped and the rest saved', async () => {
    api.routes[VIDEO_PATH] = (q) => (q.id === 'trail000001' ? [404, error('not_found')] : videoPage(q));
    const r = await runTool(ARGS);
    assert.equal(r.code, 4, r.log);
    assert.match(r.log, /@trailkit: video trail000001: not_found: scripted \(charged: no\)\. Check the channel/);
    assert.match(r.log, /@trailkit: 1 videos/);
    assert.equal(csvText('videos.csv').split('\n').length - 1, 4); // header + 3 videos
  });

  test('a lost answer is retried with the same Idempotency-Key', async () => {
    const answers = [[503, error('upstream_busy', { retry: 'yes' })]];
    api.routes[CHANNEL_PATH] = (q) => answers.pop() ?? channelPage(q);
    const r = await runTool(['--channel', 'trailkit', '--videos', '1']);
    assert.equal(r.code, 0, r.log);
    const [first, second] = api.paid();
    assert.equal(first.headers['idempotency-key'], second.headers['idempotency-key']);
    assert.match(r.log, /@trailkit: 1 videos/);
  });

  test('the budget is also checked before every call', async () => {
    api.routes[VIDEO_PATH] = (q) => {
      const [status, body] = videoPage(q);
      body.meta.billing.amount = '0.004'; // more than the catalog said
      return [status, body];
    };
    const r = await runTool([...ARGS, '--budget', '0.016']);
    assert.equal(r.code, 1, r.log);
    assert.ok(r.log.includes(`${MOON}: video moon0000002: budget_reached`));
    assert.match(r.log, /spent \$0\.016\n/);
    assert.match(r.out, /Trail Kit · 182,000 subscribers/); // what was paid for is saved and reported
  });

  test('appends cleanly to files without a final newline', async () => {
    await runTool([...ARGS, '--transcripts', '1'], { run: 0 });
    for (const name of ['channels.csv', 'videos.csv']) writeFileSync(join(out, name), csvText(name).replace(/\n+$/, ''));
    await runTool([...ARGS, '--transcripts', '1'], { run: 1 });
    assert.equal(csvText('channels.csv'), fixture('expected-channels.csv'));
    assert.equal(csvText('videos.csv'), fixture('expected-videos.csv'));
  });

  test('a wrong key stops the run and writes nothing', async () => {
    const r = await runTool(ARGS, { key: 'okd_wrong' });
    assert.equal(r.code, 1);
    assert.match(r.log, /@trailkit: channel totals: unauthorized/);
    assert.equal(r.out, '');
    assert.equal(api.paid().length, 1);
    assert.equal(existsSync(join(out, 'videos.csv')), false);
  });

  test('refuses a CSV with other columns before spending', async () => {
    mkdirSync(out);
    writeFileSync(join(out, 'videos.csv'), 'date,name\n2026-01-01,x\n');
    const r = await runTool(ARGS);
    assert.equal(r.code, 1);
    assert.match(r.log, /other columns/);
    assert.deepEqual(api.paid(), []);
  });

  test('a saved transcript is not bought again', async () => {
    const folder = join(out, 'transcripts');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'trail000002.txt'), 'mine');
    const r = await runTool([...ARGS, '--transcripts', '1']);
    assert.equal(r.code, 0, r.log);
    assert.equal(readFileSync(join(folder, 'trail000002.txt'), 'utf8'), 'mine');
    assert.match(readFileSync(join(folder, 'moon0000002.txt'), 'utf8'), /This month we built a landing pad\./);
    assert.deepEqual(calls(TRANSCRIPT_PATH).map((c) => c.query.id), ['moon0000002']);
  });

  test('more than one list page when asked for many videos', async () => {
    const ids = Array.from({ length: 45 }, (_, n) => `vid${String(n).padStart(8, '0')}`);
    api.routes[LIST_PATH] = (q) => [200, ok('l', {
      items: (q.cursor ? ids.slice(30) : ids.slice(0, 30)).map((id) => ({ id })), nextCursor: q.cursor ? null : 'p2',
    })];
    api.routes[VIDEO_PATH] = (q) => [200, ok('v', { item: { id: q.id, url: `u/${q.id}`, title: 't', metrics: { views: 1 } } })];
    const r = await runTool(['--channel', '@trailkit', '--videos', '31', '--budget', '1']);
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(calls(LIST_PATH).map((c) => c.query.cursor ?? null), [null, 'p2']);
    assert.match(r.log, /@trailkit: 31 videos/);
  });

  test('odd answers become empty cells the same way in both versions', async () => {
    api.routes[LIST_PATH] = () => [200, ok('l', { items: [null, { id: 5 }, 'x', { id: '-dashfirst1' }] })];
    api.routes[VIDEO_PATH] = (q) => [200, ok('v', {
      item: {
        id: q.id, url: ['not', 'text'], title: { a: 1 }, text: '=1+1', published_at: true, metrics: 'lots', ext: [1],
      },
    })];
    const r = await runTool(['--channel', '@trailkit', '--videos', '3']);
    assert.equal(r.code, 0, r.log);
    assert.equal(csvText('videos.csv').split('\n')[1], "2026-11-18T08:00:00Z,trailkit,'-dashfirst1,,'=1+1,,,,,");
  });

  test('an id that starts with a dash reads back as written', async () => {
    api.routes[LIST_PATH] = () => [200, ok('l', { items: [{ id: '-dashfirst1' }] })];
    api.routes[VIDEO_PATH] = (q) => [200, ok('v', { item: { id: q.id, url: 'u', title: 't', metrics: { views: 1 } } })];
    await runTool(['--channel', '@trailkit', '--videos', '1'], { run: 0 });
    const r = await runTool(['--channel', '@trailkit', '--videos', '1'], { run: 1 });
    assert.equal(r.code, 0, r.log);
    assert.match(r.out, /New uploads since the last run: 0\n/);
    assert.match(csvText('videos.csv'), /,'-dashfirst1,/); // still safe to open in a spreadsheet
  });

  test('calls whose answers were lost count against the budget', async () => {
    api.routes[VIDEO_PATH] = (q) => (q.id === 'trail000002' ? [502, 'not json'] : videoPage(q));
    const r = await runTool(['--channel', '@trailkit', '--videos', '2']);
    assert.equal(r.code, 4, r.log);
    assert.match(r.log, /\(charged: unknown\)/);
    assert.ok(r.log.includes('spent $0.006 (and up to $0.002 more on calls whose answers were lost)'));
  });
});

describe('helpers', () => {
  test('handles, ids and links are normalised', () => {
    assert.equal(channel('@NASA'), 'nasa');
    assert.equal(channel(' NASA '), 'nasa');
    assert.equal(channel('https://www.youtube.com/@NASA/videos?si=abc'), 'nasa');
    assert.equal(channel('youtube.com/@%E4%B8%AD%E6%96%87'), '中文');
    assert.equal(channel('UCLA_DiR1FfKNvjuUpBHmylQ'), 'UCLA_DiR1FfKNvjuUpBHmylQ');
    assert.equal(channel('https://m.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/featured'), 'UCLA_DiR1FfKNvjuUpBHmylQ');
    for (const bad of ['', '@', 'two words', '-start', '@=cmd', 'youtube.com/@nasa%0A', 'https://www.youtube.com/c/NASA',
      'https://www.youtube.com/user/NASA', 'https://www.youtube.com/channel/nope',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ']) {
      assert.throws(() => channel(bad), undefined, bad);
    }
  });

  test('clip counts characters, not UTF-16 units', () => {
    assert.equal(clip('a\n\tb  c', 10), 'a b c');
    assert.equal(clip('🔥'.repeat(10), 5), '🔥🔥🔥🔥…');
    assert.equal(clip(null, 5), '');
  });

  test('money is exact', () => {
    assert.equal(usd(toUnits('0.002') * 10), '0.02');
    assert.equal(usd(toUnits('0.50')), '0.5');
    assert.equal(usd(0), '0');
    assert.equal(toUnits('abc'), null);
    assert.equal(toUnits('-1'), null);
    assert.equal(usd(toUnits('1e-8')), '0.00000001');
  });

  test('growth percent rounds half up, like the Python version', () => {
    assert.equal(growthPercent(500, 1000), ' (+50.0%)');
    assert.equal(growthPercent(1, 3), ' (+33.3%)');
    assert.equal(growthPercent(1, 8), ' (+12.5%)');
    assert.equal(growthPercent(5, 0), '');
    assert.equal(growthPercent(252, 1206371), ' (<0.1%)');
  });

  test('CSV parsing handles quotes, commas and blank lines', () => {
    assert.deepEqual(parseCsv('a,b\n"x, ""y""",2\n\n'), [['a', 'b'], ['x, "y"', '2']]);
  });

  test('the report compares the right runs', () => {
    const video = (runAt, id, views, chan = 'a') => ({
      run_at: runAt, channel: chan, video_id: id, url: `u${id}`, title: '', published_at: '', duration_s: '', views,
      likes: '', comments: '',
    });
    const totals = (runAt, subscribers) => ({
      run_at: runAt, channel: 'a', channel_id: 'UC1', name: 'A', subscribers, videos: '', views: '',
    });
    const day = ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'];
    const text = report([totals(day[0], '1000'), totals(day[2], '1500')], [
      video(day[0], '1', '10'), video(day[1], '1', '100'), video(day[1], '2', '5'), video(day[2], '1', '130'),
      video(day[2], '2', '905'), video(day[2], '3', '1'), video(day[2], '4', '2'), video(day[2], '9', '7', 'b'),
    ], 1);
    assert.ok(text.includes(`(previous run ${day[1]})`));
    assert.ok(text.includes('  @a  A · 1,500 subscribers (+500) · ? videos · ? views\n')); // vs its last earlier row
    assert.ok(text.includes('  @b  no channel totals this run · first snapshot\n'));
    assert.ok(text.includes('New uploads since the last run: 2\n  2 views · @a · posted ?\n')); // not b's video
    assert.ok(text.includes('  ...and 1 more in the CSV'));
    assert.ok(text.includes('+900 views (+18000.0%) · @a · 905 now'));
    assert.doesNotMatch(text, /\+30 views|\+120 views/);
  });
});
