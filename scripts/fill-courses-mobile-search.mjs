import fs from "node:fs";
import path from "node:path";
import { CollectorDatabase } from "../src/db.mjs";
import { evaluateRelevance, isWithinWindow, normalizeVideo } from "../src/core.mjs";
import { activeKeywordGroups, buildFeishuWindowedDatasets, buildPartitionDatasets, hasBlockedTitle, matchTermsForGroup, validateCollectorRules } from "../src/rules.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const DB_PATH = path.join(ROOT, "data", "collector.sqlite");
const SEARCH_URL = "https://m.bilibili.com/search";
const SEARCH_API_URL = "https://api.bilibili.com/x/web-interface/search/type";
const VIEW_URL = "https://api.bilibili.com/x/web-interface/view";
const USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36";
const SEARCH_ORDERS = ["click", "pubdate", "totalrank"];
const SEARCH_PAGES = [1, 2, 3, 4];
const SEARCH_SUFFIXES = [
  "", "教程", "零基础", "入门", "实战", "工作流", "2026", "2025", "安装", "进阶",
  "AI", "AI绘画", "提示词", "参数", "案例", "风格", "人物", "产品", "海报", "摄影",
  "动画", "角色", "商业", "官网", "网页版", "部署", "本地", "模型", "节点", "视频",
];
const EXTRA_TERMS_BY_GROUP = {
  midjourney: [
    "midjourney v7", "midjourney v6", "midjourney v5", "midjourney prompt", "midjourney discord",
    "midjourney 设计", "midjourney 建筑", "midjourney 室内", "midjourney 电商", "midjourney 头像",
    "midjourney 指令", "midjourney seed", "midjourney sref", "midjourney cref", "midjourney 2024",
    "midjourney 2023", "midjourney 中文", "midjourney 国风", "midjourney 插画", "midjourney logo",
  ],
  niji: [
    "niji 6", "niji v6", "niji journey v6", "nijijourney", "nijijourney 教程", "niji 动漫",
    "niji AI", "niji AI绘画", "niji prompt", "niji 提示词", "niji 模型", "niji 风格",
    "niji 人物", "niji 插画", "niji 二次元", "niji journey anime", "niji journey prompt",
  ],
  "Stable Diffusion": [
    "stable diffusion lora", "stable diffusion controlnet", "stable diffusion prompt", "stable diffusion 提示词",
    "stable diffusion AI绘画", "stable diffusion 动画", "stable diffusion 人像", "stable diffusion 模型",
    "stable diffusion 2024", "stable diffusion 2023", "stable diffusion 中文", "stable diffusion 电商",
  ],
  "Stable Diffusion WebUI": ["sd webui", "stable diffusion webui lora", "stable diffusion webui controlnet", "webui AI绘画"],
  AUTOMATIC1111: ["A1111", "A1111 教程", "automatic1111 webui", "automatic1111 安装"],
  Forge: ["forge webui", "stable diffusion forge 教程", "forge AI绘画"],
};
let searchApiAvailable = true;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseTargets(value) {
  if (!value) throw new Error("必须提供 --targets 分区=目标数,...");
  return Object.fromEntries(value.split(",").map((entry) => {
    const separator = entry.lastIndexOf("=");
    if (separator <= 0) throw new Error("--targets 格式错误");
    const name = entry.slice(0, separator).trim();
    const target = Number(entry.slice(separator + 1));
    if (!Number.isInteger(target) || target < 1) throw new Error(`分区“${name}”目标必须是正整数`);
    return [name, target];
  }));
}

