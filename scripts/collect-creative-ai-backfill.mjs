import { fileURLToPath } from "node:url";
import { CollectorDatabase } from "../src/db.mjs";

const collectorDb = new CollectorDatabase(fileURLToPath(new URL("../data/collector.sqlite", import.meta.url)));
const db = collectorDb.db;
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");

const API = "https://api.bilibili.com/x/web-interface";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36";
const queries = [
  "AI恶搞", "AI搞笑", "AI整活", "AI短片", "AI动画", "AI二创", "AI剧情", "AI电影",
  "AI漫剧", "AI鬼畜", "AI同人", "AI反转", "AI原创视频", "AI生成短片", "AI MV",
  "Seedance 恶搞", "Seedance 搞笑", "即梦AI 搞笑", "可灵AI 短片", "Sora 搞笑",
  "AI全民制作人", "AI特摄", "AI改编", "AI抽象视频",
];
const aiTerms = ["ai", "人工智能", "aigc", "seedance", "即梦", "可灵", "sora", "runway", "海螺", "minimax", "veo", "wan", "luma", "pika"];
const creativeTerms = ["恶搞", "搞笑", "整活", "短片", "动画", "二创", "剧情", "故事", "电影", "漫剧", "鬼畜", "同人", "重拍", "改编", "片段", "番外", "特摄", "反转", "抽象", "发癫", "be like", "假如", "如果", "ai原创视频", "ai全民制作人", "mv"];
const rejectTerms = ["教程", "安装", "工作流", "测评", "实测", "评测", "入门", "部署", "全套", "保姆级", "提示词", "课程", "使用指南", "下载安装", "模型详解", "从零开始", "手把手", "nsfw", "破限制", "破解版", "无审查", "无视审查", "绕过审核"];
const aiVideoGroups = ["Seedance", "Kling", "Grok视频", "Sora", "Veo", "即梦", "Runway", "海螺视频", "Pika", "Luma", "PixVerse", "Vidu", "Wan视频", "混元视频", "LTX Video"];
const targets = [
  { group: "AI相关补位-Midjourney", need: 50 },
  { group: "AI相关补位-Stable Diffusion", need: 43 },
];
const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
const chinaDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const todayStart = Math.floor(Date.parse(`${chinaDay}T00:00:00+08:00`) / 1000);
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, referer = "https://search.bilibili.com/") {
  const response = await fetch(url, { headers: { "User-Agent": UA, Referer: referer, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function qualifies(item) {
  const title = String(item.title ?? "").replace(/<[^>]+>/g, " ").toLowerCase();
  const text = `${title} ${String(item.desc ?? "").toLowerCase()}`;
  return aiTerms.some((term) => text.includes(term))
    && creativeTerms.some((term) => text.includes(term))
    && !rejectTerms.some((term) => title.includes(term));
}

const placeholders = aiVideoGroups.map(() => "?").join(",");
const overlapsAiVideo = db.prepare(`SELECT 1 FROM keyword_hits WHERE bvid=? AND keyword_group IN (${placeholders}) LIMIT 1`);
const alreadyBackfilled = db.prepare("SELECT 1 FROM keyword_hits WHERE bvid=? AND keyword_group IN ('AI相关补位-Midjourney','AI相关补位-Stable Diffusion') LIMIT 1");
const previouslyBound = db.prepare("SELECT 1 FROM binding_history WHERE bvid=? LIMIT 1");
const existing = db.prepare("SELECT first_qualified_at FROM videos WHERE bvid=?");
const upsertVideo = db.prepare(`
  INSERT INTO videos(bvid,url,title,description,tags,play,pubdate,author,author_mid,category,first_qualified_at,last_checked_at,relevance_reason)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(bvid) DO UPDATE SET play=excluded.play,last_checked_at=excluded.last_checked_at
`);
const insertHit = db.prepare("INSERT OR IGNORE INTO keyword_hits(bvid,keyword_group,matched_query) VALUES(?,?,?)");

const candidates = new Set();
for (const query of queries) {
  for (const order of ["click", "pubdate"]) {
    for (let page = 1; page <= 6; page += 1) {
      const url = new URL(`${API}/search/type`);
      url.searchParams.set("search_type", "video");
      url.searchParams.set("keyword", query);
      url.searchParams.set("order", order);
      url.searchParams.set("page", String(page));
      try {
        const payload = await getJson(url);
        if (Number(payload.code) !== 0) break;
        for (const item of payload.data?.result ?? []) if (item.bvid) candidates.add(item.bvid);
      } catch (error) {
        console.warn(`search ${query} ${order} p${page}: ${error.message}`);
        if (/412|429/.test(error.message)) break;
      }
      await sleep(120);
    }
  }
  console.log(`discover ${query}: ${candidates.size}`);
}

let targetIndex = 0;
let accepted = 0;
for (const bvid of candidates) {
  while (targetIndex < targets.length) {
    const count = db.prepare("SELECT COUNT(*) n FROM keyword_hits WHERE keyword_group=?").get(targets[targetIndex].group).n;
    if (count < targets[targetIndex].need) break;
    targetIndex += 1;
  }
  if (targetIndex >= targets.length) break;
  if (previouslyBound.get(bvid)) continue;
  if (overlapsAiVideo.get(bvid, ...aiVideoGroups) || alreadyBackfilled.get(bvid)) continue;
  const old = existing.get(bvid);
  if (old && Number(old.first_qualified_at) < todayStart) continue;
  await sleep(180);
  try {
    const payload = await getJson(`${API}/view?bvid=${encodeURIComponent(bvid)}`, `https://www.bilibili.com/video/${bvid}`);
    const item = payload.data;
    if (Number(payload.code) !== 0 || !item || Number(item.stat?.view) < 10000 || Number(item.pubdate) < cutoff || !qualifies(item)) continue;
    const ts = now();
    db.exec("BEGIN IMMEDIATE");
    upsertVideo.run(item.bvid, `https://www.bilibili.com/video/${item.bvid}`, item.title, item.desc ?? "", "", Number(item.stat.view), Number(item.pubdate), item.owner?.name ?? "", String(item.owner?.mid ?? ""), item.tname ?? "", ts, ts, "AI恶搞/有趣成片补位");
    insertHit.run(item.bvid, targets[targetIndex].group, "AI恶搞/有趣成片");
    db.exec("COMMIT");
    accepted += 1;
    console.log(`accept ${targets[targetIndex].group} ${item.bvid} ${item.stat.view} ${item.title}`);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    console.warn(`detail ${bvid}: ${error.message}`);
  }
}

console.log(JSON.stringify({ discovered: candidates.size, accepted, counts: Object.fromEntries(targets.map(({ group }) => [group, db.prepare("SELECT COUNT(*) n FROM keyword_hits WHERE keyword_group=?").get(group).n])) }, null, 2));
collectorDb.close();
