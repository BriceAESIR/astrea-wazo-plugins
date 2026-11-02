// Astrea Desk — temps réel des files et des agents (0.5.0) : qui est connecté,
// qui est en appel, rejoindre / quitter une file. Code lu le 02/11/2026
// (branches master) :
//  - chatd GET /api/chatd/1.0/users/presences (chatd.users.presences.read) :
//    items {uuid, tenant_uuid, line_state, do_not_disturb} ; line_state =
//    ringing | progressing | holding | talking | available | unavailable ;
//    recurse=false par défaut ; refiltré sur le tenant ;
//  - agentd GET /agents : état des agents et, par file, logged / paused ;
//  - agentd, actions (tenant de l'agent contrôlé par agentd) :
//      POST /agents/by-id/{id}/login {extension, context}   connexion de l'agent sur un poste
//      POST /agents/by-id/{id}/logoff                        déconnexion
//      POST /agents/by-number/{n}/pause {reason?} | /unpause
//      PUT  /agents/{id}/queues/{qid}/login | /logoff        rejoindre / quitter une file (dynamique, l'agent reste membre)
//      POST /agents/by-id/{id}/add | /remove {queue_id}      ajouter / retirer de la file (permanent : confd + Asterisk)
//  - confd : agents.users[] (utilisateur lié à l'agent), queues.members.
// Groupes : l'entrée / sortie dynamique (*735…) passe par AddQueueMember dans
// le dialplan (wazo-agid group_member.py) ; seul amid la lit, et amid exige le
// tenant principal : invisible et non modifiable pour un admin de site.
import { S, $, esc, toast, listAll, confirmModal, canWrite, fullName } from '../admin-tools/common/core.js?v=0.6.1';
import { edit } from './cfbridge.js?v=0.6.1';

const REFRESH = 20e3;
export const PHONE = {
  talking: ['busy', 'En appel'], holding: ['busy', 'En attente'], ringing: ['ring', 'Sonne'], progressing: ['ring', 'Appel sortant'],
  available: ['free', 'Disponible'], unavailable: ['off', 'Hors ligne'],
};
export const phoneBadge = (p) => {
  if (!p) return '<span class="dk-ph dk-ph-off" title="État du téléphone inconnu">—</span>';
  const [c, l] = PHONE[p.line_state] || PHONE.unavailable;
  return `<span class="dk-ph dk-ph-${c}">${esc(l)}${p.do_not_disturb ? ' · NPD' : ''}</span>`;
};

