import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CollectorDatabase } from "../src/db.mjs";

test("BV号去重且多关键词合并", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-db-test-"));
  const db = new CollectorDatabase(path.join(tempDir, "test.sqlite"));
  const video = {
    bvid: "BV1234567890", url: "https://www.bilibili.com/video/BV1234567890", title: "AI",
    description: "", tags: "", play: 10000, pubdate: 1000, author: "UP", authorMid: "1", category: "科技",
  };
  assert.equal(db.upsertVideo(video, "AI", "AI", "AI上下文", 2000), "inserted");
  assert.equal(db.upsertVideo({ ...video, play: 20000 }, "GPT", "GPT", "强关键词", 3000), "updated");
  const rows = db.listVideos({ cutoffTs: 0, minViews: 10000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].play, 20000);
  assert.match(rows[0].keywords, /AI/);
  assert.match(rows[0].keywords, /GPT/);
  assert.equal(rows[0].first_qualified_at, 2000);
  const aiOnly = db.listVideos({ cutoffTs: 0, minViews: 10000, keywordGroups: ["AI"] });
  assert.equal(aiOnly.length, 1);
  assert.equal(aiOnly[0].keywords, "AI");
  assert.equal(aiOnly[0].matched_queries, "AI");
  assert.equal(db.listVideos({ cutoffTs: 0, minViews: 10000, keywordGroups: ["不存在"] }).length, 0);
  const renamed = db.listVideos({
    cutoffTs: 0,
    minViews: 10000,
    keywordGroups: [{ label: "通用AI", legacyLabels: ["AI"] }],
  });
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].keywords, "通用AI");
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("成功绑定历史可重复导入并从候选查询中排除", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-db-binding-history-test-"));
  const db = new CollectorDatabase(path.join(tempDir, "test.sqlite"));
  const video = {
    bvid: "BV1234567890", url: "https://www.bilibili.com/video/BV1234567890", title: "AI",
    description: "", tags: "", play: 10000, pubdate: 1000, author: "UP", authorMid: "1", category: "科技",
  };
  db.upsertVideo(video, "AI", "AI", "AI上下文", 2000);
  const first = db.recordBoundVideos([
    { bvid: video.bvid, courseName: "Agent", batchLabel: "本周", sourceFile: "绑定bv.xlsx" },
    { bvid: "invalid" },
  ], 3000);
  assert.deepEqual(first, { processed: 1, inserted: 1, total: 1 });
  assert.equal(db.isPreviouslyBound(video.bvid), true);
  assert.equal(db.listVideos({ cutoffTs: 0, excludeBound: false }).length, 1);
  assert.equal(db.listVideos({ cutoffTs: 0, excludeBound: true }).length, 0);
  const repeated = db.recordBoundVideos([{ bvid: video.bvid, batchLabel: "重复导入" }], 4000);
  assert.deepEqual(repeated, { processed: 1, inserted: 0, total: 1 });
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("扫描任务断点和孤儿运行可恢复", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-db-recovery-test-"));
  const db = new CollectorDatabase(path.join(tempDir, "test.sqlite"));
  const runId = db.beginRun("full", 1000);
  const job = db.createJob("full", 100, 200, 1000);
  db.updateJobProgress(job.id, 7);
  const pending = db.getPendingJob("full");
  assert.equal(pending.next_query_index, 7);
  const reset = db.resetJobProgress(job.id, "segment-v1-24h");
  assert.equal(reset.next_query_index, 0);
  assert.equal(reset.progress_kind, "segment-v1-24h");
  db.deferJobUnit(job.id, 2, new Error("HTTP 412"));
  db.deferJobUnit(job.id, 2, new Error("HTTP 412 again"));
  assert.equal(db.listDeferredJobUnits(job.id)[0].attempt_count, 2);
  db.resolveJobUnit(job.id, 2);
  assert.equal(db.listDeferredJobUnits(job.id).length, 0);
  db.recoverOrphanedRuns(1100);
  const run = db.db.prepare("SELECT status,finished_at FROM runs WHERE id=?").get(runId);
  assert.equal(run.status, "failed");
  assert.equal(run.finished_at, 1100);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("412全局冷却状态可持久化、覆盖和清除", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-db-runtime-state-test-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  let db = new CollectorDatabase(dbPath);
  db.setRuntimeState("bilibili_blocked_until", 2000, 1000);
  assert.equal(db.getRuntimeState("bilibili_blocked_until"), "2000");
  db.setRuntimeState("bilibili_blocked_until", 3000, 1100);
  db.close();

  db = new CollectorDatabase(dbPath);
  assert.equal(db.getRuntimeState("bilibili_blocked_until"), "3000");
  db.deleteRuntimeState("bilibili_blocked_until");
  assert.equal(db.getRuntimeState("bilibili_blocked_until"), null);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
