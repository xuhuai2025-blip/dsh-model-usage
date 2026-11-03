import { estimateCost, lookupPrice, CHECKED_AT } from './prices.js';

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const validRoute = route => route && typeof route.provider === 'string' && typeof route.model === 'string' && route.provider && route.model;
const timeValid = time => isCount(time) && time <= 8640000000000000;
const lastUsage = data => {
  if (data.usage !== undefined) return data.usage;
  const chunks = data.stream;
  if (!Array.isArray(chunks)) return undefined;
  return chunks.findLast(record => record.type === 'chunk' && record.chunk?.type === 'usage')?.chunk.usage;
};
/** DSH buckets are disjoint: inputTokens excludes cache reads/writes; reasoning is part of output. */
function normalize(usage) {
  if (!usage || !isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return null;
  if (usage.cacheReadTokens !== undefined && !isCount(usage.cacheReadTokens)) return null;
  if (usage.cacheWriteTokens !== undefined && !isCount(usage.cacheWriteTokens)) return null;
  if (usage.reasoningTokens !== undefined && (!isCount(usage.reasoningTokens) || usage.reasoningTokens > usage.outputTokens)) return null;
  const input = usage.inputTokens, output = usage.outputTokens;
  const cacheRead = usage.cacheReadTokens ?? 0, cacheWrite = usage.cacheWriteTokens ?? 0;
  const known = input + output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(known)) return null;
  if (usage.totalTokens !== undefined && (!isCount(usage.totalTokens) || usage.totalTokens < known ||
      (usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined && usage.totalTokens !== known))) return null;
  return {input,output,cacheRead,cacheWrite,total:usage.totalTokens ?? known,
    // Adapters omit zero-valued cache buckets. An exact matching total proves
    // those missing buckets are zero; otherwise their classification is unknown.
    incomplete: usage.totalTokens !== undefined ? usage.totalTokens !== known :
      usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined};
}

/** Fold durable settlements, matching DSH token-meter replacement and retry rules.
 * Only owned events count. Headers in the inherited prefix remain route context, never usage.
 * Retains ONLY numeric metadata and routes, never prompts, responses or tool payloads.
 */
