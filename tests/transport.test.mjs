import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {apply} from '../index.js';

test('DSH HTTP bridge contract accepts real GET without a streaming request body',async()=>{
  let route;const dispose=[];
  apply({sessionPersistence:{async list(){return []}},connection:{fetch:{register(value){route=value;return ()=>{}}}},effect(run){const cb=run();if(cb)dispose.push(cb)}});
  // Preserve the installed DSH bridge's bodyMode branch: undefined is NOT buffered.
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://dsh.internal');
      const method=req.method;
      let request;
      if(route.requestBody==='buffered') {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        request=new Request(url,{method,...chunks.length?{body:Buffer.concat(chunks)}:{}});
      } else request=new Request(url,{method,body:Readable.toWeb(req),duplex:'half'});
      const response=await route.fetch(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    }catch{res.writeHead(400);res.end('bridge rejected request')}
  });
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/model-usage?range=all`);
    assert.equal(response.status,200);
    assert.equal((await response.json()).range,'all');
  } finally {await new Promise(resolve=>server.close(resolve));for(const cb of dispose.reverse())await cb();}
});
