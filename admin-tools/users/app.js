// User Manager (Astrea Admin Tools) — audit des réglages des utilisateurs
// (lot 1) et modification en masse (lots 2a/2b, réglages dans settings.js). Cadrage : astrea-wazo-dev/docs/USER-MANAGER.md.
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
import { S, $, esc, toast, api, listAll, connect, fullName, setReadonly, showCompat, loaded, loadFailed, canWrite, confirmModal, downloadJson } from '../common/core.js?v=0.27.0';
import { SETTINGS, settingById, same, LANG, subLabel } from './settings.js?v=0.27.0';

const A = { users: [], byId: new Map(), moh: new Map(), groups: new Map(), vms: new Map(), perms: new Map(), scheds: new Map(), queues: new Map(), sbs: new Map(), contexts: [], callerOpts: [], callerOptsErr: '', lr: null, picked: new Set(), sort: { col: 'name', dir: 1 }, sel: null, scope: null, cols: null };

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
    // Libellés ajoutés par confd à la lecture, sinon listes chargées (destinations
    // construites par la masse, sans libellés).
    case 'user': { const n = [d.user_firstname, d.user_lastname].filter(Boolean).join(' ') || fullName(A.byId.get(d.user_id)) || `#${d.user_id}`; return `Utilisateur ${n}`; }
    case 'group': { const g = [...A.groups.values()].find((x) => x.id === d.group_id); return `Groupe ${d.group_label || g?.label || d.group_name || g?.name || `#${d.group_id}`}`; }
    case 'queue': return `File ${d.queue_label || A.queues.get(d.queue_id)?.label || `#${d.queue_id}`}`;
    case 'voicemail': return `Messagerie ${d.voicemail_name || A.vms.get(d.voicemail_id)?.name || `#${d.voicemail_id}`}`;
    case 'ivr': return `SVI ${d.ivr_name || `#${d.ivr_id}`}`;
    case 'conference': return `Conférence ${d.conference_name || `#${d.conference_id}`}`;
    // Contexte omis : nom technique (ctx-…) illisible, vu en réel le 13/10/2026.
    case 'extension': return `Numéro ${d.exten}`;
    case 'outcall': return `Sortant ${d.exten || ''}`;
    case 'sound': return `Son ${d.filename || ''}`;
    case 'switchboard': return `POPC ${d.switchboard_name || A.sbs.get(d.switchboard_uuid)?.name || ''}`; // nom du portail pour un standard
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
  { id: 'email', label: 'E-mail (annuaire)', tip: 'Courriel public de la fiche (Renseignements personnels), affiché dans les annuaires. Différent des adresses de connexion (Authentification) et de l\'e-mail de la boîte vocale.', grp: 'Identité', odd: false, get: (u) => txt(u.email) },
  // Licence = subscription_type (0-10) ; libellés relevés en réel (settings.js, SUBS).
  { id: 'sub', label: 'Licence', tip: 'Type de souscription du portail (subscription_type : 0 Voix, 1 Communication unifiée, 3 Relation client).', grp: 'Identité', def: true, get: (u) => ({ t: subLabel(u.subscription_type), k: String(u.subscription_type ?? '') }) },
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
  { id: 'vm', label: 'Boîte vocale associée', tip: 'Boîte vocale associée à l\'utilisateur (numéro et nom). Les boîtes se configurent dans Messageries vocales.', grp: 'Messagerie', def: true, odd: false, get: vm },
  { id: 'vm_email', label: 'E-mail (réglage de la boîte)', tip: 'E-mail renseigné dans la boîte vocale associée (page Messageries vocales) : adresse où partent les messages vocaux. Différent de l\'e-mail de l\'annuaire.', grp: 'Messagerie', odd: false, get: (u) => txt(A.vms.get(u.voicemail?.id)?.email || '') },
  { id: 'moh', label: 'Musique d\'attente', grp: 'Divers', def: true, get: (u) => txt(mohLabel(u.music_on_hold)) },
  { id: 'lang', label: 'Langue', grp: 'Divers', def: true, get: (u) => txt(LANG[u.language] || u.language || '') },
  { id: 'tz', label: 'Fuseau', grp: 'Divers', get: (u) => txt(u.timezone || '') },
  { id: 'groups', label: 'Groupes', grp: 'Groupes et droits', def: true, get: (u) => names(u.groups, groupLabel) },
  { id: 'perms', label: 'Droits d\'appel', grp: 'Groupes et droits', get: (u) => names(u.call_permissions, (c) => c.name) },
  { id: 'sched', label: 'Horaire', grp: 'Groupes et droits', get: (u) => names(u.schedules, (s) => s.name || `#${s.id}`) },
];
// v3 (0.25.2, colonne Licence) : nouvelles colonnes par défaut, l'ancien choix est ignoré.
const COLS_KEY = 'astrea-users-cols-v3';
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
  try { return await listAll(path); } catch (e) { warns?.push(`${what} indisponibles (${e.status || ''} ${path}) : valeurs techniques affichées.`); console.warn('[astrea]', path, e); return []; }
}
// Numéros présentables du tenant (principal, partagés) : lus sur un
// utilisateur, identiques pour tous ; les « associated » (SDA) sont propres à
// chacun et proposés autrement. Route absente des anciennes versions : sans gravité.
async function loadCallerOpts(users) {
  A.callerOpts = []; A.callerOptsErr = '';
  const u = users[0];
  if (!u) return;
  try {
    const r = await api('GET', `/users/${u.uuid}/callerids/outgoing`);
    A.callerOpts = (r?.items || []).filter((o) => o.number && (o.type === 'main' || o.type === 'shared'));
  } catch (e) { A.callerOptsErr = e.status ? `erreur ${e.status}` : e.message; }
}
async function reload() {
  const warns = [];
  const [users, moh, groups, vms, perms, scheds, queues, sbs, contexts] = await Promise.all([
    loadUsers(), lookup('/moh', 'Libellés des musiques d\'attente', warns), lookup('/groups', 'Libellés des groupes', warns), lookup('/voicemails', 'Détails des messageries', warns),
    lookup('/callpermissions', 'Droits d\'appel', warns), lookup('/schedules', 'Horaires', warns),
    lookup('/queues', 'Files d\'attente', null), lookup('/switchboards', 'Standards', null), lookup('/contexts', 'Contextes', null), checkLiveReload(),
  ]);
  A.queues = new Map(queues.map((q) => [q.id, q]));
  A.sbs = new Map(sbs.map((s) => [s.uuid, s]));
  A.contexts = contexts.filter((c) => c.type !== 'incall' && c.type !== 'outcall').sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name, 'fr'));
  await loadCallerOpts(users);
  selfCheck(users);
  A.users = users.sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  A.byId = new Map(users.map((u) => [u.id, u]));
  A.moh = new Map(moh.map((m) => [m.name, m.label || m.name]));
  A.groups = new Map(groups.map((g) => [g.uuid, g]));
  A.vms = new Map(vms.map((v) => [v.id, v]));
  A.perms = new Map(perms.map((p) => [p.id, p]));
  A.scheds = new Map(scheds.map((s) => [s.id, s]));
  for (const id of [...A.picked]) if (!A.byId.has(id)) A.picked.delete(id);
  renderLiveReload();
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
  $('g-head').innerHTML = `<tr>${cols.map((c, i) => `<th data-col="${c.id}"${c.tip ? ` title="${esc(c.tip)}"` : ''}>${i ? '' : `<input type="checkbox" class="pick" id="pick-all" title="Cocher les lignes affichées"${allOn ? ' checked' : ''}> `}${esc(c.label)}${c.id === A.sort.col ? `<span class="arrow">${A.sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr>`;
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
    const h = c.grp !== grp ? `<div class="grp" data-grp="${esc(c.grp)}" title="Cocher / décocher tout le groupe">${esc((grp = c.grp))}</div>` : '';
    return `${h}<label class="inline"${c.tip ? ` title="${esc(c.tip)}"` : ''}><input type="checkbox" data-col="${c.id}" data-g="${esc(c.grp)}"${A.cols.has(c.id) ? ' checked' : ''}> ${esc(c.label)}</label>`;
  }).join('');
  $('cols').dataset.ready = '1';
}
// Fiche de l'utilisateur sélectionné (lot 3) : chaque réglage du catalogue
// (settings.js), y compris les champs propres à la fiche, avec un bouton ✎.
function renderDetail() {
  const u = A.byId.get(A.sel);
  $('detail').hidden = !u;
  $('main').classList.toggle('no-detail', !u);
  if (!u) return;
  $('d-name').textContent = fullName(u);
  const c = ctx();
  const row = (k, v, edit) => `<dt>${esc(k)}</dt><dd>${v === '' || v == null || v === '—' ? '<span class="muted">—</span>' : esc(v)}${edit ? ` <button class="icon edit" data-edit="${edit}" title="Modifier">✎</button>` : ''}</dd>`;
  const sec = (title, body) => `<section class="dsec"><h4>${esc(title)}</h4><dl>${body}</dl></section>`;
  const grps = [...new Set(SETTINGS.map((s) => s.grp))];
  const vm = A.vms.get(u.voicemail?.id);
  $('d-body').innerHTML = sec('Ligne', row('Numéro interne', exten(u)))
    + grps.map((g) => sec(g, SETTINGS.filter((s) => s.grp === g).map((s) => row(s.label, s.text(s.read(u), c), s.id)).join('')
      + (g === 'Boîte vocale' && vm ? row('E-mail (réglage de la boîte)', vm.email) : ''))).join('')
    + '<p class="muted small">Les réglages de la boîte vocale se modifient dans Messageries vocales.</p>';
}
// Modification d'un réglage pour l'utilisateur de la fiche : formulaire
// prérempli, aperçu, puis même moteur que la masse (relecture, sauvegarde
// gardée dans le navigateur sans téléchargement, restauration possible).
function openEdit(id) {
  const u = A.byId.get(A.sel), s = settingById(id);
  if (!u || !s || !canWrite()) return;
  const cur = s.read(u);
  confirmModal(`<h3>${esc(s.label)}</h3><p class="muted small">${esc(fullName(u))}</p><div id="m-form">${s.form(ctx())}</div><div id="m-prev" class="mprev"></div>`, async () => {
    let spec;
    try { spec = s.parse(ctx()); } catch (e) { toast(e.message, 6000); return false; }
    if (!plan(s, spec.target, [u]).change.length) { toast('Valeur inchangée ou impossible : rien à écrire.', 5000); return false; }
    await runMass([{ s, desc: spec.desc, target: spec.target }], [u], `${fullName(u)} — ${spec.desc}`, { download: false });
  }, 'Enregistrer');
  const vals = s.prefill ? s.prefill(cur, u) : { 'm-v': cur ?? '' };
  for (const [k, v] of Object.entries(vals)) { const e = document.getElementById(k); if (e && v != null) e.value = String(v); }
  s.wire?.();
  const preview = () => { try { $('m-prev').innerHTML = planHtml(s, plan(s, s.parse(ctx()).target, [u])); } catch (e) { $('m-prev').innerHTML = `<p class="error small">${esc(e.message)}</p>`; } };
  $('m-form').oninput = preview;
  $('m-form').onchange = preview;
  preview();
}

