// User Manager (Astrea Admin Tools) — audit des réglages des utilisateurs
// (lot 1) et modification en masse (lot 2a, réglages dans settings.js). Cadrage : astrea-wazo-dev/docs/USER-MANAGER.md.
// Vérifié dans le code de wazo-confd (master, 13/10/2026) :
//  - GET /users (vue complète, UserSchema) renvoie forwards {busy, noanswer,
//    unconditional: {enabled, destination}}, services {dnd, incallfilter:
//    {enabled}}, fallbacks {noanswer|busy|congestion|fail_destination},
//    groups [{uuid, id, name}] (name = nom technique, libellé via /groups),
//    voicemail {id, name}, call_permissions [{id, name}], schedules [{id, name}] ;
//  - pagination par 100 au plus : au-delà, confd charge tout d'un coup ;
//  - music_on_hold = `name` d'une MOH (libellé via GET /moh) ;
//  - destinations de débordement : user_firstname/lastname, group_label,
//    queue_label, voicemail_name, ivr_name… ajoutés par confd.
// Supposé, à vérifier en réel : le token du portail peut lire /moh,
// /voicemails, /callpermissions, /schedules (sinon libellés techniques).
import { S, $, esc, toast, api, listAll, connect, fullName, setReadonly, showCompat, loaded, loadFailed, canWrite, confirmModal, downloadJson } from '../common/core.js?v=0.24.0';
import { SETTINGS, settingById, same, LANG } from './settings.js?v=0.24.0';

const A = { users: [], byId: new Map(), moh: new Map(), groups: new Map(), vms: new Map(), perms: new Map(), scheds: new Map(), picked: new Set(), sort: { col: 'name', dir: 1 }, sel: null, scope: null, cols: null };

// ---------------------------------------------------------------------------
// Libellés
// ---------------------------------------------------------------------------
const exten = (u) => { for (const l of u.lines || []) for (const e of l.extensions || []) if (e.exten) return e.exten; return ''; };
const groupLabel = (g) => A.groups.get(g.uuid)?.label || g.label || g.name || `#${g.id}`;
const mohLabel = (name) => (!name ? '' : name === 'default' ? 'Par défaut' : A.moh.get(name) || name);
// outgoing_caller_id : jetons « default » / « anonymous » acceptés par confd.
const callerId = (v) => (!v ? '' : v === 'default' ? 'Par défaut' : v === 'anonymous' ? 'Anonyme' : v);
const HANGUP ={ busy: 'occupé', congestion: 'encombré', normal: 'normal' };
// Destination confd (débordements) → texte lisible.
function destText(d) {
  if (!d || !d.type || d.type === 'none') return '';
  switch (d.type) {
    case 'user': { const n = [d.user_firstname, d.user_lastname].filter(Boolean).join(' ') || fullName(A.byId.get(d.user_id)) || `#${d.user_id}`; return `Utilisateur ${n}`; }
    case 'group': return `Groupe ${d.group_label || d.group_name || `#${d.group_id}`}`;
    case 'queue': return `File ${d.queue_label || `#${d.queue_id}`}`;
    case 'voicemail': return `Messagerie ${d.voicemail_name || `#${d.voicemail_id}`}`;
    case 'ivr': return `SVI ${d.ivr_name || `#${d.ivr_id}`}`;
    case 'conference': return `Conférence ${d.conference_name || `#${d.conference_id}`}`;
    // Contexte omis : nom technique (ctx-…) illisible, vu en réel le 13/10/2026.
    case 'extension': return `Numéro ${d.exten}`;
    case 'outcall': return `Sortant ${d.exten || ''}`;
    case 'sound': return `Son ${d.filename || ''}`;
    case 'switchboard': return `POPC ${d.switchboard_name || ''}`; // nom du portail pour un standard
    case 'hangup': return `Raccrocher (${HANGUP[d.cause] || d.cause || ''})`;
    case 'application': return `Application ${d.application_name || d.application || ''}`;
    case 'custom': return `Commande ${d.command || ''}`;
    default: return d.type;
  }
}

