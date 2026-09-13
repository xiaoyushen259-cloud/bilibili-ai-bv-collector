import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CollectorDatabase } from '../src/db.mjs';
import { FirecrawlClient, cliInvocation, parseFirecrawlVideo } from '../src/firecrawl.mjs';
import { ACTIVE_BATCH_KEY, batchDatasets, collectBatch, collectionProvider, creativeVideo } from '../src/collection-batch.mjs';
import { syncVerifiedBatch } from '../src/batch-publish.mjs';
import { runScan, runCycle, runCourseFill } from '../app.mjs';
import { normalizeVideo } from '../src/core.mjs';
import { buildFeishuMatrix } from '../src/feishu.mjs';

const nowTs = Date.parse('2026-09-11T08:00:00Z') / 1000;
const bv = n => 'BV' + String(n).padStart(10, '0');
const video = (n, extra = {}) => ({ bvid: bv(n), title: 'ComfyUI 工作流', description: '', tags: 'ComfyUI',
  play: 10001, pubdate: nowTs - 3600, ...extra });
const doc = (n, extra = {}) => ({ url: `https://www.bilibili.com/video/${bv(n)}`,
  markdown: '# ComfyUI 工作流', metadata: { statusCode: 200, description: '视频播放量 10,001, 弹幕量 0',
    'video:release_date': new Date((nowTs - 3600) * 1000).toISOString(), 'video:tag': ['ComfyUI'] }, ...extra });
const config = { lookbackDays: 90, minViews: 10000, courseTargetCount: 1, aiContextTerms: [],
  keywordGroups: [{ label: 'comfyui', queries: ['ComfyUI', 'ComfyUI 工作流'] }],
  contentPartitions: [{ name: 'ComfyUI', keywordGroups: ['comfyui'] }] };
function fixture(t) {
  const db = new CollectorDatabase(':memory:'); t.after(() => db.close());
  return { db, config, now: () => nowTs, allowMobile: false, allowWbi: false };
}

test('旧 scan、fill-courses、cycle 默认都走批次入口，未满额 cycle 不写飞书', async () => {
  const calls = [];
  const batchRunner = async () => { calls.push('Firecrawl'); return { complete: false }; };
  await runScan('full', { batchRunner });
  await runCourseFill({ batchRunner });
  const result = await runCycle({ batchRunner });
  assert.deepEqual(calls, ['Firecrawl', 'Firecrawl', 'Firecrawl']);
  assert.equal(result.feishu.skipped, true);
  assert.equal(collectionProvider({}), 'firecrawl');
  assert.equal(collectionProvider({}, 'wbi'), 'wbi');
  assert.throws(() => collectionProvider({}, 'unknown'));
});

test('Firecrawl 仅接受真实域名、成功详情、明确时区和精确播放量', () => {
  assert.equal(parseFirecrawlVideo(doc(1)).play, 10001);
  assert.equal(parseFirecrawlVideo(doc(1, { url: 'https://bilibili.com.evil.test/video/' + bv(1) })), null);
  for (const description of ['视频播放量 1.2万, 弹幕0', '搜索结果播放量10001', '视频播放量 12abc, 弹幕0']) {
    assert.equal(parseFirecrawlVideo(doc(1, { metadata: { ...doc(1).metadata, description } })), null);
  }
  assert.equal(parseFirecrawlVideo(doc(1, { metadata: { ...doc(1).metadata, statusCode: 404 } })), null);
  assert.equal(parseFirecrawlVideo(doc(1, { metadata: { ...doc(1).metadata, 'video:release_date': '2026-09-10 12:00:00' } })), null);
});

test('Firecrawl 成功满额时从不创建 WBI 客户端；同日续跑不重复搜索', async t => {
  const f = fixture(t); let calls = 0;
  const options = { ...f, allowWbi: true, firecrawl: { search: async () => {
    calls++; return { documents: [doc(1)], evidenceFile: 'fixture.json' };
  } }, createWbi: async () => assert.fail('不应访问WBI') };
  assert.equal((await collectBatch(options)).complete, true);
  assert.equal((await collectBatch(options)).total, 1);
  assert.equal(calls, 1);
});

test('Firecrawl 不可用后才初始化 WBI，传递精确时间窗', async t => {
  const f = fixture(t), calls = [];
  const result = await collectBatch({ ...f, allowWbi: true,
    firecrawl: { search: async () => { calls.push('fc'); throw new Error('未登录'); } },
    createWbi: async () => { calls.push('wbi-init'); return { search: async args => {
      assert.equal(args.startTs, nowTs - 90 * 86400); assert.equal(args.endTs, nowTs);
      calls.push('wbi-search'); return { items: [video(1)], numPages: 1 };
    } }; }, onWbiError: async () => assert.fail('不应失败') });
  assert.deepEqual(calls, ['fc', 'wbi-init', 'wbi-search']);
  assert.equal(result.complete, true);
});

