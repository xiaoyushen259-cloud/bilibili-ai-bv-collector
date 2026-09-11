import { activeKeywordGroups, buildPartitionDatasets, hasBlockedTitle } from './rules.mjs';
import { containsTerm, evaluateRelevance, isWithinWindow, normalizeVideo } from './core.mjs';
import { parseFirecrawlVideo } from './firecrawl.mjs';

export const ACTIVE_BATCH_KEY = 'active_collection_batch_v1';
const FUN = /恶搞|搞笑|整活|鬼畜|抽象|发癫|爆笑|沙雕|离谱|脑洞|反转|假如|如果|重拍|二创|同人|喜剧|AI全民制作人/;
const NOT_CREATIVE = /教程|安装|工作流|测评|实测|评测|入门|部署|全套|保姆级|课程|使用指南|模型详解|从零开始|手把手|女巨人|内衣|充值|网暴|逝者|以为.*ai|ai.*以为/i;
const AI_TERMS = ['AI', '人工智能', 'AIGC', 'Seedance', '即梦', '可灵', 'Sora', 'Veo', '海螺', 'Runway'];

export function collectionProvider(config, requested) {
  const provider = requested ?? config.collectionProvider ?? 'firecrawl';
  if (!['firecrawl', 'wbi'].includes(provider)) throw new Error('--provider 仅支持 firecrawl 或 wbi');
  return provider;
}

export function positiveInteger(value, name, max = 1000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`${name} 必须为 1～${max} 的整数`);
  return number;
}

export function batchDay(nowTs) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowTs * 1000));
}

export function searchJobs(config) {
  const groups = activeKeywordGroups(config).filter(g => !g.manualOnly);
  const queues = config.contentPartitions.map(p => ({ partition: p.name,
    queries: [...new Set(p.keywordGroups.flatMap(label => groups.find(g => g.label === label)?.queries ?? []))] }));
  const jobs = [];
  for (let index = 0; queues.some(q => index < q.queries.length); index++) {
    for (const q of queues) if (q.queries[index]) jobs.push({ partition: q.partition, keyword: q.queries[index] });
  }
  // Cover each direct partition first, then offer creative alternatives within the search budget.
  jobs.splice(queues.length * 2, 0, ...['AI 恶搞', 'AI 搞笑', 'AI 整活', 'AI 鬼畜', 'AI 脑洞', 'AI 二创']
    .map(keyword => ({ partition: 'creative', keyword })));
  return jobs;
}

export function creativeVideo(video) {
  if (NOT_CREATIVE.test(video.title)) return false;
  const text = `${video.title} ${video.tags} ${video.description}`;
  return FUN.test(text) && AI_TERMS.some(term => containsTerm(text, term));
}

export function batchDatasets(db, config, state, nowTs) {
  const all = buildPartitionDatasets(db.listVideos(), config).rows;
  const byId = new Map(all.map(row => [row.bvid, row]));
  const seen = new Set();
  const partitions = config.contentPartitions.map(p => ({ name: p.name, rows: [] }));
  for (const record of state.records) {
    const row = byId.get(record.bvid);
    const partition = partitions.find(p => p.name === record.partition);
    if (!row || !partition || seen.has(row.bvid) || db.isPreviouslyBound(row.bvid)
      || row.play <= config.minViews || !isWithinWindow(row.pubdate, nowTs - config.lookbackDays * 86400, nowTs)
      || batchDay(row.first_qualified_at) !== state.day || hasBlockedTitle(row, config.bindingRiskTitleTerms)) continue;
    seen.add(row.bvid);
    partition.rows.push({ ...row, content_partitions: partition.name });
  }
  const complete = state.day === batchDay(nowTs) && partitions.every(p => p.rows.length === state.targets[p.name]);
  return { complete, rows: partitions.flatMap(p => p.rows), partitions: [...partitions,
    { name: config.feishuArchivePartitionName ?? '历史归档', rows: all.filter(row => !seen.has(row.bvid)) }],
    managedPartitionNames: [] };
}

