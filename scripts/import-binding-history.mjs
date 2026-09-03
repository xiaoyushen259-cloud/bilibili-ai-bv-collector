import fs from "node:fs";
import path from "node:path";
import { CollectorDatabase } from "../src/db.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function asRecord(value, defaults = {}) {
  if (typeof value === "string") return { bvid: value, ...defaults };
  return {
    bvid: value?.bvid ?? value?.BV号 ?? value?.bv,
    courseName: value?.courseName ?? value?.课程 ?? defaults.courseName,
    batchLabel: value?.batchLabel ?? value?.批次 ?? defaults.batchLabel,
    sourceFile: defaults.sourceFile,
  };
}

export function parseBindingHistory(content, extension, defaults = {}) {
  if (extension.toLocaleLowerCase("en-US") === ".json") {
    const parsed = JSON.parse(content);
    const values = Array.isArray(parsed) ? parsed : parsed.records;
    if (!Array.isArray(values)) throw new Error("JSON 必须是数组，或包含 records 数组");
    return values.map((value) => asRecord(value, defaults));
  }
  return String(content).split(/\r?\n/).flatMap((line) => {
    const bvid = line.match(/BV[0-9A-Za-z]{10}/)?.[0];
    if (!bvid) return [];
    const columns = line.split(/[,，\t]/).map((value) => value.trim());
    const bvidIndex = columns.findIndex((value) => value.includes(bvid));
    return [{
      bvid,
      courseName: columns[bvidIndex + 1] || defaults.courseName,
      batchLabel: columns[bvidIndex + 2] || defaults.batchLabel,
      sourceFile: defaults.sourceFile,
    }];
  });
}

async function main() {
  const fileOption = option("--file");
  if (!fileOption) throw new Error("请使用 --file 指定 CSV、TXT 或 JSON 成功名单");
  const filePath = path.resolve(fileOption);
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  if (![".csv", ".txt", ".json"].includes(extension)) {
    throw new Error("仅支持 CSV、TXT 或 JSON；请先将 Excel 另存为 CSV");
  }
  const records = parseBindingHistory(fs.readFileSync(filePath, "utf8"), extension, {
    courseName: option("--course", ""),
    batchLabel: option("--batch", ""),
    sourceFile: path.basename(filePath),
  });
  const db = new CollectorDatabase(path.join(ROOT, "data", "collector.sqlite"));
  try {
    const result = db.recordBoundVideos(records);
    console.log(JSON.stringify({ file: filePath, ...result }, null, 2));
  } finally {
    db.close();
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
