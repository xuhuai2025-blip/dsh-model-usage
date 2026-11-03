/** Official standard text API prices, USD / 1M tokens. Snapshot, not a billing feed. */
export const CHECKED_AT = '2026-11-03';
const OPENAI = 'https://developers.openai.com/api/docs/pricing';
const CLAUDE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const DEEPSEEK = 'https://api-docs.deepseek.com/quick_start/pricing/';
const MINIMAX = 'https://platform.minimax.io/docs/pricing/overview';
const table = new Map();
function add(model, input, output, cacheRead, extra = {}) {
  table.set(model, { input, output, cacheRead, cacheWrite: null, source: OPENAI, checkedAt: CHECKED_AT,
    note: '官方 Standard 文本 API 单价快照；不含工具、税费、区域附加费或订阅实际费用。', ...extra });
}
for (const [model, input, output, cacheRead, longInput, longOutput, longRead] of [
  ['gpt-6-astra',10,50,1,20,75,2], ['gpt-6.1-sol',2,10,.1,4,15,.2],
  ['gpt-6.1-terra',1,5,.05,2,7.5,.1], ['gpt-6-luna',.1,.5,.01,.2,.75,.02],
  ['gpt-6-sol',2,10,.2,4,15,.4], ['gpt-5.6-sol',4,20,.4,8,30,.8],
  ['gpt-5.6-terra',2,12,.2,4,18,.4], ['gpt-5.6-luna',.2,1.2,.02,.4,1.8,.04],
  ['gpt-5.5',5,30,.5,10,45,1], ['gpt-5.5-pro',30,180,null,60,270,null],
  ['gpt-5.4',2.5,15,.25,5,22.5,.5], ['gpt-5.4-pro',30,180,null,60,270,null],
]) add(model,input,output,cacheRead,{ long: {input:longInput,output:longOutput,cacheRead:longRead}, threshold:272000 });
for (const args of [
  ['gpt-5.4-mini',.75,4.5,.075],['gpt-5.4-nano',.2,1.25,.02],
  ['gpt-5.3-codex',1.75,14,.175], ['gpt-5.2',1.75,14,.175], ['gpt-5.2-pro',21,168,null],
  ['gpt-5.1',1.25,10,.125], ['gpt-5',1.25,10,.125], ['gpt-5-mini',.25,2,.025],
  ['gpt-5-nano',.05,.4,.005], ['gpt-5-pro',15,120,null],
  ['gpt-4.1',2,8,.5], ['gpt-4.1-mini',.4,1.6,.1], ['gpt-4o',2.5,10,1.25],
  ['gpt-4o-mini',.15,.6,.075], ['o3',2,8,.5], ['o3-pro',20,80,null],
]) add(...args);
for (const args of [
  ['claude-fable-5-1',10,50,.25], ['claude-opus-5-5',4,20,.2],
  ['claude-sonnet-5-5',2,10,.1], ['claude-haiku-5-5',.1,.5,.01],
]) add(...args, {source:CLAUDE, ...(args[0] === 'claude-haiku-5-5' ? {threshold:100000,long:{input:.5,output:2.5,cacheRead:.05}} : {}),
  note:'官方标准文本价；缓存写入 TTL 未记录时不估算该次费用；不含 fast、batch 等特殊费率。'});
for (const [model,input,output,cacheRead] of [
  ['deepseek-flash',.3,1.2,.006],['deepseek-v4-pro',1.32,3.96,.044],
]) add(model,input,output,cacheRead,{source:DEEPSEEK,note:'官方峰值标准价上限估算；未应用低峰半价及中国节假日折扣。历史请求也按此快照折算，不代表当时账单。'});

// MiniMax-M3.1-Flash has its own published rate; never substitute M3's price.
// All cross-provider totals stay USD-equivalent; CN prices are disclosed separately,
// not mixed into USD totals or converted with an invented exchange rate.
add('MiniMax-M3.1-Flash',.15,.60,.015,{source:MINIMAX,
  note:'MiniMax 国际站官方 USD 标准价：输入 $0.15、输出 $0.60、缓存读取 $0.015 / 百万 Token；国内站人民币价为 ¥1 / ¥4 / ¥0.10，不作为汇率换算或实际账单。'});
add('MiniMax-M3',.30,1.20,.06,{source:MINIMAX,threshold:512000,long:{input:.60,output:2.40,cacheRead:.12},
  note:'MiniMax-M3 官方 USD Standard 永久五折价；单次输入 >512k 时使用长上下文价，不含 Priority 加价。'});
const modelAliases = {'minimax-m3.1-flash':'MiniMax-M3.1-Flash','minimax-m3':'MiniMax-M3'};

/** Only exact known ids and documented date snapshots, never fuzzy family guesses. */
export function lookupPrice(model) {
  if (typeof model !== 'string') return null;
  const normalized = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const price = table.get(model) || table.get(normalized) || table.get(modelAliases[normalized]);
  return price ? { ...price, ...(price.long ? {long:{...price.long}} : {}) } : null;
}
export function estimateCost(record) {
  const base = lookupPrice(record.model);
  if (!base) return {cost:null,price:null};
  const prompt = record.input + record.cacheRead + record.cacheWrite;
  const long = base.long && prompt > base.threshold;
  const price = { ...base, ...(long ? base.long : {}),
    note: base.note + (base.long ? ` 单次输入（含缓存）>${base.threshold.toLocaleString('en-US')} 时按长上下文价计算。` : '') };
  let sum = 0;
  for (const key of ['input','output','cacheRead','cacheWrite']) {
    if (record[key] > 0 && price[key] === null) return {cost:null,price};
    sum += record[key] * (price[key] ?? 0) / 1000000;
  }
  return {cost:sum,price};
}
