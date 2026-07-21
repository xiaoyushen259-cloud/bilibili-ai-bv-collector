const LIST_SEPARATOR = /[、,，]/;
const INVALID_SHEET_TITLE = /[\\/?*\[\]:]/;

function normalizedList(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(LIST_SEPARATOR);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function lowerSet(values) {
  return new Set(normalizedList(values).map((value) => value.toLocaleLowerCase("en-US")));
}

function validateSheetTitle(name, context) {
  const title = String(name ?? "").trim();
  if (!title || title.length > 100 || INVALID_SHEET_TITLE.test(title)) {
    throw new Error(`${context}不符合飞书工作表名称规则：${title || "空值"}`);
  }
  return title;
}

export function activeKeywordGroups(config) {
  return (config.keywordGroups ?? []).filter((group) => group.enabled !== false);
}

export function matchTermsForGroup(group) {
  const configured = normalizedList(group.matchTerms);
  return configured.length ? configured : normalizedList(group.queries);
}

export function validateCollectorRules(config) {
  const labels = new Set();
  for (const group of activeKeywordGroups(config)) {
    const label = String(group.label ?? "").trim();
    if (!label) throw new Error("keywordGroups 中存在空 label");
    const labelKey = label.toLocaleLowerCase("en-US");
    if (labels.has(labelKey)) throw new Error(`keywordGroups 中存在重复 label：${label}`);
    labels.add(labelKey);
    if (!normalizedList(group.queries).length) throw new Error(`关键词组“${label}”缺少 queries`);
    if (!matchTermsForGroup(group).length) throw new Error(`关键词组“${label}”缺少 matchTerms`);
    if (group.partitionName) validateSheetTitle(group.partitionName, `关键词组“${label}”的 partitionName`);
  }

  if (config.partitioning) {
    const threshold = Number(config.partitioning.minStandaloneVideos);
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error("partitioning.minStandaloneVideos 必须是正整数");
    }
    validateSheetTitle(config.partitioning.fallbackPartition ?? "其他AI", "fallbackPartition");
    for (const name of normalizedList(config.partitioning.managedPartitionNames)) {
      validateSheetTitle(name, "managedPartitionNames 中的名称");
    }
  }

  const partitionNames = new Set();
  let fallbackCount = 0;
  for (const partition of config.contentPartitions ?? []) {
    const name = String(partition.name ?? "").trim();
    if (!name) throw new Error("contentPartitions 中存在空 name");
    if (name.length > 100 || INVALID_SHEET_TITLE.test(name)) {
      throw new Error(`内容分区名称不符合飞书工作表规则：${name}`);
    }
    const nameKey = name.toLocaleLowerCase("en-US");
    if (partitionNames.has(nameKey)) throw new Error(`contentPartitions 中存在重复 name：${name}`);
    partitionNames.add(nameKey);
    if (partition.fallback === true) fallbackCount += 1;
    if (partition.fallback !== true
      && !normalizedList(partition.keywordGroups).length
      && !normalizedList(partition.matchTerms).length) {
      throw new Error(`内容分区“${name}”必须配置 keywordGroups、matchTerms 或 fallback`);
    }
  }
  if (fallbackCount > 1) throw new Error("contentPartitions 最多只能配置一个 fallback 分区");
  return config;
}

export function classifyVideo(row, config) {
  const rules = config.contentPartitions ?? [];
  if (!rules.length) return [];
  const rowGroups = lowerSet(row.keywords);
  const rowMatches = lowerSet(row.matched_queries);
  const matched = rules.filter((partition) => {
    if (partition.fallback === true) return false;
    const groupHit = normalizedList(partition.keywordGroups)
      .some((value) => rowGroups.has(value.toLocaleLowerCase("en-US")));
    const termHit = normalizedList(partition.matchTerms)
      .some((value) => rowMatches.has(value.toLocaleLowerCase("en-US")));
    return groupHit || termHit;
  }).map((partition) => String(partition.name).trim());
  if (matched.length) return matched;
  const fallback = rules.find((partition) => partition.fallback === true);
  return fallback ? [String(fallback.name).trim()] : [];
}

export function buildPartitionDatasets(rows, config) {
  validateCollectorRules(config);
  if (config.partitioning) return buildDynamicPartitionDatasets(rows, config);
  const enrichedRows = rows.map((row) => {
    const partitions = classifyVideo(row, config);
    return { ...row, content_partitions: partitions.join("、") };
  });
  const partitions = (config.contentPartitions ?? []).map((partition) => ({
    name: String(partition.name).trim(),
    rows: enrichedRows.filter((row) => normalizedList(row.content_partitions).includes(String(partition.name).trim())),
  }));
  return {
    rows: enrichedRows,
    partitions,
    managedPartitionNames: partitions.map((partition) => partition.name),
  };
}

function buildDynamicPartitionDatasets(rows, config) {
  const groups = activeKeywordGroups(config);
  const groupByLabel = new Map(groups.map((group) => [
    String(group.label).toLocaleLowerCase("en-US"),
    group,
  ]));
  const rowGroupKeys = rows.map((row) => lowerSet(row.keywords));
  const counts = new Map(groups.map((group) => [String(group.label).toLocaleLowerCase("en-US"), 0]));
  for (const keys of rowGroupKeys) {
    for (const key of keys) {
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
  }

  const threshold = Number(config.partitioning.minStandaloneVideos);
  const fallback = String(config.partitioning.fallbackPartition ?? "其他AI").trim();
  const resolvePartition = (group, trail = new Set()) => {
    const key = String(group.label).toLocaleLowerCase("en-US");
    if (counts.get(key) >= threshold) {
      return String(group.partitionName ?? `${group.label}分区`).trim();
    }
    if (trail.has(key)) throw new Error(`关键词分区 mergeInto 存在循环：${[...trail, key].join(" -> ")}`);
    const mergeInto = String(group.mergeInto ?? "").trim();
    if (!mergeInto) return fallback;
    const target = groupByLabel.get(mergeInto.toLocaleLowerCase("en-US"));
    if (!target) return validateSheetTitle(mergeInto, `关键词组“${group.label}”的 mergeInto`);
    return resolvePartition(target, new Set([...trail, key]));
  };

  const destinationByGroup = new Map(groups.map((group) => [
    String(group.label).toLocaleLowerCase("en-US"),
    resolvePartition(group),
  ]));
  const partitionNames = [...new Set(groups.map((group) => (
    destinationByGroup.get(String(group.label).toLocaleLowerCase("en-US"))
  )))];
  const enrichedRows = rows.map((row, index) => {
    const names = [...new Set([...rowGroupKeys[index]]
      .map((key) => destinationByGroup.get(key))
      .filter(Boolean))];
    return { ...row, content_partitions: (names.length ? names : [fallback]).join("、") };
  });
  const partitions = partitionNames.map((name) => ({
    name,
    rows: enrichedRows.filter((row) => normalizedList(row.content_partitions).includes(name)),
  }));
  const potentialNames = groups.flatMap((group) => {
    const names = [String(group.partitionName ?? `${group.label}分区`).trim()];
    const mergeInto = String(group.mergeInto ?? "").trim();
    if (mergeInto && !groupByLabel.has(mergeInto.toLocaleLowerCase("en-US"))) names.push(mergeInto);
    return names;
  });
  const managedPartitionNames = [...new Set([
    ...normalizedList(config.partitioning.managedPartitionNames),
    ...potentialNames,
    fallback,
  ])];
  return { rows: enrichedRows, partitions, managedPartitionNames, keywordCounts: Object.fromEntries(counts) };
}
