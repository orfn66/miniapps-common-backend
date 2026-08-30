const tokenKey = 'app-platform:admin-token';
const token = () => sessionStorage.getItem(tokenKey) || '';
let csrfToken = '';
let setupMode = false;
const loginPanel = document.querySelector('#login-panel');
const workspace = document.querySelector('#workspace');
const loginNotice = document.querySelector('#login-notice');
const loginForm = document.querySelector('#login-form');
const notice = document.querySelector('#notice');
const ticketsRoot = document.querySelector('#tickets');
const filters = document.querySelector('#filters');
const dialog = document.querySelector('#detail');
const labels = { new:'Nouveau',to_analyze:'À analyser',confirmed:'Confirmé',in_progress:'En cours',to_test:'À tester',fixed:'Corrigé',closed:'Fermé' };
const transitions = { new:['to_analyze','closed'],to_analyze:['confirmed','closed'],confirmed:['in_progress','closed'],in_progress:['to_test','confirmed','closed'],to_test:['fixed','in_progress','closed'],fixed:['closed','in_progress'],closed:['to_analyze'] };
async function api(path, init={}) {
  const response = await fetch(`/api/v1/admin${path}`, { ...init, headers:{ ...authHeaders(),'Content-Type':'application/json',...init.headers } });
  const body = response.status===204 ? {} : await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); return body;
}
function escapeHtml(value='') { const node=document.createElement('span'); node.textContent=String(value); return node.innerHTML; }
async function load() {
  if (!token() && !csrfToken) return;
  notice.textContent='Chargement…';
  try {
    const query = new URLSearchParams(new FormData(filters)); for (const [key,value] of [...query]) if (!value) query.delete(key);
    const [apps,data] = await Promise.all([api('/apps'),api(`/feedback?${query}`)]);
    const select=filters.elements.app_id, selected=select.value; select.innerHTML='<option value="">Toutes</option>'+apps.apps.map(app=>`<option value="${escapeHtml(app.app_id)}">${escapeHtml(app.name)}</option>`).join(''); select.value=selected;
    document.querySelector('#app-count').textContent=apps.apps.length; document.querySelector('#ticket-count').textContent=data.feedback.length; document.querySelector('#new-count').textContent=data.feedback.filter(item=>item.status==='new').length;
    ticketsRoot.innerHTML=data.feedback.length ? data.feedback.map(item=>`<button class="ticket" data-id="${item.public_id}"><span class="app">${escapeHtml(item.app_name)}</span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.message)}</span><small><b class="kind">${escapeHtml(item.type)}</b><b class="priority ${item.priority}">${escapeHtml(item.priority)}</b><b class="status">${labels[item.status]||item.status}</b> · ${escapeHtml(item.client_version)} · ${new Date(item.created_at).toLocaleString('fr-BE')}${item.attachment_count ? ` · 📎 ${item.attachment_count}`:''}</small></button>`).join('') : '<p class="empty">Aucun ticket dans ce filtre.</p>';
    notice.textContent='';
  } catch(error) { notice.textContent=`Accès impossible : ${error.message}`; if(error.message==='unauthorized'){await clearAccess();loginNotice.textContent='Votre session a expiré. Reconnectez-vous.';} }
}
async function openTicket(id) {
  try {
    const data=await api(`/feedback/${id}`), f=data.feedback;
    document.querySelector('#detail-content').innerHTML=`<p class="eyebrow">${escapeHtml(f.app_name)} · ${escapeHtml(f.type)}</p><h2>${escapeHtml(f.title)}</h2><p class="message">${escapeHtml(f.message)}</p><dl><dt>Version</dt><dd>${escapeHtml(f.client_version)}</dd><dt>Route</dt><dd>${escapeHtml(f.route||'—')}</dd><dt>Contexte</dt><dd>${escapeHtml(JSON.stringify(f.technical_context))}</dd><dt>Appareil</dt><dd>${escapeHtml([f.device,f.os,f.browser,f.resolution].filter(Boolean).join(' · ')||'—')}</dd></dl>${data.attachments.length?`<h3>Pièces jointes</h3>${data.attachments.map(a=>`<a href="/api/v1/admin/attachments/${a.id}" data-download="${a.id}">${escapeHtml(a.original_name||'Capture')} · ${Math.ceil(a.byte_size/1024)} Ko</a>`).join('')}`:''}<form id="status-form"><label>Faire évoluer le statut<select name="status">${(transitions[f.status]||[]).map(s=>`<option value="${s}">${labels[s]}</option>`).join('')}</select></label><label>Note facultative<textarea name="note" maxlength="1000"></textarea></label><button ${!(transitions[f.status]||[]).length?'disabled':''}>Mettre à jour</button></form>`;
    dialog.showModal();
    document.querySelector('#status-form').addEventListener('submit',async event=>{ event.preventDefault(); try { const values=Object.fromEntries(new FormData(event.currentTarget)); await api(`/feedback/${id}`,{method:'PATCH',body:JSON.stringify(values)}); dialog.close(); await load(); } catch(error) { notice.textContent=`Mise à jour refusée : ${error.message}`; dialog.close(); } });
    document.querySelectorAll('[data-download]').forEach(link=>link.addEventListener('click',async event=>{ event.preventDefault(); const response=await fetch(link.href,{headers:authHeaders()}); if(!response.ok)return; const blob=await response.blob(), url=URL.createObjectURL(blob), anchor=document.createElement('a'); anchor.href=url; anchor.download=link.textContent.split(' · ')[0]; anchor.click(); URL.revokeObjectURL(url); }));
  } catch(error) { notice.textContent=`Ticket inaccessible : ${error.message}`; }
}
function authHeaders() { return token() ? {Authorization:`Bearer ${token()}`} : csrfToken ? {'X-CSRF-Token':csrfToken} : {}; }
function showWorkspace(email='Accès par jeton') {
  loginPanel.hidden=true; workspace.hidden=false;
  document.querySelector('#account-email').textContent=email;
  document.querySelector('#logout').hidden=false;
  document.querySelector('#password-button').hidden=!csrfToken || !!token();
}
async function clearAccess() {
  sessionStorage.removeItem(tokenKey); csrfToken='';
  workspace.hidden=true;loginPanel.hidden=false;ticketsRoot.replaceChildren();dialog.close();
  document.querySelector('#account-email').textContent='';
  document.querySelector('#logout').hidden=true;document.querySelector('#password-button').hidden=true;
}
const authErrors = {
  credentials_invalid:'Adresse e-mail ou mot de passe incorrect.',
  email_or_password_invalid:'Vérifiez l’adresse e-mail et choisissez un mot de passe de 15 à 128 caractères.',
  password_invalid:'Choisissez un mot de passe de 15 à 128 caractères.',
  admin_token_required:'Le jeton administrateur complet est nécessaire pour cette première activation.',
  account_already_configured:'Un accès existe déjà. Utilisez « Se connecter ».',
  rate_limited:'Trop de tentatives. Patientez une minute avant de réessayer.',
  csrf_invalid:'Session expirée ou requête refusée. Reconnectez-vous.',
};
async function authRequest(action, values, headers={}) {
  const response=await fetch(`/api/v1/auth/${action}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(values)});
  const data=await response.json();
  if(!response.ok)throw new Error(authErrors[data.error]||'Opération refusée. Réessayez ou utilisez votre accès de secours.');
  return data;
}
document.querySelector('#setup-toggle').addEventListener('click',()=>{
  setupMode=!setupMode;document.querySelector('#setup-fields').hidden=!setupMode;
  loginForm.elements.confirmation.required=setupMode;loginForm.elements.admin_token.required=setupMode;
  loginForm.elements.password.minLength=setupMode?15:1;
  loginForm.elements.password.autocomplete=setupMode?'new-password':'current-password';
  document.querySelector('#login-submit').textContent=setupMode?'Activer mon accès':'Se connecter';
  document.querySelector('#setup-toggle').textContent=setupMode?'J’ai déjà un mot de passe':'Première connexion : définir mon mot de passe';
  loginNotice.textContent='';
});
loginForm.addEventListener('submit',async event=>{
  event.preventDefault(); const button=document.querySelector('#login-submit');button.disabled=true;loginNotice.textContent='Connexion…';
  try {
    const values=Object.fromEntries(new FormData(loginForm));
    if(setupMode && values.password!==values.confirmation)throw new Error('Les mots de passe ne correspondent pas.');
    const data=await authRequest(setupMode?'setup':'login',{email:values.email,password:values.password},setupMode?{Authorization:`Bearer ${values.admin_token.trim()}`} : {});
    sessionStorage.removeItem(tokenKey);csrfToken=data.csrf_token;loginForm.reset();loginNotice.textContent='';showWorkspace(data.email);await load();
  }catch(error){loginNotice.textContent=error.message;}finally{button.disabled=false;}
});
document.querySelector('#auth').addEventListener('click',()=>{
  const value=prompt('Jeton de service App Platform (accès de secours) :','');
  if(value?.trim()){sessionStorage.setItem(tokenKey,value.trim());showWorkspace();void load();}
});
document.querySelector('#logout').addEventListener('click',async()=>{
  try {if(csrfToken)await authRequest('logout',{}, {'X-CSRF-Token':csrfToken});await clearAccess();}
  catch(error){notice.textContent=error.message;}
});
const passwordDialog=document.querySelector('#password-dialog');
document.querySelector('#password-button').addEventListener('click',()=>{document.querySelector('#password-notice').textContent='';passwordDialog.showModal();});
passwordDialog.querySelector('.close').addEventListener('click',()=>{document.querySelector('#password-form').reset();passwordDialog.close();});
document.querySelector('#password-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
  try {const values=Object.fromEntries(new FormData(form));if(values.password!==values.confirmation)throw new Error('Les mots de passe ne correspondent pas.');
    const data=await authRequest('password',{current_password:values.current_password,password:values.password},{'X-CSRF-Token':csrfToken});csrfToken=data.csrf_token;form.reset();passwordDialog.close();notice.textContent='Mot de passe modifié. Les autres sessions sont fermées.';
  }catch(error){document.querySelector('#password-notice').textContent=error.message;}finally{button.disabled=false;}
});
filters.addEventListener('submit',event=>{event.preventDefault();void load();}); ticketsRoot.addEventListener('click',event=>{const ticket=event.target.closest('[data-id]');if(ticket)void openTicket(ticket.dataset.id);}); dialog.querySelector('.close').addEventListener('click',()=>dialog.close());
async function restoreAccess(){
  try{const response=await fetch('/api/v1/auth/session');if(response.ok){const data=await response.json();csrfToken=data.csrf_token;sessionStorage.removeItem(tokenKey);showWorkspace(data.email);await load();return;}}catch{loginNotice.textContent='Service momentanément inaccessible.';}
  if(token()){showWorkspace();await load();}
}
void restoreAccess();