async function svc(method, path, body) {
  if (S.readonly && method !== 'GET') throw new Error(`Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json', 'Wazo-Tenant': S.tenant };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${S.base}/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) {
    let m = ''; try { const j = await r.json(); m = Array.isArray(j?.reason) ? j.reason.join(' ') : j?.message || ''; } catch { /* */ }
    throw new Error(`${AGENTD_ERR[r.status] || `erreur ${r.status}`}${m ? ` (${m})` : ''}`);
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}
const AGENTD_ERR = { 400: 'requête refusée', 401: 'session expirée', 403: 'accès refusé', 404: 'introuvable', 409: 'impossible dans cet état' };

// Téléphones des utilisateurs (map uuid → présence). Échec : map vide (affiché « — »).
export async function loadPresences() {
  try {
    const j = await svc('GET', 'chatd/1.0/users/presences');
    return new Map((j?.items || []).filter((p) => !p.tenant_uuid || p.tenant_uuid === S.tenant).map((p) => [p.uuid, p]));
  } catch (e) { console.warn('[astrea] présences', e.message); return new Map(); }
}
async function loadStatuses() {
  const j = await svc('GET', 'agentd/1.0/agents');
  return new Map((Array.isArray(j) ? j : j?.items || []).filter((a) => !a.tenant_uuid || a.tenant_uuid === S.tenant).map((a) => [a.id, a]));
}

// Données communes aux deux écrans. Listes confd relues à chaque ouverture,
// états relus toutes les 20 s.
const L = { site: null, queues: [], agents: [], users: [], st: new Map(), pr: new Map(), at: null, err: '' };
async function loadLists() { [L.queues, L.agents, L.users] = await Promise.all([listAll('/queues'), listAll('/agents'), listAll('/users')]); }
async function loadLive() {
  const [st, pr] = await Promise.all([loadStatuses().catch((e) => { L.err = `États des agents indisponibles : ${e.message}`; return null; }), loadPresences()]);
  if (st) { L.st = st; L.err = ''; }
  L.pr = pr; L.at = new Date();
}
const agentName = (a) => [a.firstname, a.lastname].filter(Boolean).join(' ') || `Agent ${a.number}`;
const agentUser = (a) => (a.users || [])[0]?.uuid;
const userExts = () => L.users.flatMap((u) => (u.lines || []).flatMap((l) => (l.extensions || []).filter((e) => e.exten).map((e) => ({ exten: e.exten, context: e.context, user: u }))));
const hhmmss = (d) => d.toLocaleTimeString('fr-FR');

function agentState(st) {
  if (!st?.logged) return ['off', 'Déconnecté'];
  if (st.paused) return ['pause', `En pause${st.paused_reason ? ` (${st.paused_reason})` : ''}`];
  return ['on', 'Connecté'];
}

// Boucle d'actualisation propre à un écran : s'arrête quand l'écran disparaît.
function liveLoop(view, marker, draw) {
  const tick = async () => {
    if (!view.querySelector(marker)) return clearInterval(t);
    if (document.visibilityState !== 'visible' || document.querySelector('#modal:not([hidden])')) return;
    await loadLive(); if (view.querySelector(marker)) draw();
  };
  const t = setInterval(tick, REFRESH);
  return tick;
}

async function act(label, fn, after) {
  if (!canWrite()) return;
  try { await fn(); toast(label); }
  catch (e) { toast(`Échec : ${e.message}`, 8000); }
  await loadLive(); after();
}

// Connexion d'un agent sur un poste du site (son propre poste proposé en premier).
function loginAgent(a, after) {
  if (!a || !canWrite()) return;
  const mine = agentUser(a);
  const exts = userExts().sort((x, y) => (y.user.uuid === mine) - (x.user.uuid === mine) || fullName(x.user).localeCompare(fullName(y.user), 'fr'));
  if (!exts.length) { toast('Aucun poste sur ce site pour connecter l\'agent.', 6000); return; }
  confirmModal(`<h3>Connecter ${esc(agentName(a))}</h3><label>Sur le poste<select id="la-ext">${exts.map((x, i) => `<option value="${i}">${esc(x.exten)} · ${esc(fullName(x.user))}</option>`).join('')}</select></label><p class="muted small">L'agent recevra les appels de ses files sur ce poste.</p><p id="la-err" class="error small"></p>`, async () => {
    const x = exts[Number($('la-ext').value)]; if (!x) return false;
    try { await svc('POST', `agentd/1.0/agents/by-id/${a.id}/login`, { extension: x.exten, context: x.context }); toast('Agent connecté.'); }
    catch (err) { $('la-err').textContent = `Échec : ${err.message}`; return false; }
    await loadLive(); after(); return true;
  }, 'Connecter');
}

