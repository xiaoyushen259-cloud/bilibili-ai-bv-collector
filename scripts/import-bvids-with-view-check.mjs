import fs from "node:fs";
import path from "node:path";
import { CollectorDatabase } from "../src/db.mjs";
import { evaluateRelevance, normalizeVideo } from "../src/core.mjs";
import { activeKeywordGroups, hasBlockedTitle, validateCollectorRules } from "../src/rules.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const config = validateCollectorRules(JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")));
const db = new CollectorDatabase(path.join(ROOT, "data", "collector.sqlite"));
const bvidOption = process.argv[process.argv.indexOf("--bvids") + 1] ?? "";
const partitionName = process.argv[process.argv.indexOf("--partition") + 1] ?? "Stable Diffusion";
const bvids = [...new Set(bvidOption.split(",").map((value) => value.trim()).filter((value) => /^BV[0-9A-Za-z]{10}$/.test(value)))];
const partition = config.contentPartitions.find((entry) => entry.name === partitionName);
if (!partition) throw new Error(`未找到分区“${partitionName}”`);
const groupByLabel = new Map(activeKeywordGroups(config).map((group) => [group.label, group]));
const groups = partition.keywordGroups.map((label) => groupByLabel.get(label)).filter(Boolean);
const cutoffTs = Math.floor(Date.now() / 1000)
  - Math.max(Number(config.lookbackDays), Number(config.courseLibraryLookbackDays ?? config.lookbackDays)) * 86400;
const stats = { candidates: bvids.length, inserted: 0, updated: 0, rejectedViews: 0, rejectedDate: 0, rejectedRelevance: 0, errors: 0 };

try {
  for (const bvid of bvids) {
    if (db.isPreviouslyBound(bvid)) continue;
    if (db.db.prepare("SELECT 1 FROM videos WHERE bvid=?").get(bvid)) continue;
    await new Promise((resolve) => setTimeout(resolve, 450));
    try {
      const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
          Referer: `https://www.bilibili.com/video/${bvid}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (Number(payload.code) !== 0 || !payload.data) throw new Error(`code ${payload.code}`);
      const item = payload.data;
      let tags = [];
      const tagResponse = await fetch(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
          Referer: `https://www.bilibili.com/video/${bvid}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (tagResponse.ok) {
        const tagPayload = await tagResponse.json();
        if (Number(tagPayload.code) === 0 && Array.isArray(tagPayload.data)) {
          tags = tagPayload.data.map((tag) => tag.tag_name).filter(Boolean);
        }
      }
      const raw = {
        bvid: item.bvid,
        title: item.title,
        description: item.desc,
        tags,
        play: item.stat?.view,
        pubdate: item.pubdate,
        author: item.owner?.name,
        mid: item.owner?.mid,
        typename: item.tname,
      };
      const video = normalizeVideo(raw);
      if (hasBlockedTitle(video, config.bindingRiskTitleTerms)) {
        stats.rejectedRelevance += 1;
        console.log(`${bvid} reject risky-title=${video.title}`);
        continue;
      }
      if (video.play < Number(config.minViews)) {
        stats.rejectedViews += 1;
        console.log(`${bvid} reject views=${video.play}`);
        continue;
      }
      if (video.pubdate < cutoffTs) {
        stats.rejectedDate += 1;
        console.log(`${bvid} reject pubdate=${video.pubdate}`);
        continue;
      }
      const matches = groups.map((group) => ({ group, relevance: evaluateRelevance(raw, group, config) }))
        .filter((entry) => entry.relevance.accepted);
      if (!matches.length) {
        stats.rejectedRelevance += 1;
        console.log(`${bvid} reject relevance title=${video.title}`);
        continue;
      }
      let first = true;
      for (const { group, relevance } of matches) {
        const outcome = db.upsertVideo(video, group.label, relevance.matchedQuery, relevance.reason, Math.floor(Date.now() / 1000));
        if (first) stats[outcome === "inserted" ? "inserted" : "updated"] += 1;
        first = false;
      }
      console.log(`${bvid} accept views=${video.play} groups=${matches.map((entry) => entry.group.label).join("|")}`);
    } catch (error) {
      stats.errors += 1;
      console.warn(`${bvid} error ${error.message}`);
    }
  }
  console.log(JSON.stringify(stats, null, 2));
} finally {
  db.close();
}