// ---------------------------------------------------------------------------
// Modification en masse (lots 2a / 2b)
// Assistant : 1) réglages à modifier, 2) une étape par réglage (valeur +
// aperçu), 3) récapitulatif puis « Appliquer ». À l'exécution, chaque
// utilisateur est relu (GET /users/{uuid}, + sa messagerie si besoin) et les
// valeurs cibles recalculées sur cette lecture. Sauvegarde (valeurs relues)
// téléchargée AVANT la première écriture, copie dans le navigateur.
// ---------------------------------------------------------------------------
const ctx = () => ({ vms: A.vms, moh: A.moh, groups: A.groups, perms: A.perms, scheds: A.scheds, queues: A.queues, sbs: A.sbs, contexts: A.contexts, users: A.users, callerOpts: A.callerOpts, callerOptsErr: A.callerOptsErr, destText });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAST_BACKUP = 'astrea-users-last-backup';
// Classe les utilisateurs : à modifier / déjà à la valeur / impossible.
// target(cur, u) === undefined : rien à faire pour cet utilisateur.
function plan(s, target, users) {
  const out = { change: [], same: [], bad: [] };
  for (const u of users) {
    const cur = s.read(u), next = target(cur, u);
    if (next === undefined || same(cur, next)) { out.same.push(u); continue; }
    const err = s.check?.(u, next);
    if (err) out.bad.push({ u, err }); else out.change.push({ u, cur, next });
  }
  return out;
}
const counts = (p) => `<strong>${p.change.length}</strong> à modifier · ${p.same.length} déjà à cette valeur${p.bad.length ? ` · <span class="error">${p.bad.length} impossible(s)</span>` : ''}`;
function planHtml(s, p) {
  const c = ctx();
  return `<p class="small">${counts(p)}</p>
    ${p.change.length ? `<table class="diff"><tr><th>Utilisateur</th><th>Avant</th><th>Après</th></tr>${p.change.slice(0, 300).map((x) => `<tr><td>${esc(fullName(x.u))}</td><td class="muted">${esc(s.text(x.cur, c))}</td><td><strong>${esc(s.text(x.next, c))}</strong></td></tr>`).join('')}</table>` : ''}
    ${badHtml(p.bad)}`;
}
// Impossibles regroupés par motif : « aucune SDA associée (6) : Bart, Jerry… ».
function badHtml(bad) {
  const by = new Map();
  for (const x of bad) { if (!by.has(x.err)) by.set(x.err, []); by.get(x.err).push(fullName(x.u)); }
  return [...by].map(([err, names]) => `<div class="warn">${esc(err)} (${names.length}) : ${esc(names.join(', '))}</div>`).join('');
}
// steps : [{ s, desc, p }] → récapitulatif de toutes les modifications.
function recapHtml(steps) {
  const c = ctx();
  const rows = steps.flatMap(({ s, p }, i) => p.change.map((x) => ({ i, s, x })))
    .sort((a, b) => fullName(a.x.u).localeCompare(fullName(b.x.u), 'fr') || a.i - b.i);
  const heavy = steps.reduce((n, { s, p }) => n + (s.heavy ? p.change.length : 0), 0);
  return `${steps.map(({ desc, p }) => `<div class="small"><strong>${esc(desc)}</strong> — ${counts(p)}</div>${badHtml(p.bad)}`).join('')}
    ${rows.length ? `<table class="diff"><tr><th>Utilisateur</th><th>Réglage</th><th>Avant</th><th>Après</th></tr>${rows.slice(0, 500).map((r) => `<tr><td>${esc(fullName(r.x.u))}</td><td>${esc(r.s.label)}</td><td class="muted">${esc(r.s.text(r.x.cur, c))}</td><td><strong>${esc(r.s.text(r.x.next, c))}</strong></td></tr>`).join('')}</table>` : ''}
    ${heavyHtml(heavy)}`;
}
function heavyHtml(n) {
  if (n < 2) return '';
  if (A.lr?.ok && A.lr.enabled) return `<label class="inline batch"><input type="checkbox" id="m-batch" checked> Regrouper les rechargements : ${n} écritures rechargent Asterisk ; le live reload est coupé pendant les écritures puis réactivé, avec un seul rechargement à la fin. Réglage commun à tout le serveur, réactivé même en cas d'erreur.</label>`;
  if (A.lr?.ok) return '<div class="warn">Le live reload est déjà désactivé sur ce serveur : ces écritures ne rechargeront pas Asterisk tant qu\'il n\'est pas réactivé (bandeau rouge).</div>';
  return `<div class="warn">${n} écritures rechargent chacune Asterisk : elles seront espacées. Regroupement indisponible (${esc(A.lr?.err || 'état du live reload inconnu')}).</div>`;
}
function openMass() {
  if (!canWrite() || !A.picked.size) return;
  const users = [...A.picked].map((id) => A.byId.get(id)).filter(Boolean);
  const W = { step: 0, ids: [], specs: {}, vals: {}, steps: [] };
  const list = () => W.ids.map(settingById);
  const saveVals = () => {
    const s = list()[W.step - 1];
    if (s && $('m-form')) W.vals[s.id] = Object.fromEntries([...$('m-form').querySelectorAll('input[id], select[id]')].map((e) => [e.id, e.value]));
  };
  const preview = (s) => { try { $('m-prev').innerHTML = planHtml(s, plan(s, s.parse(ctx()).target, users)); } catch (e) { $('m-prev').innerHTML = `<p class="error small">${esc(e.message)}</p>`; } };
  const back = '<div class="btnrow"><button type="button" id="m-back">← Précédent</button></div>';
  const render = () => {
    const n = W.ids.length;
    const head = (t) => `<h3>${esc(t)}</h3><p class="muted small">${users.length} utilisateur(s) sélectionné(s)${W.step ? ` · étape ${W.step + 1} sur ${n + 2}` : ''}</p>`;
    let ok = 'Suivant';
    if (W.step === 0) {
      const MASS = SETTINGS.filter((s) => !s.single); // champs propres à chacun : fiche seulement
      const grps = [...new Set(MASS.map((s) => s.grp))];
      $('modal-body').innerHTML = `${head('Réglages à modifier')}<div class="wizsets">${grps.map((g) => `<div class="grp" data-grp="${esc(g)}" title="Cocher / décocher tout le groupe">${esc(g)}</div>${MASS.filter((s) => s.grp === g).map((s) => `<label class="inline"><input type="checkbox" data-set="${s.id}" data-g="${esc(s.grp)}"${W.ids.includes(s.id) ? ' checked' : ''}> ${esc(s.label)}</label>`).join('')}`).join('')}</div>`;
    } else if (W.step <= n) {
      const s = list()[W.step - 1];
      $('modal-body').innerHTML = `${head(s.label)}<div id="m-form">${s.form(ctx())}</div><div id="m-prev" class="mprev"></div>${back}`;
      for (const [id, v] of Object.entries(W.vals[s.id] || {})) { const e = document.getElementById(id); if (e) e.value = v; }
      s.wire?.();
      $('m-form').oninput = () => preview(s);
      $('m-form').onchange = () => preview(s);
      preview(s);
    } else {
      W.steps = list().map((s) => ({ s, desc: W.specs[s.id].desc, p: plan(s, W.specs[s.id].target, users) }));
      $('modal-body').innerHTML = `${head('Récapitulatif')}<div class="mprev tall">${recapHtml(W.steps)}</div>
        <p class="muted small">Chaque utilisateur est relu juste avant l'écriture. Une sauvegarde des valeurs actuelles est téléchargée avant la première écriture (« Restaurer… » pour revenir en arrière).</p>${back}`;
      ok = 'Appliquer';
    }
    $('modal-body').querySelectorAll('.wizsets .grp[data-grp]').forEach((g) => (g.onclick = () => toggleGroup($('modal-body'), g.dataset.grp)));
    $('modal-ok').textContent = ok;
    if ($('m-back')) $('m-back').onclick = () => { saveVals(); W.step--; render(); };
  };
  confirmModal('', async () => {
    if (W.step === 0) {
      const ids = [...document.querySelectorAll('#modal-body input[data-set]:checked')].map((x) => x.dataset.set);
      if (!ids.length) { toast('Cochez au moins un réglage.'); return false; }
      W.ids = SETTINGS.filter((s) => ids.includes(s.id)).map((s) => s.id);
      W.step = 1; render(); return false;
    }
    if (W.step <= W.ids.length) {
      const s = list()[W.step - 1];
      saveVals();
      try { W.specs[s.id] = s.parse(ctx()); } catch (e) { toast(e.message, 6000); return false; }
      W.step++; render(); return false;
    }
    if (!W.steps.some((x) => x.p.change.length)) { toast('Rien à modifier : les utilisateurs sélectionnés ont déjà ces valeurs.', 6000); return false; }
    const desc = W.steps.length > 1 ? W.steps.map((x) => x.s.label).join(', ') : W.steps[0].desc;
    await runMass(W.steps.map(({ s, desc: d }) => ({ s, desc: d, target: W.specs[s.id].target })), users, desc, { batch: $('m-batch')?.checked === true });
  }, 'Suivant');
  render();
}
// items : [{ s, desc, target(cur, u) }]. Lecture de tous, sauvegarde, puis écritures.
async function runMass(items, users, desc, { batch = false, download = true } = {}) {
  const todo = [], failed = [], skipped = [];
  let unchanged = 0, ok = 0, lrNote = '';
  A.running = true;
  try {
    for (const [i, u0] of users.entries()) {
      toast(`Lecture ${i + 1}/${users.length}…`, 60000);
      try {
        const u = await api('GET', `/users/${u0.uuid}`);
        for (const it of items) {
          const cur = it.s.read(u), next = it.target(cur, u);
          if (next === undefined || same(cur, next)) { unchanged++; continue; }
          const err = it.s.check?.(u, next);
          if (err) skipped.push([fullName(u), it.s.label, err]); else todo.push({ u, it, cur, next });
        }
      } catch (e) { failed.push([fullName(u0), 'lecture', e.message]); }
    }
    if (todo.length) {
      const created = new Date().toISOString();
      const backup = { app: 'astrea-users', kind: 'backup', v: 2, created, base: S.base, tenant: S.tenant, desc,
        items: items.map((it) => ({ setting: it.s.id, desc: it.desc, users: todo.filter((x) => x.it === it).map((x) => ({ id: x.u.id, uuid: x.u.uuid, name: fullName(x.u), before: x.cur, after: x.next })) })).filter((x) => x.users.length) };
      if (download) downloadJson(`astrea-users-sauvegarde-${created.replace(/[:.]/g, '-')}.json`, backup);
      try { localStorage.setItem(LAST_BACKUP, JSON.stringify(backup)); } catch { /* stockage indisponible : le fichier suffit */ }
      let lrOff = false;
      if (batch && todo.filter((x) => x.it.s.heavy).length > 1) {
        try {
          const st = await liveReload('GET');
          if (st?.enabled) { await liveReload('PUT', { enabled: false }); lrOff = true; markLr(true); } else lrNote = 'live reload déjà désactivé : laissé tel quel';
        } catch (e) { lrNote = `regroupement impossible (${e.message}) : écritures espacées`; }
      }
      try {
        for (const [i, x] of todo.entries()) {
          toast(`Écriture ${i + 1}/${todo.length}…`, 60000);
          try { await x.it.s.write(x.u, x.next, x.cur); ok++; x.done = true; } catch (e) { failed.push([fullName(x.u), x.it.s.label, e.message]); console.error('[astrea]', fullName(x.u), x.it.s.id, e); }
          if (x.it.s.heavy && !lrOff && i < todo.length - 1) await sleep(400);
        }
      } finally {
        if (lrOff) lrNote = await restoreLiveReload(todo.filter((x) => x.done && x.it.s.heavy));
      }
    }
  } finally { A.running = false; }
  $('massres').innerHTML = `<div class="massres${failed.length ? ' bad' : ''}"><strong>${esc(desc)}</strong> : ${ok} modification(s) écrite(s), ${unchanged} déjà à la valeur${skipped.length ? `, ${skipped.length} ignorée(s) (impossible)` : ''}${failed.length ? `, ${failed.length} en erreur` : ''}.${todo.length ? (download ? ' Sauvegarde téléchargée.' : ' Sauvegarde gardée dans le navigateur (« Restaurer… »).') : ''}
    ${lrNote ? `<div class="small">${esc(lrNote)}.</div>` : ''}
    ${failed.map(([n, s, m]) => `<div class="small error">${esc(n)} · ${esc(s)} : ${esc(m)}</div>`).join('')}
    ${skipped.length ? `<details class="small"><summary>Ignorées (${skipped.length})</summary>${skipped.map(([n, s, m]) => `<div>${esc(n)} · ${esc(s)} : ${esc(m)}</div>`).join('')}</details>` : ''}<button class="icon" data-close title="Fermer">×</button></div>`;
  toast(`${ok} modification(s) écrite(s)${failed.length ? `, ${failed.length} en erreur` : ''}.`, 6000);
  try { await reload(); } catch (e) { toast(e.message, 8000); }
}

