import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../src/domain.js';

export async function testDecisions({json,admin,id,legacyInstallation,auth,adminHeaders,codexHeaders,loginCookie,csrf,authOrigin}) {
  const path=`/api/v1/admin/feedback/${id}`;
  const human={cookie:loginCookie,origin:authOrigin,'x-forwarded-proto':'https','x-csrf-token':csrf};
  const body={chris_decision:'to_do',decision_destination:'codex',decision_note:'Proposer une solution, sans déployer.',expected_version:0};
  const patch=(value=body,headers=human,target=path)=>json(`${target}/decision`,{method:'PATCH',headers:{'content-type':'application/json',...headers},body:JSON.stringify(value)});
  const read=()=>json(path,{headers:human});
  const fields=f=>({decision:f.chris_decision,destination:f.decision_destination,note:f.decision_note,version:f.decision_version,at:f.decision_updated_at});
  const initial=await read();
  assert.equal(initial.body.can_edit_decision,true);
  assert.deepEqual(fields(initial.body.feedback),{decision:'to_triage',destination:'none',note:'',version:0,at:null});
  const legacy=(await admin.query('SELECT public_id,chris_decision,decision_version,decision_updated_at FROM feedback WHERE installation_id=$1',[legacyInstallation])).rows[0];
  assert.equal(legacy.chris_decision,'to_triage');assert.equal(legacy.decision_version,0);assert.equal(legacy.decision_updated_at,null);
  for(const headers of [auth,adminHeaders,codexHeaders]) assert.equal((await patch(body,headers)).response.status,403);
  assert.equal((await patch(body,{})).response.status,401);
  assert.equal((await patch(body,{...human,'x-csrf-token':''})).response.status,403);
  assert.equal((await patch(body,{...human,origin:'https://hostile.example'})).response.status,403);
  assert.equal((await json(path,{headers:codexHeaders})).body.can_edit_decision,false);
  assert.equal((await json('/api/v1/feedback',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({type:'bug',message:'forged decision',...body})})).response.status,400);
  assert.equal((await json(path,{method:'PATCH',headers:{...adminHeaders,'content-type':'application/json'},body:JSON.stringify({status:'confirmed',chris_decision:'to_do'})})).response.status,400);
  for(const invalid of [{decision_destination:'root'},{expected_version:'0'},{chris_decision:'invalid'},{decision_note:'x'.repeat(1001)},{status:'closed'}]) assert.equal((await patch({...body,...invalid})).response.status,400);
  await assert.rejects(admin.query("UPDATE feedback SET chris_decision='not_needed',decision_destination='codex' WHERE public_id=$1",[id]),{code:'23514'});

  // Human sessions remain app-scoped; the filter must never expand their access.
  await admin.query("UPDATE service_accounts SET app_ids=ARRAY['minigames-hub'] WHERE name='integration-admin'");
  assert.equal((await patch(body,human,`/api/v1/admin/feedback/${legacy.public_id}`)).response.status,404);
  assert.equal((await json(`/api/v1/admin/feedback/${legacy.public_id}`,{headers:human})).response.status,404);
  assert.deepEqual((await json('/api/v1/admin/feedback?app_id=perfect-tap&chris_decision=to_triage',{headers:human})).body.feedback,[]);
  await admin.query("UPDATE service_accounts SET app_ids=NULL WHERE name='integration-admin'");

  // Even a password session for a reader cannot decide (fixture in isolated DB).
  const raw=randomBytes(48).toString('base64url');
  const reader=(await admin.query("INSERT INTO admin_credentials(service_account_id,email,password_hash) SELECT id,'reader@example.invalid','disabled-test-hash' FROM service_accounts WHERE name='codex-reader' RETURNING id")).rows[0];
  await admin.query("INSERT INTO admin_sessions(token_hash,credential_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(raw),reader.id]);
  const readerHeaders={...human,cookie:`__Host-app-platform-session=${raw}`,'x-csrf-token':hashToken(`${raw}:csrf`)};
  assert.equal((await patch(body,readerHeaders)).response.status,403);
  assert.equal((await json(path,{headers:readerHeaders})).body.can_edit_decision,false);

  // Audit failure must roll back the decision itself.
  await admin.query('REVOKE INSERT ON platform_audit_log FROM miniapps_api');
  try {assert.equal((await patch()).response.status,500);} finally {await admin.query('GRANT INSERT ON platform_audit_log TO miniapps_api');}
  assert.deepEqual(fields((await read()).body.feedback),fields(initial.body.feedback));
  const raced=await Promise.all([patch(),patch({...body,decision_destination:'chatgpt'})]);
  assert.deepEqual(raced.map(r=>r.response.status).sort(),[200,409]);
  let current=(await read()).body;
  assert.equal(current.feedback.decision_version,1);assert.ok(current.feedback.decision_updated_at);
  assert.equal(current.feedback.status,initial.body.feedback.status);
  assert.deepEqual(current.history,initial.body.history);assert.deepEqual(current.attachments,initial.body.attachments);
  assert.equal(current.decision_history.length,1);assert.equal(current.decision_history[0].details.version,1);
  const noOp=await patch({...body,decision_destination:current.feedback.decision_destination,expected_version:1});
  assert.equal(noOp.body.changed,false);assert.equal(noOp.body.feedback.decision_version,1);
  assert.equal((await read()).body.decision_history.length,1);
  assert.equal((await patch()).response.status,409);
  for (const [chris_decision,decision_destination] of [['to_discuss','chatgpt'],['not_needed','none'],['to_triage','none'],['to_do','auto']]) {
    current=(await read()).body;
    const result=await patch({...body,chris_decision,decision_destination,expected_version:current.feedback.decision_version});
    assert.equal(result.response.status,200);
    assert.equal(result.body.feedback.decision_version,current.feedback.decision_version+1);
    assert.equal((await read()).body.feedback.status,initial.body.feedback.status);
  }
  const beforeStatus=fields((await read()).body.feedback);
  assert.equal((await json(path,{method:'PATCH',headers:{...human,'content-type':'application/json'},body:JSON.stringify({status:'in_progress'})})).response.status,200);
  assert.deepEqual(fields((await read()).body.feedback),beforeStatus);
  const list=await json('/api/v1/admin/feedback?chris_decision=to_do',{headers:codexHeaders});
  assert.deepEqual(list.body.feedback.map(f=>f.public_id),[id]);assert.equal(list.body.feedback[0].decision_version,5);
  assert.equal((await json(`/api/v1/admin/feedback/${legacy.public_id}`,{headers:codexHeaders})).response.status,404);
  assert.deepEqual((await json('/api/v1/admin/feedback?app_id=perfect-tap&chris_decision=to_triage',{headers:codexHeaders})).body.feedback,[]);
  const logs=(await json(`/api/v1/admin/logs?feedback_id=${id}`,{headers:codexHeaders})).body.logs.filter(l=>l.action==='feedback.decision_update');
  assert.equal(logs.length,5);
  assert.equal((await json('/api/v1/feedback/mine',{headers:auth})).body.feedback.some(f=>Object.hasOwn(f,'decision_note')),false);
  console.log(JSON.stringify({event:'decision_integration_complete',status:'ok'}));
}