function chinaDayBounds(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const start = Math.floor(Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`) / 1000);
  return { label: `${parts.year}-${parts.month}-${parts.day}`, start, end: start + 86400 };
}

function partitionDatasets(db, config, cutoffTs) {
  const rows = db.listVideos({
    cutoffTs,
    minViews: config.minViews,
    keywordGroups: activeKeywordGroups(config),
    excludeBound: true,
  }).filter((row) => !hasBlockedTitle(row, config.bindingRiskTitleTerms));
  const archiveName = config.feishuArchivePartitionName ?? "历史归档";
  return buildFeishuWindowedDatasets(buildPartitionDatasets(rows, config), {
    limit: config.feishuPartitionCurrentLimit ?? config.courseTargetCount ?? 50,
    archiveName,
  }).partitions.filter((partition) => partition.name !== archiveName);
}

function partitionCounts(db, config, cutoffTs) {
  return Object.fromEntries(partitionDatasets(db, config, cutoffTs).map((partition) => [
    partition.name,
    partition.rows.length,
  ]));
}

function todayCounts(db, config, cutoffTs, day) {
  return Object.fromEntries(partitionDatasets(db, config, cutoffTs).map((partition) => [
    partition.name,
    partition.rows.filter((row) => Number(row.first_qualified_at) >= day.start && Number(row.first_qualified_at) < day.end).length,
  ]));
}

async function fetchText(url, { referer = "https://m.bilibili.com/" } = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: referer,
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.text();
}

async function discoverBvids(keyword) {
  const found = new Set();
  let requestCount = 0;
  if (searchApiAvailable) {
    try {
      for (const page of [1, 2, 3, 4, 5, 6, 7, 8]) {
        for (const order of SEARCH_ORDERS) {
          const url = new URL(SEARCH_API_URL);
          url.searchParams.set("search_type", "video");
          url.searchParams.set("keyword", keyword);
          url.searchParams.set("order", order);
          url.searchParams.set("page", String(page));
          const text = await fetchText(url, { referer: "https://search.bilibili.com/" });
          requestCount += 1;
          const payload = JSON.parse(text);
          if (Number(payload.code) !== 0) throw new Error(`搜索接口返回 ${payload.code}: ${payload.message ?? "unknown"}`);
          for (const item of payload.data?.result ?? []) {
            if (item?.bvid) found.add(String(item.bvid));
          }
          await sleep(250);
        }
      }
      return { bvids: [...found], requestCount };
    } catch (error) {
      if (!/HTTP 412|HTTP 429/.test(error.message)) throw error;
      searchApiAvailable = false;
      found.clear();
    }
  }
  for (const page of SEARCH_PAGES) {
    for (const order of SEARCH_ORDERS) {
      const url = `${SEARCH_URL}?keyword=${encodeURIComponent(keyword)}&order=${encodeURIComponent(order)}&page=${page}`;
      const html = await fetchText(url);
      requestCount += 1;
      for (const match of html.matchAll(/BV[0-9A-Za-z]{10}/g)) found.add(match[0]);
      await sleep(250);
    }
  }
  return { bvids: [...found], requestCount };
}

async function fetchVideo(bvid) {
  const text = await fetchText(`${VIEW_URL}?bvid=${encodeURIComponent(bvid)}`, {
    referer: `https://www.bilibili.com/video/${bvid}`,
  });
  const payload = JSON.parse(text);
  if (Number(payload.code) !== 0 || !payload.data) return null;
  const item = payload.data;
  return {
    bvid: item.bvid,
    title: item.title,
    description: item.desc,
    tags: "",
    play: item.stat?.view,
    pubdate: item.pubdate,
    author: item.owner?.name,
    mid: item.owner?.mid,
    typename: item.tname,
  };
}

async function fetchTags(bvid) {
  const text = await fetchText(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, {
    referer: `https://www.bilibili.com/video/${bvid}`,
  });
  const payload = JSON.parse(text);
  if (Number(payload.code) !== 0 || !Array.isArray(payload.data)) return [];
  return payload.data.map((tag) => tag.tag_name).filter(Boolean);
}

