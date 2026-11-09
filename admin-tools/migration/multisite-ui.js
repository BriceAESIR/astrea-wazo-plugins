// Migration Assistant — interface de la bascule multisite (lot 2).
// Moteur : multisite.js. Brouillon (sites, affectations) gardé dans le
// navigateur par serveur et tenant (confort seulement).
import { S, $, esc, toast, canWrite, confirmModal, downloadJson, helpButton, helpBox } from '../common/core.js?v=0.40.60';
import { I } from './inventory.js?v=0.40.60';
import { buildExport, exportFileName } from './export.js?v=0.40.60';
import { sourceContexts, movableExtensions, buildPlan, executePlan, undoJournal, compactRanges, rangesText, parseRanges, liveReload, enableLiveReload, lrMarkedByUs, loadSavedJournal, clearSavedJournal, JOURNAL_FORMAT, PARTITIONS, partitionOf, linkKey, siteNames, tenantDids, didSite, outOf, didsReady, moveDids, movableObjects, objSite, rewriteOn } from './multisite.js?v=0.40.60';
import { FR_FAMILIES, FR_FORMATS } from './3cx-sites.js?v=0.40.60';
import { numWazo } from './3cx-draft.js?v=0.40.60';

const DRAFT_KEY = 'astrea-migration-ms-draft-v1';
const U = { ms: null, scope: null, q: '', sel: new Set(), busy: false, reload: null, lr: null, result: null };
let seq = 1;
const newSite = (label = '') => ({ key: `s${Date.now().toString(36)}${seq++}`, label, rangesText: '' });

