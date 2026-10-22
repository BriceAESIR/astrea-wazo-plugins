// Migration Assistant — interface de la bascule multisite (lot 2).
// Moteur : multisite.js. Brouillon (sites, affectations) gardé dans le
// navigateur par serveur et tenant (confort seulement).
import { S, $, esc, toast, canWrite, confirmModal, downloadJson, helpButton, helpBox } from '../common/core.js?v=0.40.25';
import { I } from './inventory.js?v=0.40.25';
import { buildExport, exportFileName } from './export.js?v=0.40.25';
import { sourceContexts, movableExtensions, buildPlan, executePlan, undoJournal, compactRanges, rangesText, parseRanges, liveReload, enableLiveReload, lrMarkedByUs, loadSavedJournal, clearSavedJournal, JOURNAL_FORMAT } from './multisite.js?v=0.40.25';

const DRAFT_KEY = 'astrea-migration-ms-draft-v1';
const U = { ms: null, scope: null, q: '', sel: new Set(), busy: false, reload: null, lr: null, result: null };
let seq = 1;
const newSite = (label = '') => ({ key: `s${Date.now().toString(36)}${seq++}`, label, rangesText: '' });

function draftKey() { return `${DRAFT_KEY}|${S.base}|${I.tenant}`; }
function saveDraft() {
  try { localStorage.setItem(draftKey(), JSON.stringify({ source: U.ms.source, sites: U.ms.sites, assign: [...U.ms.assign], interSite: U.ms.interSite })); } catch { /* */ }
}
function loadDraft() { try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch { return null; } }

export function initMultisite({ reload }) { U.reload = reload; }

