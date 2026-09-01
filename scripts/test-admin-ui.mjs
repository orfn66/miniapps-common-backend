// Real browser, mocked API: no real credentials or production writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const profile = await mkdtemp(join(tmpdir(), 'app-platform-ui-test-'));
const server = createServer(async (req,res) => {
  const file = {'/admin':'index.html','/admin/app.js':'app.js','/admin/style.css':'style.css'}[new URL(req.url,'http://localhost').pathname];
  if (!file) {res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
  res.end(await readFile(new URL(`../admin/${file}`,import.meta.url)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], {stdio:'ignore'});
let socket;
try {
  let port;
  for(let i=0;i<100;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.ok(port,'Browser debugging port unavailable');
  const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  socket = new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let nextId=0;const pending=new Map();
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Browser command timed out: ${method}`));},10_000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value;};
  const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,50));}throw new Error(`UI wait failed: ${expression}`);};
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.testRequests=[];window.testCanDecide=true;window.testConflict=false;
    window.testTicket={public_id:'11111111-1111-4111-8111-111111111111',app_id:'minigames-hub',app_name:'MiniGames Hub',type:'bug',title:'Ticket de test local',message:'Vérifier le contrôle de décision.',status:'new',priority:'normal',client_version:'0.1.0',created_at:'2026-08-30T12:00:00Z',technical_context:{},attachment_count:0,chris_decision:'to_triage',decision_destination:'none',decision_note:'',decision_version:0,decision_updated_at:null};
    window.testHistory=[];
    window.fetch=async(path,init={})=>{
      window.testRequests.push({path,method:init.method||'GET',headers:init.headers||{},body:init.body?JSON.parse(init.body):null});
      if(path==='/api/v1/auth/session')return new Response('{}',{status:401});
      if(path==='/api/v1/auth/setup'||path==='/api/v1/auth/login'||path==='/api/v1/auth/password')return new Response(JSON.stringify({email:'test@example.invalid',csrf_token:'a'.repeat(64)}),{status:200});
      if(path==='/api/v1/auth/logout')return new Response('{"ok":true}',{status:200});
      if(path==='/api/v1/admin/apps')return Response.json({apps:[{app_id:'minigames-hub',name:'MiniGames Hub'}]});
      if(path==='/api/v1/admin/notifications')return Response.json({notifications:[{public_id:'22222222-2222-4222-8222-222222222222',app_id:'minigames-hub',event_type:'challenge.created',status:'delivered',device_count:1,delivered_count:1,failed_count:0,created_at:'2026-08-30T12:00:00Z'}]});
      if(path==='/api/v1/admin/notifications/devices')return Response.json({devices:[{id:'33333333-3333-4333-8333-333333333333',app_id:'minigames-hub',transport:'fcm',platform:'android',permission:'granted',state:'active'}]});
      if(path.endsWith('/decision')&&init.method==='PATCH'){
        if(window.testConflict)return Response.json({error:'decision_conflict'},{status:409});
        const input=JSON.parse(init.body);Object.assign(window.testTicket,{chris_decision:input.chris_decision,decision_destination:input.decision_destination,decision_note:input.decision_note,decision_version:window.testTicket.decision_version+1,decision_updated_at:'2026-08-30T13:00:00Z'});
        window.testHistory.unshift({actor:'test-admin',created_at:'2026-08-30T13:00:00Z',details:{version:window.testTicket.decision_version,after:{...window.testTicket}}});
        return Response.json({feedback:window.testTicket,changed:true});
      }
      if(path==='/api/v1/admin/feedback/'+window.testTicket.public_id)return Response.json({feedback:window.testTicket,attachments:[],history:[],decision_history:window.testHistory,can_edit_decision:window.testCanDecide});
      if(path.startsWith('/api/v1/admin/feedback?')){const value=new URL(path,'https://local.test').searchParams.get('chris_decision');return Response.json({feedback:!value||value===window.testTicket.chris_decision?[window.testTicket]:[]});}
      throw new Error('Unexpected mocked route');
    };
  `});
  await command('Page.navigate',{url:`${base}/admin`});
  await waitFor(`document.querySelector('#login-form')`);
  assert.equal(await evaluate(`document.querySelector('#workspace').hidden`),true);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),true);
  const screenshot=await command('Page.captureScreenshot',{format:'png'});
  await writeFile(join(profile,'admin-login-mobile.png'),Buffer.from(screenshot.data,'base64'));
  await evaluate(`document.querySelector('#setup-toggle').click()`);
  assert.equal(await evaluate(`document.querySelector('#setup-fields').hidden`),false);
  await evaluate(`(()=>{const f=document.querySelector('#login-form');f.elements.email.value='test@example.invalid';f.elements.password.value='A UI test passphrase!';f.elements.confirmation.value='different';f.elements.admin_token.value='x'.repeat(64);f.requestSubmit();})()`);
  await waitFor(`document.querySelector('#login-notice').textContent.includes('correspondent')`);
  await evaluate(`(()=>{const f=document.querySelector('#login-form');f.elements.confirmation.value=f.elements.password.value;f.requestSubmit();})()`);
  await waitFor(`document.querySelector('#login-panel').hidden`);
  assert.equal(await evaluate(`document.querySelector('#login-form').elements.password.value`),'');
  assert.equal(await evaluate(`sessionStorage.getItem('app-platform:admin-token')`),null);
  assert.equal(await evaluate(`document.querySelector('#password-button').hidden`),false);
  assert.equal(await evaluate(`window.testRequests.find(r=>r.path.startsWith('/api/v1/admin/feedback')).headers['X-CSRF-Token']`),'a'.repeat(64));
  await waitFor(`document.querySelector('.ticket')`);
  assert.equal(await evaluate(`document.querySelector('#notification-device-count').textContent`),'1');
  assert.equal(await evaluate(`document.querySelector('#notification-list').textContent.includes('challenge.created')`),true);
  assert.equal(await evaluate(`document.querySelector('.decision').textContent`),'Chris : À trier');
  await evaluate(`document.querySelector('.ticket').click()`);
  await waitFor(`document.querySelector('#decision-form')`);
  assert.equal(await evaluate(`document.querySelector('#decision-form').elements.chris_decision.options.length`),4);
  assert.equal(await evaluate(`document.querySelector('#decision-destination-label').hidden`),true);
  await evaluate(`(()=>{const select=document.querySelector('#decision-form').elements.chris_decision;select.value='to_do';select.dispatchEvent(new Event('change'));document.querySelector('.decision-panel').scrollIntoView();})()`);
  assert.equal(await evaluate(`document.querySelector('#decision-destination-label').hidden`),false);
  assert.equal(await evaluate(`document.querySelector('#decision-help').textContent.includes('n’autorise pas')`),true);
  assert.equal(await evaluate(`document.querySelector('#detail').scrollWidth <= document.querySelector('#detail').clientWidth`),true);
  const decisionShot=await command('Page.captureScreenshot',{format:'png'});
  await writeFile(join(profile,'admin-decision-mobile.png'),Buffer.from(decisionShot.data,'base64'));
  await evaluate(`(()=>{const f=document.querySelector('#decision-form');f.elements.decision_destination.value='codex';f.elements.decision_note.value='Proposer une solution, sans déployer.';f.requestSubmit();})()`);
  await waitFor(`!document.querySelector('#detail').open`);
  const saved=await evaluate(`window.testRequests.find(r=>r.path.endsWith('/decision'))`);
  assert.deepEqual(saved.body,{chris_decision:'to_do',decision_destination:'codex',decision_note:'Proposer une solution, sans déployer.',expected_version:0});
  assert.equal(saved.headers['X-CSRF-Token'],'a'.repeat(64));
  assert.equal(await evaluate(`window.testTicket.status`),'new');
  for(const [decision,destination] of [['to_discuss','chatgpt'],['not_needed','none']]){
    await evaluate(`document.querySelector('.ticket').click()`);await waitFor(`document.querySelector('#decision-form')`);
    await evaluate(`(()=>{const f=document.querySelector('#decision-form');f.elements.chris_decision.value='${decision}';f.elements.chris_decision.dispatchEvent(new Event('change'));f.requestSubmit();})()`);
    await waitFor(`!document.querySelector('#detail').open`);
    assert.equal(await evaluate(`window.testRequests.filter(r=>r.path.endsWith('/decision')).at(-1).body.decision_destination`),destination);
    assert.equal(await evaluate(`window.testTicket.status`),'new');
  }
  await evaluate(`document.querySelector('.ticket').click()`);await waitFor(`document.querySelector('#decision-form')`);
  await evaluate(`window.testConflict=true;document.querySelector('#decision-form').requestSubmit()`);
  await waitFor(`!document.querySelector('#decision-reload').hidden`);
  assert.equal(await evaluate(`document.querySelector('#detail').open`),true);
  await evaluate(`window.testConflict=false;document.querySelector('#decision-reload').click()`);
  await waitFor(`document.querySelector('#decision-form')`);
  assert.equal(await evaluate(`document.querySelector('.decision-version').textContent.includes('Version 3')`),true);
  await evaluate(`document.querySelector('#detail .close').click();window.testCanDecide=false;window.testTicket.decision_note='<img src=x onerror=alert(1)>';document.querySelector('.ticket').click()`);
  await waitFor(`document.querySelector('.decision-panel') && !document.querySelector('#decision-form')`);
  assert.equal(await evaluate(`document.querySelector('.decision-panel img')===null`),true);
  assert.equal(await evaluate(`document.querySelector('.decision-panel').textContent.includes('Lecture seule')`),true);
  await evaluate(`document.querySelector('#detail .close').click();document.querySelector('#filters').elements.chris_decision.value='to_triage';document.querySelector('#filters').requestSubmit()`);
  await waitFor(`document.querySelector('.empty')`);
  assert.equal(await evaluate(`window.testRequests.some(r=>r.path.includes('chris_decision=to_triage'))`),true);
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),true);
  await evaluate(`document.querySelector('#password-button').click()`);
  await evaluate(`(()=>{const f=document.querySelector('#password-form');f.elements.current_password.value='A UI test passphrase!';f.elements.password.value='A new UI test passphrase!';f.elements.confirmation.value=f.elements.password.value;f.requestSubmit();})()`);
  await waitFor(`!document.querySelector('#password-dialog').open`);
  await evaluate(`document.querySelector('#logout').click()`);
  await waitFor(`!document.querySelector('#login-panel').hidden`);
  assert.equal(await evaluate(`document.querySelector('#workspace').hidden`),true);
  await evaluate(`document.querySelector('#setup-toggle').click()`);
  await evaluate(`(()=>{const f=document.querySelector('#login-form');f.elements.email.value='test@example.invalid';f.elements.password.value='A new UI test passphrase!';f.requestSubmit();})()`);
  await waitFor(`document.querySelector('#login-panel').hidden`);
  console.log(JSON.stringify({event:'admin_ui_test',status:'ok',mobile_width:390,desktop_width:1440,screenshot:join(profile,'admin-login-mobile.png'),decision_screenshot:join(profile,'admin-decision-mobile.png')}));
} finally {
  socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
