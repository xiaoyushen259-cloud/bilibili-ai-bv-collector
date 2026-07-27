import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BilibiliClient } from "./src/bilibili.mjs";
import { CollectorDatabase } from "./src/db.mjs";
import { evaluateRelevance, flattenKeywordGroups, isWithinWindow, normalizeVideo } from "./src/core.mjs";
import { exportWorkbook } from "./src/exporter.mjs";
import { buildFeishuMatrix, FeishuSheetsClient, loadFeishuSettings } from "./src/feishu.mjs";
import { activeKeywordGroups, buildPartitionDatasets, validateCollectorRules } from "./src/rules.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "config.json");
const DATA_DIR = path.join(ROOT, "data");
const LOG_DIR = path.join(ROOT, "logs");
const OUTPUT_DIR = path.join(ROOT, "output");
const QA_DIR = path.join(ROOT, "qa");
const DB_PATH = path.join(DATA_DIR, "collector.sqlite");
const LOCK_PATH = path.join(DATA_DIR, "collector.lock");
const FEISHU_CONFIG_PATH = path.join(DATA_DIR, "feishu-config.json");
const BILIBILI_BLOCKED_UNTIL_KEY = "bilibili_blocked_until";
const BILIBILI_LAST_RATE_LIMIT_AT_KEY = "bilibili_last_rate_limit_at";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chinaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function chinaDateString(date = new Date()) {
  const parts = chinaDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function chinaMidnightEpoch(date = new Date()) {
  const parts = chinaDateParts(date);
  return Math.floor(Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`) / 1000);
}

function lastCompletedWeek(now = new Date()) {
  const todayMidnight = chinaMidnightEpoch(now);
  const chinaDay = new Date((todayMidnight + 8 * 3600) * 1000).getUTCDay();
  const daysSinceMonday = (chinaDay + 6) % 7;
  const currentMonday = todayMidnight - daysSinceMonday * 86400;
  const start = currentMonday - 7 * 86400;
  return { start, end: currentMonday };
}

async function loadConfig() {
  return validateCollectorRules(JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")));
}

async function ensureDirectories() {
  await Promise.all([
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(LOG_DIR, { recursive: true }),
    fs.mkdir(OUTPUT_DIR, { recursive: true }),
    fs.mkdir(path.join(OUTPUT_DIR, "周报"), { recursive: true }),
    fs.mkdir(QA_DIR, { recursive: true }),
  ]);
}

async function log(message, level = "INFO") {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  await fs.appendFile(path.join(LOG_DIR, `${chinaDateString()}.log`), line, "utf8");
  process.stdout.write(line);
}

async function pruneLogs(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400_000;
  for (const entry of await fs.readdir(LOG_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const target = path.join(LOG_DIR, entry.name);
    const stat = await fs.stat(target);
    if (stat.mtimeMs < cutoff) await fs.rm(target, { force: true });
  }
}

async function acquireLock(config) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const handle = await fs.open(LOCK_PATH, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return async () => {
      await handle.close();
      await fs.rm(LOCK_PATH, { force: true });
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.stat(LOCK_PATH);
    let ownerAlive = false;
    try {
      const owner = JSON.parse(await fs.readFile(LOCK_PATH, "utf8"));
      if (Number.isInteger(owner.pid) && owner.pid > 0) {
        process.kill(owner.pid, 0);
        ownerAlive = true;
      }
    } catch {
      ownerAlive = false;
    }
    if (!ownerAlive || Date.now() - stat.mtimeMs > config.lockStaleMinutes * 60_000) {
      await fs.rm(LOCK_PATH, { force: true });
      return acquireLock(config);
    }
    const busyError = new Error("已有采集任务正在运行，本次任务已安全退出");
    busyError.code = "LOCK_BUSY";
    throw busyError;
  }
}

function makeJobWindow(mode, config, endTs = nowSeconds()) {
  if (mode === "incremental") {
    return { startTs: endTs - config.incrementalOverlapHours * 3600, endTs };
  }
  return { startTs: endTs - config.lookbackDays * 86400, endTs };
}

function splitWindowNewestFirst(startTs, endTs, segmentHours) {
  const segmentSeconds = Math.max(1, Math.floor(Number(segmentHours) * 3600));
  const segments = [];
  let cursorEnd = Number(endTs);
  while (cursorEnd >= Number(startTs)) {
    const segmentStart = Math.max(Number(startTs), cursorEnd - segmentSeconds + 1);
    segments.push({ startTs: segmentStart, endTs: cursorEnd });
    cursorEnd = segmentStart - 1;
  }
  return segments;
}

function randomizeQueriesForSegment(queries, job, segment, segmentIndex) {
  const groups = new Map();
  for (const query of queries) {
    const key = String(query.label);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(query);
  }

  const seed = [
    job.id ?? "pending",
    job.start_ts,
    job.end_ts,
    segmentIndex,
    segment.startTs,
    segment.endTs,
  ].join(":");

  return [...groups.entries()]
    .map(([label, groupQueries], originalIndex) => ({
      groupQueries,
      originalIndex,
      rank: createHash("sha256").update(`${seed}:${label}`).digest().readUInt32BE(0),
    }))
    .sort((left, right) => left.rank - right.rank || left.originalIndex - right.originalIndex)
    .flatMap((entry) => entry.groupQueries);
}

function buildScanUnits(mode, queries, job, config) {
  if (mode === "incremental") {
    const segment = { startTs: Number(job.start_ts), endTs: Number(job.end_ts) };
    return randomizeQueriesForSegment(queries, job, segment, 0).map((query, queryIndex) => ({
      ...query,
      queryIndex,
      segmentIndex: 0,
      ...segment,
    }));
  }
  const segments = splitWindowNewestFirst(
    Number(job.start_ts),
    Number(job.end_ts),
    config.fullSegmentHours ?? 24,
  );
  return segments.flatMap((segment, segmentIndex) => (
    randomizeQueriesForSegment(queries, job, segment, segmentIndex)
      .map((query, queryIndex) => ({
        ...query,
        queryIndex,
        segmentIndex,
        ...segment,
      }))
  ));
}

function jobProgressKind(mode, config) {
  const keywordSignature = activeKeywordGroups(config)
    .flatMap((group) => group.queries.map((query) => `${group.label}:${query}`))
    .join("|");
  const fingerprint = createHash("sha256").update(keywordSignature).digest("hex").slice(0, 10);
  const base = mode === "full"
    ? `segment-v3-random-groups-${config.fullSegmentHours ?? 24}h`
    : "query-v2-random-groups";
  return `${base}-kw-${fingerprint}`;
}

export function shouldExportExcelAfterScan(config) {
  return config.excelExportAfterScan === true;
}

async function exportScope(db, config, scope, { qa = false } = {}) {
  const cutoffTs = nowSeconds() - config.lookbackDays * 86400;
  const keywordGroups = activeKeywordGroups(config);
  if (scope === "master") {
    const rows = buildPartitionDatasets(
      db.listVideos({ cutoffTs, minViews: config.minViews, keywordGroups }),
      config,
    ).rows;
    return exportWorkbook({
      rows,
      config,
      outputPath: path.join(OUTPUT_DIR, "BV号自动采集.xlsx"),
      scopeLabel: "（滚动主表）",
      qaDir: qa ? QA_DIR : null,
    });
  }
  if (scope === "weekly") {
    const week = lastCompletedWeek();
    const rows = buildPartitionDatasets(db.listVideos({
      cutoffTs,
      firstQualifiedStart: week.start,
      firstQualifiedEnd: week.end,
      minViews: config.minViews,
      keywordGroups,
    }), config).rows;
    const startLabel = chinaDateString(new Date(week.start * 1000));
    const endLabel = chinaDateString(new Date((week.end - 1) * 1000));
    return exportWorkbook({
      rows,
      config,
      outputPath: path.join(OUTPUT_DIR, "周报", `BV号_${startLabel}_至_${endLabel}.xlsx`),
      scopeLabel: `（周报 ${startLabel} 至 ${endLabel}）`,
      qaDir: qa ? path.join(QA_DIR, "weekly") : null,
    });
  }
  throw new Error(`未知导出范围：${scope}`);
}

function isRateLimitError(error) {
  const text = `${String(error?.message ?? error)} ${String(error?.stdout ?? "")}`;
  return text.includes("v_voucher") || text.includes("-412") || text.includes("HTTP 412");
}

function calculateRateLimitBlock(nowTs, lastRateLimitAt, config) {
  const repeatWindowSeconds = Number(config.rateLimitRepeatWindowHours ?? 48) * 3600;
  const last = Number(lastRateLimitAt);
  const repeated = Number.isFinite(last) && last > 0 && nowTs >= last && nowTs - last <= repeatWindowSeconds;
  const cooldownHours = repeated
    ? Number(config.rateLimitRepeatCooldownHours ?? 24)
    : Number(config.rateLimitGlobalCooldownHours ?? 12);
  return {
    repeated,
    cooldownHours,
    blockedUntil: nowTs + Math.max(1, cooldownHours) * 3600,
  };
}

async function executeScanUnit({ unit, index, totalUnits, mode, job, group, client, db, config, stats }) {
  const before = { ...stats, requestCount: client.requestCount };
  const rangeLabel = mode === "full"
    ? `，时间片 ${new Date(unit.startTs * 1000).toISOString()} 至 ${new Date(unit.endTs * 1000).toISOString()}`
    : "";
  await log(`[${index + 1}/${totalUnits}] 扫描关键词：${unit.query}${rangeLabel}`);
  const result = await client.scanThresholdWindow({
    keyword: unit.query,
    startTs: unit.startTs,
    endTs: unit.endTs,
    minViews: config.minViews,
    onItems: async (items) => {
      for (const raw of items) {
        const video = normalizeVideo(raw);
        if (!/^BV[0-9A-Za-z]{10}$/.test(video.bvid)) continue;
        if (video.play < config.minViews || !isWithinWindow(video.pubdate, Number(job.start_ts), Number(job.end_ts))) continue;
        const relevance = evaluateRelevance(raw, group, config);
        if (!relevance.accepted) continue;
        const outcome = db.upsertVideo(
          video,
          group.label,
          relevance.matchedQuery ?? unit.query,
          relevance.reason,
          nowSeconds(),
        );
        stats.qualifiedCount += 1;
        if (outcome === "inserted") stats.insertedCount += 1;
        else stats.updatedCount += 1;
      }
    },
  });
  if (result.saturated) {
    await log(`关键词 ${unit.query} 存在无法继续拆分的饱和时间窗，详见配置 minSplitMinutes`, "WARN");
  }
  await log(
    `关键词 ${unit.query} 完成：${result.windows} 个时间窗、${result.pages} 页、` +
    `${client.requestCount - before.requestCount} 次请求、新增 ${stats.insertedCount - before.insertedCount} 条、` +
    `更新 ${stats.updatedCount - before.updatedCount} 次`
  );
}

async function runScan(mode, { qa = false, maxUnits = Number.POSITIVE_INFINITY, resumeOnly = false } = {}) {
  const config = await loadConfig();
  await ensureDirectories();
  await pruneLogs(config.logRetentionDays);
  const releaseLock = await acquireLock(config);
  const db = new CollectorDatabase(DB_PATH);
  db.recoverOrphanedRuns(nowSeconds());
  const stats = { requestCount: 0, qualifiedCount: 0, insertedCount: 0, updatedCount: 0 };
  let runId = null;
  let job;
  let client = null;
  try {
    const scanStartedAt = nowSeconds();
    const blockedUntil = Number(db.getRuntimeState(BILIBILI_BLOCKED_UNTIL_KEY) ?? 0);
    if (blockedUntil > scanStartedAt) {
      await log(`B站接口仍处于412冷却期，本次 ${mode} 扫描跳过；恢复时间 ${new Date(blockedUntil * 1000).toISOString()}`, "WARN");
      return { skipped: true, rateLimited: true, blockedUntil, ...stats };
    }
    if (blockedUntil > 0) db.deleteRuntimeState(BILIBILI_BLOCKED_UNTIL_KEY);

    client = new BilibiliClient(config);
    const queries = flattenKeywordGroups(config);
    const expectedProgressKind = jobProgressKind(mode, config);
    job = db.getPendingJob(mode);
    if (!job && resumeOnly) {
      await log(`没有待恢复的 ${mode} 扫描任务，本轮续扫已跳过`);
      return { skipped: true, ...stats };
    }
    runId = db.beginRun(mode, nowSeconds());
    if (!job) {
      const window = makeJobWindow(mode, config);
      job = db.createJob(mode, window.startTs, window.endTs, nowSeconds(), expectedProgressKind);
    } else {
      if (job.progress_kind !== expectedProgressKind) {
        job = db.resetJobProgress(job.id, expectedProgressKind);
        await log(`扫描任务 #${job.id} 的断点格式已升级，将按时间片重新建立进度`, "WARN");
      } else {
        db.markJobRunning(job.id);
      }
    }
    const units = buildScanUnits(mode, queries, job, config);
    await log(`恢复/开始 ${mode} 扫描任务 #${job.id}，从扫描单元 ${job.next_query_index}/${units.length} 继续`);
    await log(`开始 ${mode} 扫描 #${job.id}，窗口 ${new Date(job.start_ts * 1000).toISOString()} 至 ${new Date(job.end_ts * 1000).toISOString()}`);

    let processedUnits = 0;
    let nextIndex = Number(job.next_query_index);
    let consecutiveRateLimits = 0;
    const maxConsecutiveRateLimits = config.maxConsecutiveRateLimitedUnits ?? 3;

    const attemptUnit = async (index, deferred = false) => {
      const unit = units[index];
      const group = config.keywordGroups.find((entry) => entry.label === unit.label);
      try {
        await executeScanUnit({ unit, index, totalUnits: units.length, mode, job, group, client, db, config, stats });
        if (deferred) db.resolveJobUnit(job.id, index);
        consecutiveRateLimits = 0;
        return true;
      } catch (error) {
        if (!isRateLimitError(error)) throw error;
        db.deferJobUnit(job.id, index, error);
        consecutiveRateLimits += 1;
        const limitedAt = nowSeconds();
        const block = calculateRateLimitBlock(
          limitedAt,
          db.getRuntimeState(BILIBILI_LAST_RATE_LIMIT_AT_KEY),
          config,
        );
        db.setRuntimeState(BILIBILI_LAST_RATE_LIMIT_AT_KEY, limitedAt, limitedAt);
        db.setRuntimeState(BILIBILI_BLOCKED_UNTIL_KEY, block.blockedUntil, limitedAt);
        await log(
          `扫描单元 ${index + 1}/${units.length} 因 412 被延期：${unit.query}；` +
          `全部B站扫描暂停 ${block.cooldownHours} 小时，至 ${new Date(block.blockedUntil * 1000).toISOString()}`,
          "WARN",
        );
        return false;
      } finally {
        processedUnits += 1;
      }
    };

    for (let index = nextIndex; index < units.length && processedUnits < maxUnits; index += 1) {
      const succeeded = await attemptUnit(index);
      db.updateJobProgress(job.id, index + 1);
      nextIndex = index + 1;
      const nextUnit = units[index + 1];
      if (succeeded && mode === "incremental" && nextUnit) {
        const cooldown = config.keywordCooldownMinMs + Math.floor(
          Math.random() * Math.max(1, config.keywordCooldownMaxMs - config.keywordCooldownMinMs + 1)
        );
        await sleep(cooldown);
      }
      if (consecutiveRateLimits >= maxConsecutiveRateLimits) break;
    }

    if (mode === "full" && nextIndex >= units.length && processedUnits < maxUnits && consecutiveRateLimits < maxConsecutiveRateLimits) {
      const deferredUnits = db.listDeferredJobUnits(job.id);
      for (const deferred of deferredUnits) {
        if (processedUnits >= maxUnits || consecutiveRateLimits >= maxConsecutiveRateLimits) break;
        await attemptUnit(Number(deferred.unit_index), true);
      }
    }

    const deferredCount = db.listDeferredJobUnits(job.id).length;
    const completed = nextIndex >= units.length && (mode === "incremental" || deferredCount === 0);
    if (completed) {
      db.clearDeferredJobUnits(job.id);
      db.completeJob(job.id);
    }
    stats.requestCount = client.requestCount;
    if (shouldExportExcelAfterScan(config)) {
      await exportScope(db, config, "master", { qa });
    }
    db.finishRun(runId, stats);
    const outcome = completed ? "完成" : `本批暂停，断点 ${nextIndex}/${units.length}，延期 ${deferredCount} 个单元`;
    await log(`${mode} 扫描${outcome}：请求 ${stats.requestCount} 次，新收录 ${stats.insertedCount} 条，更新 ${stats.updatedCount} 次`);
    return { ...stats, completed, nextIndex, totalUnits: units.length };
  } catch (error) {
    stats.requestCount = client?.requestCount ?? 0;
    if (job) db.failJob(job.id, error);
    if (runId !== null) db.finishRun(runId, stats, error);
    await log(error.stack ?? String(error), "ERROR");
    throw error;
  } finally {
    db.close();
    await releaseLock();
  }
}

