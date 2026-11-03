import test from 'node:test';
import assert from 'node:assert/strict';
import { foldSession, makeReport, createUsageReader, dateKey, rangeStart } from '../core.js';
import { estimateCost, lookupPrice } from '../prices.js';
const T = Date.parse('2026-11-03T12:00:00+08:00');
const usage = (inputTokens = 10, outputTokens = 4, cacheReadTokens = 20, cacheWriteTokens = 0) => ({inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens:inputTokens+outputTokens+cacheReadTokens+cacheWriteTokens});
const route = {provider:'openai-codex',model:'gpt-6.1-sol'};
const header = (target = route) => ({type:'request/header',time:T,data:{header:{config:target}}});
const msg = (u = usage(), step = 0, extra = {}) => ({type:'assistant/message',time:T,data:{turn:1,step,usage:u,message:{source:route},...extra}});
const stream = u => [{type:'chunk',chunk:{type:'usage',usage:u}}];
const attempt = (u = usage()) => ({type:'assistant/attempt',time:T,data:{turn:1,step:0,stream:stream(u)}});
const fold = events => foldSession(events,{id:'s'});

test('disjoint buckets and reasoning is not added twice',()=>{
  const result = fold([header(),msg({...usage(),reasoningTokens:3})]);
  assert.equal(result.records[0].total,34);assert.equal(result.records[0].output,4);
  assert.equal(result.records[0].input,10); assert.equal(result.records[0].cacheRead,20);
});
test('message settles with explicit usage preferred over compact stream',()=>{
  const result = fold([header(),msg(usage(9),0,{stream:stream(usage(99))})]);
  assert.equal(result.records[0].input,9);
});
test('attempt compact stream last usage and header attribution',()=>{
  const a = attempt();a.data.stream.push(...stream(usage(40)));
  const r = fold([header(),a]);assert.equal(r.records[0].input,40);assert.equal(r.records[0].model,route.model);
});
test('same step sample replaces, retry boundary retains separate attempts',()=>{
  const retry = {type:'llm/retry-started',time:T,data:{turn:1,step:0}};
  assert.equal(fold([header(),attempt(),msg(usage(30))]).records.length,1);
  const r = fold([header(),attempt(),retry,msg(usage(30))]);assert.equal(r.records.length,2);
  assert.equal(r.records.reduce((s,x)=>s+x.input,0),40);
});
test('fork inherited usage excluded but header retained for new attempts',()=>{
  const events = [header(),msg(),{type:'session/end-seed',data:{inherited:true}},attempt(usage(50))];
  const r = foldSession(events,{id:'child',isSeeded:true,inheritedEventCount:2});
  assert.equal(r.records.length,1);assert.equal(r.records[0].input,50);assert.equal(r.records[0].provider,route.provider);
  assert.throws(()=>foldSession(events,{id:'child',isSeeded:true,inheritedEventCount:undefined}));
});
test('invalid counts and contradictory exact totals rejected, no body retained',()=>{
  const r = fold([header(),msg({...usage(),inputTokens:-1}),msg({...usage(),totalTokens:100},1)]);
  assert.equal(r.records.length,0);assert.equal(r.invalidRecords,2);
  const clean = fold([header(),msg(usage(),0,{message:{source:route,content:[{type:'text',text:'SECRET CHAT'}]}})]);
  assert.ok(!JSON.stringify(clean).includes('SECRET CHAT'));
});
test('omitted cache zeros can be proven by exact total, missing categorization not priced',()=>{
  const r = fold([msg({inputTokens:10,outputTokens:4,totalTokens:14}),msg({inputTokens:10,outputTokens:4,totalTokens:114},1)]);
  assert.equal(r.records[0].incomplete,false);assert.equal(r.records[1].incomplete,true);
  const report = makeReport([r],{now:T,range:'all'});assert.equal(report.totals.unpricedCalls,1);assert.ok(report.totals.cost>0);
});
test('official standard and per-request long-context price, unknown model remains unknown',()=>{
  const r = {model:'gpt-6.1-sol',input:1000000,output:1000,cacheRead:0,cacheWrite:0};
  assert.equal(estimateCost(r).cost,4+.015);
  assert.equal(estimateCost({...r,input:1000,cacheRead:1000}).cost,.002+.01+.0001);
  assert.equal(estimateCost({...r,model:'gpt-6.1-sol-unknown'}).cost,null);
  assert.equal(estimateCost({...r,cacheWrite:1}).cost,null);
  assert.equal(lookupPrice('gpt-6.1-sol-2026-10-01').input,2);
});
test('MiniMax Flash uses its verified own USD rate, not M3 fallback',()=>{
  const price = lookupPrice('MiniMax-M3.1-Flash');
  assert.equal(price.input,.15);assert.equal(price.output,.60);assert.equal(price.cacheRead,.015);
  assert.equal(price.source,'https://platform.minimax.io/docs/pricing/overview');
  assert.equal(lookupPrice('minimax-m3.1-flash').input,.15);
  const record = {model:'MiniMax-M3.1-Flash',input:1000000,output:1000000,cacheRead:1000000,cacheWrite:0};
  assert.equal(estimateCost(record).cost,.765);
  assert.equal(estimateCost({...record,cacheWrite:1}).cost,null);
  assert.equal(lookupPrice('MiniMax-M3').input,.30);
  assert.equal(lookupPrice('MiniMax-M3.2-unknown'),null);
});
test('OpenAI API and Codex same-model usage merge without dropping calls or double-counting sessions',()=>{
  const api = msg(usage());api.data.message.source = {provider:'openai',model:'gpt-6.1-sol'};
  const codex = msg(usage(30),1);
  const report = makeReport([fold([api,codex])],{range:'all',now:T});
  assert.equal(report.models.length,1);
  const row = report.models[0];assert.equal(row.provider,'OpenAI');
  assert.deepEqual(row.providers,['openai','openai-codex']);
  assert.equal(row.calls,2);assert.equal(row.sessions,1);assert.equal(row.total,88);
  assert.equal(row.input,40);assert.equal(row.output,8);assert.equal(row.cacheRead,40);
  assert.equal(row.tokenShare,1);assert.equal(row.costShare,1);
  assert.equal(row.cost,report.totals.cost);assert.ok(row.cost>0);
});
test('same model on other providers is one pie category and retains source metadata',()=>{
  const a = msg();a.data.message.source = {provider:'minimax-cn',model:'MiniMax-M3.1-Flash'};
  const b = msg(usage(),1);b.data.message.source = {provider:'minimax',model:'MiniMax-M3.1-Flash'};
  const report = makeReport([fold([a,b])],{range:'all',now:T});
  assert.equal(report.models.length,1);assert.equal(report.models[0].calls,2);
  assert.equal(report.models[0].provider,'多来源');
  assert.deepEqual(report.models[0].providers,['minimax','minimax-cn']);
});
test('different OpenAI models remain distinct after source merge',()=>{
  const other = msg(usage(),1);other.data.message.source = {provider:'openai',model:'gpt-5.4'};
  const report = makeReport([fold([msg(),other])],{range:'all',now:T});
  assert.equal(report.models.length,2);
  assert.ok(report.models.every(model=>model.provider==='OpenAI'));
  assert.equal(report.models.reduce((sum,model)=>sum+model.calls,0),2);
});
test('Shanghai boundaries cross UTC correctly, week is seven calendar days',()=>{
  assert.equal(dateKey(Date.parse('2026-11-02T17:00:00Z')),'2026-11-03');
  assert.equal(rangeStart('today',T),Date.parse('2026-11-03T00:00:00+08:00'));
  assert.equal(rangeStart('week',T),Date.parse('2026-10-28T00:00:00+08:00'));
  assert.throws(()=>rangeStart('bad',T));
});
test('aggregate percentages, partial costs, sessions and daily attribution',()=>{
  const r = fold([msg(),{...msg(usage(5),1),data:{...msg(usage(5),1).data,message:{source:{provider:'custom',model:'unknown'}}}}]);
  const report = makeReport([r],{range:'today',now:T});
  assert.equal(report.totals.calls,2);assert.equal(report.totals.sessions,1);assert.equal(report.totals.unpricedCalls,1);
  assert.equal(report.models.find(x=>x.model==='unknown').cost,null);
  assert.equal(report.models.reduce((s,x)=>s+x.tokenShare,0),1);
  assert.equal(report.daily[0].date,'2026-11-03');
});
test('all-unknown fees stay null and quiet calendar days remain zero',()=>{
  const event = msg();event.data.message.source = {provider:'custom',model:'unpriced'};
  const report = makeReport([fold([event])],{range:'week',now:T});
  assert.equal(report.totals.cost,null);assert.equal(report.daily.length,7);
  assert.equal(report.daily.find(x=>x.date==='2026-11-03').cost,null);
  assert.equal(report.daily.find(x=>x.date==='2026-11-02').cost,0);
});
test('cache revision, read-only handle lifecycle, failure isolation and close',async()=>{
  let reads = 0, closes = 0, revision = 'a';
  const persistence = {
    async list(){return [{header:{id:'s'},revision},{header:{id:'bad'},revision}]},
    async open(id,mode){assert.equal(mode,'read');if(id==='bad')throw new Error('private path should not leak');return {header:{isSeeded:false},inheritedEventCount:0,
      async read(){reads++;return {events:[header(),msg()]};},async close(){closes++;}};},
  };
  const reader = createUsageReader(persistence,{now:()=>T});
  let report = await reader.report('all');assert.equal(reads,1);assert.equal(closes,1);assert.equal(report.coverage.failedSessions,1);
  assert.ok(!JSON.stringify(report).includes('private path'));
  await reader.report('all');assert.equal(reads,1);
  revision = 'b';report = await reader.report('all');assert.equal(reads,2);assert.equal(closes,2);
  await reader.close();await assert.rejects(reader.report());
});
test('aborted scans close reader and never publish partial totals',async()=>{
  const controller = new AbortController();let closes = 0;
  const reader = createUsageReader({async list(){return [{header:{id:'s'},revision:'x'}]},async open(){return {header:{isSeeded:false},inheritedEventCount:0,
    async read(){controller.abort();return {events:[msg()]};},async close(){closes++;}};}},{now:()=>T});
  await assert.rejects(reader.report('all',controller.signal));assert.equal(closes,1);await reader.close();
});
