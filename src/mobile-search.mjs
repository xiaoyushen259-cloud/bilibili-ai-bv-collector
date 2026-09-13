import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BilibiliClient, isRateLimitError } from './bilibili.mjs';

const SEARCH_API = 'https://api.bilibili.com/x/web-interface/search/type';
const SEARCH_PAGE = 'https://m.bilibili.com/search';
const VIEW_API = 'https://api.bilibili.com/x/web-interface/view';
const BV = /^BV[0-9A-Za-z]{10}$/;

function checkPayload(payload) {
  if (payload?.data?.v_voucher) throw new Error('B站接口错误 v_voucher');
  if (payload?.code !== 0) throw new Error(`B站接口错误 ${payload?.code}`);
}

export function parseMobileDetail(payload, bvid) {
  const d = payload?.data;
  if (payload?.code !== 0 || !d || d.bvid !== bvid || !BV.test(bvid)
    || typeof d.title !== 'string' || !d.title.trim()
    || !Number.isSafeInteger(d.stat?.view) || d.stat.view < 0
    || !Number.isSafeInteger(d.pubdate) || d.pubdate <= 0) return null;
  return { bvid, title: d.title, description: d.desc ?? '', tags: '', play: d.stat.view,
    pubdate: d.pubdate, author: d.owner?.name, mid: d.owner?.mid, typename: d.tname };
}

// Reuse the canonical client's persisted throttling; no WBI signing or key request here.
export class MobileSearchClient extends BilibiliClient {
  constructor(config, options = {}) {
    super(config, options);
    this.maxRequests = options.maxRequests ?? config.batchMobileMaxRequests ?? 60;
    if (!Number.isInteger(this.maxRequests) || this.maxRequests < 1) throw new Error('移动端请求预算必须为正整数');
    this.evidenceDir = options.evidenceDir;
    this.detailCache = new Map();
  }

  browserHeaders() {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',
      Referer: 'https://m.bilibili.com/', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9' };
    // The canonical snapshot restricts cookies to the anonymous allowlist.
    const cookie = Object.entries(this.sessionSnapshot().cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  async request(url, options) {
    if (this.requestCount >= this.maxRequests) {
      const error = new Error('移动端请求预算已耗尽');
      error.budgetExhausted = true;
      throw error;
    }
    const response = await super.request(url, options);
    this.persistSession();
    return response;
  }

  async search({ keyword, page = 1, order = 'click', startTs, endTs, shouldFetch = () => true }) {
    const items = [], evidence = { keyword, page, collectedAt: new Date().toISOString(), responses: [] };
    let error = null, numPages = 1;
    try {
      let bvids;
      const url = new URL(SEARCH_API);
      url.search = new URLSearchParams({ search_type: 'video', keyword, page: String(page), order,
        pubtime_begin_s: String(startTs), pubtime_end_s: String(endTs) }).toString();
      try {
        const payload = await this.requestJson(url);
        evidence.responses.push({ url: String(url), payload });
        checkPayload(payload);
        if (!Array.isArray(payload.data?.result) && payload.data?.numResults !== 0) throw new Error('移动端搜索结构异常');
        bvids = (payload.data.result ?? []).map(item => item.bvid);
        numPages = Math.max(1, Number(payload.data.numPages) || 1);
      } catch (searchError) {
        // Never switch endpoints to work around a challenge or rate limit.
        if (isRateLimitError(searchError) || searchError.budgetExhausted) throw searchError;
        const pageUrl = new URL(SEARCH_PAGE);
        pageUrl.search = new URLSearchParams({ keyword, page: String(page), order }).toString();
        const response = await this.request(pageUrl, { document: true });
        const html = await response.text();
        if (/v_voucher|验证码|访问过于频繁|异常流量/.test(html)) throw new Error('B站接口错误 v_voucher');
        evidence.responses.push({ url: String(pageUrl), html });
        bvids = [...html.matchAll(/\bBV[0-9A-Za-z]{10}\b/g)].map(m => m[0]);
        numPages = bvids.length ? page + 1 : page;
      }
      for (const bvid of new Set(bvids.filter(id => typeof id === 'string' && BV.test(id)))) {
        if (!shouldFetch(bvid)) continue;
        let payload = this.detailCache.get(bvid);
        if (!payload) {
          payload = await this.requestJson(`${VIEW_API}?bvid=${bvid}`);
          if ([-404, 62002, 62012].includes(payload?.code)) continue; // Removed/private videos.
          checkPayload(payload);
          this.detailCache.set(bvid, payload);
        }
        evidence.responses.push({ url: `${VIEW_API}?bvid=${bvid}`, payload });
        const video = parseMobileDetail(payload, bvid);
        if (video) items.push(video);
      }
    } catch (caught) { error = caught; }
    let evidenceFile;
    if (this.evidenceDir) {
      await fs.mkdir(this.evidenceDir, { recursive: true });
      evidenceFile = path.join(this.evidenceDir, `${randomUUID()}.json`);
      await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
    }
    return { items, numPages, evidenceFile, error, exhausted: Boolean(error?.budgetExhausted) };
  }
}
