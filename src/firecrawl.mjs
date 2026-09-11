import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeVideo } from './core.mjs';

const execFileAsync = promisify(execFile);

// Quote every argument as a PowerShell literal; never interpolate page content as code.
export function cliInvocation(args, platform = process.platform) {
  if (platform !== 'win32') return { file: 'firecrawl', args };
  const quoted = args.map(arg => "'" + String(arg).replaceAll("'", "''") + "'").join(' ');
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; & firecrawl ${quoted}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`],
  };
}

export class FirecrawlClient {
  constructor({ evidenceDir, limit = 20, execute = execFileAsync }) {
    this.evidenceDir = evidenceDir;
    this.limit = limit;
    this.execute = execute;
    this.requestCount = 0;
  }

  async run(args) {
    const command = cliInvocation(args);
    try {
      return await this.execute(command.file, command.args, {
        windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024,
      });
    } catch {
      // CLI stderr may contain credentials or third-party text; do not persist it.
      throw new Error('Firecrawl CLI 不可用、请求失败或超时；请运行 firecrawl --status 检查安装、登录和额度');
    }
  }

  async check() {
    await this.run(['--version']);
    return { cliAvailable: true, authenticationVerified: false,
      note: '仅检查 CLI；登录、额度和联网需用 firecrawl --status 及一次搜索确认' };
  }

  async search({ keyword, startTs }) {
    await fs.mkdir(this.evidenceDir, { recursive: true });
    const file = path.join(this.evidenceDir, `search-${randomUUID()}.json`);
    // Widen the search-day boundary; the collector checks exact timestamps afterwards.
    const after = new Date((startTs - 86400) * 1000).toISOString().slice(0, 10);
    const query = `site:bilibili.com/video ${keyword} after:${after}`;
    this.requestCount++;
    await this.run(['search', query, '--scrape', '--limit', String(this.limit), '--json', '-o', file]);
    const payload = JSON.parse(await fs.readFile(file, 'utf8'));
    if (payload.success === false) throw new Error('Firecrawl 返回失败状态，请检查服务或额度');
    const documents = payload.data?.web ?? payload.web;
    if (!Array.isArray(documents)) throw new Error('Firecrawl 返回格式异常，未找到 web 结果');
    return { documents, evidenceFile: file };
  }
}

export function parseFirecrawlVideo(document) {
  let url;
  try { url = new URL(document.url ?? document.metadata?.sourceURL); } catch { return null; }
  if (!['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)
    || !['http:', 'https:'].includes(url.protocol)) return null;
  const bvid = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/)?.[1];
  const metadata = document.metadata ?? {};
  if (!bvid || Number(metadata.statusCode) !== 200 || !document.markdown) return null;
  const title = document.markdown.match(/^#\s+(.+)$/m)?.[1]?.replace(/\\([\[\]_*])/g, '$1');
  const date = metadata['video:release_date'];
  // Reject timezone-less dates and rounded/snippet-only counts instead of guessing.
  if (!title || typeof date !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(date)) return null;
  const pubdate = Date.parse(date) / 1000;
  const description = String(metadata.description ?? '');
  const count = description.match(/视频播放量\s*([0-9]+(?:,[0-9]{3})*)(?=\s*[,，。;；]|\s*$)/)?.[1];
  if (!count || !Number.isFinite(pubdate)) return null;
  return normalizeVideo({ bvid, title, pubdate, play: Number(count.replaceAll(',', '')),
    description: description.split(/[,，]?\s*视频播放量/)[0],
    tags: metadata['video:tag'] ?? [], author: metadata.author ?? '' });
}
