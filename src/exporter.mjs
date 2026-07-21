import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { activeKeywordGroups, buildPartitionDatasets } from "./rules.mjs";

const COLORS = {
  navy: "#12304A",
  blue: "#1677A6",
  cyan: "#DFF4FA",
  pale: "#F4F8FB",
  border: "#D7E2EA",
  green: "#DFF3E4",
  greenText: "#176B37",
  white: "#FFFFFF",
  text: "#20303C",
  muted: "#5E7180",
};

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

function formatChinaTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date).replaceAll("/", "-");
}

function toChinaExcelDate(seconds) {
  // Excel 日期没有时区信息；artifact-tool 按 UTC 组件写入序列值，
  // 因此先平移到 Asia/Shanghai，确保 Excel/飞书中显示北京时间。
  return new Date((Number(seconds) + 8 * 3600) * 1000);
}

function styleTitle(sheet, rangeAddress) {
  const range = sheet.getRange(rangeAddress);
  range.format = {
    fill: COLORS.navy,
    font: { bold: true, color: COLORS.white, fontSize: 16 },
    verticalAlignment: "center",
    horizontalAlignment: "left",
  };
  range.format.rowHeight = 32;
}

function styleHeader(range) {
  range.format = {
    fill: COLORS.blue,
    font: { bold: true, color: COLORS.white },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: COLORS.border },
  };
  range.format.rowHeight = 26;
}

function buildSummarySheet(workbook, rows, config, scopeLabel) {
  const sheet = workbook.worksheets.add("BV汇总");
  sheet.showGridLines = false;
  sheet.getRange("A1:D1").merge();
  sheet.getRange("A1").values = [[`B站 AI 视频 BV号${scopeLabel}`]];
  styleTitle(sheet, "A1:D1");

  sheet.getRange("A2:D2").merge();
  sheet.getRange("A2").values = [[`关键词：${activeKeywordGroups(config).map((group) => group.label).join("、")}　|　门槛：播放量 ≥ ${config.minViews.toLocaleString("zh-CN")}　|　滚动 ${config.lookbackDays} 天　|　导出：${formatChinaTime()}`]];
  sheet.getRange("A2:D2").format = {
    fill: COLORS.cyan,
    font: { color: COLORS.text, fontSize: 10 },
    wrapText: true,
    verticalAlignment: "center",
  };
  sheet.getRange("A2:D2").format.rowHeight = 32;

  sheet.getRange("A3:D3").values = [["BV号", "视频直链", "BV号", "视频直链"]];
  styleHeader(sheet.getRange("A3:D3"));

  const pairRows = [];
  for (let index = 0; index < rows.length; index += 2) {
    const left = rows[index];
    const right = rows[index + 1];
    pairRows.push([left?.bvid ?? "", left?.url ?? "", right?.bvid ?? "", right?.url ?? ""]);
  }
  if (!pairRows.length) {
    pairRows.push(["暂无符合条件的视频", "", "", ""]);
  }
  const endRow = 3 + pairRows.length;
  sheet.getRange(`A4:D${endRow}`).values = pairRows;
  sheet.getRange(`A4:D${endRow}`).format = {
    fill: COLORS.white,
    font: { color: COLORS.text },
    verticalAlignment: "center",
    borders: { insideHorizontal: { style: "thin", color: COLORS.border } },
  };
  sheet.getRange(`B4:B${endRow}`).format.font = { color: COLORS.blue };
  sheet.getRange(`D4:D${endRow}`).format.font = { color: COLORS.blue };
  sheet.getRange(`A4:A${endRow}`).format.rowHeight = 22;
  sheet.getRange(`A1:A${endRow}`).format.columnWidth = 17;
  sheet.getRange(`B1:B${endRow}`).format.columnWidth = 48;
  sheet.getRange(`C1:C${endRow}`).format.columnWidth = 17;
  sheet.getRange(`D1:D${endRow}`).format.columnWidth = 48;
  sheet.freezePanes.freezeRows(3);
  return sheet;
}