function searchTermsForGroups(groups) {
  const tasks = [];
  const seen = new Set();
  // 先对所有关键词组跑一遍精确查询，避免单个组的大量后缀查询
  // 阻塞后续组；随后补充高价值扩展词，再按后缀广度优先扩展。
  for (const group of groups) {
    const bases = [...new Set([group.label, ...(group.queries ?? []), ...matchTermsForGroup(group)])];
    for (const term of bases) {
      const key = `${group.label}\u0000${term.toLocaleLowerCase("en-US")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ group, term });
    }
  }
  for (const group of groups) {
    for (const term of EXTRA_TERMS_BY_GROUP[group.label] ?? []) {
      const key = `${group.label}\u0000${term.toLocaleLowerCase("en-US")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ group, term });
    }
  }
  for (const suffix of SEARCH_SUFFIXES.filter(Boolean)) {
    for (const group of groups) {
      const bases = [...new Set([group.label, ...(group.queries ?? []), ...matchTermsForGroup(group)])];
      for (const base of bases) {
        const term = `${base}${suffix ? ` ${suffix}` : ""}`.trim();
        const key = `${group.label}\u0000${term.toLocaleLowerCase("en-US")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tasks.push({ group, term });
      }
    }
  }
  return tasks;
}

async function main() {
  const config = validateCollectorRules(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  const targets = parseTargets(readOption("--targets"));
  const onlyGroupsOption = readOption("--only-groups", null);
  const onlyGroups = onlyGroupsOption
    ? new Set(onlyGroupsOption.split(",").map((value) => value.trim().toLocaleLowerCase("en-US")).filter(Boolean))
    : null;
  const todayMinimum = Math.max(1, Number(readOption("--today-min", 50)));
  const searchDelayMs = Math.max(500, Number(readOption("--search-delay-ms", 1200)));
  const detailDelayMs = Math.max(250, Number(readOption("--detail-delay-ms", 650)));
  const day = chinaDayBounds();
  const endTs = nowSeconds();
  const cutoffTs = endTs - Math.max(Number(config.lookbackDays), Number(config.courseLibraryLookbackDays ?? config.lookbackDays)) * 86400;
  const db = new CollectorDatabase(DB_PATH);
  db.recoverOrphanedRuns(endTs);
  const runId = db.beginRun("mobile-search-fill", endTs);
  const stats = { requestCount: 0, qualifiedCount: 0, insertedCount: 0, updatedCount: 0 };
  const seenBvids = new Set();
  try {
    const groupByLabel = new Map(activeKeywordGroups(config).map((group) => [group.label, group]));
    for (const partition of config.contentPartitions ?? []) {
      const target = Number(targets[partition.name]);
      if (!Number.isInteger(target)) throw new Error(`--targets 缺少分区“${partition.name}”`);
      let count = Number(partitionCounts(db, config, cutoffTs)[partition.name] ?? 0);
      let collectedToday = Number(todayCounts(db, config, cutoffTs, day)[partition.name] ?? 0);
      console.log(`[${new Date().toISOString()}] ${partition.name} ${count}/${target}，今日 ${collectedToday}/${todayMinimum}`);
      if (count >= target && collectedToday >= todayMinimum) continue;
      const groups = (partition.keywordGroups ?? [])
        .map((label) => groupByLabel.get(label))
        .filter(Boolean)
        .filter((group) => !onlyGroups || onlyGroups.has(group.label.toLocaleLowerCase("en-US")));
      if (!groups.length) continue;
      const partitionGroupLabels = groups.flatMap((group) => [group.label, ...(group.legacyLabels ?? [])]);
      const partitionHitQuery = db.db.prepare(
        `SELECT 1 FROM keyword_hits WHERE bvid=? AND keyword_group IN (${partitionGroupLabels.map(() => "?").join(",")}) LIMIT 1`,
      );
      const tasks = searchTermsForGroups(groups);
      for (const { group, term } of tasks) {
        let bvids;
        try {
          const discovery = await discoverBvids(term);
          bvids = discovery.bvids;
          stats.requestCount += discovery.requestCount;
        } catch (error) {
          console.warn(`发现请求失败“${term}”：${error.message}`);
          if (/HTTP 412|HTTP 429/.test(error.message)) throw error;
          await sleep(searchDelayMs);
          continue;
        }
        let acceptedForTerm = 0;
        for (const bvid of bvids) {
          const seenKey = `${group.label}\u0000${bvid}`;
          if (seenBvids.has(seenKey)) continue;
          seenBvids.add(seenKey);
          const existing = db.db.prepare("SELECT first_qualified_at FROM videos WHERE bvid=?").get(bvid);
          if (existing && Number(existing.first_qualified_at) < day.start) continue;
          if (existing && partitionHitQuery.get(bvid, ...partitionGroupLabels)) continue;
          if (db.isPreviouslyBound(bvid)) continue;
          await sleep(detailDelayMs);
          let raw;
          try {
            raw = await fetchVideo(bvid);
            stats.requestCount += 1;
          } catch (error) {
            console.warn(`详情请求失败 ${bvid}：${error.message}`);
            if (/HTTP 412|HTTP 429/.test(error.message)) throw error;
            continue;
          }
          if (!raw) continue;
          const video = normalizeVideo(raw);
          if (video.play < Number(config.minViews)) continue;
          if (!isWithinWindow(video.pubdate, cutoffTs, endTs)) continue;
          if (hasBlockedTitle(video, config.bindingRiskTitleTerms)) continue;
          let relevance = evaluateRelevance(raw, group, config);
          if (!relevance.accepted) {
            try {
              raw.tags = await fetchTags(bvid);
              stats.requestCount += 1;
              relevance = evaluateRelevance(raw, group, config);
            } catch {
              // 标签是辅助证据；获取失败时仍保留标题/简介的原判定。
            }
          }
          if (!relevance.accepted) continue;
          const outcome = db.upsertVideo(video, group.label, relevance.matchedQuery ?? term, relevance.reason, nowSeconds());
          stats.qualifiedCount += 1;
          if (outcome === "inserted") stats.insertedCount += 1;
          else stats.updatedCount += 1;
          acceptedForTerm += 1;
          count = Number(partitionCounts(db, config, cutoffTs)[partition.name] ?? 0);
          collectedToday = Number(todayCounts(db, config, cutoffTs, day)[partition.name] ?? 0);
          if (count >= target && collectedToday >= todayMinimum) break;
        }
        console.log(`[${new Date().toISOString()}] ${partition.name} “${term}” 候选 ${bvids.length}，收录 ${acceptedForTerm}，进度 ${count}/${target}，今日 ${collectedToday}/${todayMinimum}`);
        if (count >= target && collectedToday >= todayMinimum) break;
        await sleep(searchDelayMs);
      }
    }
    const counts = partitionCounts(db, config, cutoffTs);
    const collectedToday = todayCounts(db, config, cutoffTs, day);
    db.finishRun(runId, stats);
    console.log(JSON.stringify({ day: day.label, stats, targets, counts, collectedToday }, null, 2));
  } catch (error) {
    db.finishRun(runId, stats, error);
    throw error;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
