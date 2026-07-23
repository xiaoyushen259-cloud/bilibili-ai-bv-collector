import test from "node:test";
import assert from "node:assert/strict";
import { BilibiliClient, buildMixinKey, signWbiParams } from "../src/bilibili.mjs";

function response(data, status = 200, setCookies = []) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => setCookies, get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function mockBilibili(searchHandler, calls = []) {
  return async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.hostname === "www.bilibili.com") {
      return response("<html></html>", 200, ["buvid3=anonymous-test-id; Path=/; Domain=.bilibili.com", "b_nut=1; Path=/"]);
    }
    if (parsed.pathname === "/x/frontend/finger/spi") {
      return response({
        code: 0,
        data: {
          b_3: "spi-anonymous-test-id",
          b_4: "spi-anonymous-test-id-4",
        },
      });
    }
    if (parsed.pathname === "/x/web-interface/nav") {
      return response({
        code: 0,
        data: {
          wbi_img: {
            img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
            sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
          },
        },
      });
    }
    return searchHandler(url, options);
  };
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
  const fetchImpl = mockBilibili(async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    const items = page === 1
      ? [{ bvid: "BV1234567890", play: 20000 }, { bvid: "BV1234567891", play: 15000 }]
      : [{ bvid: "BV1234567892", play: 10000 }, { bvid: "BV1234567893", play: 9999 }];
    return response({ code: 0, data: { result: items, numPages: 10, numResults: 200 } });
  });
  const client = new BilibiliClient(baseConfig, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  const seen = [];
  await client.scanThresholdWindow({ keyword: "AI", startTs: 0, endTs: 1000, minViews: 10000, onItems: async (items) => seen.push(...items) });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(seen.length, 3);
});

