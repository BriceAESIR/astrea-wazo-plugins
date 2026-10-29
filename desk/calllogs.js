// Astrea Desk — journal d'appels (lot 2). Source : call-logd GET /cdr, lu dans
// le code (wazo-call-logd master, 29/10/2026) :
//  - tenant = en-tête Wazo-Tenant, recurse=false par défaut : seul le tenant
//    du site est lu (pas de sous-tenants) ;
//  - filtres : from, until, call_direction (internal | inbound | outbound),
//    call_status (answered | voicemail | blocked | unknown), search, number,
//    user_uuid ; tri order=start, direction=desc ; limit 1000 par défaut ;
//  - réponse : { items, total, filtered } ;
//  - call_status : blocked > voicemail > answered, sinon unknown (= non
//    répondu) ; duration = fin - décroché (null si non décroché).
import { S, $, esc, toast, listAll } from '../admin-tools/common/core.js?v=0.2.1';
import { stackedColumns, hbars, legend } from './charts.js?v=0.2.1';

const PAGE = 1000;       // taille d'une requête call-logd
const MAX = 20000;       // au-delà, on s'arrête et on le dit
const ROWS = 50;         // lignes par page du tableau

export const STATUS = {
  answered: 'Répondu', unknown: 'Non répondu', voicemail: 'Messagerie', blocked: 'Bloqué',
};
export const DIRECTION = { inbound: 'Entrant', outbound: 'Sortant', internal: 'Interne' };
// Ordre fixe des séries (palette catégorielle validée du skill dataviz, slots 1-4).
const SERIES = [
  { key: 'answered', label: 'Répondu', color: 'var(--dk-s1)', hex: '#2a78d6' },
  { key: 'unknown', label: 'Non répondu', color: 'var(--dk-s2)', hex: '#eb6834' },
  { key: 'voicemail', label: 'Messagerie', color: 'var(--dk-s3)', hex: '#1baf7a' },
  { key: 'blocked', label: 'Bloqué', color: 'var(--dk-s4)', hex: '#eda100' },
  { key: 'service', label: 'Code de service', color: 'var(--dk-s0)', hex: '#898781' },
];

const F0 = { period: 'today', from: '', until: '', direction: '', status: '', search: '', user: '', services: false };
const F = { ...F0 };
const C = { all: [], items: [], hiddenServices: 0, truncated: false, page: 0, loadedFor: null, users: null, site: null };

