// Migration Assistant (Astrea Admin Tools) — lot 1 : inventaire du tenant,
// vérification du paramétrage et export JSON. Lecture seule.
// Cadrage : astrea-wazo-dev/docs/MIGRATION-ASSISTANT.md.
// Inventaire : inventory.js ; contrôles : checks.js ; export : export.js.
import { S, $, esc, toast, connect, showCompat, setReadonly, loaded, loadFailed, stackVersion, helpButton, helpBox, confirmModal, downloadJson } from '../common/core.js?v=0.40.15';
import { I, SOURCES, CATEGORIES, loadInventory, ctxLabel } from './inventory.js?v=0.40.15';
import { runChecks, SEV } from './checks.js?v=0.40.15';
import { buildExport, exportFileName } from './export.js?v=0.40.15';
import { initMultisite, renderMultisite, loadJournalFile } from './multisite-ui.js?v=0.40.15';
import { init3cx, render3cx } from './3cx-ui.js?v=0.40.15';

const TESTED_STACK = ['26.07'];
const VIEW_KEY = 'astrea-migration-view-v1';
const A = { scope: null, view: 'overview', results: [] };
try { A.view = localStorage.getItem(VIEW_KEY) || 'overview'; } catch { /* stockage indisponible */ }

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
async function boot() {
  $('conn').textContent = 'Chargement…';
  document.body.classList.remove('idle');
  const scope = `${S.base}|${S.tenant}`;
  A.scope = scope;
  const prog = $('progress');
  prog.hidden = false;
  try {
    await loadInventory((msg) => { if (A.scope === scope) prog.textContent = msg; });
    if (A.scope !== scope || `${S.base}|${S.tenant}` !== scope) return; // tenant changé : un autre boot() s'en charge
    prog.hidden = true;
    selfCheck();
    A.results = runChecks();
    loaded();
    $('conn').textContent = new URL(S.base).host;
    $('lookwarn').innerHTML = I.warns.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
    renderAll();
  } catch (e) {
    if (e.stale || `${S.base}|${S.tenant}` !== scope) return;
    prog.hidden = true;
    loadFailed(e);
  }
}
// Auto-contrôle (convention Astrea) : forme des réponses dont les contrôles et
// la bascule multisite dépendent. Un écart passe le module en lecture seule
// (garde de api() dans core.js et canWrite() avant chaque écriture).
function selfCheck() {
  S.compatWarns = [];
  const p = [];
  const users = I.lists.user || [];
  if (users.length && !users.some((u) => Array.isArray(u.lines) && u.forwards)) p.push('GET /users ne contient plus lines / forwards');
  const ctx = I.lists.context || [];
  if (ctx.length && !ctx.some((c) => 'user_ranges' in c && 'contexts' in c)) p.push('GET /contexts ne contient plus les plages / inclusions');
  const inc = I.lists.incall || [];
  if (inc.length && !inc.some((i) => 'destination' in i)) p.push('GET /incalls ne contient plus destination');
  const lines = I.lists.line || [];
  if (lines.length && !lines.some((l) => 'context' in l && 'device_id' in l)) p.push('GET /lines ne contient plus context / device_id');
  const exts = I.lists.extension || [];
  if (exts.length && !exts.some((e) => 'context' in e && Array.isArray(e.lines))) p.push('GET /extensions ne contient plus context / lines');
  const v = stackVersion();
  if (v && !TESTED_STACK.some((t) => String(v).startsWith(t))) S.compatWarns.push(`Version de la stack ${v} non encore validée avec cet outil (validé : ${TESTED_STACK.join(', ')}).`);
  console.info('[astrea] Migration Assistant auto-contrôle', { users: users.length, contexts: ctx.length, problems: p });
  if (p.length) setReadonly(`réponses de Wazo différentes de celles attendues : ${p.join(' ; ')}`); else showCompat();
}

