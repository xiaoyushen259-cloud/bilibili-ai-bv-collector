import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { containsTerm, evaluateRelevance, flattenKeywordGroups, isWithinWindow, normalizeVideo, parsePlay, shouldSplitWindow } from "../src/core.mjs";
import { buildScanUnits, calculateRateLimitBlock, isRateLimitError, shouldExportExcelAfterScan, splitWindowNewestFirst } from "../app.mjs";
import { buildPartitionDatasets, validateCollectorRules } from "../src/rules.mjs";

const config = JSON.parse(await fs.readFile(new URL("../config.json", import.meta.url), "utf8"));
const group = (label) => config.keywordGroups.find((entry) => entry.label === label);
const ambiguousSdGroup = { label: "SD", queries: ["SD"], matchTerms: ["SD"], ambiguous: true };

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
  const result = evaluateRelevance({ title: "WWE SD 赛事集锦", tag: "摔角,体育", description: "比赛回放" }, ambiguousSdGroup, config);
  assert.equal(result.accepted, false);
});

test("SD 与 AI 上下文共同命中时通过", () => {
  const result = evaluateRelevance({ title: "SD 绘画工作流教程", tag: "扩散模型,AI绘画", description: "ComfyUI 模型分享" }, ambiguousSdGroup, config);
  assert.equal(result.accepted, true);
});

test("Seedance 2.0 别名统一归入 seedance2.0", () => {
  const result = evaluateRelevance({ title: "Seedance 2.0 视频生成实战", tag: "AI视频", description: "" }, group("seedance2.0"), config);
  assert.equal(result.accepted, true);
  assert.equal(result.matchedQuery, "Seedance 2.0");
});

test("搜索词与视频实际命中词可分别配置，并可停用关键词组", () => {
  const customConfig = {
    keywordGroups: [
      { label: "自定义", queries: ["搜索用词"], matchTerms: ["正文命中词"], ambiguous: false },
      { label: "停用", queries: ["不应搜索"], enabled: false, ambiguous: false },
    ],
    aiContextTerms: [],
  };
  assert.equal(evaluateRelevance({ title: "正文命中词教程" }, customConfig.keywordGroups[0], customConfig).accepted, true);
  assert.equal(evaluateRelevance({ title: "只有搜索用词" }, customConfig.keywordGroups[0], customConfig).accepted, false);
  assert.deepEqual(flattenKeywordGroups(customConfig).map((entry) => entry.query), ["搜索用词"]);
});

test("视频可进入多个内容分区，未命中分区规则时进入兜底分区", () => {
  const partitionConfig = {
    keywordGroups: [{ label: "MJ", queries: ["MJ"], ambiguous: false }],
    contentPartitions: [
      { name: "MJ分区", keywordGroups: ["MJ"] },
      { name: "绘画分区", matchTerms: ["midjourney"] },
      { name: "其他AI", fallback: true },
    ],
  };
  validateCollectorRules(partitionConfig);
  const result = buildPartitionDatasets([
    { bvid: "BV1234567890", keywords: "MJ", matched_queries: "midjourney" },
    { bvid: "BV1234567891", keywords: "AI", matched_queries: "AI" },
  ], partitionConfig);
  assert.equal(result.rows[0].content_partitions, "MJ分区、绘画分区");
  assert.equal(result.rows[1].content_partitions, "其他AI");
  assert.deepEqual(result.partitions.map((partition) => partition.rows.length), [1, 1, 1]);
});

test("关键词达到阈值后独立分区，低于阈值时并入相关分区", () => {
  const dynamicConfig = {
    keywordGroups: [
      { label: "agent", queries: ["agent"], partitionName: "Agent分区", mergeInto: "Agent相关分区" },
      { label: "codex", queries: ["codex"], partitionName: "Codex分区", mergeInto: "agent" },
      { label: "MJ", queries: ["MJ"], partitionName: "MJ分区", mergeInto: "AI绘画分区" },
    ],
    partitioning: { minStandaloneVideos: 2, fallbackPartition: "其他AI" },
  };
  const result = buildPartitionDatasets([
    { bvid: "BV1234567890", keywords: "agent", matched_queries: "agent" },
    { bvid: "BV1234567891", keywords: "agent", matched_queries: "agent" },
    { bvid: "BV1234567892", keywords: "codex", matched_queries: "codex" },
    { bvid: "BV1234567893", keywords: "MJ", matched_queries: "MJ" },
  ], dynamicConfig);
  assert.deepEqual(result.partitions.map((partition) => [partition.name, partition.rows.length]), [
    ["Agent分区", 3], ["AI绘画分区", 1],
  ]);
  assert.equal(result.rows[2].content_partitions, "Agent分区");
  assert.equal(result.rows[3].content_partitions, "AI绘画分区");
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

test("ClaudeCode 别名统一归入 Claude Code", () => {
  const result = evaluateRelevance(
    { title: "ClaudeCode 从入门到实战", tag: "AI编程", description: "" },
    group("Claude Code"),
    config,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.matchedQuery, "ClaudeCode");
});

test("首次412暂停12小时，48小时内再次触发暂停24小时", () => {
  const cooldownConfig = {
    rateLimitGlobalCooldownHours: 12,
    rateLimitRepeatCooldownHours: 24,
    rateLimitRepeatWindowHours: 48,
  };
  const first = calculateRateLimitBlock(1000, null, cooldownConfig);
  assert.equal(first.repeated, false);
  assert.equal(first.blockedUntil, 1000 + 12 * 3600);
  const repeated = calculateRateLimitBlock(1000 + 24 * 3600, 1000, cooldownConfig);
  assert.equal(repeated.repeated, true);
  assert.equal(repeated.blockedUntil, 1000 + 48 * 3600);
  const expired = calculateRateLimitBlock(1000 + 49 * 3600, 1000, cooldownConfig);
  assert.equal(expired.repeated, false);
  assert.equal(expired.blockedUntil, 1000 + 61 * 3600);
});

test("生产配置使用12小时计划任务对应的保守采集参数", () => {
  assert.equal(config.incrementalOverlapHours, 14);
  assert.deepEqual([config.requestDelayMinMs, config.requestDelayMaxMs], [30000, 45000]);
  assert.deepEqual([config.keywordCooldownMinMs, config.keywordCooldownMaxMs], [90000, 150000]);
  assert.equal(config.heavyKeywordRequestCount, 10);
  assert.equal(config.heavyKeywordCooldownMs, 600000);
  assert.equal(config.backfillUnitsPerCycle, 3);
  assert.equal(config.maxConsecutiveRateLimitedUnits, 1);
});

test("计划任务只保留一个每12小时运行的B站采集入口", async () => {
  const script = await fs.readFile(new URL("../scripts/install-tasks.ps1", import.meta.url), "utf8");
  assert.match(script, /New-TimeSpan -Hours 12/);
  assert.match(script, /Register-BVTask -TaskName 'BVCollector-Incremental' -TaskArguments @\('cycle'\)/);
  assert.doesNotMatch(script, /Register-BVTask -TaskName 'BVCollector-Daily'/);
  assert.match(script, /Unregister-ScheduledTask -TaskName \$legacyTaskName/);
});

test("自动采集默认不导出 Excel，飞书同步直接读取 SQLite", () => {
  assert.equal(shouldExportExcelAfterScan({}), false);
  assert.equal(shouldExportExcelAfterScan({ excelExportAfterScan: false }), false);
  assert.equal(shouldExportExcelAfterScan({ excelExportAfterScan: true }), true);
});