// Appelé après chaque chargement de l'inventaire.
export async function renderMultisite() {
  const scope = `${S.base}|${I.tenant}`;
  if (U.scope !== scope) {
    U.scope = scope; U.sel.clear(); U.result = null;
    const d = loadDraft();
    const srcs = sourceContexts();
    U.ms = { source: srcs[0]?.name || null, sites: [], assign: new Map(), interSite: true };
    if (d && srcs.some((s) => s.name === d.source)) U.ms = { source: d.source, sites: d.sites || [], assign: new Map(d.assign || []), interSite: d.interSite !== false };
  }
  // Affectations vers des numéros qui n'existent plus (relecture) : retirées.
  const ids = new Set(movableExtensions(U.ms.source).map((e) => e.id));
  for (const id of [...U.ms.assign.keys()]) if (!ids.has(id)) U.ms.assign.delete(id);
  try { U.lr = { ok: true, enabled: (await liveReload('GET'))?.enabled !== false }; } catch (e) { U.lr = { ok: false, err: e.message }; }
  draw();
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
function draw() {
  const root = $('ms');
  const srcs = sourceContexts();
  if (!srcs.length) { root.innerHTML = '<p class="muted">Aucun contexte interne avec des lignes dans ce tenant.</p>'; return; }
  const j = loadSavedJournal();
  const journalForHere = j && j.host === S.base && j.tenant === I.tenant ? j : null;
  root.innerHTML = `
    ${lrBanner()}
    ${journalForHere ? journalBox(journalForHere) : ''}
    ${U.result ? `<div class="mg-allok ${U.result.bad ? 'bad' : ''}">${U.result.html}</div>` : ''}
    <div class="card mg-card wide">
      <div class="titlerow"><h3>1. Contexte commun</h3>${helpButton('ms-h1', 'Aide : contexte commun')}</div>
      ${helpBox('ms-h1', 'Contexte interne actuel, partagé par tout le tenant. Il reste en place et devient le « commun » : il garde groupes, files, conférences, messageries et les utilisateurs non affectés à un site. Il inclura les sites en tête, pour que tout ce qui l\'utilise (SDA, groupes, destinations « numéro ») trouve toujours les numéros déplacés, sans rien réécrire.')}
      <label>Contexte <select id="ms-src">${srcs.map((s) => `<option value="${esc(s.name)}" ${s.name === U.ms.source ? 'selected' : ''}>${esc(s.ctx.label || s.name)} (${esc(s.name)}) · ${s.lines} ligne(s)</option>`).join('')}</select></label>
    </div>
    <div class="card mg-card wide">
      <div class="titlerow"><h3>2. Sites</h3>${helpButton('ms-h2', 'Aide : sites')}</div>
      ${helpBox('ms-h2', 'Un contexte interne est créé par site. Plages : numéros de poste autorisés dans ce contexte ; confd refuse de déplacer un numéro hors des plages du site. « Calculer » propose les plages les plus courtes qui couvrent les numéros affectés. Les sites s\'appellent entre eux : chaque site inclut les autres (sinon, un site ne joint les autres qu\'en passant par le commun, ce qui marche aussi puisque le commun les inclut).')}
      <div id="ms-sites">${U.ms.sites.map(siteRow).join('') || '<p class="muted small">Aucun site.</p>'}</div>
      <div class="btnrow"><button id="ms-add">Ajouter un site</button></div>
      <label class="inline"><input type="checkbox" id="ms-inter" ${U.ms.interSite ? 'checked' : ''}> Les sites s'incluent entre eux</label>
    </div>
    <div class="card mg-card wide">
      <div class="titlerow"><h3>3. Affectation des numéros</h3>${helpButton('ms-h3', 'Aide : affectation')}</div>
      ${helpBox('ms-h3', 'Numéros de poste du contexte commun (une ligne par numéro ; une ligne partagée n\'apparaît qu\'une fois). Un numéro affecté à un site sera déplacé dans le contexte du site : la ligne suit automatiquement (vérifié dans le code de Wazo), le poste n\'est pas reprovisionné. Non affecté : il reste dans le commun.')}
      ${assignTools()}
      <div class="tablewrap mg-assign"><table class="diff"><thead><tr><th><input type="checkbox" id="ms-all" title="Tout cocher (lignes affichées)"></th><th>Numéro</th><th>Utilisateur(s)</th><th>Site</th></tr></thead><tbody id="ms-rows">${rows()}</tbody></table></div>
    </div>
    <div class="card mg-card wide" id="ms-plan">${planBox()}</div>`;
  bind();
}
function siteRow(s) {
  const n = [...U.ms.assign.values()].filter((k) => k === s.key).length;
  const { errors } = parseRanges(s.rangesText);
  return `<div class="ms-site" data-key="${esc(s.key)}">
    <label>Nom du site <input data-f="label" value="${esc(s.label)}" placeholder="ex. Nantes"></label>
    <label>Plages de postes <input data-f="rangesText" value="${esc(s.rangesText)}" placeholder="ex. 100-149, 160">${errors.length ? `<span class="error small">${esc(errors[0])}</span>` : ''}</label>
    <span class="muted small ms-n">${n} numéro(s)</span>
    <button data-act="calc" title="Plages les plus courtes couvrant les numéros affectés">Calculer</button>
    <button class="icon" data-act="del" title="Retirer ce site">×</button>
  </div>`;
}
function assignTools() {
  const opts = U.ms.sites.map((s) => `<option value="${esc(s.key)}">${esc(s.label || '(sans nom)')}</option>`).join('');
  return `<div class="ms-tools">
    <input id="ms-q" type="search" placeholder="Filtrer : numéro, nom" value="${esc(U.q)}">
    <label class="inline">Plage <input id="ms-range" placeholder="100-149" class="short"></label>
    <select id="ms-to"><option value="">Commun (aucun site)</option>${opts}</select>
    <button id="ms-apply-range">Affecter la plage</button>
    <button id="ms-apply-sel">Affecter la sélection (${U.sel.size})</button>
  </div>`;
}
function filtered() {
  const q = U.q.trim().toLowerCase();
  return movableExtensions(U.ms.source).filter((e) => !q || e.exten.includes(q) || e.label.toLowerCase().includes(q));
}
function rows() {
  const opts = (cur) => `<option value="">Commun</option>${U.ms.sites.map((s) => `<option value="${esc(s.key)}" ${s.key === cur ? 'selected' : ''}>${esc(s.label || '(sans nom)')}</option>`).join('')}`;
  return filtered().map((e) => {
    const cur = U.ms.assign.get(e.id) || '';
    return `<tr class="${cur ? 'assigned' : ''}"><td><input type="checkbox" data-sel="${e.id}" ${U.sel.has(e.id) ? 'checked' : ''}></td><td>${esc(e.exten)}</td><td>${esc(e.label)}</td><td><select data-assign="${e.id}">${opts(cur)}</select></td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">Aucun numéro.</td></tr>';
}
function planBox() {
  const p = buildPlan(U.ms);
  const probs = p.problems.map((x) => `<div class="${x.sev === 'error' ? 'compat blocking' : 'warn'}">${esc(x.text)}</div>`).join('');
  const ctx = p.steps.filter((s) => s.phase !== 'move');
  const mv = p.steps.filter((s) => s.phase === 'move');
  const lr = !U.lr?.ok ? `Live reload illisible (${esc(U.lr?.err || '')}) : un rechargement d'Asterisk par numéro déplacé, sur tout le serveur.`
    : !U.lr.enabled ? 'Live reload déjà désactivé sur le serveur : aucun rechargement ne sera fait, à faire ensuite.'
      : mv.length > 1 ? 'Rechargements regroupés : live reload coupé pendant les déplacements, un seul rechargement complet à la fin.' : '';
  return `<div class="titlerow"><h3>4. Aperçu et bascule</h3>${helpButton('ms-h4', 'Aide : bascule')}</div>
    ${helpBox('ms-h4', 'Avant d\'écrire : un export JSON du tenant est téléchargé (sauvegarde). Ensuite, dans l\'ordre : création des contextes, inclusions des sites, inclusions du commun (relues juste avant), puis déplacement des numéros (chacun relu avant, arrêt si l\'un a changé). Chaque écriture est notée dans un journal, téléchargé à la fin et gardé dans le navigateur : il permet d\'annuler la bascule. Les appels en cours ne sont pas coupés ; un poste peut mettre quelques secondes à appeler depuis son nouveau contexte (rechargement).')}
    ${probs}
    <p class="small"><strong>${ctx.length}</strong> écriture(s) de contexte, <strong>${mv.length}</strong> numéro(s) à déplacer. ${esc(lr)}</p>
    ${p.steps.length ? `<details class="ms-steps"><summary class="small">Détail des écritures</summary><ol class="small">${p.steps.map((s) => `<li>${esc(s.text)}</li>`).join('')}</ol></details>` : ''}
    <div id="ms-progress" class="muted small"></div>
    <div class="btnrow"><button id="ms-go" class="primary" ${p.ok && !U.busy ? '' : 'disabled'}>Basculer…</button></div>`;
}
function lrBanner() {
  if (!(U.lr?.ok && !U.lr.enabled)) return '';
  return `<div class="compat blocking"><strong>Live reload désactivé sur ce serveur.</strong> Les modifications (portail compris, tous les clients) ne rechargent plus Asterisk.${lrMarkedByUs() ? ' Il a été coupé par Migration Assistant (opération interrompue ?).' : ''}
    <div class="btnrow"><button id="ms-lr-fix" class="danger">Réactiver le live reload</button></div></div>`;
}
function journalBox(j) {
  const moved = j.entries.filter((e) => e.op === 'move' && !e.skipped).length;
  return `<div class="card mg-card wide ms-journal">
    <div class="titlerow"><h3>Dernière bascule</h3></div>
    <p class="small">${esc(new Date(j.started_at).toLocaleString('fr-FR'))} · statut : <strong>${esc(j.status)}</strong> · ${j.created.length} contexte(s) créé(s), ${moved} numéro(s) déplacé(s)${j.error ? ` · erreur : ${esc(j.error)}` : ''}</p>
    <div class="btnrow"><button id="ms-j-dl">Télécharger le journal</button><button id="ms-j-undo" class="danger">Annuler cette bascule…</button><button id="ms-j-forget">Oublier</button></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------
function refreshPlan() { $('ms-plan').innerHTML = planBox(); bindPlan(); }
function bind() {
  $('ms-src').onchange = (e) => { U.ms.source = e.target.value; U.ms.assign.clear(); U.sel.clear(); saveDraft(); draw(); };
  $('ms-add').onclick = () => { U.ms.sites.push(newSite()); saveDraft(); draw(); };
  $('ms-inter').onchange = (e) => { U.ms.interSite = e.target.checked; saveDraft(); refreshPlan(); };
  $('ms-sites').addEventListener('input', (e) => {
    const row = e.target.closest('.ms-site'); const f = e.target.dataset.f; if (!row || !f) return;
    const s = U.ms.sites.find((x) => x.key === row.dataset.key); s[f] = e.target.value; saveDraft(); refreshPlan();
  });
  $('ms-sites').addEventListener('change', (e) => { if (e.target.dataset.f === 'label') draw(); }); // libellés des listes de choix
  $('ms-sites').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const key = b.closest('.ms-site').dataset.key;
    const s = U.ms.sites.find((x) => x.key === key);
    if (b.dataset.act === 'del') { U.ms.sites = U.ms.sites.filter((x) => x !== s); for (const [id, k] of U.ms.assign) if (k === key) U.ms.assign.delete(id); }
    if (b.dataset.act === 'calc') {
      const exts = movableExtensions(U.ms.source).filter((x) => U.ms.assign.get(x.id) === key).map((x) => x.exten);
      if (!exts.length) { toast('Affectez d\'abord des numéros à ce site.'); return; }
      s.rangesText = rangesText(compactRanges(exts));
    }
    saveDraft(); draw();
  });
  $('ms-q').oninput = (e) => { U.q = e.target.value; $('ms-rows').innerHTML = rows(); };
  $('ms-all').onchange = (e) => { for (const x of filtered()) e.target.checked ? U.sel.add(x.id) : U.sel.delete(x.id); $('ms-rows').innerHTML = rows(); $('ms-apply-sel').textContent = `Affecter la sélection (${U.sel.size})`; };
  $('ms-rows').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.sel) { t.checked ? U.sel.add(Number(t.dataset.sel)) : U.sel.delete(Number(t.dataset.sel)); $('ms-apply-sel').textContent = `Affecter la sélection (${U.sel.size})`; return; }
    if (t.dataset.assign) { const id = Number(t.dataset.assign); t.value ? U.ms.assign.set(id, t.value) : U.ms.assign.delete(id); t.closest('tr').classList.toggle('assigned', !!t.value); afterAssign(); }
  });
  const assign = (ids) => { const to = $('ms-to').value; for (const id of ids) to ? U.ms.assign.set(id, to) : U.ms.assign.delete(id); afterAssign(true); };
  $('ms-apply-sel').onclick = () => { if (!U.sel.size) return toast('Cochez des numéros.'); assign([...U.sel]); U.sel.clear(); draw(); };
  $('ms-apply-range').onclick = () => {
    const { ranges, errors } = parseRanges($('ms-range').value);
    if (errors.length || !ranges.length) return toast(errors[0] || 'Indiquez une plage, par ex. 100-149.');
    const ids = movableExtensions(U.ms.source).filter((x) => ranges.some((r) => x.exten.length === r.start.length && Number(r.start) <= Number(x.exten) && Number(x.exten) <= Number(r.end))).map((x) => x.id);
    if (!ids.length) return toast('Aucun numéro dans cette plage.');
    assign(ids); toast(`${ids.length} numéro(s) affecté(s).`); draw();
  };
  if ($('ms-lr-fix')) $('ms-lr-fix').onclick = async () => { if (!canWrite()) return; try { await enableLiveReload(); toast('Live reload réactivé. Le prochain changement rechargera Asterisk.', 6000); U.lr = { ok: true, enabled: true }; draw(); } catch (e) { toast(`Échec : ${e.message}`, 8000); } };
  if ($('ms-j-dl')) $('ms-j-dl').onclick = () => downloadJson(journalName(loadSavedJournal()), loadSavedJournal());
  if ($('ms-j-forget')) $('ms-j-forget').onclick = () => confirmModal('<h3>Oublier la dernière bascule ?</h3><p>Le journal gardé dans ce navigateur est effacé. Sans le fichier téléchargé, l\'annulation automatique ne sera plus possible.</p>', () => { clearSavedJournal(); draw(); }, 'Oublier');
  if ($('ms-j-undo')) $('ms-j-undo').onclick = () => openUndo(loadSavedJournal());
  bindPlan();
}
function afterAssign(skipRows) {
  saveDraft();
  for (const row of document.querySelectorAll('.ms-site')) {
    const n = [...U.ms.assign.values()].filter((k) => k === row.dataset.key).length;
    row.querySelector('.ms-n').textContent = `${n} numéro(s)`;
  }
  if (!skipRows) refreshPlan();
}
function bindPlan() { const b = $('ms-go'); if (b) b.onclick = openRun; }
const journalName = (j) => `astrea-multisite-journal-${new URL(j?.host || S.base).hostname.split('.')[0]}-${String(j?.started_at || '').slice(0, 16).replace(/[-:T]/g, '')}.json`;

// ---------------------------------------------------------------------------
// Bascule et annulation
// ---------------------------------------------------------------------------
function openRun() {
  if (!canWrite()) return;
  const p = buildPlan(U.ms);
  if (!p.ok) return;
  const warns = p.problems.filter((x) => x.sev === 'warn');
  confirmModal(`<h3>Basculer en multisite ?</h3>
    <p>${p.sites.length} contexte(s) créé(s) (${p.sites.map((s) => esc(s.label)).join(', ')}), inclusions du commun modifiées, <strong>${p.moves}</strong> numéro(s) déplacé(s).</p>
    ${warns.length ? `<p class="small">À noter : ${warns.map((w) => esc(w.text)).join(' ')}</p>` : ''}
    <p class="small">Un export JSON du tenant est d'abord téléchargé. Le journal permettra d'annuler.${!U.lr?.ok || !U.lr.enabled ? '' : p.moves > 1 ? ' Le live reload (commun à tout le serveur) sera coupé quelques instants.' : ''}</p>`, () => run(p), 'Basculer');
}
async function run(p) {
  U.busy = true; U.result = null;
  const prog = (t) => { const el = $('ms-progress'); if (el) el.textContent = t; };
  try {
    downloadJson(exportFileName().replace('astrea-export', 'astrea-export-avant-multisite'), buildExport({ secrets: false }));
    const j = await executePlan(p, U.ms, prog);
    downloadJson(journalName(j), j);
    U.result = { html: `Bascule terminée : ${j.created.length} contexte(s) créé(s), ${j.entries.filter((e) => e.op === 'move' && !e.skipped).length} numéro(s) déplacé(s). ${esc(j.note || '')} Journal téléchargé. Testez un appel depuis chaque site.` };
    U.ms.assign.clear(); U.ms.sites = []; saveDraft();
  } catch (e) {
    if (e.journal) downloadJson(journalName(e.journal), e.journal);
    U.result = { bad: true, html: `Bascule interrompue : ${esc(e.message)}. ${e.journal ? 'Journal téléchargé ; « Annuler cette bascule » remet en place ce qui a été fait.' : 'Rien n\'a été écrit.'}` };
    console.error('[astrea] bascule', e);
  } finally {
    U.busy = false;
    await U.reload();
  }
}
function openUndo(j) {
  if (!canWrite() || !j) return;
  const moved = j.entries.filter((e) => e.op === 'move' && !e.skipped).length;
  confirmModal(`<h3>Annuler la bascule du ${esc(new Date(j.started_at).toLocaleString('fr-FR'))} ?</h3>
    <ul class="small"><li>${moved} numéro(s) remis dans le commun (chacun relu avant ; arrêt s'il a changé depuis).</li>
    <li>Inclusions du commun remises comme avant la bascule.</li>
    <li>${j.created.length} contexte(s) de site supprimé(s) : ${j.created.map((c) => esc(c.label)).join(', ') || 'aucun'} (refusé par Wazo s'ils contiennent encore quelque chose).</li></ul>
    <p class="small">Un export JSON du tenant est d'abord téléchargé.</p>`, async () => {
    U.busy = true;
    try {
      downloadJson(exportFileName().replace('astrea-export', 'astrea-export-avant-annulation'), buildExport({ secrets: false }));
      const r = await undoJournal(j, (t) => toast(t, 3000));
      const failed = r.report.filter((x) => x.error);
      if (!failed.length) clearSavedJournal();
      U.result = { bad: !!failed.length, html: `Annulation ${failed.length ? 'partielle' : 'terminée'}. ${esc(r.note || '')}${failed.length ? ` Non supprimés : ${failed.map((x) => `contexte ${x.id} (${esc(x.error)})`).join(' ; ')}.` : ''}` };
    } catch (e) {
      U.result = { bad: true, html: `Annulation interrompue : ${esc(e.message)}` };
    } finally { U.busy = false; await U.reload(); }
  }, 'Annuler la bascule');
}
// Journal chargé depuis un fichier (autre navigateur, ou après « Oublier »).
export function loadJournalFile(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const j = JSON.parse(r.result);
      if (j?.format !== JOURNAL_FORMAT) throw new Error('ce fichier n\'est pas un journal de bascule multisite');
      openUndo(j);
    } catch (e) { toast(`Journal illisible : ${e.message}`, 6000); }
  };
  r.readAsText(file);
}
