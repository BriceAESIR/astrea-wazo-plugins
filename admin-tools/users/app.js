// User Manager (Astrea Admin Tools) — audit des réglages des utilisateurs
// (lot 1, lecture seule). Cadrage : astrea-wazo-dev/docs/USER-MANAGER.md.
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
import { S, $, esc, toast, api, listAll, connect, fullName, setReadonly, showCompat, loaded, loadFailed } from '../common/core.js?v=0.23.1';

const A = { users: [], byId: new Map(), moh: new Map(), groups: new Map(), vms: new Map(), sort: { col: 'name', dir: 1 }, sel: null, scope: null, cols: null };

// ---------------------------------------------------------------------------
// Libellés
// ---------------------------------------------------------------------------
const exten = (u) => { for (const l of u.lines || []) for (const e of l.extensions || []) if (e.exten) return e.exten; return ''; };
const groupLabel = (g) => A.groups.get(g.uuid)?.label || g.label || g.name || `#${g.id}`;
const mohLabel = (name) => (!name ? '' : name === 'default' ? 'Par défaut' : A.moh.get(name) || name);
const LANG = { fr_FR: 'Français', fr_CA: 'Français (CA)', en_US: 'Anglais', de_DE: 'Allemand', es_ES: 'Espagnol', it_IT: 'Italien', nl_NL: 'Néerlandais' };
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
    case 'switchboard': return `Standard ${d.switchboard_name || ''}`;
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
  { id: 'fwd_unc', label: 'Renvoi immédiat', grp: 'Renvois', def: true, get: (u) => fwd(u, 'unconditional') },
  { id: 'fwd_busy', label: 'Renvoi occupé', grp: 'Renvois', def: true, get: (u) => fwd(u, 'busy') },
  { id: 'fwd_noans', label: 'Renvoi non-réponse', grp: 'Renvois', def: true, get: (u) => fwd(u, 'noanswer') },
  { id: 'ring', label: 'Sonnerie (s)', grp: 'Sonnerie et débordement', def: true, get: (u) => ({ t: u.ring_seconds ?? '—', k: String(u.ring_seconds ?? '').padStart(6, '0') }) },
  { id: 'simul', label: 'Appels simult.', grp: 'Sonnerie et débordement', def: true, get: (u) => ({ t: u.simultaneous_calls ?? '—', k: String(u.simultaneous_calls ?? '').padStart(3, '0') }) },
  { id: 'fb_noans', label: 'Débord. non-réponse', grp: 'Sonnerie et débordement', def: true, get: (u) => fb(u, 'noanswer') },
  { id: 'fb_busy', label: 'Débord. occupé', grp: 'Sonnerie et débordement', get: (u) => fb(u, 'busy') },
  { id: 'fb_cong', label: 'Débord. encombré', grp: 'Sonnerie et débordement', get: (u) => fb(u, 'congestion') },
  { id: 'fb_fail', label: 'Débord. injoignable', grp: 'Sonnerie et débordement', get: (u) => fb(u, 'fail') },
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
const COLS_KEY = 'astrea-users-cols';
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
  const [users, moh, groups, vms] = await Promise.all([
    loadUsers(), lookup('/moh', 'Libellés des musiques d\'attente', warns), lookup('/groups', 'Libellés des groupes', warns), lookup('/voicemails', 'Détails des messageries', warns),
  ]);
  selfCheck(users);
  A.users = users.sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  A.byId = new Map(users.map((u) => [u.id, u]));
  A.moh = new Map(moh.map((m) => [m.name, m.label || m.name]));
  A.groups = new Map(groups.map((g) => [g.uuid, g]));
  A.vms = new Map(vms.map((v) => [v.id, v]));
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
  $('g-head').innerHTML = `<tr>${cols.map((c) => `<th data-col="${c.id}">${esc(c.label)}${c.id === A.sort.col ? `<span class="arrow">${A.sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr>`;
  $('g-body').innerHTML = list.map((r) => `<tr data-u="${r.u.id}" class="${r.u.id === A.sel ? 'sel' : ''}${r.u.enabled === false ? ' disabled' : ''}">${r.v.map((x, i) => {
    const cls = [x.c, oddOn && odd[i] != null && x.k !== odd[i] ? 'odd' : ''].filter(Boolean).join(' ');
    return `<td${cls ? ` class="${cls}"` : ''} title="${esc(x.t)}">${esc(x.t)}</td>`;
  }).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="none">Aucun utilisateur.</td></tr>`;
  const nOdd = data.filter((r) => r.v.some((x, i) => odd[i] != null && x.k !== odd[i])).length;
  $('count').textContent = `${list.length} / ${A.users.length} utilisateur(s)${nOdd ? ` · ${nOdd} avec un écart` : ''}`;
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
    sec('Renvois', row('Immédiat', f('unconditional')) + row('Sur occupation', f('busy')) + row('Sur non-réponse', f('noanswer'))),
    sec('Sonnerie et débordement', row('Sonnerie', u.ring_seconds != null ? `${u.ring_seconds} s` : '') + row('Appels simultanés', u.simultaneous_calls)
      + row('Non-réponse', destText(u.fallbacks?.noanswer_destination)) + row('Occupé', destText(u.fallbacks?.busy_destination))
      + row('Encombré', destText(u.fallbacks?.congestion_destination)) + row('Injoignable', destText(u.fallbacks?.fail_destination))),
    sec('Messagerie', u.voicemail ? row('Boîte', v ? `${v.number}@${v.context}` : u.voicemail.name) + row('Nom', v?.name || u.voicemail.name) + row('E-mail', v?.email)
      + row('Joindre l\'audio', v ? (v.attach_audio ? 'oui' : 'non') : '') + row('Supprimer après envoi', v ? (v.delete_messages ? 'oui' : 'non') : '') + row('Demander le code', v ? (v.ask_password ? 'oui' : 'non') : '') : row('Boîte', '')),
    sec('Divers', row('Musique d\'attente', mohLabel(u.music_on_hold)) + row('Langue', LANG[u.language] || u.language) + row('Fuseau', u.timezone)),
    sec('Groupes et droits', row('Groupes', (u.groups || []).map(groupLabel).join(', ')) + row('Droits d\'appel', (u.call_permissions || []).map((c) => c.name).join(', ')) + row('Horaire', (u.schedules || []).map((s) => s.name || `#${s.id}`).join(', '))),
  ].join('');
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
A.cols = loadCols();
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
  const th = e.target.closest('th[data-col]');
  if (!th) return;
  A.sort = { col: th.dataset.col, dir: A.sort.col === th.dataset.col ? -A.sort.dir : 1 };
  render();
};
$('g-body').onclick = (e) => {
  const tr = e.target.closest('tr[data-u]');
  if (!tr) return;
  const id = Number(tr.dataset.u);
  A.sel = A.sel === id ? null : id;
  render();
};
$('d-close').onclick = () => { A.sel = null; render(); };
$('reload').onclick = async () => { try { await reload(); toast('Rechargé'); } catch (e) { toast(e.message, 8000); } };
connect(boot);