// ---------------------------------------------------------------------------
// Live reload (vérifié dans le code de confd, 13/10/2026) :
//  - GET/PUT /configuration/live_reload {enabled}, ACL
//    confd.configuration.live_reload.read|update, tenant principal exigé
//    (required_master_tenant) : appel SANS en-tête Wazo-Tenant ;
//  - désactivé, confd n'envoie plus aucune commande de rechargement à
//    Asterisk (sysconfd) ; les données et la config des postes sont écrites ;
//  - le réactiver ne recharge rien : une écriture neutre (même valeur)
//    déclenche ensuite les rechargements de son type.
// Réglage COMMUN À TOUT LE SERVEUR (tous les tenants).
// À vérifier en réel : droit du token du portail, tenant principal.
// ---------------------------------------------------------------------------
const LR_MARK = 'astrea-users-lr-off';
async function liveReload(method, body) {
  if (S.readonly && method !== 'GET') throw new Error(`Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${S.base}/api/confd/1.1/configuration/live_reload`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`live reload ${method} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}
async function checkLiveReload() {
  try { A.lr = { ok: true, enabled: (await liveReload('GET'))?.enabled !== false }; } catch (e) { A.lr = { ok: false, err: e.message }; }
}
function markLr(on) { try { if (on) localStorage.setItem(LR_MARK, `${S.base}|${new Date().toISOString()}`); else localStorage.removeItem(LR_MARK); } catch { /* */ } }
// Réactive (3 essais), puis déclenche le rechargement final.
async function restoreLiveReload(done) {
  let err = '';
  for (let i = 0; i < 3; i++) {
    try { await liveReload('PUT', { enabled: true }); err = ''; break; } catch (e) { err = e.message; await sleep(1000); }
  }
  if (err) { A.lr = { ok: true, enabled: false }; renderLiveReload(); return `ÉCHEC de la réactivation du live reload (${err}) : utilisez le bouton du bandeau rouge`; }
  markLr(false);
  A.lr = { ok: true, enabled: true };
  renderLiveReload();
  return `rechargements regroupés : live reload coupé pendant les écritures puis réactivé${await triggerReload(done)}`;
}
async function triggerReload(done) {
  const out = [];
  try {
    const xu = done.find((x) => x.it.s.reload === 'user');
    if (xu) { const u = await api('GET', `/users/${xu.u.uuid}`); await api('PUT', `/users/${u.uuid}`, { ring_seconds: u.ring_seconds }); out.push('Asterisk'); }
    return out.length ? `, rechargement final déclenché (${out.join(', ')})` : '';
  } catch (e) { return `, mais le rechargement final a échoué (${e.message}) : bouton « Réactiver et recharger » si besoin`; }
}
function renderLiveReload() {
  if (!(A.lr?.ok && !A.lr.enabled)) { $('lrwarn').innerHTML = ''; return; }
  let mine = false;
  try { mine = (localStorage.getItem(LR_MARK) || '').startsWith(`${S.base}|`); } catch { /* */ }
  $('lrwarn').innerHTML = `<div class="compat blocking"><strong>Live reload désactivé sur ce serveur.</strong> Les modifications (portail compris, tous les clients) ne rechargent plus Asterisk.${mine ? ' Il a été coupé par User Manager (opération interrompue ?).' : ''}
    <div class="btnrow"><button id="lr-fix" class="danger">Réactiver et recharger</button></div></div>`;
  $('lr-fix').onclick = async () => {
    if (!canWrite()) return;
    const u = A.users.find((x) => (x.lines || []).length) || A.users[0];
    const note = await restoreLiveReload(u ? [{ u, it: { s: { reload: 'user' } } }] : []);
    toast(note, 8000);
  };
}

// Restauration : remet les valeurs « before » d'une sauvegarde (fichier ou
// dernière sauvegarde du navigateur). Même serveur et même tenant exigés.
// Format v2 : items[{ setting, desc, users }] ; v1 (0.24.0) : setting + users.
const backupItems = (b) => (Array.isArray(b?.items) ? b.items : b?.setting ? [{ setting: b.setting, desc: b.desc, users: b.users }] : null);
function openRestore() {
  if (!canWrite()) return;
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_BACKUP)); } catch { /* */ }
  const nUsers = (b) => new Set((backupItems(b) || []).flatMap((it) => (it.users || []).map((x) => x.uuid))).size;
  confirmModal(`<h3>Restaurer une sauvegarde</h3>
    ${last ? `<label class="inline"><input type="radio" name="m-src" value="last" checked> Dernière sauvegarde de ce navigateur : ${esc(last.desc)} (${nUsers(last)} utilisateur(s), ${esc(new Date(last.created).toLocaleString('fr-FR'))})</label>` : ''}
    <label class="inline"><input type="radio" name="m-src" value="file"${last ? '' : ' checked'}> Fichier de sauvegarde (astrea-users-sauvegarde-….json)</label>
    <input type="file" id="m-file" accept=".json,application/json">`, async () => {
    let b;
    try {
      const src = document.querySelector('input[name="m-src"]:checked')?.value;
      if (src === 'last') b = last;
      else { const f = $('m-file').files[0]; if (!f) throw new Error('Choisissez un fichier.'); b = JSON.parse(await f.text()); }
      const items = backupItems(b);
      if (b?.app !== 'astrea-users' || b.kind !== 'backup' || !items) throw new Error('Ce fichier n\'est pas une sauvegarde User Manager.');
      const unknown = items.filter((it) => !settingById(it.setting)).map((it) => it.setting);
      if (unknown.length) throw new Error(`Réglage inconnu dans la sauvegarde : ${unknown.join(', ')}.`);
      if (b.base !== S.base || (b.tenant || null) !== (S.tenant || null)) throw new Error('Cette sauvegarde vient d\'un autre serveur ou d\'un autre tenant.');
    } catch (e) { toast(e.message, 7000); return false; }
    setTimeout(() => confirmRestore(b), 0); // le dialogue se ferme d'abord
  }, 'Suivant');
}
function confirmRestore(b) {
  const all = new Set();
  const steps = backupItems(b).map((it) => {
    const s = settingById(it.setting);
    const before = new Map(it.users.map((x) => [x.uuid, x.before]));
    before.forEach((_, k) => all.add(k));
    const target = (cur, u) => (before.has(u.uuid) ? before.get(u.uuid) : undefined);
    return { s, desc: it.desc || s.label, target };
  });
  const users = A.users.filter((u) => all.has(u.uuid));
  const missing = all.size - users.length;
  const withPlan = steps.map((x) => ({ ...x, p: plan(x.s, x.target, users) }));
  confirmModal(`<h3>Restaurer : ${esc(b.desc)}</h3>
    <p class="muted small">Sauvegarde du ${esc(new Date(b.created).toLocaleString('fr-FR'))}. Les valeurs d'avant la modification sont réécrites ; une nouvelle sauvegarde est téléchargée avant.</p>
    ${missing ? `<div class="warn">${missing} utilisateur(s) de la sauvegarde n'existent plus.</div>` : ''}
    <div class="mprev tall">${recapHtml(withPlan)}</div>`, async () => {
    await runMass(steps, users, `Restauration (${b.desc})`, { batch: $('m-batch')?.checked === true });
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
// Clic sur le titre d'un groupe : tout cocher (ou tout décocher s'il l'est déjà).
function toggleGroup(box, grp) {
  const inputs = [...box.querySelectorAll('input[data-g]')].filter((x) => x.dataset.g === grp);
  const on = !inputs.every((x) => x.checked);
  inputs.forEach((x) => (x.checked = on));
  return inputs;
}
$('cols').onclick = (e) => {
  const g = e.target.closest('.grp[data-grp]');
  if (!g) return;
  for (const x of toggleGroup($('cols'), g.dataset.grp)) if (x.checked) A.cols.add(x.dataset.col); else A.cols.delete(x.dataset.col);
  saveCols();
  render();
};
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
$('d-body').onclick = (e) => { const b = e.target.closest('button[data-edit]'); if (b) openEdit(b.dataset.edit); };
$('reload').onclick = async () => { try { await reload(); toast('Rechargé'); } catch (e) { toast(e.message, 8000); } };
// Fermeture de la page pendant une opération : le live reload pourrait rester coupé.
window.addEventListener('beforeunload', (e) => { if (A.running) { e.preventDefault(); e.returnValue = ''; } });
connect(boot);
