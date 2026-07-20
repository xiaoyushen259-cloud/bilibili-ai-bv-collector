import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { containsTerm, evaluateRelevance, isWithinWindow, normalizeVideo, parsePlay, shouldSplitWindow } from "../src/core.mjs";
import { buildScanUnits, isRateLimitError, shouldExportExcelAfterScan, splitWindowNewestFirst } from "../app.mjs";

const config = JSON.parse(await fs.readFile(new URL("../config.json", import.meta.url), "utf8"));
const group = (label) => config.keywordGroups.find((entry) => entry.label === label);

test("播放量解析和阈值边界", () => {
  assert.equal(parsePlay(9999), 9999);
  assert.equal(parsePlay("1万"), 10000);
  assert.equal(parsePlay("1.2万"), 12000);
  assert.equal(parsePlay("--"), 0);
});

test("滚动窗口边界包含起止秒", () => {
  assert.equal(isWithinWindow(100, 100, 200), true);
  assert.equal(isWithinWindow(200, 100, 200), true);
  assert.equal(isWithinWindow(99, 100, 200), false);
});

test("AI/MJ/SD 使用英文边界", () => {
  assert.equal(containsTerm("AI 工具", "AI"), true);
  assert.equal(containsTerm("paid tutorial", "AI"), false);
  assert.equal(containsTerm("WWE SD 赛事", "SD"), true);
  assert.equal(containsTerm("SDXL model", "SD"), false);
});

test("WWE SD 被平衡过滤拒绝", () => {
  const result = evaluateRelevance({ title: "WWE SD 赛事集锦", tag: "摔角,体育", description: "比赛回放" }, group("SD"), config);
  assert.equal(result.accepted, false);
});

test("SD 与 AI 上下文共同命中时通过", () => {
  const result = evaluateRelevance({ title: "SD 绘画工作流教程", tag: "扩散模型,AI绘画", description: "ComfyUI 模型分享" }, group("SD"), config);
  assert.equal(result.accepted, true);
});

test("Claude Code 别名统一归入 cloudecode", () => {
  const result = evaluateRelevance({ title: "Claude Code 从入门到实战", tag: "AI编程", description: "" }, group("cloudecode"), config);
  assert.equal(result.accepted, true);
  assert.equal(result.matchedQuery, "Claude Code");
});

test("视频字段清洗和规范化链接", () => {
  const video = normalizeVideo({ bvid: "BV1234567890", title: "<em>AI</em> &amp; Codex", play: "2万", pubdate: 123, author: "UP" });
  assert.equal(video.title, "AI & Codex");
  assert.equal(video.play, 20000);
  assert.equal(video.url, "https://www.bilibili.com/video/BV1234567890");
});

test("仅在接口饱和且末页仍全部达标时拆分", () => {
  assert.equal(shouldSplitWindow({ numPages: 50, lastPageItems: [{ play: 10000 }, { play: 12000 }], minViews: 10000, startTs: 0, endTs: 3600, minSplitMinutes: 5, depth: 0, maxSplitDepth: 18 }), true);
  assert.equal(shouldSplitWindow({ numPages: 50, lastPageItems: [{ play: 9999 }], minViews: 10000, startTs: 0, endTs: 3600, minSplitMinutes: 5, depth: 0, maxSplitDepth: 18 }), false);
});

test("全量扫描按最新到最旧的24小时时间片建立可恢复单元", () => {
  const segments = splitWindowNewestFirst(0, 172800, 24);
  assert.deepEqual(segments, [
    { startTs: 86401, endTs: 172800 },
    { startTs: 1, endTs: 86400 },
    { startTs: 0, endTs: 0 },
  ]);
  const units = buildScanUnits(
    "full",
    [{ label: "AI", query: "AI" }, { label: "GPT", query: "GPT" }],
    { start_ts: 0, end_ts: 172800 },
    { fullSegmentHours: 24 },
  );
  assert.equal(units.length, 6);
  assert.deepEqual(units.map((unit) => unit.query), ["AI", "GPT", "AI", "GPT", "AI", "GPT"]);
});

test("生产配置的90天窗口按7天片段压缩主扫描单元", () => {
  const endTs = 90 * 86400;
  const units = buildScanUnits(
    "full",
    [{ label: "AI", query: "AI" }],
    { start_ts: 0, end_ts: endTs },
    config,
  );
  assert.equal(config.fullSegmentHours, 168);
  assert.equal(units.length, 13);
  assert.equal(units[0].endTs, endTs);
  assert.equal(units.at(-1).startTs, 0);
});

test("仅将B站412和v_voucher识别为可延期限流", () => {
  assert.equal(isRateLimitError(new Error("HTTP 412: request was banned")), true);
  assert.equal(isRateLimitError(new Error("B站接口返回结构异常 v_voucher")), true);
  assert.equal(isRateLimitError(new Error("HTTP 500")), false);
});

test("自动采集默认不导出 Excel，飞书同步直接读取 SQLite", () => {
  assert.equal(shouldExportExcelAfterScan({}), false);
  assert.equal(shouldExportExcelAfterScan({ excelExportAfterScan: false }), false);
  assert.equal(shouldExportExcelAfterScan({ excelExportAfterScan: true }), true);
});