// ---------------------------------------------------------------------------
// Colonnes. get(u) → { t: texte, k: clé de tri/écart, c: classe }.
// odd: false = colonne propre à chaque utilisateur (pas de recherche d'écart).
// ---------------------------------------------------------------------------
const txt = (t, c) => ({ t: t ?? '', k: String(t ?? ''), c: t === '' || t == null ? 'none' : c });
const yes = (v) => (v ? { t: 'Oui', k: '1', c: 'on' } : { t: 'Non', k: '0', c: 'none' });
function fwd(u, k) {
  const f = u.forwards?.[k];
  return f?.enabled ? { t: `→ ${f.destination || '?'}`, k: `1|${f.destination || ''}`, c: 'on' } : { t: '—', k: '0', c: 'none' };
}
// Débordement vers la propre messagerie de l'utilisateur = cas normal : même
// clé pour tous, sinon chaque utilisateur sortirait en écart.
function fb(u, k) {
  const d = u.fallbacks?.[`${k}_destination`];
  if (d?.type === 'voicemail' && u.voicemail && d.voicemail_id === u.voicemail.id) return { t: 'Sa messagerie', k: 'self-vm' };
  const t = destText(d);
  return t ? { t, k: t } : { t: '—', k: '', c: 'none' };
}
function vm(u) {
  if (!u.voicemail) return { t: '—', k: '', c: 'none' };
  const v = A.vms.get(u.voicemail.id);
  return { t: v ? `${v.number}${v.name ? ` (${v.name})` : ''}` : u.voicemail.name || `#${u.voicemail.id}`, k: '1' };
}
const names = (arr, f) => { const t = (arr || []).map(f).sort((a, b) => a.localeCompare(b, 'fr')).join(', '); return t ? { t, k: t } : { t: '—', k: '', c: 'none' }; };
const COLS = [
  { id: 'name', label: 'Utilisateur', grp: 'Identité', fixed: true, odd: false, get: (u) => txt(fullName(u)) },
  { id: 'exten', label: 'Numéro', grp: 'Identité', def: true, odd: false, get: (u) => { const e = exten(u); return { t: e || '—', k: e.padStart(12, '0'), c: e ? '' : 'none' }; } },
  { id: 'email', label: 'E-mail', grp: 'Identité', odd: false, get: (u) => txt(u.email) },
  { id: 'enabled', label: 'Actif', grp: 'Identité', get: (u) => (u.enabled === false ? { t: 'Non', k: '0', c: 'alert' } : { t: 'Oui', k: '1', c: 'none' }) },
  { id: 'dnd', label: 'Ne pas déranger', grp: 'Services', def: true, get: (u) => yes(u.services?.dnd?.enabled) },
  { id: 'incallfilter', label: 'Filtrage', grp: 'Services', get: (u) => yes(u.services?.incallfilter?.enabled) },
  // Libellés du portail (fiche utilisateur › Renvois, relevés le 13/10/2026) :
  // « Renvois d'appel » = forwards (gérés aussi par l'utilisateur), « Renvois
  // par défaut » = fallbacks (admin seulement).
  { id: 'fwd_busy', label: 'Renvoi occupé', grp: 'Renvois d\'appel (utilisateur)', def: true, get: (u) => fwd(u, 'busy') },
  { id: 'fwd_unc', label: 'Renvoi inconditionnel', grp: 'Renvois d\'appel (utilisateur)', def: true, get: (u) => fwd(u, 'unconditional') },
  { id: 'fwd_noans', label: 'Renvoi pas de réponse', grp: 'Renvois d\'appel (utilisateur)', def: true, get: (u) => fwd(u, 'noanswer') },
  { id: 'fb_busy', label: 'Défaut si occupé', grp: 'Renvois par défaut (admin)', def: true, get: (u) => fb(u, 'busy') },
  { id: 'fb_cong', label: 'Défaut congestion', grp: 'Renvois par défaut (admin)', def: true, get: (u) => fb(u, 'congestion') },
  { id: 'fb_fail', label: 'Défaut échec', grp: 'Renvois par défaut (admin)', def: true, get: (u) => fb(u, 'fail') },
  { id: 'fb_noans', label: 'Défaut non répondu', grp: 'Renvois par défaut (admin)', def: true, get: (u) => fb(u, 'noanswer') },
  { id: 'ring', label: 'Sonnerie (s)', grp: 'Sonnerie', def: true, get: (u) => ({ t: u.ring_seconds ?? '—', k: String(u.ring_seconds ?? '').padStart(6, '0') }) },
  { id: 'simul', label: 'Appels simult.', grp: 'Sonnerie', def: true, get: (u) => ({ t: u.simultaneous_calls ?? '—', k: String(u.simultaneous_calls ?? '').padStart(3, '0') }) },
  { id: 'callerid', label: 'Numéro présenté', grp: 'Identité d\'appel', def: true, get: (u) => txt(callerId(u.outgoing_caller_id)) },
  { id: 'mobile', label: 'Mobile', grp: 'Identité d\'appel', odd: false, get: (u) => txt(u.mobile_phone_number || '') },
  { id: 'vm', label: 'Messagerie', grp: 'Messagerie', def: true, odd: false, get: vm },
  { id: 'vm_email', label: 'E-mail messagerie', grp: 'Messagerie', odd: false, get: (u) => txt(A.vms.get(u.voicemail?.id)?.email || '') },
  { id: 'moh', label: 'Musique d\'attente', grp: 'Divers', def: true, get: (u) => txt(mohLabel(u.music_on_hold)) },
  { id: 'lang', label: 'Langue', grp: 'Divers', def: true, get: (u) => txt(LANG[u.language] || u.language || '') },
  { id: 'tz', label: 'Fuseau', grp: 'Divers', get: (u) => txt(u.timezone || '') },
  { id: 'groups', label: 'Groupes', grp: 'Groupes et droits', def: true, get: (u) => names(u.groups, groupLabel) },
  { id: 'perms', label: 'Droits d\'appel', grp: 'Groupes et droits', get: (u) => names(u.call_permissions, (c) => c.name) },
  { id: 'sched', label: 'Horaire', grp: 'Groupes et droits', get: (u) => names(u.schedules, (s) => s.name || `#${s.id}`) },
];
// v2 (0.23.2) : nouvelles colonnes par défaut, l'ancien choix est ignoré.
const COLS_KEY = 'astrea-users-cols-v2';
function loadCols() {
  try { const c = JSON.parse(localStorage.getItem(COLS_KEY)); if (Array.isArray(c)) return new Set(c); } catch { /* stockage indisponible */ }
  return new Set(COLS.filter((c) => c.def).map((c) => c.id));
}
function saveCols() { try { localStorage.setItem(COLS_KEY, JSON.stringify([...A.cols])); } catch { /* */ } }
const shownCols = () => COLS.filter((c) => c.fixed || A.cols.has(c.id));

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
async function boot() {
  $('conn').textContent = 'Chargement…';
  document.body.classList.remove('idle');
  const scope = `${S.base}|${S.tenant}`;
  if (A.scope !== scope) A.sel = null;
  A.scope = scope;
  try {
    await reload();
    loaded();
    $('conn').textContent = `${new URL(S.base).host}`;
  } catch (e) { loadFailed(e); }
}
// Utilisateurs du tenant courant (sans recurse), par pages de 100.
async function loadUsers() {
  const out = [];
  for (let off = 0; ; off += 100) {
    const r = await api('GET', `/users?limit=100&offset=${off}&order=firstname&direction=asc`);
    const items = r?.items || [];
    out.push(...items);
    if (items.length < 100 || (Number.isFinite(r?.total) && out.length >= r.total)) return out;
  }
}
// Listes de libellés : une erreur (droit manquant…) n'empêche pas l'audit.
async function lookup(path, what, warns) {
  try { return await listAll(path); } catch (e) { warns.push(`${what} indisponibles (${e.status || ''} ${path}) : valeurs techniques affichées.`); console.warn('[astrea]', path, e); return []; }
}
async function reload() {
  const warns = [];
  const [users, moh, groups, vms, perms, scheds] = await Promise.all([
    loadUsers(), lookup('/moh', 'Libellés des musiques d\'attente', warns), lookup('/groups', 'Libellés des groupes', warns), lookup('/voicemails', 'Détails des messageries', warns),
    lookup('/callpermissions', 'Droits d\'appel', warns), lookup('/schedules', 'Horaires', warns),
  ]);
  selfCheck(users);
  A.users = users.sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  A.byId = new Map(users.map((u) => [u.id, u]));
  A.moh = new Map(moh.map((m) => [m.name, m.label || m.name]));
  A.groups = new Map(groups.map((g) => [g.uuid, g]));
  A.vms = new Map(vms.map((v) => [v.id, v]));
  A.perms = new Map(perms.map((p) => [p.id, p]));
  A.scheds = new Map(scheds.map((s) => [s.id, s]));
  for (const id of [...A.picked]) if (!A.byId.has(id)) A.picked.delete(id);
  $('lookwarn').innerHTML = warns.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  const cur = $('f-group').value;
  $('f-group').innerHTML = '<option value="">Tous les utilisateurs</option>' + [...A.groups.values()]
    .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name, 'fr'))
    .map((g) => `<option value="${esc(g.uuid)}">${esc(g.label || g.name)}</option>`).join('');
  $('f-group').value = A.groups.has(cur) ? cur : '';
  if (A.sel && !A.byId.has(A.sel)) A.sel = null;
  render();
}
function selfCheck(users) {
  S.compatWarns = [];
  const problems = [];
  if (users.length && !users.some((u) => u && 'forwards' in u && 'services' in u && 'fallbacks' in u)) problems.push('la liste des utilisateurs ne contient plus les renvois, services ou débordements (GET /users)');
  if (users.length && !users.some((u) => u && 'ring_seconds' in u && 'simultaneous_calls' in u)) problems.push('champs ring_seconds / simultaneous_calls absents de GET /users');
  console.info('[astrea] User Manager auto-contrôle', { users: users.length, problems });
  if (problems.length) setReadonly(problems.join(' ; ')); else showCompat();
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------
function rows() {
  const q = $('q').value.trim().toLowerCase(), g = $('f-group').value;
  return A.users.filter((u) => {
    if (g && !(u.groups || []).some((x) => x.uuid === g)) return false;
    if (!q) return true;
    return [fullName(u), exten(u), u.email, u.mobile_phone_number, u.username].some((x) => String(x || '').toLowerCase().includes(q));
  });
}
function render() {
  renderCols();
  const cols = shownCols();
  const data = rows().map((u) => ({ u, v: cols.map((c) => c.get(u)) }));
  // Écarts : valeur différente de la plus fréquente, par colonne (si au moins 2 valeurs).
  const oddOn = $('f-odd').checked;
  const odd = cols.map((c, i) => {
    if (c.odd === false || data.length < 3) return null;
    const n = new Map();
    for (const r of data) n.set(r.v[i].k, (n.get(r.v[i].k) || 0) + 1);
    if (n.size < 2) return null;
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
  });
  let list = data;
  if ($('f-oddonly').checked) list = data.filter((r) => r.v.some((x, i) => odd[i] != null && x.k !== odd[i]));
  const si = Math.max(0, cols.findIndex((c) => c.id === A.sort.col));
  list = [...list].sort((a, b) => A.sort.dir * a.v[si].k.localeCompare(b.v[si].k, 'fr', { numeric: true }) || fullName(a.u).localeCompare(fullName(b.u), 'fr'));
  // Cases à cocher (sélection pour la masse) dans la première colonne ; celle
  // de l'en-tête coche / décoche les lignes affichées.
  A.shown = list.map((r) => r.u.id);
  const allOn = list.length && list.every((r) => A.picked.has(r.u.id));
  $('g-head').innerHTML = `<tr>${cols.map((c, i) => `<th data-col="${c.id}">${i ? '' : `<input type="checkbox" class="pick" id="pick-all" title="Cocher les lignes affichées"${allOn ? ' checked' : ''}> `}${esc(c.label)}${c.id === A.sort.col ? `<span class="arrow">${A.sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr>`;
  $('g-body').innerHTML = list.map((r) => `<tr data-u="${r.u.id}" class="${r.u.id === A.sel ? 'sel' : ''}${r.u.enabled === false ? ' disabled' : ''}">${r.v.map((x, i) => {
    const cls = [x.c, oddOn && odd[i] != null && x.k !== odd[i] ? 'odd' : ''].filter(Boolean).join(' ');
    const box = i ? '' : `<input type="checkbox" class="pick" data-pick="${r.u.id}"${A.picked.has(r.u.id) ? ' checked' : ''}> `;
    return `<td${cls ? ` class="${cls}"` : ''} title="${esc(x.t)}">${box}${esc(x.t)}</td>`;
  }).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="none">Aucun utilisateur.</td></tr>`;
  const nOdd = data.filter((r) => r.v.some((x, i) => odd[i] != null && x.k !== odd[i])).length;
  $('count').textContent = `${list.length} / ${A.users.length} utilisateur(s)${nOdd ? ` · ${nOdd} avec un écart` : ''}`;
  $('mass').textContent = `Modifier la sélection (${A.picked.size})`;
  $('mass').disabled = !A.picked.size;
  renderDetail();
}
function renderCols() {
  if ($('cols').dataset.ready) { $('cols').querySelectorAll('input[data-col]').forEach((x) => (x.checked = A.cols.has(x.dataset.col))); return; }
  let grp = '';
  $('cols').innerHTML = COLS.filter((c) => !c.fixed).map((c) => {
    const h = c.grp !== grp ? `<div class="grp">${esc((grp = c.grp))}</div>` : '';
    return `${h}<label class="inline"><input type="checkbox" data-col="${c.id}"${A.cols.has(c.id) ? ' checked' : ''}> ${esc(c.label)}</label>`;
  }).join('');
  $('cols').dataset.ready = '1';
}
// Détail en lecture seule de l'utilisateur sélectionné (préfigure la fiche).
function renderDetail() {
  const u = A.byId.get(A.sel);
  $('detail').hidden = !u;
  $('main').classList.toggle('no-detail', !u);
  if (!u) return;
  $('d-name').textContent = fullName(u);
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v === '' || v == null ? '<span class="muted">—</span>' : esc(v)}</dd>`;
  const sec = (title, body) => `<section class="dsec"><h4>${esc(title)}</h4><dl>${body}</dl></section>`;
  const f = (k) => { const x = u.forwards?.[k]; return x?.enabled ? `activé → ${x.destination || '?'}` : `désactivé${x?.destination ? ` (${x.destination})` : ''}`; };
  const v = A.vms.get(u.voicemail?.id);
  $('d-body').innerHTML = [
    sec('Identité', row('Numéro', exten(u)) + row('E-mail', u.email) + row('Actif', u.enabled === false ? 'non' : 'oui') + row('Mobile', u.mobile_phone_number) + row('Numéro présenté', callerId(u.outgoing_caller_id)) + row('Nom présenté', u.caller_id)),
    sec('Services', row('Ne pas déranger', u.services?.dnd?.enabled ? 'activé' : 'désactivé') + row('Filtrage', u.services?.incallfilter?.enabled ? 'activé' : 'désactivé')),
    sec('Renvois d\'appel (utilisateur)', row('Occupé', f('busy')) + row('Inconditionnel', f('unconditional')) + row('Pas de réponse', f('noanswer'))),
    sec('Renvois par défaut (admin)', row('Si occupé', destText(u.fallbacks?.busy_destination)) + row('Congestion', destText(u.fallbacks?.congestion_destination))
      + row('Échec', destText(u.fallbacks?.fail_destination)) + row('Non répondu', destText(u.fallbacks?.noanswer_destination))),
    sec('Sonnerie', row('Durée', u.ring_seconds != null ? `${u.ring_seconds} s` : '') + row('Appels simultanés', u.simultaneous_calls)),
    sec('Messagerie', u.voicemail ? row('Boîte', v ? `${v.number}@${v.context}` : u.voicemail.name) + row('Nom', v?.name || u.voicemail.name) + row('E-mail', v?.email)
      + row('Joindre l\'audio', v ? (v.attach_audio ? 'oui' : 'non') : '') + row('Supprimer après envoi', v ? (v.delete_messages ? 'oui' : 'non') : '') + row('Demander le code', v ? (v.ask_password ? 'oui' : 'non') : '') : row('Boîte', '')),
    sec('Divers', row('Musique d\'attente', mohLabel(u.music_on_hold)) + row('Langue', LANG[u.language] || u.language) + row('Fuseau', u.timezone)),
    sec('Groupes et droits', row('Groupes', (u.groups || []).map(groupLabel).join(', ')) + row('Droits d\'appel', (u.call_permissions || []).map((c) => c.name).join(', ')) + row('Horaire', (u.schedules || []).map((s) => s.name || `#${s.id}`).join(', '))),
  ].join('');
}

// ---------------------------------------------------------------------------
// Modification en masse (lot 2a)
// Aperçu calculé sur les données de l'audit ; à l'exécution, chaque
// utilisateur est relu (GET /users/{uuid}) et la valeur cible recalculée sur
// cette lecture. Sauvegarde (valeurs relues) téléchargée AVANT la première
// écriture, copie dans le navigateur pour la restauration.
// ---------------------------------------------------------------------------
const ctx = () => ({ moh: A.moh, groups: A.groups, perms: A.perms, scheds: A.scheds });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAST_BACKUP = 'astrea-users-last-backup';
// Classe les utilisateurs : à modifier / déjà à la valeur / impossible.
function plan(s, target, users) {
  const out = { change: [], same: [], bad: [] };
  for (const u of users) {
    const cur = s.read(u), next = target(cur, u);
    if (same(cur, next)) { out.same.push(u); continue; }
    const err = s.check?.(u, next);
    if (err) out.bad.push({ u, err }); else out.change.push({ u, cur, next });
  }
  return out;
}
function planHtml(s, p) {
  const c = ctx();
  return `<p class="small"><strong>${p.change.length}</strong> à modifier · ${p.same.length} déjà à cette valeur${p.bad.length ? ` · <span class="error">${p.bad.length} impossible(s)</span>` : ''}</p>
    ${p.change.length ? `<table class="diff"><tr><th>Utilisateur</th><th>Avant</th><th>Après</th></tr>${p.change.slice(0, 300).map((x) => `<tr><td>${esc(fullName(x.u))}</td><td class="muted">${esc(s.text(x.cur, c))}</td><td><strong>${esc(s.text(x.next, c))}</strong></td></tr>`).join('')}</table>` : ''}
    ${p.bad.map((x) => `<div class="warn">${esc(fullName(x.u))} : ${esc(x.err)}</div>`).join('')}
    ${s.heavy && p.change.length ? `<div class="warn">Chaque modification recharge la configuration d'Asterisk et régénère celle des postes de l'utilisateur : ${p.change.length} écriture(s), espacées.</div>` : ''}`;
}
function openMass() {
  if (!canWrite() || !A.picked.size) return;
  const users = [...A.picked].map((id) => A.byId.get(id)).filter(Boolean);
  const grps = [...new Set(SETTINGS.map((s) => s.grp))];
  confirmModal(`<h3>Modifier ${users.length} utilisateur(s)</h3>
    <label>Réglage <select id="m-set">${grps.map((g) => `<optgroup label="${esc(g)}">${SETTINGS.filter((s) => s.grp === g).map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</optgroup>`).join('')}</select></label>
    <div id="m-form"></div><div id="m-prev" class="mprev"></div>
    <p class="muted small">Une sauvegarde des valeurs actuelles est téléchargée avant d'écrire (bouton « Restaurer » pour revenir en arrière).</p>`, async () => {
    const s = settingById($('m-set').value);
    let spec;
    try { spec = s.parse(ctx()); } catch (e) { toast(e.message, 6000); return false; }
    if (!plan(s, spec.target, users).change.length) { toast('Rien à modifier : les utilisateurs sélectionnés ont déjà cette valeur.', 6000); return false; }
    await runMass(s, spec.desc, users, spec.target);
  }, 'Appliquer');
  const upd = () => {
    const s = settingById($('m-set').value);
    try { $('m-prev').innerHTML = planHtml(s, plan(s, s.parse(ctx()).target, users)); } catch (e) { $('m-prev').innerHTML = `<p class="error small">${esc(e.message)}</p>`; }
  };
  const setForm = () => { const s = settingById($('m-set').value); $('m-form').innerHTML = s.form(ctx()); s.wire?.(); upd(); };
  $('m-set').onchange = setForm;
  $('m-form').oninput = upd;
  $('m-form').onchange = upd;
  setForm();
}
// target(cur, u) → valeur à écrire. Lecture de tous, sauvegarde, puis écritures.
async function runMass(s, desc, users, target) {
  const todo = [], failed = [];
  let unchanged = 0, ok = 0;
  for (const [i, u0] of users.entries()) {
    toast(`Lecture ${i + 1}/${users.length}…`, 60000);
    try {
      const u = await api('GET', `/users/${u0.uuid}`);
      const cur = s.read(u), next = target(cur, u);
      if (next === undefined || same(cur, next)) { unchanged++; continue; }
      const err = s.check?.(u, next);
      if (err) failed.push([fullName(u), err]); else todo.push({ u, cur, next });
    } catch (e) { failed.push([fullName(u0), e.message]); }
  }
  if (todo.length) {
    const backup = { app: 'astrea-users', kind: 'backup', created: new Date().toISOString(), base: S.base, tenant: S.tenant, setting: s.id, desc,
      users: todo.map((x) => ({ id: x.u.id, uuid: x.u.uuid, name: fullName(x.u), before: x.cur, after: x.next })) };
    downloadJson(`astrea-users-sauvegarde-${s.id}-${backup.created.replace(/[:.]/g, '-')}.json`, backup);
    try { localStorage.setItem(LAST_BACKUP, JSON.stringify(backup)); } catch { /* stockage indisponible : le fichier suffit */ }
    for (const [i, x] of todo.entries()) {
      toast(`Écriture ${i + 1}/${todo.length}…`, 60000);
      try { await s.write(x.u, x.next, x.cur); ok++; } catch (e) { failed.push([fullName(x.u), e.message]); console.error('[astrea]', fullName(x.u), e); }
      if (s.heavy && i < todo.length - 1) await sleep(400);
    }
  }
  $('massres').innerHTML = `<div class="massres${failed.length ? ' bad' : ''}"><strong>${esc(desc)}</strong> : ${ok} modifié(s), ${unchanged} déjà à la valeur${failed.length ? `, ${failed.length} en erreur` : ''}.${todo.length ? ' Sauvegarde téléchargée.' : ''}
    ${failed.map(([n, m]) => `<div class="small">${esc(n)} : ${esc(m)}</div>`).join('')}<button class="icon" data-close title="Fermer">×</button></div>`;
  toast(`${ok} utilisateur(s) modifié(s)${failed.length ? `, ${failed.length} en erreur` : ''}.`, 6000);
  try { await reload(); } catch (e) { toast(e.message, 8000); }
}
// Restauration : remet les valeurs « before » d'une sauvegarde (fichier ou
// dernière sauvegarde du navigateur). Même serveur et même tenant exigés.
function openRestore() {
  if (!canWrite()) return;
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_BACKUP)); } catch { /* */ }
  confirmModal(`<h3>Restaurer une sauvegarde</h3>
    ${last ? `<label class="inline"><input type="radio" name="m-src" value="last" checked> Dernière sauvegarde de ce navigateur : ${esc(last.desc)} (${last.users?.length || 0} utilisateur(s), ${esc(new Date(last.created).toLocaleString('fr-FR'))})</label>` : ''}
    <label class="inline"><input type="radio" name="m-src" value="file"${last ? '' : ' checked'}> Fichier de sauvegarde (astrea-users-sauvegarde-….json)</label>
    <input type="file" id="m-file" accept=".json,application/json">`, async () => {
    let b;
    try {
      const src = document.querySelector('input[name="m-src"]:checked')?.value;
      if (src === 'last') b = last;
      else { const f = $('m-file').files[0]; if (!f) throw new Error('Choisissez un fichier.'); b = JSON.parse(await f.text()); }
      if (b?.app !== 'astrea-users' || b.kind !== 'backup' || !Array.isArray(b.users)) throw new Error('Ce fichier n\'est pas une sauvegarde User Manager.');
      if (!settingById(b.setting)) throw new Error(`Réglage inconnu dans la sauvegarde : ${b.setting}.`);
      if (b.base !== S.base || (b.tenant || null) !== (S.tenant || null)) throw new Error('Cette sauvegarde vient d\'un autre serveur ou d\'un autre tenant.');
    } catch (e) { toast(e.message, 7000); return false; }
    setTimeout(() => confirmRestore(b), 0); // le dialogue se ferme d'abord
  }, 'Suivant');
}
function confirmRestore(b) {
  const s = settingById(b.setting);
  const before = new Map(b.users.map((x) => [x.uuid, x.before]));
  const users = A.users.filter((u) => before.has(u.uuid));
  const missing = b.users.length - users.length;
  const target = (cur, u) => before.get(u.uuid);
  confirmModal(`<h3>Restaurer : ${esc(b.desc)}</h3>
    <p class="muted small">Sauvegarde du ${esc(new Date(b.created).toLocaleString('fr-FR'))}. Les valeurs d'avant la modification sont réécrites ; une nouvelle sauvegarde est téléchargée avant.</p>
    ${missing ? `<div class="warn">${missing} utilisateur(s) de la sauvegarde n'existent plus.</div>` : ''}
    <div class="mprev">${planHtml(s, plan(s, target, users))}</div>`, async () => {
    await runMass(s, `Restauration (${b.desc})`, users, target);
  }, 'Restaurer');
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
A.cols = loadCols();
$('mass').onclick = openMass;
$('restore').onclick = openRestore;
$('massres').onclick = (e) => { if (e.target.closest('[data-close]')) $('massres').innerHTML = ''; };
$('q').oninput = render;
$('f-group').onchange = render;
$('f-odd').onchange = render;
$('f-oddonly').onchange = render;
$('cols').onchange = (e) => {
  const id = e.target.dataset.col;
  if (!id) return;
  if (e.target.checked) A.cols.add(id); else A.cols.delete(id);
  saveCols();
  render();
};
$('cols-default').onclick = () => { A.cols = new Set(COLS.filter((c) => c.def).map((c) => c.id)); saveCols(); render(); };
$('g-head').onclick = (e) => {
  if (e.target.id === 'pick-all') {
    for (const id of A.shown || []) if (e.target.checked) A.picked.add(id); else A.picked.delete(id);
    render();
    return;
  }
  const th = e.target.closest('th[data-col]');
  if (!th) return;
  A.sort = { col: th.dataset.col, dir: A.sort.col === th.dataset.col ? -A.sort.dir : 1 };
  render();
};
$('g-body').onclick = (e) => {
  if (e.target.dataset.pick) {
    const id = Number(e.target.dataset.pick);
    if (e.target.checked) A.picked.add(id); else A.picked.delete(id);
    render();
    return;
  }
  const tr = e.target.closest('tr[data-u]');
  if (!tr) return;
  const id = Number(tr.dataset.u);
  A.sel = A.sel === id ? null : id;
  render();
};
$('d-close').onclick = () => { A.sel = null; render(); };
$('reload').onclick = async () => { try { await reload(); toast('Rechargé'); } catch (e) { toast(e.message, 8000); } };
connect(boot);
