// Astrea Desk — files d'attente en direct : agents inscrits, qui est connecté,
// qui est en appel ; connexion / déconnexion des agents DÉJÀ inscrits.
// Pas de gestion des agents dans Desk (décision de Brice, 02/11/2026 : un agent
// n'est pas une destination d'appel, Call Flow ne le code pas non plus) ; les
// inscriptions se règlent dans « Régler la file… ». Code lu le 02/11/2026
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
//      PUT  /agents/{id}/queues/{qid}/login | /logoff        connecter / déconnecter d'une file (l'agent reste inscrit)
//      (POST /agents/by-id/{id}/add | /remove existent, NON utilisés : inscription = « Régler la file… »)
//  - confd : agents.users[] (utilisateur lié à l'agent), queues.members.
// Groupes : l'entrée / sortie dynamique (*735…) passe par AddQueueMember dans
// le dialplan (wazo-agid group_member.py) ; seul amid la lit, et amid exige le
// tenant principal : invisible et non modifiable pour un admin de site.
import { S, $, esc, toast, listAll, confirmModal, canWrite, fullName } from '../admin-tools/common/core.js?v=0.7.10';
import { edit } from './cfbridge.js?v=0.7.10';

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
const userExts = () => L.users.flatMap((u) => (u.lines || []).flatMap((l) => (l.extensions || []).filter((e) => e.exten).map((e) => ({ exten: e.exten, context: e.context, user: u, line: l.id }))));

const hhmmss = (d) => d.toLocaleTimeString('fr-FR');

// Motif de pause : l'appli Wazo envoie « <code>:<texte libre> » (vu en réel le
// 02/11/2026 : « coffeeBreak:null », affiché « Pause café » dans l'appli).
// Codes connus traduits ; sinon le code est rendu lisible ; texte libre ajouté s'il existe.
const PAUSE = { coffeeBreak: 'Pause café', lunch: 'Déjeuner', lunchBreak: 'Déjeuner', meeting: 'Réunion', training: 'Formation', administrative: 'Administratif', break: 'Pause', other: 'Autre' };
export function pauseLabel(reason) {
  if (!reason) return '';
  const [code, ...rest] = String(reason).split(':');
  const extra = rest.join(':').trim();
  const base = PAUSE[code] || code.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return extra && extra !== 'null' && extra !== 'undefined' ? `${base} : ${extra}` : base;
}