// ---------------------------------------------------------------------------
// Dates et formats
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const fmtDur = (s) => { if (s == null) return ''; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h} h ${pad(m)} min` : m ? `${m} min ${pad(x)} s` : `${x} s`; };
const hms = (s) => { if (s == null) return ''; s = Math.round(s); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };

export function periodRange(p = F) {
  const now = new Date(), today = dayStart(now);
  switch (p.period) {
    case 'today': return [today, addDays(today, 1), "aujourd'hui"];
    case 'yesterday': return [addDays(today, -1), today, 'hier'];
    case '7d': return [addDays(today, -6), addDays(today, 1), '7 derniers jours'];
    case '30d': return [addDays(today, -29), addDays(today, 1), '30 derniers jours'];
    case 'month': return [new Date(now.getFullYear(), now.getMonth(), 1), addDays(today, 1), 'ce mois-ci'];
    case 'lastmonth': return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1), 'le mois dernier'];
    default: {
      const a = p.from ? new Date(`${p.from}T00:00:00`) : today;
      const b = p.until ? addDays(new Date(`${p.until}T00:00:00`), 1) : addDays(a, 1);
      return [a, b, `du ${p.from || toLocalInput(a)} au ${p.until || p.from || toLocalInput(a)}`];
    }
  }
}

// Personne d'un côté de l'appel : nom puis numéro (une seule fois si le nom
// affiché est le numéro lui-même, cas des appels sortants).
const party = (name, ext) => (name && ext && name !== ext ? `${name} · ${ext}` : name || ext || '—');
export const caller = (c) => party(c.source_name || c.source_internal_name, c.source_extension || c.source_internal_extension);
export const callee = (c) => party(c.destination_name || c.requested_name, c.destination_extension || c.requested_extension);

// Codes de service (*735… entrée / sortie de groupe, *10…) : Wazo les
// enregistre comme des appels internes jamais répondus (vu en réel le
// 29/10/2026). Mis à part : ils fausseraient le taux de réponse.
export const isService = (c) => /^\*/.test(c.requested_extension || c.destination_extension || '');
export const statusKey = (c) => (isService(c) ? 'service' : c.call_status in STATUS ? c.call_status : 'unknown');
export const statusLabel = (c) => (isService(c) ? 'Code de service' : STATUS[c.call_status] || 'Non répondu');

// Attente : avant le décroché si répondu, sinon avant le raccroché (sonnerie).
const secs = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.max(0, (y - x) / 1000) : null; };
export const waitSecs = (c) => (c.answer ? secs(c.start, c.answer) : secs(c.start, c.end));

// Numéros du site : utilisateurs (ring_seconds), groupes et files (timeout ;
// vide = pas de limite). Champs lus dans le code confd le 29/10/2026.
const T = { byExten: new Map() };
// Numéro demandé (groupe, file…) avant celui du membre qui a pris l'appel :
// c'est son délai de sonnerie qui compte.
const dialed = (c) => c.requested_internal_extension || c.destination_internal_extension || c.requested_extension || c.destination_extension || '';
async function loadTargets() {
  T.byExten = new Map();
  const [users, groups, queues] = await Promise.all(['/users', '/groups', '/queues'].map((p) => listAll(p).catch(() => [])));
  for (const u of users) {
    const label = [u.firstname, u.lastname].filter(Boolean).join(' ') || u.username || '';
    for (const l of u.lines || []) for (const e of l.extensions || []) if (e.exten) T.byExten.set(e.exten, { kind: 'Utilisateur', label, timeout: u.ring_seconds ?? 30 });
  }
  for (const g of groups) for (const e of g.extensions || []) if (e.exten) T.byExten.set(e.exten, { kind: 'Groupe', label: g.label || g.name, timeout: g.timeout ?? null });
  for (const q of queues) for (const e of q.extensions || []) if (e.exten) T.byExten.set(e.exten, { kind: 'File', label: q.label || q.name, timeout: q.timeout ?? null });
  return users;
}

// Cause probable d'un appel non répondu : DÉDUITE (call-logd n'enregistre ni
// la cause ni le côté qui raccroche, vérifié dans son modèle de base). On
// compare la sonnerie au délai prévu pour le numéro appelé.
export function probableCause(c) {
  const k = statusKey(c);
  if (k === 'service') return 'Code de service';
  if (k === 'answered') return '';
  if (k === 'voicemail') return 'Arrivé sur la messagerie';
  if (k === 'blocked') return 'Bloqué';
  if (c.call_direction === 'outbound') return 'Pas de réponse du correspondant (ou occupé)';
  const ring = waitSecs(c);
  if (ring == null) return 'Inconnue';
  if (ring <= 2) return 'Raccroché aussitôt';
  const t = T.byExten.get(dialed(c))?.timeout;
  if (t > 0 && ring >= t - 2) return 'Délai de sonnerie atteint';
  return "L'appelant a raccroché pendant la sonnerie";
}
export const CAUSE_HELP = "Cause déduite, pas enregistrée par Wazo : la durée de sonnerie est comparée au délai prévu pour le numéro appelé (utilisateur, groupe ou file).";

// ---------------------------------------------------------------------------
// Lecture call-logd
// ---------------------------------------------------------------------------
async function cdrGet(params) {
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  const r = await fetch(`${S.base}/api/call-logd/1.0/cdr?${new URLSearchParams(params)}`, { headers });
  if (r.status === 401 || r.status === 403) throw new Error(`Accès au journal d'appels refusé (${r.status}).`);
  if (!r.ok) throw new Error(`Journal d'appels : erreur ${r.status}.`);
  return r.json();
}

