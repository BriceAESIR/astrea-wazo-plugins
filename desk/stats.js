// Astrea Desk — statistiques des files et des agents (lot 3). Source :
// call-logd, plugin support_center, lu dans le code (wazo-call-logd master,
// 29/10/2026) :
//  - GET /queues/statistics, /queues/{id}/statistics?interval=hour|day|month,
//    GET /agents/statistics ; ACL call-logd.queues.statistics.read et
//    call-logd.agents.statistics.read ;
//  - paramètres : from, until, timezone, qos_threshold (s), week_days (1 = lundi),
//    day_start_time / day_end_time (HH:MM, heures incluses) ;
//  - ATTENTION : ces routes lisent le tenant ET ses sous-tenants (recurse=True,
//    contrairement à /cdr) : chaque ligne est refiltrée sur S.tenant ;
//  - files : received, answered, abandoned, closed, not_answered (délai de la
//    file atteint), saturated (file pleine ou débordement), blocked (aucun
//    agent : joinempty + leaveempty), average_waiting_time, answered_rate,
//    quality_of_service (% de répondus en moins de qos_threshold s) ;
//  - agents : answered, conversation_time, login_time, pause_time,
//    wrapup_time (secondes), détail par file dans queues[].
// Ces chiffres sont exacts (comptés par Wazo), contrairement aux causes
// déduites du journal d'appels. Ils viennent des tables stat_* que Wazo remplit
// périodiquement : les appels des dernières heures peuvent manquer.
import { S, $, esc, toast, listAll } from '../admin-tools/common/core.js?v=0.7.6';
import { stackedColumns, hbars, legend } from './charts.js?v=0.7.6';
import { periodRange, fmtDur, fmtDate } from './calllogs.js?v=0.7.6';
import { download, fileSafe, csv, printHtml, REPORT_CSS, hoverTips } from './report.js?v=0.7.6';

// Issue des appels en file : 4 séries au plus (palette validée, slots 1-4).
// Fermé, saturé et sans agent sont regroupés dans le graphique, détaillés
// dans le panneau des raisons et dans le tableau.
const SERIES = [
  { key: 'answered', label: 'Répondus', color: 'var(--dk-s1)', hex: '#2a78d6' },
  { key: 'abandoned', label: 'Abandonnés', color: 'var(--dk-s2)', hex: '#eb6834' },
  { key: 'not_answered', label: "Délai d'attente dépassé", color: 'var(--dk-s3)', hex: '#1baf7a' },
  { key: 'refused', label: 'Fermé, saturé ou sans agent', color: 'var(--dk-s4)', hex: '#eda100' },
];
// Raisons exactes des appels non répondus en file (libellés de l'API Wazo).
const LOST = [
  { key: 'abandoned', label: "Abandonné pendant l'attente" },
  { key: 'not_answered', label: "Délai d'attente dépassé" },
  { key: 'blocked', label: 'Aucun agent disponible' },
  { key: 'saturated', label: 'File pleine ou débordement' },
  { key: 'closed', label: 'File fermée (hors horaires)' },
];
const LOST_HELP = "Raisons comptées par Wazo pour chaque appel (exactes, pas déduites). Abandonné : l'appelant a raccroché avant d'être servi. Délai dépassé : le temps d'attente maximal de la file est atteint. Aucun agent : personne de connecté ou de libre. Débordement : file pleine, ou seuil d'attente ou de ratio appels / agents atteint.";
const QCOLS = ['received', 'answered', 'abandoned', 'not_answered', 'blocked', 'saturated', 'closed'];

const F0 = { period: 'today', from: '', until: '', days: 'all', h1: '', h2: '', qos: 20 };
const F = { ...F0 };
const X = { site: null, loadedFor: null, queues: [], agents: [], idle: 0, buckets: null, oneDay: true, names: null };

