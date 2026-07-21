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
  assert.equal(typeof matrix[1][4], "number");
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
  assert.equal(writes[0].body.valueRange.range, "tab1!A1:M2");
  assert.equal(writes[0].body.valueRange.values[1][0], "BV1234567892");
  assert.equal(writes[2].body.valueRange.range, "tab1!A5:M5");
  assert.deepEqual(writes[2].body.valueRange.values, [new Array(13).fill("")]);
  assert.equal(calls.some((call) => call.url.endsWith("values_batch_clear")), false);
  assert.equal(result.firstBvid, "BV1234567892");
});

test("飞书旧行统计忽略接口返回的空白尾行", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
      return response({ code: 0, tenant_access_token: "token" });
    }
    return response({ code: 0, data: { valueRange: { values: [
      ["BV号"], ["BV1234567890"], [], [""], [],
    ] } } });
  };
  const client = new FeishuSheetsClient({
    appId: "app", appSecret: "secret", spreadsheetToken: "token", clearUntilRow: 20000,
  }, { fetchImpl });
  assert.equal(await client.readRowCount("tab1"), 2);
});

test("飞书同步自动创建并写入独立内容分区工作表", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
      return response({ code: 0, tenant_access_token: "token" });
    }
    if (url.includes("/sheets/query")) {
      return response({ code: 0, data: { sheets: [
        { sheet_id: "main", title: "全部视频", index: 0 },
        { sheet_id: "mj-tab", title: "MJ分区", index: 1 },
        { sheet_id: "legacy-tab", title: "SD分区", index: 2 },
      ] } });
    }
    if (url.endsWith("/sheets_batch_update")) {
      if (body.requests[0].deleteSheet) return response({ code: 0, data: { replies: [] } });
      return response({ code: 0, data: { replies: [{ addSheet: { properties: {
        sheetId: "agent-tab", title: body.requests[0].addSheet.properties.title, index: 2,
      } } }] } });
    }
    if (options.method === "GET" && url.includes("/values/")) {
      return response({ code: 0, data: { valueRange: { values: [] } } });
    }
    return response({ code: 0, data: {} });
  };
  const settings = {
    appId: "app", appSecret: "secret", spreadsheetToken: "sheet-token", sheetId: "main",
    sheetUrl: "https://example.feishu.cn/sheets/sheet-token?sheet=main", batchRows: 200, clearUntilRow: 1000,
  };
  const client = new FeishuSheetsClient(settings, { fetchImpl, sleepImpl: async () => {} });
  const row = {
    bvid: "BV1234567890", url: "https://www.bilibili.com/video/BV1234567890", title: "A",
    content_partitions: "MJ分区、Agent分区", play: 10000, pubdate: 100, author: "A", category: "科技",
    keywords: "MJ、agent", matched_queries: "MJ、agent", first_qualified_at: 1000,
    last_checked_at: 1000, relevance_reason: "AI",
  };
  const result = await client.sync([row], {
    partitions: [
      { name: "MJ分区", rows: [row] },
      { name: "Agent分区", rows: [row] },
    ],
    managedPartitionNames: ["MJ分区", "Agent分区", "SD分区"],
  });
  const batchCalls = calls.filter((call) => call.url.endsWith("/sheets_batch_update"));
  const addCalls = batchCalls.filter((call) => call.body.requests[0].addSheet);
  const deleteCalls = batchCalls.filter((call) => call.body.requests[0].deleteSheet);
  const writes = calls.filter((call) => call.options.method === "PUT");
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0].body.requests[0].addSheet.properties.title, "Agent分区");
  assert.deepEqual(writes.map((call) => call.body.valueRange.range), [
    "main!A1:M2", "mj-tab!A1:M2", "agent-tab!A1:M2",
  ]);
  assert.deepEqual(result.partitions.map((partition) => [partition.name, partition.rowCount]), [
    ["MJ分区", 1], ["Agent分区", 1],
  ]);
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].body.requests[0].deleteSheet.sheetId, "legacy-tab");
  assert.deepEqual(result.removedPartitions, ["SD分区"]);
});
