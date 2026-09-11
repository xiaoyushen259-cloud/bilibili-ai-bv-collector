import { createHash } from "node:crypto";
import { parsePlay, shouldSplitWindow } from "./core.mjs";

const HOME_URL = "https://www.bilibili.com/";
const SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi";
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const SEARCH_URL = "https://api.bilibili.com/x/web-interface/wbi/search/type";
const ANONYMOUS_COOKIE_NAMES = new Set(["buvid3", "buvid4", "b_nut", "CURRENT_FNVAL"]);
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(status, body = "") {
  return new Error(`HTTP ${status}: ${String(body).slice(0, 500)}`);
}

function jsonError(body) {
  return new Error(`B站接口返回的不是有效 JSON：${String(body).slice(0, 300)}`);
}

function responseSetCookies(headers) {
  if (typeof headers?.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers?.get?.("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

export function buildMixinKey(imgKey, subKey) {
  const source = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map((index) => source[index] ?? "").join("").slice(0, 32);
}

export function signWbiParams(params, imgKey, subKey, nowMs = Date.now()) {
  const signedParams = { ...params, wts: Math.floor(nowMs / 1000) };
  const query = Object.keys(signedParams)
    .sort()
    .map((key) => {
      const value = String(signedParams[key] ?? "").replace(/[!'()*]/g, "");
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join("&");
  const wRid = createHash("md5").update(query + buildMixinKey(imgKey, subKey)).digest("hex");
  return { query, wRid, wts: signedParams.wts };
}

export class BilibiliClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.random = options.random ?? Math.random;
    this.nowImpl = options.nowImpl ?? Date.now;
    this.onSessionUpdate = options.onSessionUpdate ?? null;
    this.onThrottleUpdate = options.onThrottleUpdate ?? null;
    this.requestCount = 0;
    this.lastRequestAt = Math.max(0, Number(options.initialThrottleState?.lastRequestAt) || 0);
    this.requestsSinceHeavyCooldown = Math.max(
      0,
      Number(options.initialThrottleState?.requestsSinceHeavyCooldown) || 0,
    );
    this.cookies = new Map(
      Object.entries(options.initialSession?.cookies ?? {})
        .filter(([name, value]) => ANONYMOUS_COOKIE_NAMES.has(name) && typeof value === "string" && value),
    );
    this.sessionReady = this.cookies.has("buvid3") && this.cookies.has("buvid4");
    const cachedKeys = options.initialSession?.wbiKeys;
    this.wbiKeys = cachedKeys?.imgKey
      && cachedKeys?.subKey
      && Number(cachedKeys?.expiresAt) > this.nowImpl()
      ? {
        imgKey: String(cachedKeys.imgKey),
        subKey: String(cachedKeys.subKey),
        expiresAt: Number(cachedKeys.expiresAt),
      }
      : null;
  }

  sessionSnapshot() {
    return {
      version: 1,
      cookies: Object.fromEntries(
        [...this.cookies.entries()].filter(([name]) => ANONYMOUS_COOKIE_NAMES.has(name)),
      ),
      wbiKeys: this.wbiKeys,
      updatedAt: this.nowImpl(),
    };
  }

  persistSession() {
    this.onSessionUpdate?.(this.sessionSnapshot());
  }

  persistThrottleState() {
    this.onThrottleUpdate?.({
      version: 1,
      lastRequestAt: this.lastRequestAt,
      requestsSinceHeavyCooldown: this.requestsSinceHeavyCooldown,
      updatedAt: this.nowImpl(),
    });
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  absorbCookies(headers) {
    for (const header of responseSetCookies(headers)) {
      const pair = String(header).split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  browserHeaders({ document = false } = {}) {
    const headers = {
      "User-Agent": USER_AGENT,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "Sec-CH-UA": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-Fetch-Mode": document ? "navigate" : "cors",
      "Sec-Fetch-Site": document ? "none" : "same-site",
      "Sec-Fetch-Dest": document ? "document" : "empty",
      Accept: document
        ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
        : "application/json, text/plain, */*",
    };
    if (!document) headers.Referer = "https://search.bilibili.com/";
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  async throttle() {
    const min = Number(this.config.requestDelayMinMs);
    const max = Number(this.config.requestDelayMaxMs);
    const heavyRequestCount = Number(this.config.heavyKeywordRequestCount ?? 0);
    const heavyCooldownMs = Number(this.config.heavyKeywordCooldownMs ?? 0);
    let elapsed = this.nowImpl() - this.lastRequestAt;
    if (
      this.lastRequestAt
      && heavyRequestCount > 0
      && this.requestsSinceHeavyCooldown >= heavyRequestCount
    ) {
      if (heavyCooldownMs > 0 && elapsed < heavyCooldownMs) {
        await this.sleepImpl(heavyCooldownMs - elapsed);
      }
      this.requestsSinceHeavyCooldown = 0;
      this.persistThrottleState();
      elapsed = this.nowImpl() - this.lastRequestAt;
    }
    const targetDelay = min + Math.floor(this.random() * Math.max(1, max - min + 1));
    if (this.lastRequestAt && elapsed < targetDelay) await this.sleepImpl(targetDelay - elapsed);
  }

  async request(url, { document = false } = {}) {
    await this.throttle();
    this.lastRequestAt = this.nowImpl();
    this.requestsSinceHeavyCooldown += 1;
    this.persistThrottleState();
    this.requestCount += 1;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.browserHeaders({ document }),
      redirect: "follow",
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    this.absorbCookies(response.headers);
    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch { /* 保留 HTTP 状态即可 */ }
      throw httpError(response.status, body);
    }
    return response;
  }

  async requestJson(url) {
    const response = await this.request(url);
    let body;
    try {
      body = await response.text();
      return JSON.parse(body);
    } catch {
      if (body === undefined && typeof response.json === "function") return response.json();
      throw jsonError(body);
    }
  }

  async ensureAnonymousSession() {
    if (this.sessionReady) return;
    await this.request(HOME_URL, { document: true });
    const fingerprint = await this.requestJson(SPI_URL);
    if (fingerprint?.code === 0 && fingerprint?.data?.b_3) {
      this.cookies.set("buvid3", fingerprint.data.b_3);
    }
    if (fingerprint?.code === 0 && fingerprint?.data?.b_4) {
      this.cookies.set("buvid4", fingerprint.data.b_4);
    }
    this.cookies.set("CURRENT_FNVAL", "4048");
    if (!this.cookies.has("buvid3")) {
      const error = new Error("B站匿名会话未返回 buvid3 标识，已停止请求且不会尝试绕过验证");
      error.noRetry = true;
      throw error;
    }
    this.sessionReady = true;
    this.persistSession();
  }

  async getWbiKeys({ refresh = false } = {}) {
    if (this.wbiKeys && !refresh) return this.wbiKeys;
    await this.ensureAnonymousSession();
    const payload = await this.requestJson(NAV_URL);
    const imgUrl = payload?.data?.wbi_img?.img_url;
    const subUrl = payload?.data?.wbi_img?.sub_url;
    const imgKey = imgUrl?.split("/").pop()?.split(".")[0];
    const subKey = subUrl?.split("/").pop()?.split(".")[0];
    if (!imgKey || !subKey) {
      if (payload?.code !== 0) {
        throw new Error(`B站导航接口错误 ${payload?.code}: ${payload?.message ?? "未知错误"}；且缺少 WBI 图片密钥`);
      }
      throw new Error("B站导航接口缺少 WBI 图片密钥");
    }
    const cacheHours = Math.max(1, Number(this.config.wbiKeyCacheHours ?? 6));
    this.wbiKeys = {
      imgKey,
      subKey,
      expiresAt: this.nowImpl() + cacheHours * 3600_000,
    };
    this.persistSession();
    return this.wbiKeys;
  }

  async signedSearchUrl(params) {
    const { imgKey, subKey } = await this.getWbiKeys();
    const signed = signWbiParams(params, imgKey, subKey, this.nowImpl());
    return new URL(`${SEARCH_URL}?${signed.query}&w_rid=${signed.wRid}`);
  }

  async search({ keyword, order, page, startTs, endTs }) {
    const params = {
      search_type: "video",
      keyword,
      order,
      page: String(page),
      page_size: "20",
      pubtime_begin_s: String(startTs),
      pubtime_end_s: String(endTs),
    };

    let lastError;
    let emptyResponses = 0;
    let errorAttempts = 0;
    let rateLimitAttempts = 0;
    while (true) {
      try {
        const url = await this.signedSearchUrl(params);
        const payload = await this.requestJson(url);
        if (payload?.code !== 0) throw new Error(`B站接口错误 ${payload?.code}: ${payload?.message ?? "未知错误"}`);
        const explicitZeroResults = payload.data
          && Object.hasOwn(payload.data, "numResults")
          && Number(payload.data.numResults) === 0;
        if (explicitZeroResults && payload.data.result == null) {
          emptyResponses += 1;
          if (page === 1 && emptyResponses < this.config.emptyResultConfirmations) {
            await this.sleepImpl(this.config.emptyResultDelayMs);
            continue;
          }
          return { items: [], numPages: 0, numResults: 0, url: url.toString() };
        }
        if (!payload.data || !Array.isArray(payload.data.result)) {
          throw new Error(`B站接口返回结构异常：缺少 data.result；摘要 ${JSON.stringify(payload).slice(0, 500)}`);
        }
        return {
          items: payload.data.result,
          numPages: Number(payload.data.numPages ?? 0),
          numResults: Number(payload.data.numResults ?? 0),
          url: url.toString(),
        };
      } catch (error) {
        lastError = error;
        if (error?.noRetry) break;
        if (errorAttempts >= this.config.maxRetries) break;
        const errorText = `${String(error?.message ?? error)} ${String(error?.stdout ?? "")}`;
        const rateLimited = errorText.includes("v_voucher") || errorText.includes("-412") || errorText.includes("HTTP 412");
        if (rateLimited) {
          if (rateLimitAttempts >= this.config.maxRateLimitRetries) break;
          rateLimitAttempts += 1;
          await this.sleepImpl(this.config.rateLimitCooldownMs);
          continue;
        }
        const backoff = Math.min(60_000, 2_000 * (2 ** errorAttempts)) + Math.floor(this.random() * 1000);
        errorAttempts += 1;
        await this.sleepImpl(backoff);
      }
    }
    throw lastError;
  }

  async scanThresholdWindow({ keyword, startTs, endTs, minViews, onItems, depth = 0 }) {
    const first = await this.search({ keyword, order: "click", page: 1, startTs, endTs });
    if (!first.items.length) return { windows: 1, pages: 1, saturated: false };
    const maxPage = Math.min(Math.max(first.numPages, 1), 50);

    if (maxPage >= 50) {
      const last = await this.search({ keyword, order: "click", page: 50, startTs, endTs });
      if (shouldSplitWindow({
        numPages: first.numPages,
        lastPageItems: last.items,
        minViews,
        startTs,
        endTs,
        minSplitMinutes: this.config.minSplitMinutes,
        depth,
        maxSplitDepth: this.config.maxSplitDepth,
      })) {
        const midpoint = Math.floor((startTs + endTs) / 2);
        const left = await this.scanThresholdWindow({ keyword, startTs, endTs: midpoint, minViews, onItems, depth: depth + 1 });
        const right = await this.scanThresholdWindow({ keyword, startTs: midpoint + 1, endTs, minViews, onItems, depth: depth + 1 });
        return {
          windows: 1 + left.windows + right.windows,
          pages: 2 + left.pages + right.pages,
          saturated: left.saturated || right.saturated,
        };
      }
    }

    let pages = 0;
    let saturated = false;
    let previousSignature = "";
    for (let page = 1; page <= maxPage; page += 1) {
      const result = page === 1 ? first : await this.search({ keyword, order: "click", page, startTs, endTs });
      pages += 1;
      if (!result.items.length) break;
      const signature = result.items.map((item) => item.bvid).join("|");
      if (signature && signature === previousSignature) throw new Error(`B站接口重复返回第 ${page} 页，已停止以避免死循环`);
      previousSignature = signature;

      const qualifying = result.items.filter((item) => parsePlay(item.play) >= minViews);
      if (qualifying.length) await onItems(qualifying, { keyword, startTs, endTs, page, sourceUrl: result.url });
      if (qualifying.length < result.items.length) break;
      if (page === 50 && result.items.every((item) => parsePlay(item.play) >= minViews)) saturated = true;
    }
    return { windows: 1, pages, saturated };
  }
}