export async function collectBatch({ db, config, firecrawl, createWbi, onWbiError,
  log = async () => {}, now = () => Math.floor(Date.now() / 1000),
  target, partitionTargets, maxSearches, maxWbiRequests, maxPages, allowWbi = true }) {
  const started = now(), day = batchDay(started), key = `collection_batch_v1:${day}`;
  const targets = Object.fromEntries(config.contentPartitions.map(p => [p.name,
    positiveInteger(partitionTargets?.[p.name] ?? target ?? config.courseTargetCount ?? 50, '目标数量')]));
  for (const name of Object.keys(partitionTargets ?? {})) {
    if (!(name in targets)) throw new Error(`未知分区：${name}`);
  }
  const state = JSON.parse(db.getRuntimeState(key) ?? 'null') ?? { day, targets, records: [], completedQueries: [] };
  if (state.day !== day) throw new Error('批次日期不匹配');
  if (Object.keys(targets).some(p => targets[p] < state.records.filter(r => r.partition === p).length)) {
    throw new Error('目标数小于当天已收集数量；请保留或提高目标，不会自动丢弃已有记录');
  }
  state.targets = targets;
  const save = () => { db.setRuntimeState(key, JSON.stringify(state)); db.setRuntimeState(ACTIVE_BATCH_KEY, JSON.stringify(state)); };
  // Recheck resumed records against current bindings, publication window, and policy.
  const valid = new Set(batchDatasets(db, config, state, started).rows.map(row => row.bvid));
  state.records = state.records.filter(row => valid.has(row.bvid));
  save();
  const counts = () => Object.fromEntries(Object.keys(targets).map(p => [p, state.records.filter(r => r.partition === p).length]));
  const full = p => p === 'creative'
    ? ['Midjourney', 'Stable Diffusion'].every(name => !(name in targets) || counts()[name] >= targets[name])
    : counts()[p] >= targets[p];
  const complete = () => Object.keys(targets).every(full);
  const exists = db.db.prepare('SELECT 1 FROM videos WHERE bvid=?');
  const groups = activeKeywordGroups(config).filter(g => !g.manualOnly);
  const accept = (raw, job, evidence) => {
    const video = normalizeVideo(raw);
    if (batchDay(now()) !== day) throw new Error('已跨过北京时间午夜，请重新运行以建立新日期批次');
    if (!/^BV[0-9A-Za-z]{10}$/.test(video.bvid) || exists.get(video.bvid) || db.isPreviouslyBound(video.bvid)
      || video.play <= config.minViews || !isWithinWindow(video.pubdate, now() - config.lookbackDays * 86400, now())
      || hasBlockedTitle(video, config.bindingRiskTitleTerms) || /充值/.test(video.title)) return;
    let partition = job.partition, group, reason;
    if (partition === 'creative') {
      if (!creativeVideo(video)) return;
      partition = ['Midjourney', 'Stable Diffusion'].filter(p => p in targets && !full(p))
        .sort((a, b) => counts()[a] - counts()[b])[0];
      if (!partition) return;
      group = `AI相关补位-${partition}`;
      if (!activeKeywordGroups(config).some(g => g.label === group)) return;
      reason = '有趣/恶搞AI成片补位，非教程';
    } else {
      if (full(partition)) return;
      const p = config.contentPartitions.find(p => p.name === partition);
      const match = groups.filter(g => p.keywordGroups.includes(g.label))
        .map(g => ({ group: g.label, relevance: evaluateRelevance(video, g, config) })).find(r => r.relevance.accepted);
      if (!match) return;
      group = match.group; reason = match.relevance.reason;
    }
    // Ledger and insertion commit together so a crash cannot consume a BV without recording its batch.
    db.db.exec('BEGIN IMMEDIATE');
    try {
      db.upsertVideo(video, group, job.keyword, `${reason}；${evidence.provider}；采集日期 ${day}`, now());
      state.records.push({ bvid: video.bvid, partition, ...evidence });
      save(); db.db.exec('COMMIT');
    } catch (error) { db.db.exec('ROLLBACK'); throw error; }
  };
  const jobs = searchJobs(config);
  const searchBudget = positiveInteger(maxSearches ?? config.firecrawlMaxSearches ?? 20, 'max-searches');
  const wbiBudget = positiveInteger(maxWbiRequests ?? config.batchWbiMaxRequests ?? 20, 'max-wbi-requests');
  const pageLimit = positiveInteger(maxPages ?? config.batchWbiMaxPages ?? 3, 'max-pages');
  let searches = 0, wbiRequests = 0, fallbackReason = null;
  if (!complete()) await log('第一尝试：Firecrawl 搜索并抓取正文；仅有可核验播放量和发布时间的视频计入本批');
  for (const job of jobs) {
    const queryKey = `firecrawl:${job.partition}:${job.keyword}`;
    if (complete() || searches >= searchBudget) break;
    if (full(job.partition) || state.completedQueries.includes(queryKey)) continue;
    let result;
    try { searches++; result = await firecrawl.search({ keyword: job.keyword, startTs: started - config.lookbackDays * 86400 }); }
    catch (error) { fallbackReason = error.message; break; }
    for (const doc of result.documents) {
      const video = parseFirecrawlVideo(doc);
      if (video) accept(video, job, { provider: 'Firecrawl详情精确数值', evidenceFile: result.evidenceFile });
    }
    state.completedQueries.push(queryKey); save();
    await log(`Firecrawl ${job.keyword}：${JSON.stringify(counts())}`);
  }
  if (!complete()) {
    fallbackReason ??= 'Firecrawl 搜索预算内结果不足或缺少可核验证据';
    await log(`${fallbackReason}；${allowWbi ? '尝试 WBI 补充，仍遵守原有冷却限制' : '已禁用 WBI，本批保留缺口'}`);
    if (allowWbi) {
      const client = await createWbi(); // Lazy: never initializes Bilibili before Firecrawl has been attempted.
      if (client) {
        wbiLoop: for (const job of jobs) {
          if (full(job.partition)) continue;
          for (let page = 1; page <= pageLimit; page++) {
            if (complete() || full(job.partition) || wbiRequests >= wbiBudget) break;
            const queryKey = `wbi:${job.partition}:${job.keyword}:${page}`;
            if (state.completedQueries.includes(queryKey)) continue;
            let result;
            try { wbiRequests++; result = await client.search({ keyword: job.keyword, page, order: 'click',
              startTs: started - config.lookbackDays * 86400, endTs: started }); }
            catch (error) { await onWbiError(error); fallbackReason = 'WBI 补充失败或处于冷却，本批保留缺口'; break wbiLoop; }
            for (const video of result.items) accept(video, job, { provider: 'WBI公开搜索精确数值' });
            state.completedQueries.push(queryKey); save();
            await log(`WBI ${job.keyword} 第${page}页：${JSON.stringify(counts())}`);
            if (!result.items.length || page >= result.numPages) break;
          }
          if (wbiRequests >= wbiBudget) break;
        }
      }
    }
  }
  state.complete = complete(); save();
  const report = { day, complete: state.complete, targetCounts: targets, partitionCounts: counts(),
    total: state.records.length, searches, wbiRequests, fallbackReason };
  await log(`${state.complete ? '本批已补齐' : '本批未补齐，不自动发布'}：${JSON.stringify(report)}`);
  return report;
}
