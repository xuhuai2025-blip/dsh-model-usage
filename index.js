import { createUsageReader } from './core.js';

export const name = 'dsh-model-usage';
export const inject = ['connection','sessionPersistence'];
const json = (value,status = 200) => new Response(JSON.stringify(value), {status,headers:{
  'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
}});
/** Exact connection routes run under an authenticated owner Peer, including non-cookie carriers.
 * No file path, model credential or chat content is ever exposed by this endpoint.
 */
export function apply(ctx) {
  const reader = createUsageReader(ctx.sessionPersistence);
  ctx.effect(()=>()=>reader.close());
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/model-usage',methods:['GET'],requestBody:'buffered',async fetch(request) {
    const range = new URL(request.url).searchParams.get('range') || 'month';
    if (!['today','week','month','all'].includes(range)) return json({error:{code:'INVALID_RANGE',message:'不支持的时间范围。'}},400);
    try { return json(await reader.report(range,request.signal)); }
    catch {
      if (request.signal.aborted) return json({error:{code:'CANCELED',message:'读取已取消。'}},408);
      return json({error:{code:'USAGE_UNAVAILABLE',message:'用量读取失败，请刷新重试。原始会话未修改。'}},503);
    }
  }}));
}
