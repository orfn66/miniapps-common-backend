import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createNotificationHandler } from '../src/notification-service.js';

test('admin notification view exposes technical counters without capabilities or payloads',async()=>{
  const html=await readFile(new URL('../admin/index.html',import.meta.url),'utf8'),script=await readFile(new URL('../admin/app.js',import.meta.url),'utf8');
  assert.match(html,/Livraisons de notifications/);assert.match(html,/aucun contenu ni token/i);
  assert.match(script,/\/notifications\/devices/);assert.match(script,/delivered_count/);assert.match(script,/failed_count/);
  for(const forbidden of ['capability_ciphertext','payload_ciphertext','recipient_hash','device_reference_hash'])assert.equal(script.includes(forbidden),false);
});

test('email admin session can read technical state without granting bearer readers access',async()=>{
  const replies=[],pool={query:async()=>({rows:[]})};
  const handler=createNotificationHandler({pool,readJson:async()=>({}),reply:(_response,status,body)=>replies.push({status,body})});
  const request={method:'GET',headers:{}};
  const path=new URL('https://platform.invalid/api/v1/admin/notifications');
  assert.equal(await handler(request,{},path,'',{kind:'service',session_hash:'fixture',scopes:['feedback:read'],app_ids:null}),200);
  assert.equal(await handler(request,{},path,'',{kind:'service',scopes:['feedback:read'],app_ids:null}),403);
  assert.deepEqual(replies.map(item=>item.status),[200,403]);
});