async function load(onProgress) {
  if (!S.tenant) throw new Error('Tenant du site inconnu : lecture refusée.');
  const [from, until] = periodRange();
  const params = { from: from.toISOString(), until: until.toISOString(), order: 'start', direction: 'desc', limit: PAGE };
  if (F.direction) params.call_direction = F.direction;
  if (F.status) params.call_status = F.status;
  if (F.search) params.search = F.search;
  if (F.user) params.user_uuid = F.user;
  const items = [];
  let filtered = null;
  for (let offset = 0; offset < MAX; offset += PAGE) {
    const j = await cdrGet({ ...params, offset });
    const page = Array.isArray(j?.items) ? j.items : [];
    filtered = j?.filtered ?? filtered;
    // Garde-fou tenant (règle de base) : call-logd filtre déjà, on revérifie.
    items.push(...page.filter((c) => !c.tenant_uuid || c.tenant_uuid === S.tenant));
    onProgress?.(items.length, filtered);
    if (page.length < PAGE) break;
  }
  C.all = items;
  C.truncated = filtered != null ? filtered > items.length : items.length >= MAX;
  C.filtered = filtered;
  applyLocal();
}
// Filtre local : codes de service masqués sauf demande.
function applyLocal() {
  C.items = F.services ? C.all : C.all.filter((c) => !isService(c));
  C.hiddenServices = C.all.length - C.items.length;
  C.page = 0;
}

