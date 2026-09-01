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
const decisionLabels = {to_triage:'À trier',to_do:'À faire',to_discuss:'À discuter',not_needed:'Pas besoin'};
const destinationLabels = {none:'Aucun envoi',auto:'Auto',chatgpt:'ChatGPT',codex:'Codex'};
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
    ticketsRoot.innerHTML=data.feedback.length ? data.feedback.map(item=>`<button class="ticket" data-id="${item.public_id}"><span class="app">${escapeHtml(item.app_name)}</span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.message)}</span><small><b class="kind">${escapeHtml(item.type)}</b><b class="priority ${item.priority}">${escapeHtml(item.priority)}</b><b class="status">${labels[item.status]||item.status}</b><b class="decision">Chris : ${escapeHtml(decisionLabels[item.chris_decision]||'À trier')}</b> · ${escapeHtml(item.client_version)} · ${new Date(item.created_at).toLocaleString('fr-BE')}${item.attachment_count ? ` · 📎 ${item.attachment_count}`:''}</small></button>`).join('') : '<p class="empty">Aucun ticket dans ce filtre.</p>';
    notice.textContent='';await loadNotifications();
  } catch(error) { notice.textContent=`Accès impossible : ${error.message}`; if(error.message==='unauthorized'){await clearAccess();loginNotice.textContent='Votre session a expiré. Reconnectez-vous.';} }
}
async function loadNotifications() {
  const root=document.querySelector('#notification-list'),notificationNotice=document.querySelector('#notification-notice');
  try {
    const [messages,devices]=await Promise.all([api('/notifications'),api('/notifications/devices')]);
    document.querySelector('#notification-device-count').textContent=devices.devices.length;
    document.querySelector('#notification-message-count').textContent=messages.notifications.length;
    document.querySelector('#notification-failure-count').textContent=messages.notifications.filter(item=>['failed','partial'].includes(item.status)).length;
    root.innerHTML=messages.notifications.length?messages.notifications.map(item=>`<article class="ticket"><span class="app">${escapeHtml(item.app_id)}</span><strong>${escapeHtml(item.event_type)}</strong><span>Statut : ${escapeHtml(item.status)}</span><small>${Number(item.delivered_count)}/${Number(item.device_count)} livré(s) · ${Number(item.failed_count)} échec(s) · ${new Date(item.created_at).toLocaleString('fr-BE')}</small></article>`).join(''):'<p class="empty">Aucune livraison visible.</p>';
    notificationNotice.textContent='';
  } catch(error) {
    root.replaceChildren();notificationNotice.textContent=error.message==='forbidden'?'Votre compte ne possède pas le scope notifications:read.':`Livraisons indisponibles : ${error.message}`;
  }
}
async function openTicket(id) {
  try {
    const data=await api(`/feedback/${id}`), f=data.feedback;
    document.querySelector('#detail-content').innerHTML=`<p class="eyebrow">${escapeHtml(f.app_name)} · ${escapeHtml(f.type)}</p><h2>${escapeHtml(f.title)}</h2><p class="message">${escapeHtml(f.message)}</p><dl><dt>Version</dt><dd>${escapeHtml(f.client_version)}</dd><dt>Route</dt><dd>${escapeHtml(f.route||'—')}</dd><dt>Contexte</dt><dd>${escapeHtml(JSON.stringify(f.technical_context))}</dd><dt>Appareil</dt><dd>${escapeHtml([f.device,f.os,f.browser,f.resolution].filter(Boolean).join(' · ')||'—')}</dd></dl>${data.attachments.length?`<h3>Pièces jointes</h3>${data.attachments.map(a=>`<a href="/api/v1/admin/attachments/${a.id}" data-download="${a.id}">${escapeHtml(a.original_name||'Capture')} · ${Math.ceil(a.byte_size/1024)} Ko</a>`).join('')}`:''}<form id="status-form"><label>Faire évoluer le statut<select name="status">${(transitions[f.status]||[]).map(s=>`<option value="${s}">${labels[s]}</option>`).join('')}</select></label><label>Note facultative<textarea name="note" maxlength="1000"></textarea></label><button ${!(transitions[f.status]||[]).length?'disabled':''}>Mettre à jour</button></form>`;
    document.querySelector('#status-form').insertAdjacentHTML('beforebegin', decisionPanel(data));
    bindDecision(f);
    dialog.showModal();
    document.querySelector('#status-form').addEventListener('submit',async event=>{ event.preventDefault(); try { const values=Object.fromEntries(new FormData(event.currentTarget)); await api(`/feedback/${id}`,{method:'PATCH',body:JSON.stringify(values)}); dialog.close(); await load(); } catch(error) { notice.textContent=`Mise à jour refusée : ${error.message}`; dialog.close(); } });
    document.querySelectorAll('[data-download]').forEach(link=>link.addEventListener('click',async event=>{ event.preventDefault(); const response=await fetch(link.href,{headers:authHeaders()}); if(!response.ok)return; const blob=await response.blob(), url=URL.createObjectURL(blob), anchor=document.createElement('a'); anchor.href=url; anchor.download=link.textContent.split(' · ')[0]; anchor.click(); URL.revokeObjectURL(url); }));
  } catch(error) { notice.textContent=`Ticket inaccessible : ${error.message}`; }
}
function decisionPanel(data) {
  const f=data.feedback, editable=data.can_edit_decision===true;
  return `<section class="decision-panel" aria-labelledby="decision-heading"><h3 id="decision-heading">Décision de Chris</h3>
    <p>Une orientation pour le centre, indépendante du statut technique. Rien n’est envoyé depuis ce panneau.</p>
    ${editable?`<form id="decision-form"><label>Décision<select name="chris_decision">${Object.entries(decisionLabels).map(([value,label])=>`<option value="${value}" ${f.chris_decision===value?'selected':''}>${label}</option>`).join('')}</select></label>
      <label id="decision-destination-label">Destinataire<select name="decision_destination">${['auto','chatgpt','codex'].map(value=>`<option value="${value}" ${f.decision_destination===value?'selected':''}>${destinationLabels[value]}</option>`).join('')}</select></label>
      <p id="decision-help"></p><label>Consigne facultative de Chris<textarea name="decision_note" maxlength="1000" rows="3">${escapeHtml(f.decision_note||'')}</textarea></label>
      <button>Enregistrer la décision</button></form>`:
      `<p><strong>${escapeHtml(decisionLabels[f.chris_decision]||'À trier')}</strong> · ${escapeHtml(destinationLabels[f.decision_destination]||'Aucun envoi')}</p><p class="message">${escapeHtml(f.decision_note||'')}</p><p>Lecture seule. Connectez-vous par e-mail avec un accès admin autorisé pour décider.</p>`}
    <p class="decision-version">Version ${Number(f.decision_version)||0}${f.decision_updated_at?` · ${new Date(f.decision_updated_at).toLocaleString('fr-BE')}`:' · Aucune décision enregistrée'}</p>
    <p id="decision-notice" role="status"></p><button id="decision-reload" type="button" hidden>Recharger le ticket</button>
    ${data.decision_history?.length?`<details><summary>Historique des décisions (50 dernières maximum)</summary><ul>${data.decision_history.map(entry=>`<li>v${Number(entry.details.version)} · ${new Date(entry.created_at).toLocaleString('fr-BE')} — ${escapeHtml(decisionLabels[entry.details.after?.chris_decision]||'')} / ${escapeHtml(destinationLabels[entry.details.after?.decision_destination]||'')}<p class="message">${escapeHtml(entry.details.after?.decision_note||'')}</p></li>`).join('')}</ul></details>`:''}
  </section>`;
}
function bindDecision(f) {
  const form=document.querySelector('#decision-form'); if(!form)return;
  const help=document.querySelector('#decision-help');
  const updateDestination=()=>{
    const decision=form.elements.chris_decision.value;
    document.querySelector('#decision-destination-label').hidden=decision!=='to_do';
    help.textContent={to_triage:'Aucune action à transmettre.',to_do:'Demander une solution au destinataire. Ce choix n’autorise pas à lui seul un développement ou un déploiement.',to_discuss:'À discuter avec ChatGPT. Le centre transmettra la demande lorsqu’il sera sollicité.',not_needed:'Aucun envoi. Le ticket reste conservé et son statut technique ne change pas.'}[decision];
  };
  form.elements.chris_decision.addEventListener('change',updateDestination);updateDestination();
  document.querySelector('#decision-reload').addEventListener('click',()=>{dialog.close();void openTicket(f.public_id);});
  form.addEventListener('submit',async event=>{
    event.preventDefault();const button=form.querySelector('button');button.disabled=true;
    const values=Object.fromEntries(new FormData(form));
    values.decision_destination=values.chris_decision==='to_discuss'?'chatgpt':values.chris_decision==='to_do'?values.decision_destination:'none';
    values.expected_version=f.decision_version;
    try {
      const result=await api(`/feedback/${f.public_id}/decision`,{method:'PATCH',body:JSON.stringify(values)});
      dialog.close();await load();notice.textContent=result.changed?'Décision enregistrée. Aucun message envoyé ; le centre la traitera lorsqu’il sera sollicité.':'Décision inchangée. Aucun message envoyé.';
    } catch(error) {
      const conflict=error.message==='decision_conflict';
      document.querySelector('#decision-notice').textContent=conflict?'La décision a changé dans une autre session. Rechargez le ticket avant de choisir à nouveau.':'Décision non enregistrée. Vérifiez votre session et réessayez.';
      document.querySelector('#decision-reload').hidden=!conflict;
    } finally {button.disabled=false;}
  });
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
