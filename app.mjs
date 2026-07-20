import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BilibiliClient } from "./src/bilibili.mjs";
import { CollectorDatabase } from "./src/db.mjs";
import { evaluateRelevance, flattenKeywordGroups, isWithinWindow, normalizeVideo } from "./src/core.mjs";
import { exportWorkbook } from "./src/exporter.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "config.json");
const DATA_DIR = path.join(ROOT, "data");
const LOG_DIR = path.join(ROOT, "logs");
const OUTPUT_DIR = path.join(ROOT, "output");
const QA_DIR = path.join(ROOT, "qa");
const DB_PATH = path.join(DATA_DIR, "collector.sqlite");
const LOCK_PATH = path.join(DATA_DIR, "collector.lock");

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
  return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
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

function buildScanUnits(mode, queries, job, config) {
  if (mode === "incremental") {
    return queries.map((query, queryIndex) => ({
      ...query,
      queryIndex,
      segmentIndex: 0,
      startTs: Number(job.start_ts),
      endTs: Number(job.end_ts),
    }));
  }
  const segments = splitWindowNewestFirst(
    Number(job.start_ts),
    Number(job.end_ts),
    config.fullSegmentHours ?? 24,
  );
  return segments.flatMap((segment, segmentIndex) => queries.map((query, queryIndex) => ({
    ...query,
    queryIndex,
    segmentIndex,
    ...segment,
  })));
}

function jobProgressKind(mode, config) {
  return mode === "full" ? `segment-v2-time-first-${config.fullSegmentHours ?? 24}h` : "query-v1";
}

async function exportScope(db, config, scope, { qa = false } = {}) {
  const cutoffTs = nowSeconds() - config.lookbackDays * 86400;
  if (scope === "master") {
    const rows = db.listVideos({ cutoffTs, minViews: config.minViews });
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
    const rows = db.listVideos({
      cutoffTs,
      firstQualifiedStart: week.start,
      firstQualifiedEnd: week.end,
      minViews: config.minViews,
    });
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
  const client = new BilibiliClient(config);
  const stats = { requestCount: 0, qualifiedCount: 0, insertedCount: 0, updatedCount: 0 };
  let runId = null;
  let job;
  try {
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
        await log(`扫描单元 ${index + 1}/${units.length} 因 412 被延期，不阻塞其他关键词：${unit.query}`, "WARN");
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
    await exportScope(db, config, "master", { qa });
    db.finishRun(runId, stats);
    const outcome = completed ? "完成" : `本批暂停，断点 ${nextIndex}/${units.length}，延期 ${deferredCount} 个单元`;
    await log(`${mode} 扫描${outcome}：请求 ${stats.requestCount} 次，新收录 ${stats.insertedCount} 条，更新 ${stats.updatedCount} 次`);
    return { ...stats, completed, nextIndex, totalUnits: units.length };
  } catch (error) {
    stats.requestCount = client.requestCount;
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
  return { incremental, backfill };
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
  const checks = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    configuredTimezone: config.timezone,
    config: fsSync.existsSync(CONFIG_PATH),
    artifactTool: true,
    database: fsSync.existsSync(DB_PATH),
    schedulerCommand: process.platform === "win32" && fsSync.existsSync("C:\\Windows\\System32\\schtasks.exe"),
    stats: db.stats(nowSeconds() - config.lookbackDays * 86400, config.minViews),
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
    return runScan(mode, { qa });
  }
  if (command === "cycle") return runCycle({ qa });
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
  doctor,
  exportScope,
  isRateLimitError,
  jobProgressKind,
  lastCompletedWeek,
  makeJobWindow,
  runCycle,
  runExport,
  runScan,
  splitWindowNewestFirst,
};
