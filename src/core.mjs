import { activeKeywordGroups, matchTermsForGroup } from "./rules.mjs";

const AMBIGUOUS_BOUNDARY_TERMS = new Set(["ai", "mj", "sd"]);

export function stripHtml(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function parsePlay(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = String(value ?? "").replace(/,/g, "").trim().toLowerCase();
  if (!text || text === "--") return 0;
  const match = text.match(/^([\d.]+)\s*([万亿w])?$/i);
  if (!match) return Number.parseInt(text, 10) || 0;
  const base = Number.parseFloat(match[1]);
  const factor = match[2] === "亿" ? 100_000_000 : (match[2] === "万" || match[2] === "w") ? 10_000 : 1;
  return Math.trunc(base * factor);
}

function latinBoundaryContains(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

export function containsTerm(text, term) {
  const source = stripHtml(text).toLowerCase();
  const needle = stripHtml(term).toLowerCase();
  if (!needle) return false;
  if (AMBIGUOUS_BOUNDARY_TERMS.has(needle)) return latinBoundaryContains(source, needle);
  if (/^[a-z0-9 ._-]+$/i.test(needle) && needle.length <= 3) return latinBoundaryContains(source, needle);
  return source.includes(needle);
}

export function searchableText(item) {
  return [item.title, item.description, item.desc, item.tag, item.tags]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter(Boolean)
    .map(stripHtml)
    .join(" | ");
}

export function evaluateRelevance(item, group, config) {
  const text = searchableText(item);
  const matchedQuery = matchTermsForGroup(group).find((query) => containsTerm(text, query));
  if (!matchedQuery) {
    return { accepted: false, reason: `搜索结果正文未直接出现关键词组“${group.label}”` };
  }
  if (!group.ambiguous) {
    return { accepted: true, reason: `强关键词命中：${matchedQuery}`, matchedQuery };
  }

  const otherStrong = activeKeywordGroups(config)
    .filter((candidate) => !candidate.ambiguous && candidate.label !== group.label)
    .flatMap((candidate) => matchTermsForGroup(candidate).map((query) => ({ label: candidate.label, query })))
    .find(({ query }) => containsTerm(text, query));
  if (otherStrong) {
    return {
      accepted: true,
      reason: `歧义词“${matchedQuery}”与强关键词“${otherStrong.query}”共同命中`,
      matchedQuery,
    };
  }

  const context = config.aiContextTerms.find((term) => {
    if (String(term).toLowerCase() === String(matchedQuery).toLowerCase()) return false;
    return containsTerm(text, term);
  });
  if (context) {
    return {
      accepted: true,
      reason: `歧义词“${matchedQuery}”与 AI 上下文“${context}”共同命中`,
      matchedQuery,
    };
  }
  return { accepted: false, reason: `歧义词“${matchedQuery}”缺少 AI 上下文`, matchedQuery };
}

export function normalizeVideo(item) {
  const bvid = String(item.bvid ?? "").trim();
  return {
    bvid,
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : "",
    title: stripHtml(item.title),
    description: stripHtml(item.description ?? item.desc),
    tags: stripHtml(Array.isArray(item.tags) ? item.tags.join(",") : item.tag ?? item.tags),
    play: parsePlay(item.play),
    pubdate: Number(item.pubdate) || 0,
    author: stripHtml(item.author ?? item.uname),
    authorMid: String(item.mid ?? item.uid ?? ""),
    category: stripHtml(item.typename ?? item.cate_name ?? item.type),
  };
}

export function isWithinWindow(pubdate, startTs, endTs) {
  const value = Number(pubdate);
  return Number.isFinite(value) && value >= startTs && value <= endTs;
}

export function canonicalVideoUrl(bvid) {
  return `https://www.bilibili.com/video/${String(bvid).trim()}`;
}

export function flattenKeywordGroups(config) {
  return activeKeywordGroups(config)
    .flatMap((group) => group.queries.map((query) => ({ ...group, query })));
}

export function shouldSplitWindow({ numPages, lastPageItems, minViews, startTs, endTs, minSplitMinutes, depth, maxSplitDepth }) {
  if (Number(numPages) < 50 || !lastPageItems?.length) return false;
  const minLastPlay = Math.min(...lastPageItems.map((item) => parsePlay(item.play)));
  const durationSeconds = endTs - startTs;
  return minLastPlay >= minViews && durationSeconds > minSplitMinutes * 60 && depth < maxSplitDepth;
}