function renderAll() {
  renderOverview();
  renderChecks();
  renderExport();
  renderMultisite().catch((e) => console.error('[astrea] multisite', e));
  render3cx();
  renderNavCounts();
  showView(A.view);
  const d = I.loadedAt;
  $('sidefoot').textContent = d ? `Lu à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : '';
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const VIEWS = ['overview', 'checks', 'export', 'multisite', '3cx'];
// Bascule multisite masquée tant qu'elle n'est pas testée en réel (décision de
// Brice, 19/10/2026) : affichée avec ?beta=1, ou après confirmation via le lien
// « Fonctions en test… » (retenu dans le navigateur ; dans le portail, l'adresse
// du cadre vient du manifest et ne peut pas porter ?beta=1).
const BETA_KEY = 'astrea-migration-beta';
const BETA = { on: new URLSearchParams(location.search).has('beta') };
try { BETA.on = BETA.on || localStorage.getItem(BETA_KEY) === '1'; } catch { /* */ }
function applyBeta() {
  $('nav-ms').hidden = !BETA.on;
  $('beta-toggle').textContent = BETA.on ? 'Masquer les fonctions en test' : 'Fonctions en test…';
  if (!BETA.on && A.view === 'multisite') showView('overview');
}
$('beta-toggle').onclick = () => {
  const set = (on) => { BETA.on = on; try { localStorage.setItem(BETA_KEY, on ? '1' : '0'); } catch { /* */ } applyBeta(); };
  if (BETA.on) return set(false);
  confirmModal('<h3>Afficher les fonctions en test ?</h3><p>La <strong>bascule multisite</strong> modifie les contextes et les numéros du tenant. Elle n\'a été testée que sur un faux serveur : ne l\'utilisez que sur un tenant de test, export et journal à l\'appui.</p>', () => set(true), 'Afficher');
};
function showView(v) {
  if (!VIEWS.includes(v) || (v === 'multisite' && !BETA.on)) v = 'overview';
  A.view = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* */ }
  for (const b of $('nav').querySelectorAll('button')) b.classList.toggle('active', b.dataset.view === v);
  for (const x of VIEWS) $(`v-${x}`).hidden = x !== v;
}
applyBeta();
initMultisite({ reload: () => boot() });
init3cx();
$('ms-jfile').onchange = (e) => { const f = e.target.files?.[0]; if (f) loadJournalFile(f); e.target.value = ''; };
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) showView(b.dataset.view); });
$('reload').onclick = () => boot();

function renderNavCounts() {
  const n = (sev) => A.results.filter((r) => r.sev === sev && r.items.length).length;
  const err = n('error'); const warn = n('warn');
  const el = $('nav-checks');
  el.textContent = err || warn || '';
  el.className = `mg-count ${err ? 's-error' : warn ? 's-warn' : ''}`; // pas « warn » : classe d'alerte du style commun
  el.title = `${err} contrôle(s) en erreur, ${warn} en avertissement`;
}

// ---------------------------------------------------------------------------
// Inventaire
// ---------------------------------------------------------------------------
function renderOverview() {
  const failed = new Set(I.warns.map((w) => w.split(' illisibles')[0]));
  const cats = Object.entries(CATEGORIES).map(([cat, title]) => {
    const rows = SOURCES.filter((s) => s[3] === cat).map(([key, , label, , , help]) => {
      const n = (I.lists[key] || []).length;
      const ko = failed.has(label);
      return `<tr title="${esc(help)}"><td>${esc(label)}</td><td class="n ${ko ? 'ko' : n ? '' : 'zero'}">${ko ? 'illisible' : n}</td></tr>`;
    }).join('');
    return `<div class="mg-cat"><h3>${esc(title)}</h3><table>${rows}</table></div>`;
  }).join('');
  const fk = Object.values(I.funckeys).reduce((s, k) => s + Object.keys(k || {}).length, 0);
  $('inv').innerHTML = `<div class="mg-cats">${cats}</div>
    <p class="muted small">Touches de fonction des utilisateurs : ${fk}.</p>
    ${contextsTable()}`;
}
const TYPE_CTX = { internal: 'Interne', incall: 'Entrant', outcall: 'Sortant', services: 'Services', others: 'Autre' };
const rangesTxt = (r) => (r || []).map((x) => (x.end && x.end !== x.start ? `${x.start}–${x.end}` : x.start)).join(', ');
function contextsTable() {
  const ctx = [...(I.lists.context || [])].sort((a, b) => String(a.type).localeCompare(b.type) || String(a.label).localeCompare(b.label));
  if (!ctx.length) return '';
  const nLines = (n) => (I.lists.line || []).filter((l) => l.context === n).length;
  const nInc = (n) => (I.lists.incall || []).filter((i) => (i.extensions || []).some((e) => e.context === n)).length;
  const nTrunk = (n) => (I.lists.trunk || []).filter((t) => t.context === n).length;
  const rows = ctx.map((c) => {
    const ranges = [['postes', c.user_ranges], ['groupes', c.group_ranges], ['files', c.queue_ranges], ['conf.', c.conference_room_ranges], ['SDA', c.incall_ranges]]
      .filter(([, r]) => (r || []).length).map(([l, r]) => `${l} ${esc(rangesTxt(r))}`).join('<br>');
    const use = c.type === 'internal' ? `${nLines(c.name)} ligne(s)` : c.type === 'incall' ? `${nInc(c.name)} SDA, ${nTrunk(c.name)} trunk(s)` : '';
    return `<tr><td>${esc(c.label || c.name)}<div class="muted">${esc(c.name)}</div></td><td>${esc(TYPE_CTX[c.type] || c.type)}${c.enabled === false ? ' <span class="muted">(désactivé)</span>' : ''}</td>
      <td>${ranges || '<span class="muted">aucune</span>'}</td><td>${(c.contexts || []).map((x) => esc(ctxLabel(x.name))).join('<br>') || '<span class="muted">aucun</span>'}</td><td>${esc(use)}</td></tr>`;
  }).join('');
  return `<div class="mg-ctx"><div class="titlerow"><h3>Contextes</h3>${helpButton('ctx-help', 'Aide : contextes')}</div>
    ${helpBox('ctx-help', 'Un contexte regroupe des numéros joignables. Le nom technique (sous le libellé) est généré par Wazo : c\'est lui que référencent lignes, numéros et trunks, et il change si on recrée le contexte (point clé d\'une restauration). Plages : numéros autorisés par type d\'objet ; un numéro hors plage ne peut plus être modifié. Inclus : contextes dont les numéros sont aussi joignables depuis celui-ci, dans l\'ordre.')}
    <table><thead><tr><th>Contexte</th><th>Type</th><th>Plages</th><th>Inclus</th><th>Utilisation</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Vérification
// ---------------------------------------------------------------------------
const SEV_ORDER = { error: 0, warn: 1, info: 2 };
const SHOW_MAX = 200;
$('checks-help').innerHTML = helpButton('checks-hb', 'Aide : vérification');
$('checks-helpbox').innerHTML = helpBox('checks-hb', 'Chaque contrôle lit l\'inventaire du tenant, sans rien modifier. Erreur : des appels échouent ou une obligation n\'est pas respectée. Avertissement : configuration douteuse, ou qui bloquera une modification (bascule multisite). Information : objet inutilisé ou incomplet, à nettoyer. Le « ? » de chaque contrôle dit ce qu\'il vérifie et ses limites. Les corrections se font dans les autres modules (Call Flow Manager, User Manager, BLF Manager) ou dans le portail.');
for (const cb of document.querySelectorAll('.mg-filters input')) cb.addEventListener('change', renderChecks);
function renderChecks() {
  const sevOn = new Set([...document.querySelectorAll('.mg-filters input[data-sev]')].filter((c) => c.checked).map((c) => c.dataset.sev));
  const showOk = $('f-ok').checked;
  const list = [...A.results].sort((a, b) => (b.items.length ? 1 : 0) - (a.items.length ? 1 : 0) || SEV_ORDER[a.sev] - SEV_ORDER[b.sev])
    .filter((r) => (r.items.length || r.failed ? sevOn.has(r.sev) : showOk));
  const total = A.results.filter((r) => r.items.length).length;
  $('checks').innerHTML = (total ? '' : '<div class="mg-allok">Aucun problème détecté par les contrôles.</div>') + list.map((r) => {
    const ok = !r.items.length && !r.failed;
    const cls = `s-${ok ? 'ok' : r.sev}`;
    const rows = r.items.slice(0, SHOW_MAX).map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.detail || '')}</td></tr>`).join('');
    const more = r.items.length > SHOW_MAX ? `<div class="more muted small">… et ${r.items.length - SHOW_MAX} autre(s) : voir le rapport CSV.</div>` : '';
    return `<details class="mg-check ${cls}" data-id="${esc(r.id)}">
      <summary><span class="sev">${ok ? 'Conforme' : esc(SEV[r.sev])}</span><span class="ttl">${esc(r.title)}</span>${helpButton(`hc-${r.id}`, `Aide : ${r.title}`)}<span class="nb">${r.failed ? 'échec' : r.items.length}</span></summary>
      <div class="body">${helpBox(`hc-${r.id}`, r.help)}${r.failed ? `<p class="error">Contrôle en échec : ${esc(r.failed)}</p>` : ''}${rows ? `<table>${rows}</table>${more}` : '<p>Aucun objet concerné.</p>'}</div>
    </details>`;
  }).join('');
}
// Le « ? » dans le résumé ne replie pas le contrôle : il l'ouvre si besoin, et
// l'aide est dépliée par le gestionnaire commun (core.js, délégation sur document).
$('checks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-help-toggle]');
  if (!b) return;
  e.preventDefault();
  const d = b.closest('details');
  if (d) d.open = true;
});
function reportRows() {
  const rows = [];
  for (const r of A.results) for (const x of r.items) rows.push({ check: r.id, severity: r.sev, title: r.title, object_type: x.type, object: x.label, detail: x.detail || '' });
  return rows;
}
$('csv').onclick = () => {
  const cols = ['severity', 'title', 'object_type', 'object', 'detail'];
  const head = ['Gravité', 'Contrôle', 'Type', 'Objet', 'Détail'];
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(';'), ...reportRows().map((r) => cols.map((c) => q(c === 'severity' ? SEV[r[c]] : r[c])).join(';'))];
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = exportFileName().replace('astrea-export', 'astrea-verification').replace(/\.json$/, '.csv');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { toast(`Téléchargement impossible : ${e.message}`); }
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
$('export-help').innerHTML = helpButton('export-hb', 'Aide : export');
$('export-helpbox').innerHTML = helpBox('export-hb', 'Le fichier contient les objets tels que confd les renvoie (format astrea-migration, version 1) : contextes, numéros, utilisateurs avec leurs réglages, lignes, comptes SIP, appareils, messageries, groupes, files, SVI, horaires, SDA, trunks, règles sortantes, droits, services, musiques d\'attente, liste des sons et touches de fonction. Il est enregistré sur votre poste uniquement. La restauration (lot suivant) recréera les objets et fera la correspondance des identifiants et des noms de contextes.');
$('x-secrets-help').textContent = 'Décoché : les mots de passe sont remplacés par *** (fichier partageable, mais une restauration devra en créer de nouveaux et reprovisionner les postes). Coché : le fichier permet de restaurer les comptes SIP à l\'identique ; à conserver comme un coffre-fort, jamais par e-mail.';
const OUT_OF_EXPORT = [
  'Mots de passe des comptes utilisateurs (wazo-auth) : jamais lisibles, à recréer.',
  'Fichiers sons (accueils, SVI, musiques d\'attente) : seule leur liste est exportée.',
  'Messages vocaux, enregistrements d\'appels, journaux d\'appels.',
  'Contacts personnels et annuaires (wazo-dird).',
  'Configuration provd des appareils (modèles de provisionnement, options Astrea).',
  'Réglages globaux de la stack (communs à tous les tenants).',
];
function renderExport() {
  const n = (k) => (I.lists[k] || []).length;
  $('x-summary').textContent = `${n('user')} utilisateurs, ${n('line')} lignes, ${n('device')} appareils, ${n('incall')} SDA, ${n('group')} groupes, ${n('queue')} files, ${n('ivr')} SVI, ${n('context')} contextes.`;
  $('x-out').innerHTML = OUT_OF_EXPORT.map((x) => `<li>${esc(x)}</li>`).join('');
}
$('x-go').onclick = () => {
  if (!I.loadedAt) return;
  const secrets = $('x-secrets').checked;
  const go = () => {
    const report = $('x-report').checked ? reportRows() : null;
    downloadJson(exportFileName(), buildExport({ secrets, report }));
    toast('Export téléchargé.');
  };
  if (!secrets) return go();
  confirmModal(`<h3>Exporter avec les mots de passe ?</h3><p>Le fichier contiendra en clair les mots de passe des comptes SIP (lignes et trunks), les codes des messageries et des droits d'appel. Toute personne qui l'obtient peut enregistrer un poste ou un trunk du client.</p><p>Conservez-le dans un espace protégé et supprimez-le après la migration.</p>`, go, 'Télécharger');
};

connect(boot);