function buildDetailSheet(workbook, rows, config, scopeLabel) {
  const sheet = workbook.worksheets.add("视频明细");
  sheet.showGridLines = false;
  const headers = [
    "BV号", "视频链接", "标题", "内容分区", "播放量", "发布时间", "UP主", "B站分区",
    "关键词组", "命中关键词", "首次达标时间", "最近检查时间", "相关性依据",
  ];
  const lastCol = excelColumnName(headers.length - 1);
  sheet.getRange(`A1:${lastCol}1`).merge();
  sheet.getRange("A1").values = [[`B站 AI 视频明细${scopeLabel}`]];
  styleTitle(sheet, `A1:${lastCol}1`);
  sheet.getRange(`A2:${lastCol}2`).merge();
  sheet.getRange("A2").values = [[`收录条件：最近 ${config.lookbackDays} 天、播放量 ≥ ${config.minViews.toLocaleString("zh-CN")}、通过平衡相关性过滤。数据来源：B站公开网页搜索结果。`]];
  sheet.getRange(`A2:${lastCol}2`).format = {
    fill: COLORS.cyan,
    font: { color: COLORS.muted, fontSize: 10 },
    verticalAlignment: "center",
  };
  sheet.getRange(`A3:${lastCol}3`).values = [headers];
  styleHeader(sheet.getRange(`A3:${lastCol}3`));

  const values = rows.map((row) => [
    row.bvid,
    row.url,
    row.title,
    row.content_partitions ?? "",
    Number(row.play),
    toChinaExcelDate(row.pubdate),
    row.author,
    row.category,
    row.keywords,
    row.matched_queries ?? "",
    toChinaExcelDate(row.first_qualified_at),
    toChinaExcelDate(row.last_checked_at),
    row.relevance_reason,
  ]);
  if (!values.length) {
    values.push(["暂无符合条件的视频", "", "", "", 0, null, "", "", "", "", null, null, ""]);
  }
  const endRow = 3 + values.length;
  sheet.getRange(`A4:${lastCol}${endRow}`).values = values;
  sheet.getRange(`A4:${lastCol}${endRow}`).format = {
    font: { color: COLORS.text },
    verticalAlignment: "center",
    borders: { insideHorizontal: { style: "thin", color: COLORS.border } },
  };
  sheet.getRange(`B4:B${endRow}`).format.font = { color: COLORS.blue };
  sheet.getRange(`E4:E${endRow}`).format.numberFormat = "#,##0";
  sheet.getRange(`F4:F${endRow}`).format.numberFormat = "yyyy-mm-dd hh:mm";
  sheet.getRange(`K4:L${endRow}`).format.numberFormat = "yyyy-mm-dd hh:mm";
  sheet.getRange(`E4:E${endRow}`).conditionalFormats.add("cellIs", {
    operator: "greaterThanOrEqual",
    formula: config.minViews,
    format: { fill: COLORS.green, font: { color: COLORS.greenText, bold: true } },
  });

  const widths = [17, 43, 48, 22, 13, 19, 20, 14, 24, 24, 19, 19, 48];
  widths.forEach((width, index) => {
    sheet.getRange(`${excelColumnName(index)}1:${excelColumnName(index)}${endRow}`).format.columnWidth = width;
  });
  sheet.getRange(`C4:C${endRow}`).format.wrapText = true;
  sheet.getRange(`M4:M${endRow}`).format.wrapText = true;
  sheet.getRange(`A4:${lastCol}${endRow}`).format.rowHeight = 34;
  sheet.freezePanes.freezeRows(3);
  sheet.freezePanes.freezeColumns(2);
  if (rows.length) {
    const table = sheet.tables.add(`A3:${lastCol}${endRow}`, true, "VideoDetailsTable");
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
  }
  return sheet;
}

async function atomicSave(workbook, finalPath) {
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp.xlsx`;
  const backupPath = `${finalPath}.bak`;
  await fs.rm(tempPath, { force: true });
  await fs.rm(backupPath, { force: true });
  const blob = await SpreadsheetFile.exportXlsx(workbook);
  await blob.save(tempPath);
  await fs.rm(`${tempPath}.inspect.ndjson`, { force: true });
  let backedUp = false;
  try {
    await fs.rename(finalPath, backupPath);
    backedUp = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(tempPath, finalPath);
    if (backedUp) await fs.rm(backupPath, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fs.rm(`${tempPath}.inspect.ndjson`, { force: true });
  } catch (error) {
    if (backedUp) await fs.rename(backupPath, finalPath);
    throw error;
  }
}

export async function exportWorkbook({ rows, config, outputPath, scopeLabel = "", qaDir = null }) {
  const datasets = buildPartitionDatasets(rows, config);
  const workbook = Workbook.create();
  buildSummarySheet(workbook, datasets.rows, config, scopeLabel);
  buildDetailSheet(workbook, datasets.rows, config, scopeLabel);

  const summaryCheck = await workbook.inspect({
    kind: "table", sheetId: "BV汇总", range: "A1:D12", include: "values,formulas",
    tableMaxRows: 12, tableMaxCols: 4, maxChars: 5000,
  });
  const detailCheck = await workbook.inspect({
    kind: "table", sheetId: "视频明细", range: "A1:M10", include: "values,formulas",
    tableMaxRows: 10, tableMaxCols: 13, maxChars: 8000,
  });
  const errors = await workbook.inspect({
    kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|HYPERLINK is not implemented",
    options: { useRegex: true, maxResults: 100 }, summary: "final compatibility error scan",
  });

  if (qaDir) {
    await fs.mkdir(qaDir, { recursive: true });
    const summaryPreview = await workbook.render({ sheetName: "BV汇总", autoCrop: "all", scale: 1.25, format: "png" });
    const detailPreview = await workbook.render({ sheetName: "视频明细", range: "A1:M12", scale: 1.1, format: "png" });
    await fs.writeFile(path.join(qaDir, "BV汇总.png"), new Uint8Array(await summaryPreview.arrayBuffer()));
    await fs.writeFile(path.join(qaDir, "视频明细.png"), new Uint8Array(await detailPreview.arrayBuffer()));
    await fs.writeFile(path.join(qaDir, "inspect.txt"), `${summaryCheck.ndjson}\n${detailCheck.ndjson}\n${errors.ndjson}\n`, "utf8");
  }

  if (/"(?:value|text)":"(?:#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A)|HYPERLINK is not implemented)/.test(errors.ndjson)) {
    throw new Error(`Excel 兼容性错误扫描未通过：${errors.ndjson.slice(0, 1000)}`);
  }
  await atomicSave(workbook, outputPath);
  return { outputPath, rowCount: rows.length };
}