test('默认依次 Firecrawl → 移动端 → WBI；移动端满额就停止', async t => {
  for (const mobileFull of [true, false]) {
    const f = fixture(t), calls = [];
    const result = await collectBatch({ ...f, allowMobile: true, allowWbi: true, maxSearches: 1,
      firecrawl: { search: async () => { calls.push('fc'); return { documents: [] }; } },
      createMobile: async () => { calls.push('mobile-init'); return { requestCount: 0, search: async () => {
        calls.push('mobile'); return { items: mobileFull ? [video(1)] : [], numPages: 1 };
      } }; },
      createWbi: async () => { calls.push('wbi-init'); return { search: async () => {
        calls.push('wbi'); return { items: [video(2)], numPages: 1 };
      } }; } });
    assert.equal(result.complete, true);
    assert.equal(calls[0], 'fc'); assert.equal(calls[1], 'mobile-init');
    if (mobileFull) assert.equal(calls.includes('wbi-init'), false);
    else assert.ok(calls.indexOf('wbi-init') > calls.lastIndexOf('mobile'));
  }
});

test('Firecrawl满额完全不初始化移动端或WBI', async t => {
  const result = await collectBatch({ ...fixture(t), allowMobile: true, allowWbi: true,
    firecrawl: { search: async () => ({ documents: [doc(1)] }) },
    createMobile: async () => assert.fail('不应创建移动端'), createWbi: async () => assert.fail('不应创建WBI') });
  assert.equal(result.complete, true);
});

test('移动端普通错误后可回退WBI，限流或已在冷却则禁止WBI', async t => {
  for (const message of ['HTTP 503', 'HTTP 412', 'HTTP 429', 'v_voucher', 'cooldown']) {
    const f = fixture(t); let wbiCalls = 0, errors = 0;
    const result = await collectBatch({ ...f, allowMobile: true, allowWbi: true, maxSearches: 1,
      firecrawl: { search: async () => ({ documents: [] }) },
      createMobile: async () => message === 'cooldown' ? null : { requestCount: 1,
        search: async () => ({ items: [video(1)], error: new Error(message) }) },
      target: 2, createWbi: async () => { wbiCalls++; return { search: async () => ({ items: [video(2)], numPages: 1 }) }; },
      onWbiError: async () => { errors++; } });
    assert.equal(wbiCalls, message === 'HTTP 503' ? 1 : 0);
    assert.equal(errors, message === 'cooldown' ? 0 : 1);
    assert.equal(result.total, message === 'cooldown' ? 0 : message === 'HTTP 503' ? 2 : 1);
  }
});

test('移动端不完整页续跑不丢进度，沿用历史排重与精确时间窗', async t => {
  const f = fixture(t); let run = 0;
  f.db.recordBoundVideos([{ bvid: bv(9) }]);
  const options = { ...f, allowMobile: true, target: 2, maxSearches: 1,
    firecrawl: { search: async () => ({ documents: [] }) },
    createMobile: async () => ({ requestCount: 2, search: async args => {
      assert.equal(args.page, 1); assert.equal(args.startTs, nowTs - 90 * 86400);
      assert.equal(args.shouldFetch(bv(9)), false);
      if (run++) {
        assert.equal(args.shouldFetch(bv(1)), false);
        return { items: [video(2)], numPages: 1 };
      }
      return { items: [video(1)], exhausted: true, error: new Error('budget') };
    } }) };
  assert.equal((await collectBatch(options)).complete, false);
  assert.equal((await collectBatch(options)).complete, true);
  assert.equal(run, 2);
});

test('移动端某分区满额后继续其他分区，过滤历史、已绑定、边界与无关视频', async t => {
  const f = fixture(t);
  f.db.upsertVideo(normalizeVideo(video(8)), 'comfyui', 'ComfyUI', '历史', nowTs - 86400);
  f.db.recordBoundVideos([{ bvid: bv(9) }]);
  const multi = { ...config, contentPartitions: [...config.contentPartitions,
    { name: 'Agent', keywordGroups: ['comfyui'] }] };
  const result = await collectBatch({ ...f, config: multi, allowMobile: true, maxSearches: 1,
    firecrawl: { search: async () => ({ documents: [] }) },
    createMobile: async () => ({ requestCount: 0, search: async () => ({ numPages: 3,
      items: [video(8), video(9), video(3, { play: 10000 }), video(4, { pubdate: nowTs - 91 * 86400 }),
        video(5, { pubdate: nowTs + 1 }), video(6, { title: '无关电影', tags: '' }), video(1), video(2)] }) }) });
  assert.deepEqual(result.partitionCounts, { ComfyUI: 1, Agent: 1 });
  assert.equal(result.complete, true);
});