function agentState(st) {
  if (!st?.logged) return ['off', 'Déconnecté'];
  if (st.paused) { const r = pauseLabel(st.paused_reason); return ['pause', `En pause${r ? ` (${r})` : ''}`]; }
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

// Connexion d'un agent, comme le bouton « Connexion Agent » de l'appli Wazo
// (décision de Brice, 02/11/2026 : même schéma, pas de choix téléphone / appli) :
// sur le NUMÉRO de son utilisateur lié (extension + contexte), toutes ses lignes
// sonnent ; agentd choisit lui-même la ligne surveillée. Un seul numéro libre :
// connexion directe ; sinon (pas d'utilisateur lié, plusieurs numéros, numéro
// déjà pris) fenêtre de choix du poste. Un utilisateur qui a plusieurs lignes
// sur le même numéro n'apparaît qu'une fois.
function loginAgent(a, after) {
  if (!a || !canWrite()) return;
  const mine = agentUser(a);
  const seen = new Map();
  for (const x of userExts()) {
    const k = `${x.exten}@${x.context}`;
    const o = seen.get(k) || { ...x, lines: 0, lineIds: [] };
    o.lines++; o.lineIds.push(x.line); seen.set(k, o);
  }
  const ctxs = new Set([...seen.values()].map((x) => x.context));
  // Poste déjà pris par un autre agent connecté (agentd le refuserait).
  const taken = new Map([...L.st.values()].filter((s) => s.logged && s.id !== a.id && s.extension).map((s) => [`${s.extension}@${s.context}`, L.agents.find((g) => g.id === s.id)]));
  const exts = [...seen.values()].sort((x, y) => (y.user.uuid === mine) - (x.user.uuid === mine) || fullName(x.user).localeCompare(fullName(y.user), 'fr'));
  if (!exts.length) { toast('Aucun poste sur ce site pour connecter l\'agent.', 6000); return; }
  const row = (x, i) => {
    const k = `${x.exten}@${x.context}`, other = taken.get(k);
    return `<label class="dk-pick${other ? ' dk-pick-off' : ''}"><input type="radio" name="la-ext" value="${i}"${other ? ' disabled' : ''}${i === 0 && !other ? ' checked' : ''}>
      <span class="dk-pick-main"><strong>${esc(fullName(x.user) || x.user.username || '?')}</strong><span class="muted small">poste ${esc(x.exten)}${ctxs.size > 1 ? ` · ${esc(x.context)}` : ''}${x.lines > 1 ? ` · ${x.lines} lignes (poste et appli)` : ''}</span></span>
      <span>${other ? `<span class="muted small">déjà utilisé par ${esc(agentName(other))}</span>` : phoneBadge(L.pr.get(x.user.uuid))}</span></label>`;
  };
  const own = exts.filter((x) => x.user.uuid === mine), others = exts.filter((x) => x.user.uuid !== mine);
  const login = (x) => svc('POST', `agentd/1.0/agents/by-id/${a.id}/login`, { extension: x.exten, context: x.context });
  // Cas courant : un seul poste, le sien, libre → connexion directe, comme dans l'appli.
  if (own.length === 1 && !taken.has(`${own[0].exten}@${own[0].context}`)) {
    act(`${agentName(a)} connecté sur son poste ${own[0].exten}.`, () => login(own[0]), after);
    return;
  }
  confirmModal(`<div class="dk-ed"><h3>Connecter l'agent ${esc(agentName(a))} <span class="muted small">n° ${esc(a.number)}</span></h3>
    <p class="muted small">Choisissez le poste sur lequel l'agent recevra les appels de ses files.</p>
    ${own.length ? `<h4>Son poste</h4><div class="dk-picks">${own.map((x) => row(x, exts.indexOf(x))).join('')}</div>` : '<p class="muted small">Aucun utilisateur n\'est lié à cet agent dans Wazo : choisissez un poste ci-dessous.</p>'}
    ${others.length ? (own.length
      // Son poste existe : les autres postes, rarement utiles, restent repliés (retour de Brice : « trompeur »).
      ? `<details class="dk-other"><summary>Le connecter sur le poste de quelqu'un d'autre (${others.length})</summary>${others.length > 8 ? '<input id="la-q" type="search" placeholder="Rechercher un nom ou un numéro">' : ''}<div class="dk-picks dk-picks-scroll" id="la-others">${others.map((x) => row(x, exts.indexOf(x))).join('')}</div></details>`
      : `<h4>Postes du site</h4>${others.length > 8 ? '<input id="la-q" type="search" placeholder="Rechercher un nom ou un numéro">' : ''}<div class="dk-picks dk-picks-scroll" id="la-others">${others.map((x) => row(x, exts.indexOf(x))).join('')}</div>`) : ''}
    <p id="la-err" class="error small"></p></div>`, async () => {
    const v = $('modal-body').querySelector('input[name="la-ext"]:checked')?.value;
    const x = exts[Number(v)]; if (!x) { $('la-err').textContent = 'Choisissez un poste.'; return false; }
    try { await login(x); toast(`${agentName(a)} connecté sur le poste ${x.exten}.`); }
    catch (err) { $('la-err').textContent = `Échec : ${err.message}`; return false; }
    await loadLive(); after(); return true;
  }, 'Connecter');
  if ($('la-q')) $('la-q').oninput = (e) => { const q = e.target.value.toLowerCase(); for (const l of $('la-others').children) l.hidden = q && !l.textContent.toLowerCase().includes(q); };
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
      + `<p class="muted small"><strong>Connecter</strong> : connecte l'agent sur son poste (il reçoit alors les appels de ses files). <strong>Déconnecter de la file</strong> : pour cette file seulement. <strong>Déconnecter l'agent</strong> : de toutes ses files. Ajouter ou retirer un agent de la file : « Régler la file… ».</p>`
      + (L.queues.length ? L.queues.map((q) => {
        const members = [...(q.members?.agents || [])].map((m) => ({ m, a: byId.get(m.id) || m })).sort((x, y) => agentName(x.a).localeCompare(agentName(y.a), 'fr'));
        const users = q.members?.users || [];
        const logged = members.filter(({ m }) => L.st.get(m.id)?.queues?.find((x) => x.id === q.id)?.logged && L.st.get(m.id)?.logged).length;
        const rows = members.map(({ m, a }) => {
          const st = L.st.get(m.id), inq = st?.queues?.find((x) => x.id === q.id);
          const [c, lbl] = agentState(st);
          // Ce que dit agentd (donc l'appli Wazo de l'agent) : une file absente de son
          // état n'est PAS une file où il reçoit des appels (constaté en réel le
          // 02/11/2026 : membre dans confd, connecté, mais « 0/0 file active » dans l'appli).
          const here = st?.logged ? (!inq ? ['off', 'Hors de la file pour Wazo'] : inq.logged === false ? ['off', 'A quitté la file'] : inq.paused ? ['pause', 'En pause dans la file'] : ['on', 'Dans la file']) : [c, lbl];
          // Pilotage (retours de Brice, 02/11/2026) : actions affichées directement
          // sur la ligne (le menu « ⋯ » a été retiré) ; les membres se règlent ailleurs.
          const btn = ro ? '' : !st?.logged ? `<button class="dk-text" data-on="${m.id}">Connecter</button>`
            : [st.paused ? `<button class="dk-text" data-unp="${esc(a.number)}">Reprendre</button>` : `<button class="dk-text" data-pause="${esc(a.number)}">Pause</button>`,
              !inq || inq.logged === false ? `<button class="dk-text" data-qin="${q.id}:${m.id}">${inq ? 'Reconnecter à la file' : 'Connecter à la file'}</button>` : `<button class="dk-text" data-qout="${q.id}:${m.id}">Déconnecter de la file</button>`,
              `<button class="dk-text" data-off="${m.id}" title="Déconnecte l'agent de toutes ses files">Déconnecter l'agent</button>`].join(' ');
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
    if (b.dataset.pause) { act('Agent en pause.', () => svc('POST', `agentd/1.0/agents/by-number/${encodeURIComponent(b.dataset.pause)}/pause`, {}), draw); return; }
    if (b.dataset.unp) { act('Fin de pause.', () => svc('POST', `agentd/1.0/agents/by-number/${encodeURIComponent(b.dataset.unp)}/unpause`, {}), draw); return; }
    if (b.dataset.off) {
      const a = byId.get(Number(b.dataset.off));
      if (canWrite()) confirmModal(`<p>Déconnecter <strong>${esc(agentName(a || {}))}</strong> de toutes ses files ?</p><p class="muted small">Il ne recevra plus aucun appel de file jusqu'à sa reconnexion.</p>`, async () => { await act('Agent déconnecté.', () => svc('POST', `agentd/1.0/agents/by-id/${b.dataset.off}/logoff`), draw); return true; }, 'Déconnecter');
      return;
    }
    const [qid, aid] = (b.dataset.qin || b.dataset.qout || '').split(':').map(Number);
    const q = L.queues.find((x) => x.id === qid);
    if (b.dataset.qin) act(`Agent reconnecté à « ${q.label} ».`, () => svc('PUT', `agentd/1.0/agents/${aid}/queues/${qid}/login`), draw);
    else if (b.dataset.qout) act(`Agent déconnecté de « ${q.label} ».`, () => svc('PUT', `agentd/1.0/agents/${aid}/queues/${qid}/logoff`), draw);
  };
  draw();
  liveLoop(view, '#lq-head', draw);
}
