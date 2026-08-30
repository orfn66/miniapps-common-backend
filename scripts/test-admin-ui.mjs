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
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value;};
  const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,50));}throw new Error(`UI wait failed: ${expression}`);};
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.testRequests=[];
    window.fetch=async(path,init={})=>{
      window.testRequests.push({path,method:init.method||'GET',headers:init.headers||{}});
      if(path==='/api/v1/auth/session')return new Response('{}',{status:401});
      if(path==='/api/v1/auth/setup'||path==='/api/v1/auth/login'||path==='/api/v1/auth/password')return new Response(JSON.stringify({email:'test@example.invalid',csrf_token:'a'.repeat(64)}),{status:200});
      if(path==='/api/v1/auth/logout')return new Response('{"ok":true}',{status:200});
      if(path==='/api/v1/admin/apps')return new Response('{"apps":[]}',{status:200});
      if(path.startsWith('/api/v1/admin/feedback'))return new Response('{"feedback":[]}',{status:200});
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
  await evaluate(`document.querySelector('#password-button').click()`);
  await evaluate(`(()=>{const f=document.querySelector('#password-form');f.elements.current_password.value='A UI test passphrase!';f.elements.password.value='A new UI test passphrase!';f.elements.confirmation.value=f.elements.password.value;f.requestSubmit();})()`);
  await waitFor(`!document.querySelector('#password-dialog').open`);
  await evaluate(`document.querySelector('#logout').click()`);
  await waitFor(`!document.querySelector('#login-panel').hidden`);
  assert.equal(await evaluate(`document.querySelector('#workspace').hidden`),true);
  await evaluate(`document.querySelector('#setup-toggle').click()`);
  await evaluate(`(()=>{const f=document.querySelector('#login-form');f.elements.email.value='test@example.invalid';f.elements.password.value='A new UI test passphrase!';f.requestSubmit();})()`);
  await waitFor(`document.querySelector('#login-panel').hidden`);
  console.log(JSON.stringify({event:'admin_ui_test',status:'ok',mobile_width:390,screenshot:join(profile,'admin-login-mobile.png')}));
} finally {
  socket?.close();browser.kill();await new Promise(resolve=>server.close(resolve));
}