test('证据不足也会回退；WBI 冷却不妨碍先使用 Firecrawl', async t => {
  const f = fixture(t), calls = [];
  f.db.setRuntimeState('bilibili_blocked_until', nowTs + 86400);
  const result = await collectBatch({ ...f, allowWbi: true, maxSearches: 1,
    firecrawl: { search: async () => { calls.push('fc'); return { documents: [doc(1, { metadata: {} })] }; } },
    createWbi: async () => { calls.push('cooldown'); return null; } });
  assert.deepEqual(calls, ['fc', 'cooldown']); assert.equal(result.complete, false);
  assert.equal(f.db.getRuntimeState('bilibili_blocked_until'), String(nowTs + 86400));
});

test('历史和已绑定、阈值边界、过期与未来视频不计为新增', async t => {
  const f = fixture(t);
  f.db.upsertVideo(normalizeVideo(video(1)), 'comfyui', 'ComfyUI', '历史', nowTs - 86400);
  f.db.recordBoundVideos([{ bvid: bv(2) }]);
  const documents = [doc(1), doc(2), doc(3, { metadata: { ...doc(3).metadata, description: '视频播放量 10000, 弹幕0' } }),
    doc(4, { metadata: { ...doc(4).metadata, 'video:release_date': '2025-01-01T00:00:00Z' } }),
    doc(5, { metadata: { ...doc(5).metadata, 'video:release_date': '2027-01-01T00:00:00Z' } }), doc(6)];
  const result = await collectBatch({ ...f, firecrawl: { search: async () => ({ documents }) } });
  assert.equal(result.total, 1);
  const state = JSON.parse(f.db.getRuntimeState(ACTIVE_BATCH_KEY));
  assert.equal(state.records[0].bvid, bv(6));
  const datasets = batchDatasets(f.db, config, state, nowTs);
  assert.equal(datasets.rows.length, 1); assert.equal(datasets.partitions.at(-1).rows[0].bvid, bv(1));
  assert.equal(batchDatasets(f.db, config, state, nowTs + 86400).complete, false);
});

test('预算耗尽后续跑搜索下一关键词；目标增大时继续补，不拿旧库充数', async t => {
  const f = fixture(t); let count = 0;
  const firecrawl = { search: async () => ({ documents: [doc(++count)] }) };
  const first = await collectBatch({ ...f, target: 2, maxSearches: 1, firecrawl });
  assert.equal(first.complete, false);
  const second = await collectBatch({ ...f, target: 2, maxSearches: 1, firecrawl });
  assert.equal(second.complete, true); assert.equal(count, 2);
  await assert.rejects(collectBatch({ ...f, target: 1, firecrawl }), /目标数小于/);
});

test('WBI 报错只调用一次错误处理且停止本批网络补充', async t => {
  const f = fixture(t); let errors = 0;
  const result = await collectBatch({ ...f, allowWbi: true, maxSearches: 1,
    firecrawl: { search: async () => ({ documents: [] }) },
    createWbi: async () => ({ search: async () => { throw new Error('HTTP 412'); } }),
    onWbiError: async error => { assert.match(error.message, /412/); errors++; } });
  assert.equal(errors, 1); assert.equal(result.complete, false); assert.equal(result.wbiRequests, 1);
});

test('趣味补位排除教程、真人比喻和争议新闻', () => {
  assert.equal(creativeVideo(video(1, { title: 'AI恶搞三国', tags: 'AI短剧' })), true);
  for (const title of ['AI恶搞教程', '以为是AI恶搞，居然是真人', 'AI恶搞逝者照片']) {
    assert.equal(creativeVideo(video(1, { title, tags: 'AI' })), false);
  }
});

test('同一 BV 不会分配到两个当前分区，已绑定的新批次记录使发布失效', async t => {
  const f = fixture(t);
  const multiConfig = { ...config, contentPartitions: [...config.contentPartitions,
    { name: 'Agent', keywordGroups: ['comfyui'] }] };
  const result = await collectBatch({ ...f, config: multiConfig, firecrawl: { search: async () => ({ documents: [doc(1)] }) } });
  assert.equal(result.total, 1); assert.equal(result.complete, false);
  f.db.recordBoundVideos([{ bvid: bv(1) }]);
  const datasets = batchDatasets(f.db, multiConfig, JSON.parse(f.db.getRuntimeState(ACTIVE_BATCH_KEY)), nowTs);
  assert.equal(datasets.rows.length, 0); assert.equal(datasets.complete, false);
});

