import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,inject} from '../index.js';

function mount(persistence = {async list(){return []}}) {
  let route;const disposers = [];
  const ctx = {sessionPersistence:persistence,connection:{fetch:{register(value){route = value;return ()=>{};}}},effect(run){const dispose = run();if(dispose)disposers.push(dispose);}};
  apply(ctx);
  return {route,async close(){for(const dispose of disposers.reverse())await dispose();}};
}
test('mounts exact authenticated connection route; empty storage succeeds',async()=>{
  const host = mount();
  assert.deepEqual(inject,['connection','sessionPersistence']);
  assert.equal(host.route.path,'/api/model-usage');assert.deepEqual(host.route.methods,['GET']);
  // DSH's node HTTP bridge treats an absent mode as streaming, which attempts
  // to attach a request body to GET and fails with HTTP 400 before our handler.
  assert.equal(host.route.requestBody,'buffered');
  assert.doesNotThrow(()=>new Request('http://local/api/model-usage',{method:'GET'}));
  const response = await host.route.fetch(new Request('http://local/api/model-usage?range=all'));
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const value = await response.json();assert.equal(value.totals.calls,0);assert.equal(value.totals.cost,0);assert.equal(value.range,'all');
  await host.close();
});
test('invalid range rejects before reading storage',async()=>{
  let calls = 0;const host = mount({async list(){calls++;return []}});
  const response = await host.route.fetch(new Request('http://local/api/model-usage?range=bad'));
  assert.equal(response.status,400);assert.equal(calls,0);await host.close();
});
test('failure redacts private errors and paths',async()=>{
  const host = mount({async list(){throw new Error('PRIVATEKEY private path')}});
  const response = await host.route.fetch(new Request('http://local/api/model-usage'));
  assert.equal(response.status,503);assert.ok(!(await response.text()).includes('PRIVATEKEY'));await host.close();
});
test('all failed sessions do not produce a zero report',async()=>{
  const host = mount({async list(){return [{header:{id:'broken'},revision:'x'}]},async open(){throw new Error('broken')}});
  const response = await host.route.fetch(new Request('http://local/api/model-usage'));
  assert.equal(response.status,503);await host.close();
});