async function runCycle({ qa = false } = {}) {
  const config = await loadConfig();
  const incremental = await runScan("incremental", { qa });
  const backfill = await runScan("full", {
    qa,
    maxUnits: config.backfillUnitsPerCycle ?? 40,
    resumeOnly: true,
  });
  const feishu = await syncFeishuIfConfigured();
  return { incremental, backfill, feishu };
}

async function qualifiedRowsSnapshot(config = null) {
  const activeConfig = config ?? await loadConfig();
  await ensureDirectories();
  const releaseLock = await acquireLock(activeConfig);
  const db = new CollectorDatabase(DB_PATH);
  try {
    return db.listVideos({
      cutoffTs: nowSeconds() - activeConfig.lookbackDays * 86400,
      minViews: activeConfig.minViews,
      keywordGroups: activeKeywordGroups(activeConfig),
    });
  } finally {
    db.close();
    await releaseLock();
  }
}

async function runFeishu(action = "preview", { settings: suppliedSettings = null } = {}) {
  const config = await loadConfig();
  if (action === "preview") {
    const snapshot = await qualifiedRowsSnapshot(config);
    const datasets = buildPartitionDatasets(snapshot, config);
    const matrix = buildFeishuMatrix(datasets.rows);
    const preview = {
      rowCount: datasets.rows.length,
      keywordCounts: datasets.keywordCounts ?? null,
      partitionCounts: Object.fromEntries(datasets.partitions.map((partition) => [partition.name, partition.rows.length])),
      headers: matrix[0],
      firstRows: matrix.slice(1, 6),
    };
    console.log(JSON.stringify(preview, null, 2));
    return preview;
  }

  const settings = suppliedSettings ?? await loadFeishuSettings(
    FEISHU_CONFIG_PATH,
    process.env,
    { required: true },
  );
  const client = new FeishuSheetsClient(settings);
  if (action === "doctor") {
    const result = await client.doctor();
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (action === "sync") {
    const snapshot = await qualifiedRowsSnapshot(config);
    const datasets = buildPartitionDatasets(snapshot, config);
    const result = await client.sync(datasets.rows, {
      partitions: datasets.partitions,
      managedPartitionNames: datasets.managedPartitionNames,
    });
    await log(`飞书同步完成：${result.rowCount} 条，最新 BV号 ${result.firstBvid ?? "无"}`);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  throw new Error("feishu 仅支持 preview、doctor 或 sync");
}

async function syncFeishuIfConfigured() {
  const settings = await loadFeishuSettings(FEISHU_CONFIG_PATH);
  if (!settings.enabled) return { skipped: true, reason: "飞书自动同步未启用" };
  try {
    return await runFeishu("sync", { settings });
  } catch (error) {
    await log(`飞书自动同步失败，采集结果已保留：${error.stack ?? error}`, "ERROR");
    return { failed: true, error: String(error?.message ?? error) };
  }
}

async function runExport(scope, { qa = false } = {}) {
  const config = await loadConfig();
  await ensureDirectories();
  const releaseLock = await acquireLock(config);
  const db = new CollectorDatabase(DB_PATH);
  try {
    const result = await exportScope(db, config, scope, { qa });
    await log(`Excel 导出完成：${result.outputPath}，${result.rowCount} 条`);
    return result;
  } finally {
    db.close();
    await releaseLock();
  }
}

async function doctor() {
  const config = await loadConfig();
  await ensureDirectories();
  const db = new CollectorDatabase(DB_PATH);
  const blockedUntil = Number(db.getRuntimeState(BILIBILI_BLOCKED_UNTIL_KEY) ?? 0);
  const currentTs = nowSeconds();
  const checks = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    configuredTimezone: config.timezone,
    activeKeywordGroups: activeKeywordGroups(config).length,
    bilibiliTransport: {
      searchApi: "WBI",
      cookieStorage: "process-memory-only",
      requestIntervalMs: [config.requestDelayMinMs, config.requestDelayMaxMs],
      collectionSchedule: "PT12H single task",
    },
    partitioning: config.partitioning ?? null,
    config: fsSync.existsSync(CONFIG_PATH),
    artifactTool: true,
    database: fsSync.existsSync(DB_PATH),
    schedulerCommand: process.platform === "win32" && fsSync.existsSync("C:\\Windows\\System32\\schtasks.exe"),
    bilibiliRateLimit: {
      blocked: blockedUntil > currentTs,
      blockedUntil: blockedUntil > 0 ? blockedUntil : null,
      blockedUntilIso: blockedUntil > 0 ? new Date(blockedUntil * 1000).toISOString() : null,
    },
    stats: db.stats(
      nowSeconds() - config.lookbackDays * 86400,
      config.minViews,
      activeKeywordGroups(config),
    ),
  };
  db.close();
  console.log(JSON.stringify(checks, null, 2));
  return checks;
}

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2] ?? "doctor";
  const qa = process.argv.includes("--qa");
  if (command === "doctor") return doctor();
  if (command === "scan") {
    const mode = readOption("--mode", "incremental");
    if (!["incremental", "full"].includes(mode)) throw new Error("--mode 仅支持 incremental 或 full");
    const maxUnitsOption = readOption("--max-units", null);
    const maxUnits = maxUnitsOption === null ? Number.POSITIVE_INFINITY : Number(maxUnitsOption);
    if (maxUnitsOption !== null && (!Number.isInteger(maxUnits) || maxUnits < 1)) {
      throw new Error("--max-units 必须是正整数");
    }
    return runScan(mode, { qa, maxUnits });
  }
  if (command === "cycle") return runCycle({ qa });
  if (command === "feishu") return runFeishu(process.argv[3] ?? "preview");
  if (command === "export") {
    const scope = readOption("--scope", "master");
    if (!["master", "weekly"].includes(scope)) throw new Error("--scope 仅支持 master 或 weekly");
    return runExport(scope, { qa });
  }
  throw new Error(`未知命令：${command}`);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    if (error?.code === "LOCK_BUSY") {
      console.log(error.message);
      return;
    }
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}

export {
  buildScanUnits,
  calculateRateLimitBlock,
  doctor,
  exportScope,
  isRateLimitError,
  jobProgressKind,
  lastCompletedWeek,
  makeJobWindow,
  qualifiedRowsSnapshot,
  randomizeQueriesForSegment,
  runCycle,
  runExport,
  runFeishu,
  runScan,
  syncFeishuIfConfigured,
  splitWindowNewestFirst,
};
