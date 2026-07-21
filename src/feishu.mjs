import fs from "node:fs/promises";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
export const FEISHU_HEADERS = [
  "BV号", "视频直链", "标题", "内容分区", "播放量", "发布时间", "UP主", "B站分区",
  "关键词组", "命中关键词", "首次收集时间", "最近检查时间", "相关性依据",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function excelColumnName(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function formatChinaDateTime(epochSeconds) {
  if (!Number(epochSeconds)) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(Number(epochSeconds) * 1000));
}

export function buildFeishuMatrix(rows) {
  const sorted = [...rows].sort((left, right) => (
    Number(right.first_qualified_at) - Number(left.first_qualified_at)
    || Number(right.play) - Number(left.play)
    || String(left.bvid).localeCompare(String(right.bvid))
  ));
  return [
    FEISHU_HEADERS,
    ...sorted.map((row) => [
      row.bvid,
      row.url,
      row.title,
      row.content_partitions ?? "",
      Number(row.play),
      formatChinaDateTime(row.pubdate),
      row.author,
      row.category,
      row.keywords,
      row.matched_queries ?? "",
      formatChinaDateTime(row.first_qualified_at),
      formatChinaDateTime(row.last_checked_at),
      row.relevance_reason,
    ]),
  ];
}

export function parseFeishuSheetUrl(value) {
  if (!value) return { spreadsheetToken: "", sheetId: "" };
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  const sheetsIndex = parts.indexOf("sheets");
  if (sheetsIndex < 0 || !parts[sheetsIndex + 1]) {
    throw new Error("飞书目标必须是电子表格链接，格式应包含 /sheets/{spreadsheet_token}");
  }
  return {
    spreadsheetToken: parts[sheetsIndex + 1],
    sheetId: url.searchParams.get("sheet") ?? url.searchParams.get("sheet_id") ?? "",
  };
}

function envBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export async function loadFeishuSettings(configPath, env = process.env, { required = false } = {}) {
  let local = {};
  try {
    local = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parsedUrl = parseFeishuSheetUrl(env.FEISHU_SHEET_URL ?? local.sheet_url ?? "");
  const settings = {
    enabled: envBoolean(env.FEISHU_SYNC_ENABLED, Boolean(local.enabled)),
    appId: env.FEISHU_APP_ID ?? local.app_id ?? "",
    appSecret: env.FEISHU_APP_SECRET ?? local.app_secret ?? "",
    spreadsheetToken: env.FEISHU_SPREADSHEET_TOKEN ?? local.spreadsheet_token ?? parsedUrl.spreadsheetToken,
    sheetId: env.FEISHU_SHEET_ID ?? local.sheet_id ?? parsedUrl.sheetId,
    sheetUrl: env.FEISHU_SHEET_URL ?? local.sheet_url ?? "",
    batchRows: Math.max(1, Math.min(400, Number(env.FEISHU_BATCH_ROWS ?? local.batch_rows ?? 200))),
    clearUntilRow: Math.max(1000, Number(env.FEISHU_CLEAR_UNTIL_ROW ?? local.clear_until_row ?? 20000)),
  };
  if (required) {
    const missing = [];
    if (!settings.appId) missing.push("app_id / FEISHU_APP_ID");
    if (!settings.appSecret) missing.push("app_secret / FEISHU_APP_SECRET");
    if (!settings.spreadsheetToken) missing.push("sheet_url / FEISHU_SHEET_URL");
    if (missing.length) throw new Error(`飞书配置缺少：${missing.join("、")}`);
  }
  return settings;
}

export class FeishuSheetsClient {
  constructor(settings, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
    this.settings = settings;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
    this.accessToken = "";
  }

  async request(path, { method = "GET", body = null, authenticated = true } = {}) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (authenticated) {
      if (!this.accessToken) await this.authenticate();
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    const response = await this.fetchImpl(`${FEISHU_API_BASE}${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`飞书接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`);
    }
    if (!response.ok || Number(payload.code ?? 0) !== 0) {
      throw new Error(`飞书接口失败（HTTP ${response.status} / code ${payload.code ?? "未知"}）：${payload.msg ?? text.slice(0, 300)}`);
    }
    return payload;
  }

  async authenticate() {
    const payload = await this.request("/auth/v3/tenant_access_token/internal", {
      method: "POST",
      authenticated: false,
      body: { app_id: this.settings.appId, app_secret: this.settings.appSecret },
    });
    this.accessToken = payload.tenant_access_token;
    if (!this.accessToken) throw new Error("飞书授权成功响应中缺少 tenant_access_token");
    return this.accessToken;
  }

  async resolveSheetId() {
    if (this.settings.sheetId) return this.settings.sheetId;
    const sheets = await this.listSheets();
    const sheetId = sheets[0]?.sheetId;
    if (!sheetId) throw new Error("目标飞书电子表格没有可写工作表，且链接中未包含 sheet 参数");
    this.settings.sheetId = sheetId;
    return sheetId;
  }

  async listSheets() {
    const payload = await this.request(
      `/sheets/v3/spreadsheets/${encodeURIComponent(this.settings.spreadsheetToken)}/sheets/query`
    );
    const sheets = payload.data?.sheets ?? payload.data?.items ?? [];
    return sheets.map((sheet) => ({
      sheetId: sheet.sheet_id ?? sheet.sheetId ?? sheet.properties?.sheetId,
      title: sheet.title ?? sheet.name ?? sheet.properties?.title ?? "",
      index: Number(sheet.index ?? sheet.properties?.index ?? 0),
    })).filter((sheet) => sheet.sheetId);
  }

  async addSheet(title, index) {
    const payload = await this.request(
      `/sheets/v2/spreadsheets/${encodeURIComponent(this.settings.spreadsheetToken)}/sheets_batch_update`,
      {
        method: "POST",
        body: { requests: [{ addSheet: { properties: { title, index } } }] },
      },
    );
    const properties = payload.data?.replies?.[0]?.addSheet?.properties
      ?? payload.data?.replies?.[0]?.add_sheet?.properties;
    const sheetId = properties?.sheetId ?? properties?.sheet_id;
    if (!sheetId) throw new Error(`飞书已响应新增工作表“${title}”，但未返回 sheetId`);
    return { sheetId, title, index: Number(properties?.index ?? index) };
  }

  async deleteSheets(sheetIds) {
    if (!sheetIds.length) return [];
    await this.request(
      `/sheets/v2/spreadsheets/${encodeURIComponent(this.settings.spreadsheetToken)}/sheets_batch_update`,
      {
        method: "POST",
        body: { requests: sheetIds.map((sheetId) => ({ deleteSheet: { sheetId } })) },
      },
    );
    return sheetIds;
  }

  async ensurePartitionSheets(partitions, mainSheetId) {
    if (!partitions.length) return [];
    const sheets = await this.listSheets();
    const byTitle = new Map(sheets.map((sheet) => [sheet.title, sheet]));
    const resolved = [];
    let nextIndex = sheets.length;
    for (const partition of partitions) {
      let sheet = byTitle.get(partition.name);
      if (sheet?.sheetId === mainSheetId) {
        throw new Error(`分区工作表“${partition.name}”与主工作表重名，请修改 partitionName 或 mergeInto`);
      }
      if (!sheet) {
        sheet = await this.addSheet(partition.name, nextIndex);
        nextIndex += 1;
        byTitle.set(partition.name, sheet);
      }
      resolved.push({ ...partition, sheetId: sheet.sheetId });
    }
    return resolved;
  }

  async removeStalePartitionSheets(activeNames, managedNames, mainSheetId) {
    if (!managedNames.length) return [];
    const active = new Set(activeNames);
    const managed = new Set(managedNames);
    const stale = (await this.listSheets()).filter((sheet) => (
      sheet.sheetId !== mainSheetId && managed.has(sheet.title) && !active.has(sheet.title)
    ));
    await this.deleteSheets(stale.map((sheet) => sheet.sheetId));
    return stale.map((sheet) => sheet.title);
  }

  async doctor() {
    await this.authenticate();
    const sheetId = await this.resolveSheetId();
    return {
      authenticated: true,
      spreadsheetToken: this.settings.spreadsheetToken,
      sheetId,
      sheetUrl: this.settings.sheetUrl,
    };
  }

  async writeRange(range, values) {
    return this.request(`/sheets/v2/spreadsheets/${encodeURIComponent(this.settings.spreadsheetToken)}/values`, {
      method: "PUT",
      body: { valueRange: { range, values } },
    });
  }

  async readRowCount(sheetId) {
    const range = `${sheetId}!A1:A${this.settings.clearUntilRow}`;
    const payload = await this.request(
      `/sheets/v2/spreadsheets/${encodeURIComponent(this.settings.spreadsheetToken)}/values/${encodeURIComponent(range)}`,
    );
    const values = payload.data?.valueRange?.values ?? payload.data?.value_range?.values ?? [];
    if (!Array.isArray(values)) return 0;
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (String(values[index]?.[0] ?? "").trim()) return index + 1;
    }
    return 0;
  }

  async clearRows(sheetId, startRow, endRow, lastColumn, columnCount = FEISHU_HEADERS.length) {
    if (startRow > endRow) return;
    for (let offset = startRow; offset <= endRow; offset += this.settings.batchRows) {
      const batchEnd = Math.min(endRow, offset + this.settings.batchRows - 1);
      const blankRows = Array.from(
        { length: batchEnd - offset + 1 },
        () => new Array(columnCount).fill(""),
      );
      await this.writeRange(`${sheetId}!A${offset}:${lastColumn}${batchEnd}`, blankRows);
      if (batchEnd < endRow) await this.sleepImpl(350);
    }
  }

  async syncSheet(sheetId, rows) {
    const matrix = buildFeishuMatrix(rows);
    const lastColumn = excelColumnName(FEISHU_HEADERS.length - 1);
    const previousRowCount = await this.readRowCount(sheetId);
    for (let offset = 0; offset < matrix.length; offset += this.settings.batchRows) {
      const batch = matrix.slice(offset, offset + this.settings.batchRows);
      const startRow = offset + 1;
      const endRow = startRow + batch.length - 1;
      await this.writeRange(`${sheetId}!A${startRow}:${lastColumn}${endRow}`, batch);
      if (endRow < matrix.length) await this.sleepImpl(350);
    }
    await this.clearRows(sheetId, matrix.length + 1, previousRowCount, lastColumn, FEISHU_HEADERS.length);
    return { rowCount: rows.length, firstBvid: matrix[1]?.[0] ?? null, sheetId };
  }

  async sync(rows, { partitions = [], managedPartitionNames = [] } = {}) {
    const sheetId = await this.resolveSheetId();
    const mainResult = await this.syncSheet(sheetId, rows);
    const partitionSheets = await this.ensurePartitionSheets(partitions, sheetId);
    const partitionResults = [];
    for (const partition of partitionSheets) {
      const result = await this.syncSheet(partition.sheetId, partition.rows);
      partitionResults.push({ name: partition.name, ...result });
      await this.sleepImpl(350);
    }
    const removedPartitions = await this.removeStalePartitionSheets(
      partitions.map((partition) => partition.name),
      managedPartitionNames,
      sheetId,
    );
    return {
      rowCount: mainResult.rowCount,
      firstBvid: mainResult.firstBvid,
      sheetId,
      sheetUrl: this.settings.sheetUrl,
      partitions: partitionResults.map((partition) => ({
        name: partition.name,
        rowCount: partition.rowCount,
        sheetId: partition.sheetId,
      })),
      removedPartitions,
    };
  }
}

export async function syncFeishuSheet(rows, settings, options = {}) {
  const client = new FeishuSheetsClient(settings, options);
  return client.sync(rows);
}
