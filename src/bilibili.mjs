import { parsePlay, shouldSplitWindow } from "./core.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const SEARCH_URL = "https://api.bilibili.com/x/web-interface/search/type";
const execFileAsync = promisify(execFile);
const HTTP_STATUS_MARKER = "\n__HTTP_STATUS__:";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseCurlJsonOutput(stdout) {
  const text = String(stdout);
  const markerIndex = text.lastIndexOf(HTTP_STATUS_MARKER);
  if (markerIndex < 0) throw new Error(`curl 响应缺少 HTTP 状态：${text.slice(0, 300)}`);
  const body = text.slice(0, markerIndex);
  const status = Number.parseInt(text.slice(markerIndex + HTTP_STATUS_MARKER.length).trim(), 10);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw new Error(`HTTP ${Number.isInteger(status) ? status : "未知"}: ${body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`B站接口返回的不是有效 JSON：${body.slice(0, 300)}`);
  }
}

export class BilibiliClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? null;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.random = options.random ?? Math.random;
    this.requestCount = 0;
    this.lastRequestAt = 0;
  }

  async requestJson(url) {
    if (this.fetchImpl) {
      const response = await this.fetchImpl(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://search.bilibili.com/",
          Accept: "application/json,text/plain,*/*",
        },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    const curlPath = process.platform === "win32" ? "C:\\Windows\\System32\\curl.exe" : "curl";
    const timeoutSeconds = Math.max(1, Math.ceil(this.config.requestTimeoutMs / 1000));
    const { stdout } = await execFileAsync(curlPath, [
      "-sS", "--compressed",
      "--connect-timeout", "10", "--max-time", String(timeoutSeconds),
      "-A", "Mozilla/5.0",
      "-e", "https://search.bilibili.com/",
      "-H", "Accept: application/json,text/plain,*/*",
      "-w", `${HTTP_STATUS_MARKER}%{http_code}`,
      url.toString(),
    ], {
      encoding: "utf8",
      timeout: this.config.requestTimeoutMs + 5_000,
      maxBuffer: 30 * 1024 * 1024,
      windowsHide: true,
    });
    return parseCurlJsonOutput(stdout);
  }

  async throttle() {
    const min = this.config.requestDelayMinMs;
    const max = this.config.requestDelayMaxMs;
    const targetDelay = min + Math.floor(this.random() * Math.max(1, max - min + 1));
    const elapsed = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt && elapsed < targetDelay) await this.sleepImpl(targetDelay - elapsed);
  }

  async search({ keyword, order, page, startTs, endTs }) {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("search_type", "video");
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("order", order);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "20");
    url.searchParams.set("pubtime_begin_s", String(startTs));
    url.searchParams.set("pubtime_end_s", String(endTs));

    let lastError;
    let emptyResponses = 0;
    let errorAttempts = 0;
    let rateLimitAttempts = 0;
    while (true) {
      await this.throttle();
      this.lastRequestAt = Date.now();
      this.requestCount += 1;
      try {
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
          throw new Error(`B站接口返回结构异常：缺少 data.result；摘要=${JSON.stringify(payload).slice(0, 500)}`);
        }
        return {
          items: payload.data.result,
          numPages: Number(payload.data.numPages ?? 0),
          numResults: Number(payload.data.numResults ?? 0),
          url: url.toString(),
        };
      } catch (error) {
        lastError = error;
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
