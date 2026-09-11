import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { containsTerm, evaluateRelevance, flattenKeywordGroups, isWithinWindow, normalizeVideo, parsePlay, shouldSplitWindow } from "../src/core.mjs";
import {
  buildScanUnits,
  calculateRateLimitBlock,
  isRateLimitError,
  randomizeQueriesForSegment,
  shouldExportExcelAfterScan,
  splitWindowNewestFirst,
} from "../app.mjs";
import { activeKeywordGroups, buildFeishuWindowedDatasets, buildPartitionDatasets, validateCollectorRules } from "../src/rules.mjs";

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

test("Seedance 2.0 别名统一归入 Seedance", () => {
  const result = evaluateRelevance({ title: "Seedance 2.0 视频生成实战", tag: "AI视频", description: "" }, group("Seedance"), config);
  assert.equal(result.accepted, true);
  assert.equal(result.matchedQuery, "Seedance 2.0");
});

test("细分关键词必须同时出现配置的课程上下文", () => {
  const comfyFlux = group("ComfyUI-Flux");
  const unrelated = evaluateRelevance(
    { title: "Flux 建筑焊接工艺", tag: "工业", description: "" },
    comfyFlux,
    config,
  );
  const relevant = evaluateRelevance(
    { title: "ComfyUI Flux.1 工作流完整教程", tag: "AI绘画", description: "" },
    comfyFlux,
    config,
  );
  assert.equal(unrelated.accepted, false);
  assert.match(unrelated.reason, /缺少课程上下文/);
  assert.equal(relevant.accepted, true);
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

test("生产配置固定映射为五门课程且每个细分组都有归属", () => {
  validateCollectorRules(config);
  assert.deepEqual(
    config.contentPartitions.map((partition) => partition.name),
    ["Midjourney", "ComfyUI", "Agent", "AI视频", "Stable Diffusion"],
  );
  const mappedGroups = new Set(config.contentPartitions.flatMap((partition) => partition.keywordGroups));
  assert.deepEqual(
    activeKeywordGroups(config).map((entry) => entry.label).filter((label) => !mappedGroups.has(label)),
    [],
  );
  assert.ok(flattenKeywordGroups(config).length >= 200);

  const result = buildPartitionDatasets([
    { bvid: "BV1234567890", keywords: "ComfyUI-Flux", matched_queries: "Flux" },
    { bvid: "BV1234567891", keywords: "codex", matched_queries: "codex" },
    { bvid: "BV1234567892", keywords: "Grok视频", matched_queries: "Grok" },
    { bvid: "BV1234567893", keywords: "Forge", matched_queries: "Forge" },
    { bvid: "BV1234567894", keywords: "niji", matched_queries: "Niji" },
  ], config);
  assert.deepEqual(
    result.rows.map((row) => row.content_partitions),
    ["ComfyUI", "Agent", "AI视频", "Stable Diffusion", "Midjourney"],
  );
  assert.equal(result.partitions.length, 5);
  assert.ok(result.managedPartitionNames.includes("Codex分区"));
});

test("扩展关键词仍保留 Seedance 2.0 精确搜索词且不退回裸词", () => {
  const seedance = group("Seedance");
  assert.ok(seedance.queries.includes("Seedance 2.0"));
  assert.ok(seedance.queries.includes("Seedance2.0"));
  assert.ok(!seedance.queries.includes("Seedance"));
  assert.ok(seedance.legacyLabels.includes("seedance2.0"));
});

test("固定课程分区保留超过目标数量的全部数据", () => {
  const partitionConfig = {
    courseTargetCount: 2,
    keywordGroups: [{ label: "codex", queries: ["codex"] }],
    contentPartitions: [{ name: "Agent", keywordGroups: ["codex"] }],
  };
  const rows = Array.from({ length: 3 }, (_, index) => ({
    bvid: `BV123456789${index}`,
    keywords: "codex",
    matched_queries: "codex",
  }));
  const result = buildPartitionDatasets(rows, partitionConfig);
  assert.equal(result.partitions[0].rows.length, 3);
  assert.equal(result.partitions[0].totalRowCount, 3);
  assert.equal(result.partitions[0].targetCount, 2);
});

test("飞书主分区只保留最新记录，其余进入历史归档且不重复", () => {
  const rows = [
    { bvid: "BV1234567890", first_qualified_at: 100, play: 10000, content_partitions: "Agent" },
    { bvid: "BV1234567891", first_qualified_at: 200, play: 20000, content_partitions: "Agent" },
    { bvid: "BV1234567892", first_qualified_at: 300, play: 30000, content_partitions: "Agent" },
  ];
  const result = buildFeishuWindowedDatasets({
    rows,
    partitions: [{ name: "Agent", rows }],
    managedPartitionNames: ["Agent"],
  }, { limit: 2, archiveName: "历史归档" });
  assert.deepEqual(result.partitions[0].rows.map((row) => row.bvid), ["BV1234567892", "BV1234567891"]);
  assert.deepEqual(result.partitions[1].rows.map((row) => row.bvid), ["BV1234567890"]);
  assert.deepEqual(result.rows.map((row) => row.bvid), ["BV1234567892", "BV1234567891"]);
  assert.ok(result.managedPartitionNames.includes("历史归档"));
});

test("飞书当前分区之间不重复使用同一 BV", () => {
  const shared = { bvid: "BV1234567890", first_qualified_at: 300, play: 30000 };
  const agentOnly = { bvid: "BV1234567891", first_qualified_at: 200, play: 20000 };
  const videoOnly = { bvid: "BV1234567892", first_qualified_at: 100, play: 10000 };
  const result = buildFeishuWindowedDatasets({
    rows: [shared, agentOnly, videoOnly],
    partitions: [
      { name: "Agent", rows: [shared, agentOnly] },
      { name: "AI视频", rows: [shared, videoOnly] },
    ],
    managedPartitionNames: [],
  }, { limit: 1 });
  assert.deepEqual(result.partitions[0].rows.map((row) => row.bvid), [shared.bvid]);
  assert.deepEqual(result.partitions[1].rows.map((row) => row.bvid), [videoOnly.bvid]);
  assert.equal(new Set(result.rows.map((row) => row.bvid)).size, 2);
});

test("高风险标题不会进入飞书当前分区但会保留在历史归档", () => {
  const safe = { bvid: "BV1234567890", title: "AI 有趣短片", first_qualified_at: 100, play: 10000 };
  const risky = { bvid: "BV1234567891", title: "NSFW 破限制教程", first_qualified_at: 200, play: 20000 };
  const result = buildFeishuWindowedDatasets({
    rows: [safe, risky],
    partitions: [{ name: "AI视频", rows: [safe, risky] }],
    managedPartitionNames: ["AI视频"],
  }, { limit: 2, blockedTitleTerms: ["NSFW", "破限制"] });
  assert.deepEqual(result.partitions[0].rows.map((row) => row.bvid), [safe.bvid]);
  assert.deepEqual(result.partitions[1].rows.map((row) => row.bvid), [risky.bvid]);
});

test("固定课程分区不能引用不存在的细分关键词组", () => {
  assert.throws(() => validateCollectorRules({
    keywordGroups: [{ label: "codex", queries: ["codex"] }],
    contentPartitions: [{ name: "Agent", keywordGroups: ["codex", "不存在"] }],
  }), /引用了不存在或已停用的关键词组/);
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

test("全量扫描按最新到最旧的24小时时间片建立可恢复随机单元", () => {
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
  for (let segmentIndex = 0; segmentIndex < 3; segmentIndex += 1) {
    const segmentQueries = units
      .filter((unit) => unit.segmentIndex === segmentIndex)
      .map((unit) => unit.query)
      .sort();
    assert.deepEqual(segmentQueries, ["AI", "GPT"]);
  }
});

test("同一时间片的关键词组顺序稳定随机且组内别名连续不重复", () => {
  const queries = [
    { label: "agent", query: "agent" },
    { label: "Claude Code", query: "Claude Code" },
    { label: "Claude Code", query: "ClaudeCode" },
    { label: "GPT", query: "GPT" },
    { label: "comfyui", query: "comfyui" },
    { label: "midjourney", query: "midjourney" },
  ];
  const job = { id: 42, start_ts: 0, end_ts: 172800 };
  const newest = { startTs: 86401, endTs: 172800 };
  const older = { startTs: 1, endTs: 86400 };

  const firstOrder = randomizeQueriesForSegment(queries, job, newest, 0);
  const resumedOrder = randomizeQueriesForSegment(queries, job, newest, 0);
  const nextSegmentOrder = randomizeQueriesForSegment(queries, job, older, 1);

  assert.deepEqual(resumedOrder, firstOrder);
  assert.notDeepEqual(nextSegmentOrder, firstOrder);
  assert.deepEqual(
    firstOrder.map((entry) => entry.query).sort(),
    queries.map((entry) => entry.query).sort(),
  );
  const claudeIndex = firstOrder.findIndex((entry) => entry.query === "Claude Code");
  assert.equal(firstOrder[claudeIndex + 1].query, "ClaudeCode");
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
  assert.equal(config.courseLibraryLookbackDays, 90);
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
  assert.equal(config.heavyKeywordRequestCount, 6);
  assert.equal(config.heavyKeywordCooldownMs, 600000);
  assert.equal(config.wbiKeyCacheHours, 6);
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