function draftKey() { return `${DRAFT_KEY}|${S.base}|${I.tenant}`; }
function saveDraft() {
  try { localStorage.setItem(draftKey(), JSON.stringify({ source: U.ms.source, sites: U.ms.sites, assign: [...U.ms.assign], clientId: U.ms.clientId, partition: U.ms.partition, links: U.ms.links, out: U.ms.out, didAssign: U.ms.didAssign, objAssign: U.ms.objAssign, moveVm: U.ms.moveVm, rewrite: U.ms.rewrite, dropCommonOut: U.ms.dropCommonOut })); } catch { /* */ }
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
    U.ms = { source: srcs[0]?.name || null, sites: [], assign: new Map(), clientId: '', partition: 'mesh', links: [], out: null, didAssign: {}, objAssign: {}, moveVm: true };
    // Brouillon d'avant (interSite) : « tous les sites s'appellent », comme le faisait le commun.
    if (d && srcs.some((s) => s.name === d.source)) U.ms = { source: d.source, sites: d.sites || [], assign: new Map(d.assign || []), clientId: d.clientId || '', partition: d.partition || 'mesh', links: d.links || [], out: d.out || null, didAssign: d.didAssign || {}, objAssign: d.objAssign || {}, moveVm: d.moveVm !== false, rewrite: d.rewrite, dropCommonOut: !!d.dropCommonOut };
    U.ms.out = outOf(U.ms);
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
      ${helpBox('ms-h1', 'Contexte interne actuel, partagé par tout le tenant. Il reste en place et devient le « commun » : il garde groupes, files, conférences, messageries et les utilisateurs non affectés à un site. Chaque site l\'inclut (groupes, files et utilisateurs restés y sont joignables). Si tous les sites s\'appellent, il inclut aussi les sites, en fin de liste (après son sortant : sinon ses appels externes sortiraient par le trunk d\'un site) : tout ce qui l\'utilise (SDA, groupes, destinations « numéro ») trouve alors toujours les numéros déplacés, sans rien réécrire.')}
      <div class="ms-tools"><label>Contexte <select id="ms-src">${srcs.map((s) => `<option value="${esc(s.name)}" ${s.name === U.ms.source ? 'selected' : ''}>${esc(s.ctx.label || s.name)} (${esc(s.name)}) · ${s.lines} ligne(s)</option>`).join('')}</select></label>
      <label>ID client <input id="ms-client" value="${esc(U.ms.clientId || '')}" placeholder="44150" class="short"></label></div>
    </div>
    <div class="card mg-card wide">
      <div class="titlerow"><h3>2. Sites</h3>${helpButton('ms-h2', 'Aide : sites')}</div>
      ${helpBox('ms-h2', 'Trois contextes par site, nommés comme dans l\'import 3CX : <ID client>-<site>-internal (postes du site, avec ses plages), -to-extern (sortant, inclus en premier par l\'interne ; vide pour l\'instant, le site sort donc par le sortant du commun) et -from-extern (entrant, vide : ses SDA et son trunk au lot suivant). Noms modifiables. Plages : numéros de poste autorisés dans le site ; confd refuse de déplacer un numéro hors des plages. « Calculer » propose les plages les plus courtes qui couvrent les numéros affectés.')}
      <div id="ms-sites">${U.ms.sites.map(siteRow).join('') || '<p class="muted small">Aucun site.</p>'}</div>
      <div class="btnrow"><button id="ms-add">Ajouter un site</button></div>
    </div>
    <div class="card mg-card wide">
      <div class="titlerow"><h3>3. Appels internes entre sites</h3>${helpButton('ms-h2b', 'Aide : cloisonnement')}</div>
      ${helpBox('ms-h2b', 'Asterisk suit les inclusions en cascade : un contexte inclus apporte ses propres inclusions. « Tous les sites s\'appellent » : chaque site inclut les autres, et le commun inclut les sites. « Liens choisis » et « Sites isolés » : chaque site n\'inclut que les sites cochés, puis le commun ; le commun n\'inclut plus les sites, sinon ils se joindraient par lui. Conséquence : les utilisateurs restés dans le commun ne joignent plus les sites, et les références « numéro@commun » vers un numéro déplacé cassent (relevées dans l\'aperçu). La simulation montre le résultat avant d\'écrire.')}
      <label>Mode <select id="ms-part">${Object.entries(PARTITIONS).map(([k, l]) => `<option value="${k}" ${partitionOf(U.ms) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${partitionOf(U.ms) === 'pairs' ? linksBox() : ''}
      <label class="inline small" title="Destinations « numéro » (SDA, débordements, SVI, horaires, seuils de file) et membres « numéro » des groupes qui visent un numéro déplacé : leur contexte devient celui du site. Relu avant chaque écriture, valeur d'avant gardée dans le journal."><input type="checkbox" id="ms-rewrite" ${rewriteOn(U.ms) ? 'checked' : ''}> Réécrire les références « numéro@commun » vers les numéros déplacés${partitionOf(U.ms) === 'mesh' ? ' (facultatif ici : le commun inclut les sites)' : ' (nécessaire : le commun n\'inclut pas les sites)'}</label>
      <label class="inline small" title="Seulement si plus aucun poste ne reste dans le commun et que chaque site a son trunk : les sites ne sortent plus que par leur propre règle (sinon ce qu'elle ne prend pas part par le sortant du commun)."><input type="checkbox" id="ms-dropout" ${U.ms.dropCommonOut ? 'checked' : ''}> Retirer le sortant du commun (commun vidé de ses postes)</label>
    </div>
    <div class="card mg-card wide">
      <div class="titlerow"><h3>Appels sortants et SDA des sites</h3>${helpButton('ms-h2c', 'Aide : sortants et SDA')}</div>
      ${helpBox('ms-h2c', 'Sortant : pour chaque site qui a un trunk (choisi sur la ligne du site), une règle « <ID> - <site> - Appels sortants » avec les motifs de l\'assistant France de Call Flow, dans le contexte sortant du site, inclus en premier par son interne. Le site sort donc par son trunk ; ce que sa règle ne prend pas part par le commun. SDA : chaque SDA cochée pour un site est déclarée dans les plages de l\'entrant du site, qui inclut aussi les entrants actuels (repli : rien ne se perd quand le trunk change de contexte). Les trunks ne sont jamais modifiés par l\'outil : après la bascule, régler dans le Portal le contexte entrant du trunk du site, relire, puis « Déplacer les SDA ». Par défaut, une SDA suit l\'utilisateur qu\'elle vise.')}
      <div class="small">${FR_FAMILIES.map((f) => `<label class="inline"><input type="checkbox" data-out="fam" data-id="${f.id}" ${U.ms.out.fams.includes(f.id) ? 'checked' : ''}> ${esc(f.label)}</label>`).join(' ')}</div>
      <div class="ms-tools small"><label>Format attendu par l'opérateur <select data-out="fmt">${Object.entries(FR_FORMATS).map(([k, l]) => `<option value="${k}" ${U.ms.out.fmt === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="inline"><input type="checkbox" data-out="block118" ${U.ms.out.block118 ? 'checked' : ''}> Bloquer les 118 XXX</label>
        <label class="inline" title="Prend tout numéro qu'aucun autre motif ne prend : capte les numéros des sites mal inclus (la simulation le montre)."><input type="checkbox" data-out="catchAll" ${U.ms.out.catchAll ? 'checked' : ''}> Attrape-tout _X.</label></div>
      ${didTable()}
    </div>
    <div class="card mg-card wide">
      <div class="titlerow"><h3>4. Affectation des numéros</h3>${helpButton('ms-h3', 'Aide : affectation')}</div>
      ${helpBox('ms-h3', 'Numéros de poste du contexte commun (une ligne par numéro ; une ligne partagée n\'apparaît qu\'une fois). Un numéro affecté à un site sera déplacé dans le contexte du site : la ligne suit automatiquement (vérifié dans le code de Wazo), le poste n\'est pas reprovisionné. Non affecté : il reste dans le commun.')}
      ${assignTools()}
      <div class="tablewrap mg-assign"><table class="diff"><thead><tr><th><input type="checkbox" id="ms-all" title="Tout cocher (lignes affichées)"></th><th>Numéro</th><th>Utilisateur(s)</th><th>Site</th></tr></thead><tbody id="ms-rows">${rows()}</tbody></table></div>
      <label class="inline small"><input type="checkbox" id="ms-vm" ${U.ms.moveVm !== false ? 'checked' : ''}> Messagerie des utilisateurs déplacée avec eux (contexte du site ; Wazo déplace aussi les messages)</label>
      ${objTable()}
    </div>
    <div class="card mg-card wide" id="ms-plan">${planBox()}</div>`;
  bind();
}
function siteRow(s) {
  const n = [...U.ms.assign.values()].filter((k) => k === s.key).length;
  const { errors } = parseRanges(s.rangesText);
  // Noms par défaut (ID client et site) en indication ; saisie = nom imposé.
  const def = siteNames(U.ms, { label: s.label });
  return `<div class="ms-site" data-key="${esc(s.key)}">
    <label>Nom du site <input data-f="label" value="${esc(s.label)}" placeholder="ex. Nantes"></label>
    <label>Plages de postes <input data-f="rangesText" value="${esc(s.rangesText)}" placeholder="ex. 100-149, 160">${errors.length ? `<span class="error small">${esc(errors[0])}</span>` : ''}</label>
    <span class="muted small ms-n">${n} numéro(s)</span>
    <button data-act="calc" title="Plages les plus courtes couvrant les numéros affectés">Calculer</button>
    <button class="icon" data-act="del" title="Retirer ce site">×</button>
    <div class="ms-names small">
      <label title="Numéro présenté par la règle du site aux utilisateurs réglés sur « défaut » (wazo-agid : le numéro de la règle sortante, lu dans outgoingfeatures.py)">Numéro présenté <select data-f="callerId"><option value="">celui du trunk</option>${tenantDids().filter((d) => didSite(U.ms, d) === s.key).map((d) => { const n = numWazo(d.exten); return `<option value="${esc(n)}" ${s.callerId === n ? 'selected' : ''}>${esc(n)}</option>`; }).join('')}</select></label>
      <label>Trunk du site <select data-f="trunkId"><option value="">aucun (sort par le commun)</option>${(I.lists.trunk || []).map((t) => `<option value="${t.id}" ${String(s.trunkId) === String(t.id) ? 'selected' : ''}>${esc(t.endpoint_sip?.label || t.endpoint_sip?.name || `Trunk ${t.id}`)}</option>`).join('')}</select></label>
      <label>Interne <input data-f="ctxLabel" value="${esc(s.ctxLabel || '')}" placeholder="${esc(def.ctx)}"></label>
      <label>Sortant <input data-f="outLabel" value="${esc(s.outLabel || '')}" placeholder="${esc(def.out)}"></label>
      <label>Entrant <input data-f="incLabel" value="${esc(s.incLabel || '')}" placeholder="${esc(def.inc)}"></label>
    </div>
  </div>`;
}
// Groupes, files et conférences du commun et leur site (par défaut : majorité stricte de leurs membres).
function objTable() {
  const objs = movableObjects(U.ms.source); if (!objs.length) return '';
  const opts = (cur) => `<option value="">commun (reste)</option>${U.ms.sites.map((s) => `<option value="${esc(s.key)}" ${s.key === cur ? 'selected' : ''}>${esc(s.label || '(sans nom)')}</option>`).join('')}`;
  return `<details class="small" open><summary>Groupes, files et conférences (${objs.length}) : déplacés par leur numéro ; les plages du site sont calculées</summary><div class="tablewrap"><table class="diff small"><thead><tr><th>Numéro</th><th>Type</th><th>Nom</th><th>Site</th></tr></thead><tbody>
    ${objs.map((x) => `<tr><td>${esc(x.exten)}</td><td>${esc(x.what)}</td><td>${esc(x.label)}</td><td><select data-obj="${x.id}">${opts(objSite(U.ms, x))}</select></td></tr>`).join('')}</tbody></table></div></details>`;
}
// SDA du tenant et leur site (par défaut : celui de l'utilisateur visé).
function didTable() {
  const dids = tenantDids(); if (!dids.length) return '<p class="muted small">Aucune SDA dans ce tenant.</p>';
  const dest = (d) => { const x = d.incall.destination; if (x?.type === 'user') { const u = (I.lists.user || []).find((y) => y.id === x.user_id); return `utilisateur ${[u?.firstname, u?.lastname].filter(Boolean).join(' ') || x.user_id}`; } return x?.type || 'aucune'; };
  const opts = (cur) => `<option value="">aucun (reste où elle est)</option>${U.ms.sites.map((s) => `<option value="${esc(s.key)}" ${s.key === cur ? 'selected' : ''}>${esc(s.label || '(sans nom)')}</option>`).join('')}`;
  return `<details class="small" open><summary>SDA (${dids.length})</summary><div class="tablewrap"><table class="diff small"><thead><tr><th>SDA</th><th>Contexte actuel</th><th>Destination</th><th>Site</th></tr></thead><tbody>
    ${dids.map((d) => `<tr><td>${esc(d.exten)}</td><td>${esc(I.by.context?.get(String(d.context))?.label || d.context)}</td><td>${esc(dest(d))}</td><td><select data-did="${d.extId}">${opts(didSite(U.ms, d))}</select></td></tr>`).join('')}</tbody></table></div></details>`;
}
// Liens entre sites (mode « Liens choisis ») : une case par paire, appels dans les deux sens.
function linksBox() {
  const sites = U.ms.sites.filter((s) => s.label);
  if (sites.length < 2) return '<p class="muted small">Nommez au moins deux sites pour choisir leurs liens.</p>';
  const pairs = []; for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) pairs.push([sites[i], sites[j]]);
  return `<div class="small ms-links">${pairs.map(([a, b]) => `<label class="inline"><input type="checkbox" data-link="${esc(linkKey(a.key, b.key))}" ${(U.ms.links || []).includes(linkKey(a.key, b.key)) ? 'checked' : ''}> ${esc(a.label)} ↔ ${esc(b.label)}</label>`).join('')}</div>`;
}
// Tableau de simulation : une ligne par contexte d'appel, une colonne par numéro type.
function simTable(sim) {
  if (!sim?.rows?.length) return '';
  return `<details class="ms-sim" open><summary class="small"><strong>Simulation des appels</strong> : où part chaque numéro, depuis chaque site, avant et après (moteur de Call Flow et de l'import 3CX ; droits d'appel et horaires non pris en compte)</summary>
    <div class="tablewrap"><table class="diff small"><thead><tr><th>Depuis</th>${sim.cols.map((c) => `<th>${esc(c.n)}<div class="muted">${esc(c.what)}</div></th>`).join('')}</tr></thead>
    <tbody>${sim.rows.map((r) => `<tr><td>${esc(r.from)}</td>${r.cells.map((x) => `<td class="${x.ok ? '' : 'x3-error'}" title="Avant (depuis le commun) : ${esc(x.before)}">${esc(x.after)}${x.after !== x.before ? `<div class="muted">avant : ${esc(x.before)}</div>` : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
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
  return `<div class="titlerow"><h3>5. Aperçu et bascule</h3>${helpButton('ms-h4', 'Aide : bascule')}</div>
    ${helpBox('ms-h4', 'Avant d\'écrire : un export JSON du tenant est téléchargé (sauvegarde). Ensuite, dans l\'ordre : création des contextes de chaque site, inclusions des sites, inclusions du commun (relues juste avant, seulement si tous les sites s\'appellent), puis déplacement des numéros (chacun relu avant, arrêt si l\'un a changé). Chaque écriture est notée dans un journal, téléchargé à la fin et gardé dans le navigateur : il permet d\'annuler la bascule. Les appels en cours ne sont pas coupés ; un poste peut mettre quelques secondes à appeler depuis son nouveau contexte (rechargement). Une case rouge de la simulation est une erreur : appel interne perdu, ou cloisonnement qui fuit.')}
    ${probs}
    ${simTable(p.sim)}
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
    ${(j.sites || []).filter((s) => s.dids.length).map((s) => { const r = didsReady(j, s.site); return `<div class="small ms-dids"><strong>${esc(s.label)}</strong> : ${s.dids.length} SDA pour « ${esc(s.inc.label)} ». ${r.done ? 'Déplacées.' : r.ok ? 'Trunk réglé sur l\'entrant du site.' : esc(r.why) + '.'} ${r.ok ? `<button data-movedids="${esc(s.site)}">Déplacer les SDA (${r.left.length})</button>` : ''}</div>`; }).join('')}
    <div class="btnrow"><button id="ms-j-dl">Télécharger le journal</button><button id="ms-j-undo" class="danger">Annuler cette bascule…</button><button id="ms-j-forget">Oublier</button></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------
function refreshPlan() { $('ms-plan').innerHTML = planBox(); bindPlan(); }
// Noms par défaut des contextes (indication des champs) quand l'ID client ou le nom du site change.
function refreshNames() {
  for (const row of document.querySelectorAll('.ms-site')) {
    const s = U.ms.sites.find((x) => x.key === row.dataset.key); if (!s) continue; const def = siteNames(U.ms, { label: s.label });
    for (const [f, k] of [['ctxLabel', 'ctx'], ['outLabel', 'out'], ['incLabel', 'inc']]) { const i = row.querySelector(`[data-f="${f}"]`); if (i) i.placeholder = def[k]; }
  }
}
function bind() {
  $('ms-src').onchange = (e) => { U.ms.source = e.target.value; U.ms.assign.clear(); U.sel.clear(); saveDraft(); draw(); };
  $('ms-add').onclick = () => { U.ms.sites.push(newSite()); saveDraft(); draw(); };
  $('ms-client').oninput = (e) => { U.ms.clientId = e.target.value.trim(); saveDraft(); refreshPlan(); refreshNames(); };
  $('ms-part').onchange = (e) => { U.ms.partition = e.target.value; saveDraft(); draw(); };
  for (const c of document.querySelectorAll('[data-obj]')) c.onchange = (e) => { U.ms.objAssign = { ...(U.ms.objAssign || {}), [e.target.dataset.obj]: e.target.value }; saveDraft(); refreshPlan(); };
  $('ms-vm').onchange = (e) => { U.ms.moveVm = e.target.checked; saveDraft(); refreshPlan(); };
  $('ms-rewrite').onchange = (e) => { U.ms.rewrite = e.target.checked; saveDraft(); refreshPlan(); };
  $('ms-dropout').onchange = (e) => { U.ms.dropCommonOut = e.target.checked; saveDraft(); refreshPlan(); };
  for (const c of document.querySelectorAll('[data-did]')) c.onchange = (e) => { U.ms.didAssign = { ...(U.ms.didAssign || {}), [e.target.dataset.did]: e.target.value }; saveDraft(); refreshPlan(); };
  for (const c of document.querySelectorAll('[data-out]')) c.onchange = (e) => {
    const t = e.target; const o = U.ms.out;
    if (t.dataset.out === 'fam') { const f = new Set(o.fams); t.checked ? f.add(t.dataset.id) : f.delete(t.dataset.id); o.fams = FR_FAMILIES.map((x) => x.id).filter((x) => f.has(x)); }
    else if (t.dataset.out === 'fmt') o.fmt = t.value; else o[t.dataset.out] = t.checked;
    saveDraft(); refreshPlan();
  };
  for (const b of document.querySelectorAll('[data-movedids]')) b.onclick = () => openMoveDids(b.dataset.movedids);
  for (const c of document.querySelectorAll('[data-link]')) c.onchange = (e) => { const k = e.target.dataset.link; const l = new Set(U.ms.links || []); e.target.checked ? l.add(k) : l.delete(k); U.ms.links = [...l]; saveDraft(); refreshPlan(); };
  $('ms-sites').addEventListener('input', (e) => {
    const row = e.target.closest('.ms-site'); const f = e.target.dataset.f; if (!row || !f) return;
    const s = U.ms.sites.find((x) => x.key === row.dataset.key); s[f] = e.target.value; saveDraft(); refreshPlan(); if (f === 'label') refreshNames();
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
    <p>${p.sites.length * 3} contexte(s) créé(s), trois par site (${p.sites.map((s) => esc(s.label)).join(', ')}), ${esc(PARTITIONS[partitionOf(U.ms)].toLowerCase())}${partitionOf(U.ms) === 'mesh' ? ', inclusions du commun modifiées' : ', commun inchangé'}, <strong>${p.moves}</strong> numéro(s) déplacé(s).</p>
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
    U.ms.assign.clear(); U.ms.sites = []; U.ms.didAssign = {}; U.ms.objAssign = {}; saveDraft();
  } catch (e) {
    if (e.journal) downloadJson(journalName(e.journal), e.journal);
    U.result = { bad: true, html: `Bascule interrompue : ${esc(e.message)}. ${e.journal ? 'Journal téléchargé ; « Annuler cette bascule » remet en place ce qui a été fait.' : 'Rien n\'a été écrit.'}` };
    console.error('[astrea] bascule', e);
  } finally {
    U.busy = false;
    await U.reload();
  }
}
// SDA d'un site déplacées dans son entrant (trunk déjà réglé, relu avant).
function openMoveDids(key) {
  if (!canWrite()) return;
  const j = loadSavedJournal(); const r = didsReady(j, key); if (!r.ok) return toast(r.why, 6000);
  confirmModal(`<h3>Déplacer ${r.left.length} SDA dans « ${esc(r.s.inc.label)} » ?</h3><p class="small">${r.left.map((d) => esc(d.exten)).join(', ')}. Le trunk ${esc(r.tr.endpoint_sip?.label || r.tr.id)} arrive déjà sur cet entrant (relu juste avant l'écriture). Notées dans le journal de la bascule : l'annulation les remet en place.</p>`, async () => {
    U.busy = true;
    try { const note = await moveDids(j, key, (t) => toast(t, 2000)); U.result = { html: `SDA de « ${esc(r.s.label)} » déplacées. ${esc(note || '')}` }; }
    catch (e) { U.result = { bad: true, html: `Déplacement des SDA interrompu : ${esc(e.message)}` }; }
    finally { U.busy = false; await U.reload(); }
  }, 'Déplacer');
}
function openUndo(j) {
  if (!canWrite() || !j) return;
  // Un trunk réglé sur un entrant créé : l'annulation le supprimerait. Le remettre d'abord ailleurs.
  const incs = new Set(j.created.filter((c) => c.role === 'inc').map((c) => c.name));
  const tr = (I.lists.trunk || []).filter((t) => incs.has(t.context));
  if (tr.length) return toast(`Annulation impossible : ${tr.map((t) => t.endpoint_sip?.label || t.id).join(', ')} arrive sur un entrant créé par la bascule. Le remettre sur son ancien contexte dans le Portal, relire, puis annuler.`, 10000);
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
