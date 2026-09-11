import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { formatChinaDateTime } from './feishu.mjs';

export async function syncVerifiedBatch(client, settings, datasets, backupDir) {
  if (!datasets.complete) throw new Error('本批未补齐，拒绝覆盖飞书');
  const batchRows = settings.batchRows ?? 200;
  if (!Number.isInteger(batchRows) || batchRows < 1) throw new Error('无效的飞书写入批量大小');
  const known = new Set(datasets.partitions.flatMap(p => p.rows.map(row => row.bvid)));
  const managedNames = new Set(datasets.partitions.map(p => p.name));
  const mainId = await client.resolveSheetId();
  const sheets = (await client.listSheets()).filter(s => s.sheetId === mainId || managedNames.has(s.title));
  const backup = [];
  for (const sheet of sheets) {
    const range = `${sheet.sheetId}!A1:M20000`;
    const response = await client.request(`/sheets/v2/spreadsheets/${encodeURIComponent(settings.spreadsheetToken)}/values/${encodeURIComponent(range)}`);
    const values = response.data?.valueRange?.values;
    if (!Array.isArray(values)) throw new Error('无法备份飞书原始内容，取消同步');
    backup.push({ ...sheet, values });
  }
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(path.join(backupDir, `before-sync-${randomUUID()}.json`), JSON.stringify(backup));
  if (backup.some(s => s.values.length >= 20000)) throw new Error('飞书数据达到备份读取上限，需先扩大备份范围；未覆盖任何内容');
  const unknown = new Set(backup.flatMap(s => s.values.slice(1).map(row => String(row[0] ?? '')))
    .filter(bvid => /^BV[0-9A-Za-z]{10}$/.test(bvid) && !known.has(bvid)));
  if (unknown.size) throw new Error(`飞书含 ${unknown.size} 条本机没有的历史 BV，请先交接历史数据库；未覆盖任何内容`);
  try {
  const result = await client.sync(datasets.rows, { partitions: datasets.partitions, managedPartitionNames: [] });
  const expectedSheets = [{ sheetId: result.sheetId, rows: datasets.rows },
    ...result.partitions.map(p => ({ sheetId: p.sheetId, rows: datasets.partitions.find(d => d.name === p.name).rows }))];
  for (const sheet of expectedSheets) {
    const range = `${sheet.sheetId}!A1:M${sheet.rows.length + 2}`;
    const response = await client.request(`/sheets/v2/spreadsheets/${encodeURIComponent(settings.spreadsheetToken)}/values/${encodeURIComponent(range)}`);
    const values = response.data?.valueRange?.values;
    if (!Array.isArray(values)) throw new Error('飞书写入后读回失败，需检查远端，备份已保留');
    const actual = values.slice(1).filter(row => String(row[0] ?? '').startsWith('BV'));
    const expected = new Map(sheet.rows.map(row => [row.bvid, row]));
    if (actual.length !== expected.size || new Set(actual.map(row => row[0])).size !== expected.size
      || actual.some(row => {
        const wanted = expected.get(row[0]);
        return !wanted || Number(row[4]) !== wanted.play || row[3] !== wanted.content_partitions
          || row[5] !== formatChinaDateTime(wanted.pubdate)
          || row[10] !== formatChinaDateTime(wanted.first_qualified_at);
      })) {
      throw new Error('飞书读回的 BV 或播放量不匹配，请检查远端，备份已保留');
    }
  }
  return { ...result, verified: true };
  } catch {
    // The remote API is not transactional. Restore existing sheets and clear only new managed sheets.
    let failed = false;
    for (const sheet of backup) {
      try {
        const currentRows = await client.readRowCount(sheet.sheetId);
        for (let offset = 0; offset < sheet.values.length; offset += batchRows) {
          const rows = sheet.values.slice(offset, offset + batchRows);
          await client.writeRange(`${sheet.sheetId}!A${offset + 1}:M${offset + rows.length}`, rows);
        }
        await client.clearRows(sheet.sheetId, sheet.values.length + 1, currentRows, 'M', 13);
        const range = `${sheet.sheetId}!A1:M${sheet.values.length + 2}`;
        const response = await client.request(`/sheets/v2/spreadsheets/${encodeURIComponent(settings.spreadsheetToken)}/values/${encodeURIComponent(range)}`);
        const restored = response.data?.valueRange?.values;
        const canonical = rows => rows.filter(row => row.some(cell => cell !== '' && cell != null))
          .map(row => Array.from({ length: 13 }, (_, i) => row[i] ?? ''));
        if (!Array.isArray(restored) || JSON.stringify(canonical(restored)) !== JSON.stringify(canonical(sheet.values))) failed = true;
      } catch { failed = true; }
    }
    try {
      for (const sheet of await client.listSheets()) {
        if (!backup.some(s => s.sheetId === sheet.sheetId) && managedNames.has(sheet.title)) {
          await client.clearRows(sheet.sheetId, 1, await client.readRowCount(sheet.sheetId), 'M', 13);
        }
      }
    } catch { failed = true; }
    throw new Error(failed
      ? '飞书同步失败且恢复不完整，暂停使用远端表；请根据本机 feishu-backups 备份人工恢复'
      : '飞书同步失败，已回写原有内容并清空本次新建分区；请检查后重试，备份已保留');
  }
}
