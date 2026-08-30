const tokenKey = 'app-platform:admin-token';
const token = () => sessionStorage.getItem(tokenKey) || '';
const notice = document.querySelector('#notice');
const ticketsRoot = document.querySelector('#tickets');
const filters = document.querySelector('#filters');
const dialog = document.querySelector('#detail');
const labels = { new:'Nouveau',to_analyze:'À analyser',confirmed:'Confirmé',in_progress:'En cours',to_test:'À tester',fixed:'Corrigé',closed:'Fermé' };
const transitions = { new:['to_analyze','closed'],to_analyze:['confirmed','closed'],confirmed:['in_progress','closed'],in_progress:['to_test','confirmed','closed'],to_test:['fixed','in_progress','closed'],fixed:['closed','in_progress'],closed:['to_analyze'] };
async function api(path, init={}) {
  const response = await fetch(`/api/v1/admin${path}`, { ...init, headers:{ Authorization:`Bearer ${token()}`,'Content-Type':'application/json',...init.headers } });
  const body = response.status===204 ? {} : await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); return body;
}
function escapeHtml(value='') { const node=document.createElement('span'); node.textContent=String(value); return node.innerHTML; }
async function load() {
  if (!token()) return;
  notice.textContent='Chargement…';
  try {
    const query = new URLSearchParams(new FormData(filters)); for (const [key,value] of [...query]) if (!value) query.delete(key);
    const [apps,data] = await Promise.all([api('/apps'),api(`/feedback?${query}`)]);
    const select=filters.elements.app_id, selected=select.value; select.innerHTML='<option value="">Toutes</option>'+apps.apps.map(app=>`<option value="${escapeHtml(app.app_id)}">${escapeHtml(app.name)}</option>`).join(''); select.value=selected;
    document.querySelector('#app-count').textContent=apps.apps.length; document.querySelector('#ticket-count').textContent=data.feedback.length; document.querySelector('#new-count').textContent=data.feedback.filter(item=>item.status==='new').length;
    ticketsRoot.innerHTML=data.feedback.length ? data.feedback.map(item=>`<button class="ticket" data-id="${item.public_id}"><span class="app">${escapeHtml(item.app_name)}</span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.message)}</span><small><b class="kind">${escapeHtml(item.type)}</b><b class="priority ${item.priority}">${escapeHtml(item.priority)}</b><b class="status">${labels[item.status]||item.status}</b> · ${escapeHtml(item.client_version)} · ${new Date(item.created_at).toLocaleString('fr-BE')}${item.attachment_count ? ` · 📎 ${item.attachment_count}`:''}</small></button>`).join('') : '<p class="empty">Aucun ticket dans ce filtre.</p>';
    notice.textContent='';
  } catch(error) { notice.textContent=`Accès impossible : ${error.message}`; }
}
async function openTicket(id) {
  try {
    const data=await api(`/feedback/${id}`), f=data.feedback;
    document.querySelector('#detail-content').innerHTML=`<p class="eyebrow">${escapeHtml(f.app_name)} · ${escapeHtml(f.type)}</p><h2>${escapeHtml(f.title)}</h2><p class="message">${escapeHtml(f.message)}</p><dl><dt>Version</dt><dd>${escapeHtml(f.client_version)}</dd><dt>Route</dt><dd>${escapeHtml(f.route||'—')}</dd><dt>Contexte</dt><dd>${escapeHtml(JSON.stringify(f.technical_context))}</dd><dt>Appareil</dt><dd>${escapeHtml([f.device,f.os,f.browser,f.resolution].filter(Boolean).join(' · ')||'—')}</dd></dl>${data.attachments.length?`<h3>Pièces jointes</h3>${data.attachments.map(a=>`<a href="/api/v1/admin/attachments/${a.id}" data-download="${a.id}">${escapeHtml(a.original_name||'Capture')} · ${Math.ceil(a.byte_size/1024)} Ko</a>`).join('')}`:''}<form id="status-form"><label>Faire évoluer le statut<select name="status">${(transitions[f.status]||[]).map(s=>`<option value="${s}">${labels[s]}</option>`).join('')}</select></label><label>Note facultative<textarea name="note" maxlength="1000"></textarea></label><button ${!(transitions[f.status]||[]).length?'disabled':''}>Mettre à jour</button></form>`;
    dialog.showModal();
    document.querySelector('#status-form').addEventListener('submit',async event=>{ event.preventDefault(); const values=Object.fromEntries(new FormData(event.currentTarget)); await api(`/feedback/${id}`,{method:'PATCH',body:JSON.stringify(values)}); dialog.close(); await load(); });
    document.querySelectorAll('[data-download]').forEach(link=>link.addEventListener('click',async event=>{ event.preventDefault(); const response=await fetch(link.href,{headers:{Authorization:`Bearer ${token()}`}}); if(!response.ok)return; const blob=await response.blob(), url=URL.createObjectURL(blob), anchor=document.createElement('a'); anchor.href=url; anchor.download=link.textContent.split(' · ')[0]; anchor.click(); URL.revokeObjectURL(url); }));
  } catch(error) { notice.textContent=`Ticket inaccessible : ${error.message}`; }
}
document.querySelector('#auth').addEventListener('click',()=>{ const value=prompt('Jeton de service App Platform (conservé uniquement pour cette session) :',token()); if(value!==null){ if(value)sessionStorage.setItem(tokenKey,value.trim()); else sessionStorage.removeItem(tokenKey); void load(); } });
filters.addEventListener('submit',event=>{event.preventDefault();void load();}); ticketsRoot.addEventListener('click',event=>{const ticket=event.target.closest('[data-id]');if(ticket)void openTicket(ticket.dataset.id);}); dialog.querySelector('.close').addEventListener('click',()=>dialog.close()); void load();