// ---------------------------------------------------------------------------
// Files d'attente : membres, états, connexion de l'agent
// ---------------------------------------------------------------------------
export async function renderQueues(view, site) {
  view.innerHTML = '<p class="dk-empty">Lecture…</p>';
  L.site = site.uuid;
  await loadLists(); await loadLive();
  const byId = new Map(L.agents.map((a) => [a.id, a]));
  const draw = () => {
    const ro = !!S.readonly;
    view.innerHTML = `<div class="phonehead" id="lq-head"><div><h2>Files d'attente</h2><div class="muted small">${esc(site.name)} · agents et membres en direct</div></div><div class="btnrow"><span class="muted small">Actualisé à ${esc(hhmmss(L.at))}</span><button id="lq-refresh">Actualiser</button></div></div>`
      + (L.err ? `<p class="warn small">${esc(L.err)}</p>` : '')
      + `<p class="muted small"><strong>Connecter…</strong> : connecte l'agent sur un poste (il reçoit alors les appels de ses files). <strong>Déconnecter de la file</strong> / <strong>Reconnecter à la file</strong> : pour cette file seulement, l'agent reste connecté aux autres. Ajouter ou retirer un membre : « Régler la file… ».</p>`
      + (L.queues.length ? L.queues.map((q) => {
        const members = [...(q.members?.agents || [])].map((m) => ({ m, a: byId.get(m.id) || m })).sort((x, y) => agentName(x.a).localeCompare(agentName(y.a), 'fr'));
        const users = q.members?.users || [];
        const logged = members.filter(({ m }) => L.st.get(m.id)?.queues?.find((x) => x.id === q.id)?.logged && L.st.get(m.id)?.logged).length;
        const rows = members.map(({ m, a }) => {
          const st = L.st.get(m.id), inq = st?.queues?.find((x) => x.id === q.id);
          const [c, lbl] = agentState(st);
          const here = st?.logged ? (inq?.logged === false ? ['off', 'A quitté la file'] : inq?.paused ? ['pause', 'En pause dans la file'] : ['on', 'Dans la file']) : [c, lbl];
          const btn = ro ? '' : !st?.logged ? `<button class="dk-text" data-on="${m.id}">Connecter…</button>` : inq?.logged === false ? `<button class="dk-text" data-qin="${q.id}:${m.id}">Reconnecter à la file</button>` : `<button class="dk-text" data-qout="${q.id}:${m.id}">Déconnecter de la file</button>`;
          return `<tr><td class="nowrap">${esc(agentName(a))} <span class="muted small">${esc(a.number || '')}</span></td><td><span class="dk-ag dk-ag-${here[0]}">${esc(here[1])}</span>${st?.logged && st.extension ? ` <span class="muted small">sur ${esc(st.extension)}</span>` : ''}</td><td>${phoneBadge(L.pr.get(agentUser(a)))}</td><td class="dk-acts">${btn}</td></tr>`;
        }).join('');
        return `<section class="dk-panel"><div class="dk-panhead"><h3>${esc(q.label || q.name)} <span class="muted small">${esc((q.extensions || []).map((e) => e.exten).join(', '))} · ${logged} / ${members.length} agent${members.length > 1 ? 's' : ''} dans la file</span></h3>${ro ? '' : `<button class="dk-text" data-qcfg="${q.id}" title="Stratégie, délais, débordements, membres, numéro, horaire">Régler la file…</button>`}</div>`
          + (rows ? `<div class="dk-scroll"><table class="dk-table"><thead><tr><th>Agent</th><th>Dans la file</th><th>Téléphone</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted small">Aucun agent membre.</p>')
          + (users.length ? `<details class="dk-members" open><summary>${users.length} utilisateur${users.length > 1 ? 's' : ''} membre${users.length > 1 ? 's' : ''} (sans agent)</summary><ul>${users.map((u) => `<li><span>${esc(fullName(u) || u.uuid)}</span>${phoneBadge(L.pr.get(u.uuid))}</li>`).join('')}</ul></details>` : '')
          + '</section>';
      }).join('') : '<p class="dk-empty">Aucune file d\'attente sur ce site.</p>');
    $('lq-refresh').onclick = async () => { await loadLive(); draw(); };
  };
  const reload = async () => { await loadLists(); byId.clear(); for (const a of L.agents) byId.set(a.id, a); draw(); };
  view.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    // Réglage complet de la file : éditeur de Call Flow Manager.
    if (b.dataset.qcfg) { edit('queue', b.dataset.qcfg, () => { if (view.querySelector('#lq-head')) reload(); }); return; }
    if (b.dataset.on) { loginAgent(byId.get(Number(b.dataset.on)), draw); return; }
    const [qid, aid] = (b.dataset.qin || b.dataset.qout || '').split(':').map(Number);
    const q = L.queues.find((x) => x.id === qid);
    if (b.dataset.qin) act(`Agent reconnecté à « ${q.label} ».`, () => svc('PUT', `agentd/1.0/agents/${aid}/queues/${qid}/login`), draw);
    else if (b.dataset.qout) act(`Agent déconnecté de « ${q.label} ».`, () => svc('PUT', `agentd/1.0/agents/${aid}/queues/${qid}/logoff`), draw);
  };
  draw();
  liveLoop(view, '#lq-head', draw);
}

// ---------------------------------------------------------------------------
// Agents : connexion, pause, téléphone
// ---------------------------------------------------------------------------
export async function renderAgents(view, site) {
  view.innerHTML = '<p class="dk-empty">Lecture…</p>';
  await loadLists(); await loadLive();
  const qname = new Map(L.queues.map((q) => [q.id, q.label || q.name]));
  const draw = () => {
    const ro = !!S.readonly;
    const list = [...L.agents].sort((a, b) => agentName(a).localeCompare(agentName(b), 'fr'));
    view.innerHTML = `<div class="phonehead" id="la-head"><div><h2>Agents</h2><div class="muted small">${esc(site.name)} · en direct</div></div><div class="btnrow"><span class="muted small">Actualisé à ${esc(hhmmss(L.at))}</span><button id="la-refresh">Actualiser</button></div></div>`
      + (L.err ? `<p class="warn small">${esc(L.err)}</p>` : '')
      + (list.length ? `<div class="dk-scroll"><table class="dk-table"><thead><tr><th>Agent</th><th>État</th><th>Téléphone</th><th>Files</th><th></th></tr></thead><tbody>${list.map((a) => {
        const st = L.st.get(a.id), [c, l] = agentState(st);
        const qs = (st?.queues?.length ? st.queues : (a.queues || []).map((x) => ({ id: x.queue?.id ?? x.id, logged: null }))).map((x) => `<span class="${x.logged === false ? 'muted' : ''}" title="${x.logged === false ? 'a quitté cette file' : ''}">${esc(qname.get(x.id) || x.display_name || x.name || `#${x.id}`)}${x.logged === false ? ' (sorti)' : ''}</span>`).join(', ');
        const btns = ro ? '' : st?.logged
          ? `${st.paused ? `<button class="dk-text" data-unp="${esc(a.number)}">Reprendre</button>` : `<button class="dk-text" data-pause="${esc(a.number)}">Pause</button>`} <button class="dk-text" data-off="${a.id}">Déconnecter</button>`
          : `<button class="dk-text" data-on="${a.id}">Connecter…</button>`;
        return `<tr><td class="nowrap">${esc(agentName(a))} <span class="muted small">${esc(a.number)}</span></td><td><span class="dk-ag dk-ag-${c}">${esc(l)}</span>${st?.logged && st.extension ? ` <span class="muted small">sur ${esc(st.extension)}</span>` : ''}</td><td>${phoneBadge(L.pr.get(agentUser(a)))}</td><td class="small">${qs || '—'}</td><td class="dk-acts">${btns}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="dk-empty">Aucun agent sur ce site.</p>');
    $('la-refresh').onclick = async () => { await loadLive(); draw(); };
  };
  view.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pause) act('Agent en pause.', () => svc('POST', `agentd/1.0/agents/by-number/${encodeURIComponent(b.dataset.pause)}/pause`, {}), draw);
    else if (b.dataset.unp) act('Agent sorti de pause.', () => svc('POST', `agentd/1.0/agents/by-number/${encodeURIComponent(b.dataset.unp)}/unpause`, {}), draw);
    else if (b.dataset.off) act('Agent déconnecté.', () => svc('POST', `agentd/1.0/agents/by-id/${b.dataset.off}/logoff`), draw);
    else if (b.dataset.on) loginAgent(L.agents.find((x) => x.id === Number(b.dataset.on)), draw);
  };
  draw();
  liveLoop(view, '#la-head', draw);
}