test('Windows CLI 参数使用单引号字面量，错误不泄漏 stderr 密钥', async () => {
  const invocation = cliInvocation(['search', "x'; $(Get-Secret)"], 'win32');
  assert.ok(invocation.args.at(-1).includes("'x''; $(Get-Secret)'"));
  const client = new FirecrawlClient({ evidenceDir: '.', execute: async () => { throw new Error('fc-private-secret'); } });
  await assert.rejects(client.check(), e => !e.message.includes('fc-private-secret'));
});

test('未满额或云端存在未交接的历史 BV 时禁止覆盖飞书', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-batch-backup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const datasets = { complete: false, rows: [], partitions: [{ name: 'ComfyUI', rows: [] }] };
  let writes = 0;
  const client = { resolveSheetId: async () => 'main', listSheets: async () => [{ sheetId: 'main', title: '主表' }],
    request: async () => ({ data: { valueRange: { values: [['BV号'], [bv(99)]] } } }),
    sync: async () => { writes++; } };
  await assert.rejects(syncVerifiedBatch(client, {}, datasets, dir), /未补齐/);
  await assert.rejects(syncVerifiedBatch(client, {}, { ...datasets, complete: true }, dir), /历史 BV/);
  assert.equal(writes, 0); assert.equal((await fs.readdir(dir)).length, 1);
});

test('批次写入失败回滚视频、关键词和台账，避免重试时吞掉 BV', async t => {
  const f = fixture(t); let writes = 0;
  const original = f.db.setRuntimeState.bind(f.db);
  f.db.setRuntimeState = (...args) => { if (++writes === 3) throw new Error('模拟写入失败'); return original(...args); };
  await assert.rejects(collectBatch({ ...f, firecrawl: { search: async () => ({ documents: [doc(1)] }) } }), /模拟写入失败/);
  assert.equal(f.db.listVideos().length, 0);
  assert.equal(JSON.parse(f.db.getRuntimeState(ACTIVE_BATCH_KEY)).records.length, 0);
});

test('第二天重建批次且不重复昨天的视频', async t => {
  const f = fixture(t);
  const firecrawl = { search: async () => ({ documents: [doc(1), doc(2)] }) };
  assert.equal((await collectBatch({ ...f, firecrawl })).total, 1);
  await collectBatch({ ...f, now: () => nowTs + 86400, firecrawl });
  const state = JSON.parse(f.db.getRuntimeState(ACTIVE_BATCH_KEY));
  assert.equal(state.day, '2026-09-12'); assert.equal(state.records[0].bvid, bv(2));
});

function mockPublisher({ fail = false } = {}) {
  const tables = new Map([['main', [['BV号']]]]);
  const client = {
    resolveSheetId: async () => 'main',
    listSheets: async () => [...tables.keys()].map(sheetId => ({ sheetId, title: sheetId === 'main' ? '主表' : 'ComfyUI' })),
    request: async url => {
      const range = decodeURIComponent(url.split('/values/')[1]);
      const id = range.split('!')[0];
      return { data: { valueRange: { values: structuredClone(tables.get(id) ?? []) } } };
    },
    readRowCount: async id => (tables.get(id) ?? []).length,
    writeRange: async (range, rows) => {
      const [id, cells] = range.split('!'), start = Number(cells.match(/^A(\d+)/)[1]) - 1;
      const data = tables.get(id) ?? []; rows.forEach((r, i) => { data[start + i] = r; }); tables.set(id, data);
    },
    clearRows: async (id, start) => { tables.set(id, (tables.get(id) ?? []).slice(0, start - 1)); },
    sync: async (rows, { partitions }) => {
      tables.set('main', buildFeishuMatrix(rows));
      tables.set('course', buildFeishuMatrix(partitions[0].rows));
      if (fail) throw new Error('模拟部分写入后失败');
      return { sheetId: 'main', partitions: [{ name: 'ComfyUI', sheetId: 'course' }] };
    },
  };
  return { client, tables };
}

test('发布成功会读回核对；部分失败会回写原表并清空新表', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-batch-publish-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const rows = [{ ...normalizeVideo(video(1)), content_partitions: 'ComfyUI', first_qualified_at: nowTs, last_checked_at: nowTs }];
  const datasets = { complete: true, rows, partitions: [{ name: 'ComfyUI', rows }] };
  const success = mockPublisher();
  assert.equal((await syncVerifiedBatch(success.client, { batchRows: 200 }, datasets, dir)).verified, true);
  const failure = mockPublisher({ fail: true });
  await assert.rejects(syncVerifiedBatch(failure.client, { batchRows: 200 }, datasets, dir), /已回写原有内容/);
  assert.deepEqual(failure.tables.get('main'), [['BV号']]);
  assert.deepEqual(failure.tables.get('course'), []);
});