const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pct = (n) => (n == null ? '—' : `${Math.round(n)} %`);
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris'; } catch { return 'Europe/Paris'; } })();

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------
async function statGet(path, params) {
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json', 'Wazo-Tenant': S.tenant };
  const r = await fetch(`${S.base}/api/call-logd/1.0${path}?${new URLSearchParams(params)}`, { headers });
  if (r.status === 401 || r.status === 403) throw new Error(`Accès aux statistiques refusé (${r.status}).`);
  if (!r.ok) throw new Error(`Statistiques : erreur ${r.status}.`);
  const j = await r.json();
  // Règle de base : ces routes incluent les sous-tenants, on ne garde que le site.
  return (Array.isArray(j?.items) ? j.items : []).filter((x) => !x.tenant_uuid || x.tenant_uuid === S.tenant);
}

function baseParams() {
  const [from, until] = periodRange(F);
  const p = { from: localIso(from), until: localIso(until), timezone: TZ, qos_threshold: F.qos };
  if (F.days === 'week') p.week_days = '1,2,3,4,5';
  if (F.h1 !== '' && F.h2 !== '' && +F.h1 < +F.h2) { p.day_start_time = `${pad(F.h1)}:00`; p.day_end_time = `${pad(F.h2)}:00`; }
  return p;
}

// Noms lisibles : libellé confd des files, prénom nom des agents.
async function loadNames() {
  const [queues, agents] = await Promise.all([listAll('/queues').catch(() => []), listAll('/agents').catch(() => [])]);
  return {
    queue: new Map(queues.map((q) => [q.id, q.label || q.name])),
    agent: new Map(agents.map((a) => [a.id, [a.firstname, a.lastname].filter(Boolean).join(' ') || `Agent ${a.number}`])),
  };
}

async function load() {
  if (!S.tenant) throw new Error('Tenant du site inconnu : lecture refusée.');
  const p = baseParams();
  const [queues, agents] = await Promise.all([statGet('/queues/statistics', p), statGet('/agents/statistics', p)]);
  X.queues = queues.map((q) => ({ ...q, label: X.names.queue.get(q.queue_id) || q.queue_name || `File ${q.queue_id}` }))
    .sort((a, b) => (b.received || 0) - (a.received || 0) || a.label.localeCompare(b.label, 'fr'));
  const all = agents.map((a) => ({ ...a, label: X.names.agent.get(a.agent_id) || `Agent ${a.agent_number}` }));
  X.agents = all.filter((a) => a.answered || a.login_time).sort((a, b) => (b.answered || 0) - (a.answered || 0) || a.label.localeCompare(b.label, 'fr'));
  X.idle = all.length - X.agents.length;
  await loadSeries(p);
}

// Évolution : une requête par file active, sommée par heure (une journée) ou
// par jour. call-logd limite le découpage par heure à un mois.
async function loadSeries(p) {
  const [from, until] = periodRange(F);
  X.oneDay = until - from <= 86400e3 + 3600e3;
  const zero = () => ({ answered: 0, abandoned: 0, not_answered: 0, refused: 0 });
  const buckets = [];
  if (X.oneDay) for (let h = 0; h < 24; h++) buckets.push({ key: h, label: `${h}h`, tip: `${h}h-${h + 1}h`, values: zero() });
  else for (let d = new Date(from); d < until; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) buckets.push({ key: dayKey(d), label: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`, tip: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`, values: zero() });
  const idx = new Map(buckets.map((b, i) => [b.key, i]));
  const active = X.queues.filter((q) => q.received > 0);
  const lists = await Promise.all(active.map((q) => statGet(`/queues/${q.queue_id}/statistics`, { ...p, interval: X.oneDay ? 'hour' : 'day' }).catch((e) => { console.warn('[astrea] évolution', q.queue_id, e.message); return []; })));
  for (const items of lists) {
    // Le dernier élément est le total de la période : déjà compté ailleurs.
    for (const it of items.slice(0, -1)) {
      const d = new Date(it.from);
      if (isNaN(d)) continue;
      const b = buckets[idx.get(X.oneDay ? d.getHours() : dayKey(d))];
      if (!b) continue;
      b.values.answered += it.answered || 0;
      b.values.abandoned += it.abandoned || 0;
      b.values.not_answered += it.not_answered || 0;
      b.values.refused += (it.closed || 0) + (it.saturated || 0) + (it.blocked || 0);
    }
  }
  X.buckets = buckets;
}

