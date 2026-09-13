import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MobileSearchClient, parseMobileDetail } from '../src/mobile-search.mjs';
import { BilibiliClient } from '../src/bilibili.mjs';

const bv = n => 'BV' + String(n).padStart(10, '0');
const detail = n => ({ code: 0, data: { bvid: bv(n), title: 'ComfyUI 工作流',
  stat: { view: 10001 }, pubdate: 1789290000, desc: 'ComfyUI', owner: { name: '作者', mid: 1 } } });
const config = { requestDelayMinMs: 0, requestDelayMaxMs: 0, requestTimeoutMs: 1000 };
const args = { keyword: 'ComfyUI', startTs: 1789290000 - 90 * 86400, endTs: 1789300000 };
const response = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
const searchResult = (...ids) => ({ code: 0, data: { result: ids.map(n => ({ bvid: bv(n), play: '999万' })), numPages: 2 } });

test('移动端详情必须有对应BV、精确整数播放量和发布时间', () => {
  assert.equal(parseMobileDetail(detail(1), bv(1)).play, 10001);
  assert.equal(parseMobileDetail(detail(1), bv(2)), null);
  for (const value of ['1.2万', '10001', null, undefined, NaN, Infinity, 10001.5]) {
    const payload = detail(1); payload.data.stat.view = value;
    assert.equal(parseMobileDetail(payload, bv(1)), null);
  }
  const payload = detail(1); delete payload.data.pubdate;
  assert.equal(parseMobileDetail(payload, bv(1)), null);
});

test('移动端无签名发现后逐条详情核验，历史BV不请求，证据落盘', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-mobile-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const client = new MobileSearchClient(config, { evidenceDir: dir, fetchImpl: async (url, options) => {
    const parsed = new URL(url); calls.push(parsed);
    assert.match(options.headers['User-Agent'], /Android/);
    if (parsed.pathname.endsWith('/search/type')) return response(searchResult(1, 1, 2));
    return response(detail(1));
  } });
  const result = await client.search({ ...args, shouldFetch: id => id !== bv(2) });
  assert.equal(result.error, null); assert.equal(result.items[0].play, 10001);
  assert.equal(result.items.length, 1); assert.equal(client.requestCount, 2);
  assert.equal(calls[0].pathname.includes('/wbi/'), false);
  assert.equal(calls[0].searchParams.get('pubtime_begin_s'), String(args.startTs));
  assert.equal(JSON.parse(await fs.readFile(result.evidenceFile, 'utf8')).responses.length, 2);
});

test('非限流搜索故障才回退移动网页，网页显示数值不直接计入', async () => {
  const calls = [];
  const client = new MobileSearchClient(config, { fetchImpl: async url => {
    const parsed = new URL(url); calls.push(parsed);
    if (parsed.pathname.endsWith('/search/type')) return response({}, 503);
    if (parsed.hostname === 'm.bilibili.com') return response(`<a href="/video/${bv(1)}">999万</a>`);
    return response(detail(1));
  } });
  const result = await client.search(args);
  assert.equal(result.error, null); assert.equal(result.items[0].play, 10001);
  assert.equal(calls.length, 3);
});

test('移动端412、429、验证响应均停止，不换网页或请求详情', async () => {
  for (const [payload, status] of [[{}, 412], [{}, 429], [{ code: -352 }, 200],
    ['<html>请输入验证码</html>', 200], ['<html>访问过于频繁</html>', 200], ['异常流量', 200],
    [{ code: 0, data: { v_voucher: 'challenge' } }, 200]]) {
    const client = new MobileSearchClient(config, { fetchImpl: async () => response(payload, status) });
    const result = await client.search(args);
    assert.ok(result.error); assert.equal(result.items.length, 0); assert.equal(client.requestCount, 1);
  }
});

test('移动端回送并持久化白名单匿名Cookie，不发送登录Cookie', async () => {
  const headers = []; let session;
  const client = new MobileSearchClient(config, { initialSession: { cookies: { buvid3: 'old', SESSDATA: 'private' } },
    onSessionUpdate: value => { session = value; }, fetchImpl: async (url, options) => {
      headers.push(options.headers);
      if (new URL(url).pathname.endsWith('/search/type')) {
        return new Response(JSON.stringify(searchResult(1)), { headers: { 'set-cookie': 'buvid4=new; Path=/' } });
      }
      return response(detail(1));
    } });
  assert.equal((await client.search(args)).error, null);
  assert.equal(headers[0].Cookie, 'buvid3=old');
  assert.match(headers[1].Cookie, /buvid4=new/);
  assert.equal(headers[1].Cookie.includes('SESSDATA'), false);
  assert.equal(session.cookies.buvid4, 'new');
});

test('详情阶段限流保留之前核验结果；请求预算包括搜索与详情', async () => {
  for (const limited of [false, true]) {
    const client = new MobileSearchClient(config, { maxRequests: limited ? 10 : 2, fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/search/type')) return response(searchResult(1, 2));
      if (parsed.searchParams.get('bvid') === bv(1)) return response(detail(1));
      return response({}, 429);
    } });
    const result = await client.search(args);
    assert.equal(result.items.length, 1); assert.ok(result.error);
    assert.equal(result.exhausted, !limited); assert.equal(client.requestCount, limited ? 3 : 2);
  }
});

test('移动端到WBI复用已持久化的请求节流时间', async () => {
  let current = 10000, state;
  const waits = [];
  const options = { nowImpl: () => current, sleepImpl: async ms => { waits.push(ms); current += ms; },
    random: () => 0, onThrottleUpdate: value => { state = value; }, fetchImpl: async () => response('ok') };
  const delayed = { ...config, requestDelayMinMs: 5000, requestDelayMaxMs: 5000 };
  const mobile = new MobileSearchClient(delayed, options);
  await mobile.request('https://m.bilibili.com/search');
  const wbi = new BilibiliClient(delayed, { ...options, initialThrottleState: state });
  await wbi.request('https://api.bilibili.com/x/web-interface/nav');
  assert.deepEqual(waits, [5000]);
});