test("接口1000条封顶且末页仍达标时拆分窗口", async () => {
  const windows = new Set();
  const fetchImpl = mockBilibili(async (url) => {
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
  });
  const client = new BilibiliClient(baseConfig, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  await client.scanThresholdWindow({ keyword: "AI", startTs: 0, endTs: 2000, minViews: 10000, onItems: async () => {} });
  assert.ok(windows.size > 1);
});

test("临时HTTP错误会重试", async () => {
  let attempts = 0;
  const fetchImpl = mockBilibili(async () => {
    attempts += 1;
    if (attempts === 1) return response({}, 429);
    return response({ code: 0, data: { result: [], numPages: 0, numResults: 0 } });
  });
  const client = new BilibiliClient(baseConfig, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  await client.search({ keyword: "AI", order: "click", page: 1, startTs: 0, endTs: 1 });
  assert.equal(attempts, 2);
});

test("零结果时允许 data.result 为 null", async () => {
  const fetchImpl = mockBilibili(async () => response({ code: 0, data: { result: null, numPages: 0, numResults: 0 } }));
  const client = new BilibiliClient(baseConfig, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  const result = await client.search({ keyword: "coze", order: "click", page: 1, startTs: 0, endTs: 1 });
  assert.deepEqual(result.items, []);
});

test("第一页空结果可按配置重复确认", async () => {
  let attempts = 0;
  const fetchImpl = mockBilibili(async () => {
    attempts += 1;
    return response({ code: 0, data: { result: null, numPages: 0, numResults: 0 } });
  });
  const client = new BilibiliClient({ ...baseConfig, emptyResultConfirmations: 3 }, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  await client.search({ keyword: "rare", order: "click", page: 1, startTs: 0, endTs: 1 });
  assert.equal(attempts, 3);
});

test("只有 v_voucher 的伪成功响应不得当作空结果", async () => {
  let attempts = 0;
  const fetchImpl = mockBilibili(async () => {
    attempts += 1;
    if (attempts === 1) return response({ code: 0, data: { v_voucher: "blocked" } });
    return response({ code: 0, data: { result: [], numPages: 0, numResults: 0 } });
  });
  const client = new BilibiliClient({ ...baseConfig, maxRetries: 1, maxRateLimitRetries: 1 }, { fetchImpl, sleepImpl: async () => {}, random: () => 0 });
  const result = await client.search({ keyword: "codex", order: "click", page: 1, startTs: 0, endTs: 1 });
  assert.equal(attempts, 2);
  assert.deepEqual(result.items, []);
});

test("WBI 参数签名与公开算法样例一致", () => {
  const imgKey = "7cd084941338484aae1ad9425b84077c";
  const subKey = "4932caff0ff746eab6f01bf08b70ac45";
  assert.equal(buildMixinKey(imgKey, subKey), "ea1db124af3c7062474693fa704f4ff8");
  const signed = signWbiParams(
    { foo: "114", bar: "514", zab: "1919810" },
    imgKey,
    subKey,
    1702204169000,
  );
  assert.equal(signed.query, "bar=514&foo=114&wts=1702204169&zab=1919810");
  assert.equal(signed.wRid, "8f6f2b5b3d485fe1886cec6a0be8c5d4");
});

test("匿名 Cookie 仅在进程内传给 WBI 导航和搜索请求", async () => {
  const calls = [];
  const fetchImpl = mockBilibili(
    async () => response({ code: 0, data: { result: [], numPages: 0, numResults: 0 } }),
    calls,
  );
  const client = new BilibiliClient(baseConfig, {
    fetchImpl,
    sleepImpl: async () => {},
    random: () => 0,
    nowImpl: () => 1702204169000,
  });
  await client.search({ keyword: "Claude Code", order: "click", page: 1, startTs: 1, endTs: 2 });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].url.pathname, "/");
  assert.equal(calls[1].url.pathname, "/x/frontend/finger/spi");
  assert.equal(calls[2].url.pathname, "/x/web-interface/nav");
  assert.equal(calls[3].url.pathname, "/x/web-interface/wbi/search/type");
  assert.match(calls[2].options.headers.Cookie, /buvid3=spi-anonymous-test-id/);
  assert.match(calls[2].options.headers.Cookie, /buvid4=spi-anonymous-test-id-4/);
  assert.match(calls[3].options.headers.Cookie, /buvid3=spi-anonymous-test-id/);
  assert.match(calls[3].options.headers["User-Agent"], /Chrome\/136/);
  assert.equal(calls[3].options.headers.Referer, "https://search.bilibili.com/");
  assert.equal(calls[3].url.searchParams.get("wts"), "1702204169");
  assert.match(calls[3].url.searchParams.get("w_rid"), /^[0-9a-f]{32}$/);
  assert.equal(client.requestCount, 4);
});

test("匿名导航返回 -101 但包含 WBI 密钥时仍可搜索", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.hostname === "www.bilibili.com") {
      return response("<html></html>", 200, ["buvid3=anonymous-test-id; Path=/; Domain=.bilibili.com"]);
    }
    if (parsed.pathname === "/x/frontend/finger/spi") {
      return response({
        code: 0,
        data: {
          b_3: "spi-anonymous-test-id",
          b_4: "spi-anonymous-test-id-4",
        },
      });
    }
    if (parsed.pathname === "/x/web-interface/nav") {
      return response({
        code: -101,
        message: "账号未登录",
        data: {
          isLogin: false,
          wbi_img: {
            img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
            sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
          },
        },
      });
    }
    return response({ code: 0, data: { result: [], numPages: 0, numResults: 0 } });
  };
  const client = new BilibiliClient(baseConfig, {
    fetchImpl,
    sleepImpl: async () => {},
    random: () => 0,
    nowImpl: () => 1702204169000,
  });

  const result = await client.search({
    keyword: "agent",
    order: "click",
    page: 1,
    startTs: 1,
    endTs: 2,
  });

  assert.deepEqual(result.items, []);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].url.pathname, "/x/web-interface/nav");
  assert.equal(calls[3].url.pathname, "/x/web-interface/wbi/search/type");
});

test("首页与匿名指纹接口都未返回 buvid3 时停止，不继续请求 WBI 接口", async () => {
  let calls = 0;
  const client = new BilibiliClient(baseConfig, {
    fetchImpl: async (url) => {
      calls += 1;
      if (new URL(url).pathname === "/x/frontend/finger/spi") {
        return response({ code: 0, data: {} });
      }
      return response("<html></html>");
    },
    sleepImpl: async () => {},
  });
  await assert.rejects(
    client.search({ keyword: "AI", order: "click", page: 1, startTs: 1, endTs: 2 }),
    /未返回 buvid3/,
  );
  assert.equal(calls, 2);
});

test("WBI fetch 的 HTML 412 会原样交给全局长冷却逻辑", async () => {
  let searchCalls = 0;
  const client = new BilibiliClient(baseConfig, {
    fetchImpl: mockBilibili(async () => {
      searchCalls += 1;
      return response("<html>blocked</html>", 412);
    }),
    sleepImpl: async () => {},
  });
  await assert.rejects(
    client.search({ keyword: "AI", order: "click", page: 1, startTs: 1, endTs: 2 }),
    /HTTP 412/,
  );
  assert.equal(searchCalls, 1);
});