// ---------------------------------------------------------------------------
// Résumé
// ---------------------------------------------------------------------------
export function summarize(items, range) {
  const zero = () => ({ answered: 0, unknown: 0, voicemail: 0, blocked: 0, service: 0 });
  const st = zero();
  const dir = { inbound: 0, outbound: 0, internal: 0 };
  let talk = 0, waitAns = 0;
  const hours = Array.from({ length: 24 }, () => 0);
  const who = new Map();
  const causes = new Map();
  for (const c of items) {
    const k = statusKey(c);
    st[k]++;
    if (k === 'service') continue; // ni dans les sens, ni dans les classements
    if (c.call_direction in dir) dir[c.call_direction]++;
    if (k === 'answered') { if (c.duration) talk += c.duration; waitAns += waitSecs(c) || 0; }
    if (k === 'unknown') { const r = probableCause(c); causes.set(r, (causes.get(r) || 0) + 1); }
    const d = new Date(c.start);
    if (!isNaN(d)) hours[d.getHours()]++;
    // Numéros les plus appelés (hors sortants) : postes, groupes, files, SVI…
    const x = dialed(c);
    if (x && c.call_direction !== 'outbound') {
      const t = T.byExten.get(x);
      const o = who.get(x) || { label: t ? `${t.label} · ${x}${t.kind !== 'Utilisateur' ? ` (${t.kind.toLowerCase()})` : ''}` : party(c.destination_name || c.requested_name, x), value: 0, answered: 0 };
      o.value++; if (k === 'answered') o.answered++;
      who.set(x, o);
    }
  }
  // Découpage : par heure sur une journée, sinon par jour.
  const [from, until] = range;
  const oneDay = until - from <= 86400e3 + 3600e3;
  const buckets = [];
  if (oneDay) {
    for (let h = 0; h < 24; h++) buckets.push({ label: `${h}h`, tip: `${h}h-${h + 1}h`, values: zero() });
  } else {
    for (let d = new Date(from); d < until; d = addDays(d, 1)) buckets.push({ key: toLocalInput(d), label: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`, tip: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`, values: zero() });
  }
  const idx = new Map(buckets.map((b, i) => [b.key, i]));
  for (const c of items) {
    const d = new Date(c.start);
    if (isNaN(d)) continue;
    const b = oneDay ? buckets[d.getHours()] : buckets[idx.get(toLocalInput(d))];
    if (b) b.values[statusKey(c)]++;
  }
  // Taux de réponse calculé sans les codes de service.
  const calls = items.length - st.service;
  return {
    total: calls, services: st.service, st, dir, talk, hours, buckets, oneDay,
    rate: calls ? Math.round((st.answered / calls) * 100) : 0,
    avg: st.answered ? talk / st.answered : 0,
    avgWait: st.answered ? waitAns / st.answered : 0,
    top: [...who.values()].sort((a, b) => b.value - a.value).slice(0, 10),
    causes: [...causes.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
  };
}

export function summaryHtml(sum, colors = 'css') {
  const col = (s) => (colors === 'css' ? s.color : s.hex);
  const series = SERIES.filter((s) => sum.st[s.key] > 0 || !['blocked', 'service'].includes(s.key));
  const chartOpts = colors === 'css' ? {} : { ink: '#52514e', grid: '#e1e0d9' };
  const bar = colors === 'css' ? {} : { color: '#2a78d6' };
  const bar2 = { wide: true, color: colors === 'css' ? 'var(--dk-s2)' : '#eb6834' };
  const tiles = [
    ['Appels', sum.total], ['Répondus', `${sum.st.answered} (${sum.rate} %)`], ['Non répondus', sum.st.unknown],
    ['Messagerie', sum.st.voicemail], ...(sum.st.blocked ? [['Bloqués', sum.st.blocked]] : []),
    ['Attente moyenne avant décroché', fmtDur(sum.avgWait)], ['Durée moyenne', fmtDur(sum.avg)], ['Durée totale', fmtDur(sum.talk)],
    ...(sum.services ? [['Codes de service', sum.services]] : []),
  ];
  return `<div class="dk-kpis">${tiles.map(([l, v]) => `<div class="dk-kpi"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`
    + `<section class="dk-panel"><h3>${sum.oneDay ? 'Appels par heure' : 'Appels par jour'}</h3>${legend(series.map((s) => ({ ...s, color: col(s) })))}${stackedColumns(sum.buckets, series.map((s) => ({ ...s, color: col(s) })), chartOpts)}</section>`
    + `<div class="dk-two"><section class="dk-panel"><h3>Par sens</h3>${hbars(Object.entries(DIRECTION).map(([k, l]) => ({ label: l, value: sum.dir[k] })), bar)}</section>`
    + `<section class="dk-panel"><h3>Numéros les plus appelés</h3>${sum.top.length ? hbars(sum.top.map((t) => ({ label: t.label, value: t.value, extra: `${t.answered} répondus` })), bar) : '<p class="muted small">Aucun appel reçu.</p>'}</section></div>`
    + (sum.causes.length ? `<section class="dk-panel dk-causes"><h3>Non répondus : cause probable</h3><p class="muted small">${esc(CAUSE_HELP)}</p>${hbars(sum.causes, bar2)}</section>` : '');
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------
export async function renderCallLogs(view, site) {
  if (C.site !== site.uuid) { Object.assign(F, F0); C.all = []; C.items = []; C.loadedFor = null; C.users = null; C.site = site.uuid; }
  if (!C.users) C.users = (await loadTargets()).map((u) => ({ uuid: u.uuid, name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.username || u.uuid })).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
  view.innerHTML = `
    <div class="phonehead"><div><h2>Journal d'appels</h2><div class="muted small">${esc(site.name)} · lecture seule</div></div>
      <div class="btnrow"><button id="cl-csv">CSV</button><button id="cl-html">HTML</button><button id="cl-pdf">PDF</button></div></div>
    <form id="cl-filters" class="dk-filters">
      <label>Période <select id="cl-period">${[['today', "Aujourd'hui"], ['yesterday', 'Hier'], ['7d', '7 derniers jours'], ['30d', '30 derniers jours'], ['month', 'Ce mois-ci'], ['lastmonth', 'Mois dernier'], ['custom', 'Personnalisée']].map(([v, l]) => opt(v, l, F.period)).join('')}</select></label>
      <label class="cl-custom">Du <input id="cl-from" type="date" value="${esc(F.from)}"></label>
      <label class="cl-custom">Au <input id="cl-until" type="date" value="${esc(F.until)}"></label>
      <label>Sens <select id="cl-dir">${opt('', 'Tous', F.direction)}${Object.entries(DIRECTION).map(([v, l]) => opt(v, l, F.direction)).join('')}</select></label>
      <label>Statut <select id="cl-status">${opt('', 'Tous', F.status)}${Object.entries(STATUS).map(([v, l]) => opt(v, l, F.status)).join('')}</select></label>
      <label>Utilisateur <select id="cl-user">${opt('', 'Tous', F.user)}${C.users.map((u) => opt(u.uuid, u.name, F.user)).join('')}</select></label>
      <label class="dk-grow">Recherche <input id="cl-search" value="${esc(F.search)}" placeholder="Nom ou numéro"></label>
      <div class="dk-go"><button class="primary" type="submit">Afficher</button></div>
      <label class="inline dk-svc" title="Numéros commençant par * (entrée / sortie de groupe, renvois…). Wazo les enregistre comme des appels non répondus."><input type="checkbox" id="cl-svc"${F.services ? ' checked' : ''}> Afficher les codes de service</label>
    </form>
    <div id="cl-out"></div><div id="dk-tip" class="dk-tip" hidden></div>`;
  const syncCustom = () => view.querySelectorAll('.cl-custom').forEach((l) => (l.hidden = $('cl-period').value !== 'custom'));
  syncCustom();
  $('cl-period').onchange = syncCustom;
  $('cl-filters').onsubmit = (e) => { e.preventDefault(); readFilters(); refresh(); };
  // Bascule locale, sans relire call-logd.
  $('cl-svc').onchange = () => { F.services = $('cl-svc').checked; if (C.loadedFor) { applyLocal(); C.loadedFor = JSON.stringify(F); draw(); } };
  $('cl-csv').onclick = () => exportCsv(site);
  $('cl-html').onclick = () => exportHtml(site);
  $('cl-pdf').onclick = () => exportPdf(site);
  hoverTips(view);
  const key = JSON.stringify(F);
  if (C.loadedFor === key) draw(); else refresh();
}

function readFilters() {
  F.period = $('cl-period').value; F.from = $('cl-from').value; F.until = $('cl-until').value;
  F.direction = $('cl-dir').value; F.status = $('cl-status').value; F.user = $('cl-user').value; F.search = $('cl-search').value.trim();
  if (F.period === 'custom' && F.from && F.until && F.until < F.from) [F.from, F.until] = [F.until, F.from];
}

async function refresh() {
  const out = $('cl-out');
  out.innerHTML = '<p class="dk-empty">Lecture du journal…</p>';
  try {
    await load((n) => { if ($('cl-out') === out) out.innerHTML = `<p class="dk-empty">Lecture du journal… ${n} appels</p>`; });
    C.loadedFor = JSON.stringify(F);
    if ($('cl-out') === out) draw();
  } catch (err) {
    if ($('cl-out') === out) out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function draw() {
  const out = $('cl-out');
  const range = periodRange();
  const sum = summarize(C.items, range);
  const warn = (C.truncated ? `<div class="warn">Plus de ${MAX} appels sur la période : seuls les ${C.all.length} plus récents sont affichés et exportés. Réduisez la période.</div>` : '')
    + (C.hiddenServices ? `<p class="muted small">${C.hiddenServices} code${C.hiddenServices > 1 ? 's' : ''} de service masqué${C.hiddenServices > 1 ? 's' : ''} (numéros commençant par *).</p>` : '');
  if (!C.items.length) { out.innerHTML = warn + `<p class="dk-empty">Aucun appel ${esc(range[2])} avec ces filtres.</p>`; return; }
  out.innerHTML = warn + summaryHtml(sum) + `<section class="dk-panel"><h3>Détail des appels <span class="muted small">(${C.items.length})</span></h3><div id="cl-table"></div></section>`;
  drawTable();
}

function drawTable() {
  const pages = Math.ceil(C.items.length / ROWS);
  C.page = Math.min(C.page, pages - 1);
  const rows = C.items.slice(C.page * ROWS, (C.page + 1) * ROWS);
  $('cl-table').innerHTML = `<div class="dk-scroll"><table class="dk-table"><thead><tr><th>Date</th><th>Sens</th><th>Appelant</th><th>Appelé</th><th>Statut</th><th class="num" title="Avant le décroché si l'appel est répondu, sinon avant le raccroché.">Attente</th><th class="num">Durée</th><th title="${esc(CAUSE_HELP)}">Cause probable</th></tr></thead><tbody>${rows.map((c) => `<tr><td class="nowrap">${esc(fmtDate(c.start))}</td><td>${esc(DIRECTION[c.call_direction] || c.call_direction || '')}</td><td>${esc(caller(c))}</td><td>${esc(callee(c))}</td><td><span class="dk-st dk-st-${esc(statusKey(c))}">${esc(statusLabel(c))}</span></td><td class="num">${esc(fmtDur(waitSecs(c)))}</td><td class="num">${esc(fmtDur(c.duration))}</td><td class="muted small">${esc(probableCause(c))}</td></tr>`).join('')}</tbody></table></div>`
    + (pages > 1 ? `<div class="btnrow dk-pager"><button id="cl-prev"${C.page ? '' : ' disabled'}>Précédent</button><span class="muted small">Page ${C.page + 1} / ${pages}</span><button id="cl-next"${C.page < pages - 1 ? '' : ' disabled'}>Suivant</button></div>` : '');
  if (pages > 1) {
    $('cl-prev').onclick = () => { C.page--; drawTable(); };
    $('cl-next').onclick = () => { C.page++; drawTable(); };
  }
}

// Infobulle au survol des marques ([data-tip]).
function hoverTips(root) {
  root.addEventListener('mousemove', (e) => {
    const t = $('dk-tip'); if (!t) return;
    const m = e.target.closest?.('[data-tip]');
    if (!m) { t.hidden = true; return; }
    t.textContent = m.getAttribute('data-tip');
    t.hidden = false;
    t.style.left = `${Math.min(e.clientX + 12, innerWidth - t.offsetWidth - 8)}px`;
    t.style.top = `${e.clientY + 14}px`;
  });
  root.addEventListener('mouseleave', () => { const t = $('dk-tip'); if (t) t.hidden = true; });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
function download(name, text, type) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Fichier ${name} téléchargé`);
  } catch (e) { console.warn('[astrea] téléchargement', e); toast('Téléchargement impossible dans cette appli.', 6000); }
}
const fileBase = (site) => `journal-appels_${(site.name || 'site').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-')}_${toLocalInput(periodRange()[0])}`;
function needData() { if (!C.items.length) { toast('Rien à exporter : lancez d\'abord une recherche avec des résultats.'); return false; } return true; }
function filtersText() {
  const u = C.users?.find((x) => x.uuid === F.user);
  return [`Période : ${periodRange()[2]}`, F.direction && `Sens : ${DIRECTION[F.direction]}`, F.status && `Statut : ${STATUS[F.status]}`, u && `Utilisateur : ${u.name}`, F.search && `Recherche : ${F.search}`, !F.services && C.hiddenServices && `${C.hiddenServices} codes de service exclus`].filter(Boolean).join(' · ');
}

