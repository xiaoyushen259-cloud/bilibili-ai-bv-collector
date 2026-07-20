import test from "node:test";
import assert from "node:assert/strict";
import { buildFeishuMatrix, FeishuSheetsClient, parseFeishuSheetUrl } from "../src/feishu.mjs";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test("解析飞书电子表格链接中的 token 和 sheet id", () => {
  assert.deepEqual(
    parseFeishuSheetUrl("https://example.feishu.cn/sheets/sht123?sheet=abc789"),
    { spreadsheetToken: "sht123", sheetId: "abc789" },
  );
  assert.throws(() => parseFeishuSheetUrl("https://example.feishu.cn/docx/doc123"), /电子表格链接/);
});

test("飞书矩阵按首次收集时间倒序并保留播放量数值", () => {
  const matrix = buildFeishuMatrix([
    { bvid: "BV1234567890", url: "https://www.bilibili.com/video/BV1234567890", title: "旧", play: 20000, pubdate: 100, author: "A", category: "科技", keywords: "AI", first_qualified_at: 1000, last_checked_at: 1200, relevance_reason: "AI" },
    { bvid: "BV1234567891", url: "https://www.bilibili.com/video/BV1234567891", title: "新", play: 10000, pubdate: 200, author: "B", category: "科技", keywords: "GPT", first_qualified_at: 2000, last_checked_at: 2200, relevance_reason: "GPT" },
  ]);
  assert.equal(matrix[1][0], "BV1234567891");
  assert.equal(matrix[2][0], "BV1234567890");
  assert.equal(typeof matrix[1][3], "number");
});

test("飞书同步分批写入并在成功后清理旧尾行", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
      return response({ code: 0, tenant_access_token: "token" });
    }
    if (options.method === "GET" && url.includes("/values/")) {
      return response({
        code: 0,
        data: { valueRange: { values: [["BV号"], ["旧1"], ["旧2"], ["旧3"], ["旧4"]] } },
      });
    }
    return response({ code: 0, data: {} });
  };
  const settings = {
    appId: "app", appSecret: "secret", spreadsheetToken: "sheet-token", sheetId: "tab1",
    sheetUrl: "https://example.feishu.cn/sheets/sheet-token?sheet=tab1", batchRows: 2, clearUntilRow: 1000,
  };
  const client = new FeishuSheetsClient(settings, { fetchImpl, sleepImpl: async () => {} });
  const rows = [
    { bvid: "BV1234567890", url: "https://www.bilibili.com/video/BV1234567890", title: "A", play: 10000, pubdate: 100, author: "A", category: "科技", keywords: "AI", first_qualified_at: 1000, last_checked_at: 1000, relevance_reason: "AI" },
    { bvid: "BV1234567891", url: "https://www.bilibili.com/video/BV1234567891", title: "B", play: 20000, pubdate: 200, author: "B", category: "科技", keywords: "GPT", first_qualified_at: 2000, last_checked_at: 2000, relevance_reason: "GPT" },
    { bvid: "BV1234567892", url: "https://www.bilibili.com/video/BV1234567892", title: "C", play: 30000, pubdate: 300, author: "C", category: "科技", keywords: "Codex", first_qualified_at: 3000, last_checked_at: 3000, relevance_reason: "Codex" },
  ];
  const result = await client.sync(rows);
  const writes = calls.filter((call) => call.options.method === "PUT");
  assert.equal(writes.length, 3);
  assert.equal(writes[0].body.valueRange.range, "tab1!A1:K2");
  assert.equal(writes[0].body.valueRange.values[1][0], "BV1234567892");
  assert.equal(writes[2].body.valueRange.range, "tab1!A5:K5");
  assert.deepEqual(writes[2].body.valueRange.values, [new Array(11).fill("")]);
  assert.equal(calls.some((call) => call.url.endsWith("values_batch_clear")), false);
  assert.equal(result.firstBvid, "BV1234567892");
});
