import test from "node:test";
import assert from "node:assert/strict";
import { BilibiliClient, parseCurlJsonOutput } from "../src/bilibili.mjs";

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

const baseConfig = {
  requestDelayMinMs: 0,
  requestDelayMaxMs: 0,
  requestTimeoutMs: 1000,
  maxRetries: 1,
  maxRateLimitRetries: 0,
  rateLimitCooldownMs: 0,
  emptyResultConfirmations: 1,
  emptyResultDelayMs: 0,
  minSplitMinutes: 5,
  maxSplitDepth: 8,
};

test("遇到低于阈值的页面后停止分页", async () => {
  const pages = [];
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    const items = page === 1
      ? [{ bvid: "BV1234567890", play: 20000 }, { bvid: "BV1234567891", play: 15000 }]
      : [{ bvid: "BV1234567892", play: 10000 }, { bvid: "BV1234567893", play: 9999 }];
    return response({ code: 0, data: { result: items, numPages: 10, numResults: 200 } });
  };
  const client = new BilibiliClient(baseConfig, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  const seen = [];
  await client.scanThresholdWindow({ keyword: "AI", startTs: 0, endTs: 1000, minViews: 10000, onItems: async (items) => seen.push(...items) });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(seen.length, 3);
});

test("接口1000条封顶且末页仍达标时拆分窗口", async () => {
  const windows = new Set();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("pubtime_begin_s"));
    const end = Number(parsed.searchParams.get("pubtime_end_s"));
    const page = Number(parsed.searchParams.get("page"));
    windows.add(`${start}-${end}`);
    const wide = end - start > 600;
    const items = wide
      ? [{ bvid: `BV${String(start).padStart(10, "0").slice(-10)}`, play: 20000 }]
      : page === 1
        ? [{ bvid: `BV${String(start + 1).padStart(10, "0").slice(-10)}`, play: 12000 }, { bvid: `BV${String(start + 2).padStart(10, "0").slice(-10)}`, play: 9000 }]
        : [];
    return response({ code: 0, data: { result: items, numPages: wide ? 50 : 1, numResults: wide ? 1000 : items.length } });
  };
  const client = new BilibiliClient(baseConfig, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  await client.scanThresholdWindow({ keyword: "AI", startTs: 0, endTs: 2000, minViews: 10000, onItems: async () => {} });
  assert.ok(windows.size > 1);
});

test("临时HTTP错误会重试", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) return response({}, 429);
    return response({ code: 0, data: { result: [], numPages: 0, numResults: 0 } });
  };
  const client = new BilibiliClient(baseConfig, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  await client.search({ keyword: "AI", order: "click", page: 1, startTs: 0, endTs: 1 });
  assert.equal(attempts, 2);
});

test("零结果时允许 data.result 为 null", async () => {
  const fetchImpl = async () => response({ code: 0, data: { result: null, numPages: 0, numResults: 0 } });
  const client = new BilibiliClient(baseConfig, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  const result = await client.search({ keyword: "coze", order: "click", page: 1, startTs: 0, endTs: 1 });
  assert.deepEqual(result.items, []);
});

test("第一页空结果可按配置重复确认", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return response({ code: 0, data: { result: null, numPages: 0, numResults: 0 } });
  };
  const client = new BilibiliClient({ ...baseConfig, emptyResultConfirmations: 3 }, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  await client.search({ keyword: "rare", order: "click", page: 1, startTs: 0, endTs: 1 });
  assert.equal(attempts, 3);
});

test("只有 v_voucher 的伪成功响应不得当作空结果", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) return response({ code: 0, data: { v_voucher: "blocked" } });
    return response({ code: 0, data: { result: [], numPages: 0, numResults: 0 } });
  };
  const client = new BilibiliClient({ ...baseConfig, maxRetries: 1, maxRateLimitRetries: 1 }, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  const result = await client.search({ keyword: "codex", order: "click", page: 1, startTs: 0, endTs: 1 });
  assert.equal(attempts, 2);
  assert.deepEqual(result.items, []);
});

test("curl 的 HTML 412 响应会保留状态码供限流恢复", () => {
  assert.throws(
    () => parseCurlJsonOutput("<html>blocked</html>\n__HTTP_STATUS__:412"),
    /HTTP 412/,
  );
});
