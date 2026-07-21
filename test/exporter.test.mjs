import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { exportWorkbook } from "../src/exporter.mjs";

const config = {
  keywordGroups: [{ label: "AI", queries: ["AI"] }],
  contentPartitions: [{ name: "其他AI", fallback: true }],
  minViews: 10000,
  lookbackDays: 90,
};

const rows = [
  {
    bvid: "BV1234567890",
    url: "https://www.bilibili.com/video/BV1234567890",
    title: "AI 视频",
    play: 10000,
    pubdate: Date.parse("2026-07-15T09:43:21Z") / 1000,
    author: "UP主",
    category: "科技",
    keywords: "AI",
    matched_queries: "AI",
    first_qualified_at: Date.parse("2026-07-20T04:18:32Z") / 1000,
    last_checked_at: Date.parse("2026-07-20T04:18:32Z") / 1000,
    relevance_reason: "强关键词命中：AI",
  },
];

test("Excel 和飞书导入使用原始 URL，不写入不兼容的 HYPERLINK 公式", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bv-export-test-"));
  const outputPath = path.join(tempDir, "feishu-compatible.xlsx");
  try {
    await exportWorkbook({ rows, config, outputPath });
    const blob = await FileBlob.load(outputPath);
    const workbook = await SpreadsheetFile.importXlsx(blob);
    const summary = await workbook.inspect({
      kind: "table",
      sheetId: "BV汇总",
      range: "A3:D4",
      include: "values,formulas",
      tableMaxRows: 2,
      tableMaxCols: 4,
      maxChars: 2000,
    });
    const detail = await workbook.inspect({
      kind: "table",
      sheetId: "视频明细",
      range: "A3:M4",
      include: "values,formulas",
      tableMaxRows: 2,
      tableMaxCols: 13,
      maxChars: 3000,
    });
    assert.match(summary.ndjson, /https:\/\/www\.bilibili\.com\/video\/BV1234567890/);
    assert.match(detail.ndjson, /https:\/\/www\.bilibili\.com\/video\/BV1234567890/);
    const detailValues = JSON.parse(detail.ndjson).values;
    const expectedChinaExcelSerial = (
      Date.UTC(2026, 6, 20, 12, 18, 32) - Date.UTC(1899, 11, 30)
    ) / 86400000;
    assert.equal(detailValues[1][3], "其他AI");
    assert.ok(Math.abs(detailValues[1][10] - expectedChinaExcelSerial) < 1e-9);
    assert.doesNotMatch(`${summary.ndjson}\n${detail.ndjson}`, /HYPERLINK|formula/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