export function foldSession(events, {id, isSeeded = false, inheritedEventCount = 0} = {}) {
  if (!Array.isArray(events)) throw new Error('Invalid session event slice');
  if (!isCount(inheritedEventCount) || inheritedEventCount > events.length || (isSeeded && inheritedEventCount === 0)) {
    // Zero-length forks are legal when followed by a tagged cut; otherwise fail closed.
    if (!(isSeeded && inheritedEventCount === 0 && events[0]?.type === 'session/end-seed' && events[0]?.data?.inherited === true))
      throw new Error('Unproven inherited boundary');
  }
  const records = []; let last = null, route = null, invalidRecords = 0, missingUsage = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i], data = event?.data;
    if (!data) continue;
    if (event.type === 'request/header') {
      const config = data.header?.config;
      route = validRoute(config) ? {provider:config.provider,model:config.model} : null;
    }
    if (i < inheritedEventCount) continue;
    if (event.type === 'llm/retry-started') {
      if (last && last.turn === data.turn && last.step === data.step) last = null;
      continue;
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    const usage = lastUsage(data);
    if (usage === undefined) { missingUsage++; continue; }
    const buckets = normalize(usage);
    const source = event.type === 'assistant/message' ? data.message?.source : route;
    const target = validRoute(source) ? source : {provider:'unknown',model:'unknown'};
    if (!buckets || !isCount(data.turn) || !isCount(data.step) || !timeValid(event.time)) { invalidRecords++; continue; }
    const record = {sessionId:id, provider:target.provider,model:target.model,time:event.time,...buckets};
    if (last && last.turn === data.turn && last.step === data.step) records[last.index] = record;
    else { records.push(record); last = {turn:data.turn,step:data.step,index:records.length - 1}; }
  }
  return {records,invalidRecords,missingUsage};
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export function dateKey(time) { return dateFormatter.format(new Date(time)); }
export function rangeStart(range, now) {
  if (!['today','week','month','all'].includes(range)) throw new RangeError('不支持的时间范围。');
  if (range === 'all') return 0;
  const today = dateKey(now);
  const day = Date.parse(today + 'T00:00:00+08:00');
  return range === 'today' ? day : range === 'week' ? day - 6 * 86400000 : Date.parse(today.slice(0,7) + '-01T00:00:00+08:00');
}
const empty = () => ({input:0,output:0,cacheRead:0,cacheWrite:0,total:0,calls:0,cost:0,unpricedCalls:0});
const add = (target, record, cost) => {
  for (const key of ['input','output','cacheRead','cacheWrite','total']) target[key] += record[key];
  target.calls++;
  if (cost === null) target.unpricedCalls++;
  else target.cost += cost;
};
/** API and subscription adapters are transport sources, not separate model owners. */
export function providerGroup(provider) {
  if (provider === 'openai' || provider === 'openai-codex') return 'OpenAI';
  return provider;
}
export function makeReport(folds, {range = 'month', now = Date.now(), coverage = {}, warnings = []} = {}) {
  const start = rangeStart(range,now), totals = empty(), models = new Map(), days = new Map(), sessions = new Set();
  let incomplete = 0, missingUsage = 0, invalidRecords = 0;
  for (const fold of folds) {
    invalidRecords += fold.invalidRecords; missingUsage += fold.missingUsage;
    for (const record of fold.records) {
      if (record.time < start || record.time > now) continue;
      const {cost} = record.incomplete ? {cost:null} : estimateCost(record);
      const provider = providerGroup(record.provider);
      const key = record.model;
      if (!models.has(key)) {
        const price = lookupPrice(record.model);
        if (price?.long) price.note += ` 单次输入（含缓存）>${price.threshold.toLocaleString('en-US')} 后使用长上下文价：输入 $${price.long.input}、输出 $${price.long.output}、缓存读取 $${price.long.cacheRead} / 1M。`;
        models.set(key,{provider,model:record.model,...empty(),sessionIds:new Set(),sourceProviders:new Set(),price});
      }
      const model = models.get(key); add(model,record,cost); add(totals,record,cost);
      model.sessionIds.add(record.sessionId); model.sourceProviders.add(record.provider); sessions.add(record.sessionId);
      const date = dateKey(record.time);
      if (!days.has(date)) days.set(date,{date,...empty()});
      add(days.get(date),record,cost);
      if (record.incomplete) incomplete++;
    }
  }
  totals.sessions = sessions.size;
  const rows = [...models.values()].map(({sessionIds,sourceProviders,...model}) => ({...model,
    provider:[...new Set([...sourceProviders].map(providerGroup))].length === 1 ? providerGroup([...sourceProviders][0]) : '多来源',
    providers:[...sourceProviders].sort(),
    cost:model.calls === model.unpricedCalls ? null : model.cost,
    sessions:sessionIds.size,tokenShare:totals.total ? model.total/totals.total : 0,
    costShare:totals.cost && model.calls !== model.unpricedCalls ? model.cost/totals.cost : null,
  })).sort((a,b)=>b.total-a.total);
  const notes = [...warnings];
  if (totals.unpricedCalls) notes.push(`${totals.unpricedCalls} 次有用量调用未定价：未知型号、缓存写入费率或缓存分类不足。成本与成本占比只含可定价部分，未把未知费用当作零。`);
  if (incomplete) notes.push(`${incomplete} 次调用未完整报告缓存分类，其 Token 为已报告值，费用不估算。`);
  if (invalidRecords) notes.push(`${invalidRecords} 条无效用量记录已跳过。`);
  if (missingUsage) notes.push(`全部历史中有 ${missingUsage} 条结算未报告用量，未猜测其 Token 或成本；调用次数只统计有用量结算。`);
  if (rows.some(row=>row.price?.source.includes('deepseek.com'))) notes.push('DeepSeek 按当前官方峰值价上限估算，未应用低峰半价；因此通常高于实际标准 API 费用。');
  notes.push('仅覆盖持久日志中提供用量回执的对话／子会话请求；自动标题等未记录用量的额外请求无法统计。生成中的用量需结算并落盘后才显示。');
  notes.push(`价格为 ${CHECKED_AT} 官方标准文本 API 快照，统一 USD，历史请求也按此价折算；不含图像生成、工具调用、订阅、税费或特殊服务档位费用。`);
  // Include quiet calendar days so the graph does not compress gaps in time.
  const dayKeys = [...days.keys()].sort();
  const first = range === 'all' ? (dayKeys[0] ? Date.parse(dayKeys[0]+'T00:00:00+08:00') : null) : start;
  const today = rangeStart('today',now);
  if (first !== null && today - first <= 3660 * 86400000) {
    for (let time = first; time <= today; time += 86400000) {
      const date = dateKey(time);
      if (!days.has(date)) days.set(date,{date,...empty()});
    }
  } else if (first !== null) notes.push('全部历史超过十年，每日趋势仅列有用量的日期。');
  if (totals.calls && totals.calls === totals.unpricedCalls) totals.cost = null;
  const daily = [...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(day=>({
    ...day,cost:day.calls && day.calls === day.unpricedCalls ? null : day.cost,
  }));
  return {generatedAt:new Date(now).toISOString(),range,timeZone:'Asia/Shanghai',
    scopeLabel:'本机 DSH 持久会话（含子会话，排除继承历史）',
    totals,models:rows,daily,warnings:notes,
    coverage:{sessions:folds.length,files:folds.length,invalidRecords,...coverage}};
}

/** Cache compact folds by opaque storage revision. Scan serially to bound memory pressure. */
export function createUsageReader(persistence, {now = Date.now} = {}) {
  const cache = new Map(); let tail = Promise.resolve(), closed = false;
  const controllers = new Set();
  async function scan(range, signal) {
    if (closed) throw new Error('模型用量插件已停用。');
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    const check = () => controller.signal.throwIfAborted();
    try {
      check(); rangeStart(range,now());
      const snapshots = await persistence.list({signal:controller.signal});
      const seen = new Set(), folds = [], warnings = []; let failed = 0;
      for (const snapshot of snapshots) {
        check(); const id = snapshot.header.id;
        if (seen.has(id)) continue; seen.add(id);
        let entry = cache.get(id);
        if (!entry || entry.revision !== snapshot.revision) {
          let handle;
          try {
            handle = await persistence.open(id,'read',{signal:controller.signal});
            const slice = await handle.read(0,Number.MAX_SAFE_INTEGER,{signal:controller.signal});
            check();
            const fold = foldSession(slice.events,{id,isSeeded:handle.header.isSeeded,inheritedEventCount:handle.inheritedEventCount});
            entry = {revision:snapshot.revision,fold};
            cache.set(id,entry);
          } catch {
            check(); failed++; cache.delete(id); continue;
          } finally { if (handle) await handle.close(); }
        }
        folds.push(entry.fold);
      }
      for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
      if (failed && folds.length === 0) throw new Error('没有可读取的会话，不能将不可用显示为零用量。');
      if (failed) warnings.push(`${failed} 个会话暂时无法读取，统计不完整；原日志未修改。刷新可重试。`);
      return makeReport(folds,{range,now:now(),warnings,coverage:{sessions:seen.size,files:folds.length,failedSessions:failed}});
    } finally {signal?.removeEventListener('abort',abort);controllers.delete(controller);}
  }
  return {
    report(range = 'month',signal) {
      const task = tail.then(()=>scan(range,signal));
      tail = task.catch(()=>{}); return task;
    },
    async close() {closed = true;for (const controller of controllers) controller.abort(new Error('插件已停用。'));await tail;cache.clear();},
  };
}