// CSV pour Excel en français : séparateur « ; », BOM UTF-8.
function exportCsv(site) {
  if (!needData()) return;
  const q = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['Date', 'Sens', 'Appelant (nom)', 'Appelant (numéro)', 'Appelé (nom)', 'Appelé (numéro)', 'Numéro composé', 'Statut', 'Décroché', 'Attente (s)', 'Durée (s)', 'Durée', 'Cause probable (déduite)', 'Mots clés'];
  const lines = C.items.map((c) => {
    const w = waitSecs(c);
    return [fmtDate(c.start), DIRECTION[c.call_direction] || c.call_direction, c.source_name || c.source_internal_name, c.source_extension || c.source_internal_extension, c.destination_name, c.destination_extension, c.requested_extension, statusLabel(c), c.answer ? fmtDate(c.answer) : '', w == null ? '' : Math.round(w), c.duration == null ? '' : Math.round(c.duration), hms(c.duration), probableCause(c), (c.tags || []).join(', ')].map(q).join(';');
  });
  download(`${fileBase(site)}.csv`, '﻿' + [head.join(';'), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
}

// Rapport HTML autonome (styles intégrés, couleurs en dur, mode clair).
function reportHtml(site) {
  const sum = summarize(C.items, periodRange());
  const rows = C.items.map((c) => `<tr><td>${esc(fmtDate(c.start))}</td><td>${esc(DIRECTION[c.call_direction] || '')}</td><td>${esc(caller(c))}</td><td>${esc(callee(c))}</td><td>${esc(statusLabel(c))}</td><td class="num">${esc(fmtDur(waitSecs(c)))}</td><td class="num">${esc(fmtDur(c.duration))}</td><td>${esc(probableCause(c))}</td></tr>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Journal d'appels · ${esc(site.name)}</title><style>
body{font:14px/1.45 "Mulish",Helvetica,Arial,sans-serif;color:#0b0b0b;margin:24px;background:#fff}h1{font-size:20px;margin:0}h3{font-size:15px;margin:0 0 8px}
.sub{color:#52514e;font-size:12px;margin:2px 0 16px}.dk-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:16px}.dk-panel>p{color:#52514e;font-size:11px;margin:-4px 0 8px}
.dk-kpi{border:1px solid #e1e0d9;border-radius:4px;padding:8px 12px}.dk-kpi span{display:block;color:#52514e;font-size:11px}.dk-kpi strong{font-size:18px}
.dk-panel{border:1px solid #e1e0d9;border-radius:4px;padding:12px 16px;margin-bottom:16px;break-inside:avoid}.dk-two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.dk-legend{display:flex;gap:16px;font-size:12px;color:#52514e;margin-bottom:6px}.dk-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.dk-hb{display:grid;grid-template-columns:minmax(80px,38%) 1fr auto;gap:10px;align-items:center;font-size:12px;padding:3px 0}.dk-hb-l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dk-hb-t{height:14px}.dk-hb-t i{display:block;height:100%;border-radius:0 4px 4px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact}.dk-hb-v{color:#52514e;white-space:nowrap}.dk-wide .dk-hb{grid-template-columns:minmax(200px,40%) 1fr auto}.dk-two+.dk-panel{margin-top:16px}
.dk-legend i,svg{-webkit-print-color-adjust:exact;print-color-adjust:exact}
table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;color:#52514e;font-weight:600;border-bottom:1px solid #c3c2b7;padding:6px 8px}td{border-bottom:1px solid #e1e0d9;padding:5px 8px}.num{text-align:right}
@media print{body{margin:0}.dk-kpis{grid-template-columns:repeat(4,1fr)}thead{display:table-header-group}tr{break-inside:avoid}}
</style></head><body><h1>Journal d'appels · ${esc(site.name)}</h1><p class="sub">${esc(site.customer || '')} · ${esc(filtersText())} · ${C.items.length} appels · édité le ${esc(fmtDate(new Date().toISOString()))} par Astrea Desk${C.truncated ? ` · <strong>limité aux ${C.items.length} plus récents</strong>` : ''}</p>
${summaryHtml(sum, 'hex')}<section class="dk-panel"><h3>Détail des appels</h3><table><thead><tr><th>Date</th><th>Sens</th><th>Appelant</th><th>Appelé</th><th>Statut</th><th class="num">Attente</th><th class="num">Durée</th><th>Cause probable</th></tr></thead><tbody>${rows}</tbody></table></section></body></html>`;
}
function exportHtml(site) { if (needData()) download(`${fileBase(site)}.html`, reportHtml(site), 'text/html;charset=utf-8'); }

// PDF : impression du rapport HTML (« Enregistrer au format PDF »). Dans
// l'appli desktop, l'impression depuis l'iframe n'est pas vérifiée : en cas
// d'échec, on propose l'export HTML à imprimer depuis le navigateur.
function exportPdf(site) {
  if (!needData()) return;
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  f.onload = () => {
    try { f.contentWindow.focus(); f.contentWindow.print(); }
    catch (e) { console.warn('[astrea] impression', e); toast("Impression impossible ici : utilisez l'export HTML puis imprimez-le en PDF.", 8000); }
    setTimeout(() => f.remove(), 60000);
  };
  f.srcdoc = reportHtml(site);
}
