import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class CollectorDatabase {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        bvid TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        play INTEGER NOT NULL,
        pubdate INTEGER NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        author_mid TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        first_qualified_at INTEGER NOT NULL,
        last_checked_at INTEGER NOT NULL,
        relevance_reason TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS keyword_hits (
        bvid TEXT NOT NULL,
        keyword_group TEXT NOT NULL,
        matched_query TEXT NOT NULL,
        PRIMARY KEY (bvid, keyword_group, matched_query),
        FOREIGN KEY (bvid) REFERENCES videos(bvid) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS scan_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        next_query_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        qualified_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS scan_job_deferred (
        job_id INTEGER NOT NULL,
        unit_index INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, unit_index),
        FOREIGN KEY (job_id) REFERENCES scan_jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS binding_history (
        bvid TEXT PRIMARY KEY,
        course_name TEXT NOT NULL DEFAULT '',
        batch_label TEXT NOT NULL DEFAULT '',
        source_file TEXT NOT NULL DEFAULT '',
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_videos_pubdate ON videos(pubdate);
      CREATE INDEX IF NOT EXISTS idx_videos_first_qualified ON videos(first_qualified_at);
      CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(mode, status, id);
      CREATE INDEX IF NOT EXISTS idx_binding_history_batch ON binding_history(batch_label, course_name);
    `);
    const jobColumns = new Set(this.db.prepare("PRAGMA table_info(scan_jobs)").all().map((column) => column.name));
    if (!jobColumns.has("progress_kind")) {
      this.db.exec("ALTER TABLE scan_jobs ADD COLUMN progress_kind TEXT NOT NULL DEFAULT 'query-v1'");
    }
  }

  close() {
    this.db.close();
  }

  getRuntimeState(key) {
    return this.db.prepare("SELECT value FROM runtime_state WHERE key=?").get(key)?.value ?? null;
  }

  setRuntimeState(key, value, nowTs = Math.floor(Date.now() / 1000)) {
    this.db.prepare(`
      INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, String(value), nowTs);
  }

  deleteRuntimeState(key) {
    this.db.prepare("DELETE FROM runtime_state WHERE key=?").run(key);
  }

  isPreviouslyBound(bvid) {
    return Boolean(this.db.prepare("SELECT 1 FROM binding_history WHERE bvid=?").get(String(bvid)));
  }

  bindingHistoryCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM binding_history").get().count);
  }

  recordBoundVideos(records, nowTs = Math.floor(Date.now() / 1000)) {
    const normalized = [...new Map((records ?? []).map((record) => {
      const bvid = String(record?.bvid ?? "").trim();
      return [bvid, {
        bvid,
        courseName: String(record?.courseName ?? "").trim(),
        batchLabel: String(record?.batchLabel ?? "").trim(),
        sourceFile: String(record?.sourceFile ?? "").trim(),
      }];
    }).filter(([bvid]) => /^BV[0-9A-Za-z]{10}$/.test(bvid))).values()];
    const statement = this.db.prepare(`
      INSERT INTO binding_history(bvid,course_name,batch_label,source_file,recorded_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(bvid) DO UPDATE SET
        course_name=CASE WHEN excluded.course_name<>'' THEN excluded.course_name ELSE binding_history.course_name END,
        batch_label=CASE WHEN excluded.batch_label<>'' THEN excluded.batch_label ELSE binding_history.batch_label END,
        source_file=CASE WHEN excluded.source_file<>'' THEN excluded.source_file ELSE binding_history.source_file END
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = this.bindingHistoryCount();
      for (const record of normalized) {
        statement.run(record.bvid, record.courseName, record.batchLabel, record.sourceFile, nowTs);
      }
      const after = this.bindingHistoryCount();
      this.db.exec("COMMIT");
      return { processed: normalized.length, inserted: after - before, total: after };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  beginRun(mode, nowTs) {
    const result = this.db.prepare(
      "INSERT INTO runs(mode, started_at, status) VALUES (?, ?, 'running')"
    ).run(mode, nowTs);
    return Number(result.lastInsertRowid);
  }

  recoverOrphanedRuns(nowTs) {
    return this.db.prepare(`
      UPDATE runs
      SET status='failed', finished_at=?, error=COALESCE(error, 'Collector process ended before completion')
      WHERE status='running'
    `).run(nowTs);
  }

  finishRun(runId, stats, error = null) {
    this.db.prepare(`
      UPDATE runs SET finished_at=?, status=?, request_count=?, qualified_count=?,
        inserted_count=?, updated_count=?, error=? WHERE id=?
    `).run(
      Math.floor(Date.now() / 1000), error ? "failed" : "complete",
      stats.requestCount ?? 0, stats.qualifiedCount ?? 0,
      stats.insertedCount ?? 0, stats.updatedCount ?? 0,
      error ? String(error).slice(0, 4000) : null, runId
    );
  }

  getPendingJob(mode) {
    return this.db.prepare(`
      SELECT * FROM scan_jobs WHERE mode=? AND status IN ('running','failed') ORDER BY id DESC LIMIT 1
    `).get(mode);
  }

  createJob(mode, startTs, endTs, nowTs, progressKind = "query-v1") {
    const result = this.db.prepare(`
      INSERT INTO scan_jobs(mode,start_ts,end_ts,next_query_index,status,started_at,updated_at,progress_kind)
      VALUES(?,?,?,0,'running',?,?,?)
    `).run(mode, startTs, endTs, nowTs, nowTs, progressKind);
    return this.db.prepare("SELECT * FROM scan_jobs WHERE id=?").get(Number(result.lastInsertRowid));
  }

  resetJobProgress(jobId, progressKind) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE scan_jobs SET next_query_index=0, progress_kind=?, status='running', error=NULL, updated_at=?
        WHERE id=?
      `).run(progressKind, Math.floor(Date.now() / 1000), jobId);
      this.db.prepare("DELETE FROM scan_job_deferred WHERE job_id=?").run(jobId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db.prepare("SELECT * FROM scan_jobs WHERE id=?").get(jobId);
  }

  deferJobUnit(jobId, unitIndex, error) {
    this.db.prepare(`
      INSERT INTO scan_job_deferred(job_id,unit_index,attempt_count,last_error,updated_at)
      VALUES(?,?,1,?,?)
      ON CONFLICT(job_id,unit_index) DO UPDATE SET
        attempt_count=scan_job_deferred.attempt_count+1,
        last_error=excluded.last_error,
        updated_at=excluded.updated_at
    `).run(jobId, unitIndex, String(error).slice(0, 1000), Math.floor(Date.now() / 1000));
  }

  resolveJobUnit(jobId, unitIndex) {
    this.db.prepare("DELETE FROM scan_job_deferred WHERE job_id=? AND unit_index=?").run(jobId, unitIndex);
  }

  listDeferredJobUnits(jobId) {
    return this.db.prepare(`
      SELECT unit_index,attempt_count,last_error,updated_at
      FROM scan_job_deferred WHERE job_id=? ORDER BY updated_at ASC, unit_index ASC
    `).all(jobId);
  }

  clearDeferredJobUnits(jobId) {
    this.db.prepare("DELETE FROM scan_job_deferred WHERE job_id=?").run(jobId);
  }

  markJobRunning(jobId) {
    this.db.prepare("UPDATE scan_jobs SET status='running', error=NULL, updated_at=? WHERE id=?")
      .run(Math.floor(Date.now() / 1000), jobId);
  }

  updateJobProgress(jobId, nextQueryIndex) {
    this.db.prepare("UPDATE scan_jobs SET next_query_index=?, updated_at=? WHERE id=?")
      .run(nextQueryIndex, Math.floor(Date.now() / 1000), jobId);
  }

  completeJob(jobId) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare("UPDATE scan_jobs SET status='complete', finished_at=?, updated_at=?, error=NULL WHERE id=?")
      .run(now, now, jobId);
  }

  failJob(jobId, error) {
    this.db.prepare("UPDATE scan_jobs SET status='failed', updated_at=?, error=? WHERE id=?")
      .run(Math.floor(Date.now() / 1000), String(error).slice(0, 4000), jobId);
  }

  upsertVideo(video, groupLabel, matchedQuery, relevanceReason, nowTs) {
    const existing = this.db.prepare("SELECT play FROM videos WHERE bvid=?").get(video.bvid);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO videos(
          bvid,url,title,description,tags,play,pubdate,author,author_mid,category,
          first_qualified_at,last_checked_at,relevance_reason
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(bvid) DO UPDATE SET
          url=excluded.url,
          title=excluded.title,
          description=excluded.description,
          tags=excluded.tags,
          play=MAX(videos.play, excluded.play),
          pubdate=excluded.pubdate,
          author=excluded.author,
          author_mid=excluded.author_mid,
          category=excluded.category,
          last_checked_at=excluded.last_checked_at,
          relevance_reason=excluded.relevance_reason
      `).run(
        video.bvid, video.url, video.title, video.description, video.tags,
        video.play, video.pubdate, video.author, video.authorMid, video.category,
        nowTs, nowTs, relevanceReason
      );
      this.db.prepare(`
        INSERT OR IGNORE INTO keyword_hits(bvid,keyword_group,matched_query) VALUES(?,?,?)
      `).run(video.bvid, groupLabel, matchedQuery);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return existing ? "updated" : "inserted";
  }

  listVideos({
    cutoffTs = 0,
    firstQualifiedStart = null,
    firstQualifiedEnd = null,
    minViews = 0,
    keywordGroups = null,
    excludeBound = false,
  } = {}) {
    const clauses = ["v.pubdate >= ?", "v.play >= ?"];
    const params = [cutoffTs, minViews];
    if (firstQualifiedStart !== null) {
      clauses.push("v.first_qualified_at >= ?");
      params.push(firstQualifiedStart);
    }
    if (firstQualifiedEnd !== null) {
      clauses.push("v.first_qualified_at < ?");
      params.push(firstQualifiedEnd);
    }
    if (excludeBound) clauses.push("NOT EXISTS (SELECT 1 FROM binding_history b WHERE b.bvid=v.bvid)");
    const rows = this.db.prepare(`
      SELECT v.*,
        (SELECT GROUP_CONCAT(k.keyword_group || char(31) || k.matched_query, char(30))
          FROM keyword_hits k WHERE k.bvid=v.bvid) AS keyword_hit_pairs
      FROM videos v
      WHERE ${clauses.join(" AND ")}
      ORDER BY v.first_qualified_at DESC, v.play DESC, v.bvid ASC
    `).all(...params);
    const canonicalGroupByAlias = Array.isArray(keywordGroups)
      ? new Map(keywordGroups.flatMap((group) => {
        const label = typeof group === "string" ? group : group.label;
        const aliases = typeof group === "string" ? [] : (group.legacyLabels ?? []);
        return [label, ...aliases].map((alias) => [
          String(alias).toLocaleLowerCase("en-US"),
          String(label),
        ]);
      }))
      : null;
    return rows.map((row) => {
      const hits = String(row.keyword_hit_pairs ?? "").split(String.fromCharCode(30))
        .filter(Boolean)
        .map((pair) => {
          const [keywordGroup, matchedQuery = ""] = pair.split(String.fromCharCode(31));
          return { keywordGroup, matchedQuery };
        })
        .map((hit) => ({
          ...hit,
          canonicalGroup: canonicalGroupByAlias?.get(hit.keywordGroup.toLocaleLowerCase("en-US")) ?? null,
        }))
        .filter((hit) => !canonicalGroupByAlias || hit.canonicalGroup);
      if (canonicalGroupByAlias && !hits.length) return null;
      const { keyword_hit_pairs: ignored, ...video } = row;
      return {
        ...video,
        keywords: [...new Set(hits.map((hit) => hit.canonicalGroup ?? hit.keywordGroup).filter(Boolean))].sort().join("、"),
        matched_queries: [...new Set(hits.map((hit) => hit.matchedQuery).filter(Boolean))].sort().join("、"),
      };
    }).filter(Boolean);
  }

  stats(cutoffTs, minViews, keywordGroups = null) {
    const qualifiedVideos = this.listVideos({ cutoffTs, minViews, keywordGroups }).length;
    const lastRun = this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get();
    return { qualifiedVideos, lastRun: lastRun ?? null };
  }
}
