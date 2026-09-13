import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BilibiliClient, courseFillClientConfig } from '../src/bilibili.mjs';
import { MobileSearchClient } from '../src/mobile-search.mjs';
import { calculateRateLimitBlock } from '../app.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

test('日常补齐只覆盖正常节奏，保留风险冷却且不修改旧扫描配置', () => {
  const original = structuredClone(config);
  const fill = courseFillClientConfig(config);
  assert.equal(fill.requestDelayMinMs, 5000);
  assert.equal(fill.requestDelayMaxMs, 8000);
  assert.equal(fill.heavyKeywordRequestCount, 10);
  assert.equal(fill.heavyKeywordCooldownMs, 60000);
  assert.deepEqual(config, original);
  assert.equal(config.requestDelayMinMs, 30000);
  assert.equal(config.heavyKeywordRequestCount, 6);
  assert.equal(config.heavyKeywordCooldownMs, 600000);
  for (const key of Object.keys(config).filter(k => k.startsWith('rateLimit') || k === 'maxRateLimitRetries')) {
    assert.equal(fill[key], config[key]);
  }
  assert.equal(fill.lookbackDays, 90); assert.equal(fill.minViews, 10000);
  assert.equal(fill.collectionProvider, 'firecrawl');
  const nowTs = 1789300000;
  assert.equal(calculateRateLimitBlock(nowTs, 0, fill).blockedUntil, nowTs + 12 * 3600);
  assert.equal(calculateRateLimitBlock(nowTs, nowTs - 1, fill).blockedUntil, nowTs + 24 * 3600);
});

test('缺少补齐字段用温和默认值，非法配置失败而不是零间隔请求', () => {
  assert.equal(courseFillClientConfig({}).heavyKeywordCooldownMs, 60000);
  for (const value of [0, -1, 'bad', 1.5, Infinity]) {
    assert.throws(() => courseFillClientConfig({ courseFillRequestDelayMinMs: value }), /正整数/);
  }
  assert.throws(() => courseFillClientConfig({ courseFillRequestDelayMaxMs: 1000 }), /不能小于/);
  assert.equal(courseFillClientConfig({ courseFillRequestDelayMinMs: 7000 }).requestDelayMinMs, 7000);
});

test('移动端切到WBI仍共享请求计数：第7次不休息10分钟，第11次休息1分钟', async () => {
  let nowMs = 100000, state;
  const waits = [], notices = [];
  const options = {
    nowImpl: () => nowMs, random: () => 0,
    sleepImpl: async ms => { waits.push(ms); nowMs += ms; },
    fetchImpl: async () => new Response('{}'),
    onThrottleUpdate: value => { state = value; },
    onHeavyWait: ms => { notices.push(ms); },
  };
  const fill = courseFillClientConfig(config);
  const mobile = new MobileSearchClient(fill, options);
  for (let n = 0; n < 6; n++) await mobile.request('https://m.bilibili.com/search');
  assert.equal(state.requestsSinceHeavyCooldown, 6);
  const wbi = new BilibiliClient(fill, { ...options, initialThrottleState: state });
  for (let n = 0; n < 5; n++) await wbi.request('https://api.bilibili.com/x/web-interface/view');
  assert.deepEqual(waits, [...Array(9).fill(5000), 60000]);
  assert.deepEqual(notices, [60000]);
  assert.equal(state.requestsSinceHeavyCooldown, 1);
});

test('升级恢复旧节流记录不清空计数，按新正常节奏等待', async () => {
  let nowMs = 100000;
  const waits = [];
  const client = new MobileSearchClient(courseFillClientConfig(config), {
    initialThrottleState: { lastRequestAt: nowMs - 1000, requestsSinceHeavyCooldown: 10 },
    nowImpl: () => nowMs, random: () => 0,
    sleepImpl: async ms => { waits.push(ms); nowMs += ms; },
    fetchImpl: async () => new Response('{}'),
  });
  assert.equal(client.requestsSinceHeavyCooldown, 10);
  await client.request('https://m.bilibili.com/search');
  assert.deepEqual(waits, [59000]);
});

test('50次串行请求的模拟纯等待时间下降；不代表真实采集耗时', async () => {
  async function totalWait(clientConfig) {
    let nowMs = 100000, waited = 0;
    const client = new BilibiliClient(clientConfig, {
      nowImpl: () => nowMs, random: () => 0,
      sleepImpl: async ms => { waited += ms; nowMs += ms; },
      fetchImpl: async () => new Response('{}'),
    });
    for (let i = 0; i < 50; i++) await client.request('https://api.bilibili.com/x/web-interface/view');
    return waited;
  }
  assert.equal(await totalWait(config), 6030000);
  assert.equal(await totalWait(courseFillClientConfig(config)), 465000);
});