// ---------------------------------------------------------------------------
// Résumé
// ---------------------------------------------------------------------------
function totals() {
  const t = Object.fromEntries(QCOLS.map((k) => [k, X.queues.reduce((a, q) => a + (q[k] || 0), 0)]));
  // Taux de réponse Wazo : répondus / (reçus - fermés).
  t.rate = t.received - t.closed > 0 ? (t.answered / (t.received - t.closed)) * 100 : null;
  // Attente moyenne pondérée par les appels qui ont attendu.
  let w = 0, n = 0, qa = 0, qn = 0;
  for (const q of X.queues) {
    const k = (q.answered || 0) + (q.abandoned || 0) + (q.not_answered || 0);
    if (q.average_waiting_time != null && k) { w += q.average_waiting_time * k; n += k; }
    if (q.quality_of_service != null && q.answered) { qa += (q.quality_of_service / 100) * q.answered; qn += q.answered; }
  }
  t.wait = n ? w / n : null;
  t.qos = qn ? (qa / qn) * 100 : null;
  t.lost = t.abandoned + t.not_answered + t.blocked + t.saturated;
  return t;
}

function summaryHtml(colors = 'css') {
  const t = totals();
  const col = (s) => (colors === 'css' ? s.color : s.hex);
  const chartOpts = colors === 'css' ? {} : { ink: '#52514e', grid: '#e1e0d9' };
  const bar = colors === 'css' ? {} : { color: '#2a78d6' };
  const lostBar = { wide: true, color: colors === 'css' ? 'var(--dk-s2)' : '#eb6834' };
  const series = SERIES.map((s) => ({ ...s, color: col(s) }));
  const tiles = [
    ['Appels reçus en file', t.received], ['Répondus', `${t.answered} (${pct(t.rate)})`], ['Perdus', t.lost],
    ['Hors horaires', t.closed], ['Attente moyenne', t.wait == null ? '—' : fmtDur(t.wait)],
    [`Répondus en moins de ${F.qos} s`, pct(t.qos)],
  ];
  const lost = LOST.map((l) => ({ label: l.label, value: t[l.key] })).filter((r) => r.value > 0);
  return `<div class="dk-kpis">${tiles.map(([l, v]) => `<div class="dk-kpi"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`
    + (X.buckets ? `<section class="dk-panel"><h3>${X.oneDay ? 'Appels en file par heure' : 'Appels en file par jour'}</h3>${legend(series)}${stackedColumns(X.buckets, series, chartOpts)}</section>` : '')
    + `<section class="dk-panel dk-causes"><h3>Appels non répondus en file : raison</h3><p class="muted small">${esc(LOST_HELP)}</p>${lost.length ? hbars(lost, lostBar) : '<p class="muted small">Aucun appel perdu sur la période.</p>'}</section>`
    + queueTable()
    + `<section class="dk-panel"><h3>Agents</h3>${X.idle ? `<p class="muted small">${X.idle} agent${X.idle > 1 ? 's' : ''} sans activité sur la période, non affiché${X.idle > 1 ? 's' : ''}.</p>` : ''}`
    + (X.agents.length ? hbars(X.agents.slice(0, 15).map((a) => ({ label: a.label, value: a.answered || 0, extra: `${fmtDur(a.conversation_time || 0)} en conversation` })), bar) + agentTable() : '<p class="muted small">Aucune activité d\'agent sur la période.</p>')
    + '</section>';
}

function queueTable() {
  const th = ['File', 'Reçus', 'Répondus', 'Taux', 'Abandonnés', 'Délai dépassé', 'Sans agent', 'Saturé', 'Fermé', 'Attente moy.', `≤ ${F.qos} s`];
  return `<section class="dk-panel"><h3>Par file</h3><div class="dk-scroll"><table class="dk-table"><thead><tr>${th.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${X.queues.map((q) => `<tr><td class="nowrap">${esc(q.label)}</td>${['received', 'answered'].map((k) => `<td class="num">${q[k] || 0}</td>`).join('')}<td class="num">${pct(q.answered_rate)}</td>${['abandoned', 'not_answered', 'blocked', 'saturated', 'closed'].map((k) => `<td class="num">${q[k] || 0}</td>`).join('')}<td class="num">${q.average_waiting_time == null ? '—' : esc(fmtDur(q.average_waiting_time))}</td><td class="num">${pct(q.quality_of_service)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

const occupation = (a) => (a.login_time ? ((a.conversation_time || 0) / a.login_time) * 100 : null);
function agentTable() {
  const th = ['Agent', 'Répondus', 'Conversation', 'Durée moy.', 'Connecté', 'Pause', 'Post-appel', 'Occupation'];
  return `<div class="dk-scroll"><table class="dk-table"><thead><tr>${th.map((h, i) => `<th${i ? ' class="num"' : ''}${h === 'Occupation' ? ' title="Temps en conversation / temps connecté"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${X.agents.map((a) => `<tr><td class="nowrap">${esc(a.label)} <span class="muted small">${esc(a.agent_number || '')}</span></td><td class="num">${a.answered || 0}</td><td class="num">${esc(fmtDur(a.conversation_time || 0))}</td><td class="num">${a.answered ? esc(fmtDur(a.conversation_time / a.answered)) : '—'}</td><td class="num">${esc(fmtDur(a.login_time || 0))}</td><td class="num">${esc(fmtDur(a.pause_time || 0))}</td><td class="num">${esc(fmtDur(a.wrapup_time || 0))}</td><td class="num">${pct(occupation(a))}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------
export async function renderStats(view, site) {
  if (X.site !== site.uuid) { Object.assign(F, F0); Object.assign(X, { site: site.uuid, loadedFor: null, queues: [], agents: [], idle: 0, buckets: null, names: null }); }
  if (!X.names) X.names = await loadNames();
  const opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
  const hours = (cur, none) => opt('', none, cur) + Array.from({ length: 24 }, (_, h) => opt(h, `${h} h`, cur)).join('');
  view.innerHTML = `
    <div class="phonehead"><div><h2>Statistiques</h2><div class="muted small">${esc(site.name)} · files d'attente et agents · lecture seule</div></div>
      <div class="btnrow"><button id="st-csv">CSV</button><button id="st-html">HTML</button><button id="st-pdf">PDF</button></div></div>
    <form id="st-filters" class="dk-filters">
      <label>Période <select id="st-period">${[['today', "Aujourd'hui"], ['yesterday', 'Hier'], ['7d', '7 derniers jours'], ['30d', '30 derniers jours'], ['month', 'Ce mois-ci'], ['lastmonth', 'Mois dernier'], ['custom', 'Personnalisée']].map(([v, l]) => opt(v, l, F.period)).join('')}</select></label>
      <label class="st-custom">Du <input id="st-from" type="date" value="${esc(F.from)}"></label>
      <label class="st-custom">Au <input id="st-until" type="date" value="${esc(F.until)}"></label>
      <label>Jours <select id="st-days">${opt('all', 'Tous les jours', F.days)}${opt('week', 'Du lundi au vendredi', F.days)}</select></label>
      <label title="Heures incluses : de 8 h à 17 h compte les appels de 8 h 00 à 17 h 59.">De <select id="st-h1">${hours(F.h1, 'Toute la journée')}</select></label>
      <label>À (incluse) <select id="st-h2">${hours(F.h2, '—')}</select></label>
      <label title="Un appel répondu en moins de ce délai compte comme bien servi.">Seuil de qualité (s) <input id="st-qos" type="number" min="0" max="600" value="${esc(F.qos)}"></label>
      <div class="dk-go"><button class="primary" type="submit">Afficher</button></div>
    </form>
    <p class="muted small">Chiffres calculés périodiquement par Wazo : les appels des dernières heures peuvent ne pas encore apparaître.</p>
    <div id="st-out"></div><div id="dk-tip" class="dk-tip" hidden></div>`;
  const syncCustom = () => view.querySelectorAll('.st-custom').forEach((l) => (l.hidden = $('st-period').value !== 'custom'));
  syncCustom();
  $('st-period').onchange = syncCustom;
  $('st-filters').onsubmit = (e) => { e.preventDefault(); readFilters(); refresh(); };
  $('st-csv').onclick = () => exportCsv(site);
  $('st-html').onclick = () => exportHtml(site);
  $('st-pdf').onclick = () => { if (needData()) printHtml(reportHtml(site)); };
  hoverTips(view);
  if (X.loadedFor === JSON.stringify(F)) draw(); else refresh();
}

function readFilters() {
  F.period = $('st-period').value; F.from = $('st-from').value; F.until = $('st-until').value;
  F.days = $('st-days').value; F.h1 = $('st-h1').value; F.h2 = $('st-h2').value;
  F.qos = Math.max(0, Math.min(600, parseInt($('st-qos').value, 10) || 0));
  if (F.period === 'custom' && F.from && F.until && F.until < F.from) [F.from, F.until] = [F.until, F.from];
  if (F.h1 !== '' && F.h2 !== '' && +F.h2 <= +F.h1) { toast("Plage horaire ignorée : l'heure de fin doit suivre l'heure de début.", 6000); F.h1 = F.h2 = ''; }
}

async function refresh() {
  const out = $('st-out');
  out.innerHTML = '<p class="dk-empty">Lecture des statistiques…</p>';
  try {
    await load();
    X.loadedFor = JSON.stringify(F);
    if ($('st-out') === out) draw();
  } catch (err) {
    X.loadedFor = null;
    if ($('st-out') === out) out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function draw() {
  const out = $('st-out');
  if (!X.queues.length && !X.agents.length) { out.innerHTML = `<p class="dk-empty">Aucune file d'attente ni aucun agent sur ce site.</p>`; return; }
  out.innerHTML = summaryHtml();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
const fileBase = (site) => `statistiques_${fileSafe(site.name)}_${dayKey(periodRange(F)[0])}`;
function needData() { if (!X.loadedFor || (!X.queues.length && !X.agents.length)) { toast("Rien à exporter : affichez d'abord des statistiques."); return false; } return true; }
function filtersText() {
  return [`Période : ${periodRange(F)[2]}`, F.days === 'week' && 'du lundi au vendredi', F.h1 !== '' && F.h2 !== '' && `de ${F.h1} h à ${F.h2} h (incluse)`, `seuil de qualité : ${F.qos} s`].filter(Boolean).join(' · ');
}

// Un seul fichier : les files, puis les agents (deux blocs séparés par une ligne vide).
function exportCsv(site) {
  if (!needData()) return;
  const r = (n) => (n == null ? '' : Math.round(n));
  const rows = [
    ...X.queues.map((q) => [q.label, q.received || 0, q.answered || 0, r(q.answered_rate), q.abandoned || 0, q.not_answered || 0, q.blocked || 0, q.saturated || 0, q.closed || 0, r(q.average_waiting_time), r(q.quality_of_service)]),
    [], ['Agent', 'Numéro', 'Répondus', 'Conversation (s)', 'Connecté (s)', 'Pause (s)', 'Post-appel (s)', 'Occupation (%)'],
    ...X.agents.map((a) => [a.label, a.agent_number, a.answered || 0, a.conversation_time || 0, a.login_time || 0, a.pause_time || 0, a.wrapup_time || 0, r(occupation(a))]),
  ];
  const head = ['File', 'Reçus', 'Répondus', 'Taux de réponse (%)', 'Abandonnés', "Délai d'attente dépassé", 'Sans agent', 'Saturé ou débordement', 'Fermé', 'Attente moyenne (s)', `Répondus en moins de ${F.qos} s (%)`];
  download(`${fileBase(site)}.csv`, csv(head, rows), 'text/csv;charset=utf-8');
}

function reportHtml(site) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Statistiques · ${esc(site.name)}</title><style>${REPORT_CSS}.muted{color:#52514e}.small{font-size:11px}</style></head><body><h1>Statistiques des files et des agents · ${esc(site.name)}</h1><p class="sub">${esc(site.customer || '')} · ${esc(filtersText())} · édité le ${esc(fmtDate(new Date().toISOString()))} par Astrea Desk</p>${summaryHtml('hex')}</body></html>`;
}
function exportHtml(site) { if (needData()) download(`${fileBase(site)}.html`, reportHtml(site), 'text/html;charset=utf-8'); }
