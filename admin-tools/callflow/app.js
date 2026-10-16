// Call Flow Manager (Astrea Admin Tools) — vue graphique du parcours des
// appels : lecture (lot 1) et modification des destinations par glisser-
// déposer (lot 2a, brouillon puis aperçu, sauvegarde, écriture).
// Cadrage : astrea-wazo-dev/docs/CALLFLOW-MANAGER.md.
// Modèle (sources confd vérifiées) : model.js ; canevas : canvas.js ; écriture : write.js.
import { S, $, esc, fullName, toast, connect, setReadonly, showCompat, loaded, loadFailed, stackVersion, helpButton, helpBox, canWrite, confirmModal, downloadJson } from '../common/core.js?v=0.39.2';
import { M, TYPES, loadAll, ensureAllDetails, loadLiveMembers, loadTrunkOperators, scanGroupKeys, buildTree, landingAt, reverseIndex, facts, listOf, nodeInfo, entity, applyTime, whenOf, dayBands, schedulesIn, landingSegments, destLabel, periodText, STRATEGY, QSTRAT, baseKey, gateOf, loadBlocklist, blockedBy, dialUser } from './model.js?v=0.39.2';
import { createCanvas } from './canvas.js?v=0.39.2';
import { getDest, setDest, sameValue, prepare, execute } from './write.js?v=0.39.2';
import { openScheduleEditor } from './sched-editor.js?v=0.39.2';
import { openGroupEditor, groupCfgDiff } from './group-editor.js?v=0.39.2';
import { openQueueEditor, queueCfgDiff, agentName } from './queue-editor.js?v=0.39.2';
import { openIvrEditor, ivrCfgDiff } from './ivr-editor.js?v=0.39.2';
import { openSbEditor, sbCfgDiff } from './sb-editor.js?v=0.39.2';
import { redact } from './ed-ui.js?v=0.39.2';
import { openRestore } from './restore.js?v=0.39.2';
import { openIncallEditor, incallCfgDiff, openUserEditor, userCfgDiff, openVmEditor, vmCfgDiff, openConfEditor, confCfgDiff, openSchedGenEditor, schedCfgDiff } from './obj-editors.js?v=0.39.2';
import { openDestEditor, ENTITY_DEST } from './dest-editor.js?v=0.39.2';
import { openOutcallEditor, outcallCfgDiff } from './outcall-editor.js?v=0.39.2';
import { openCreate, CREATABLE } from './create.js?v=0.39.2';
import { simulate, userContext, simPath } from './dialsim.js?v=0.39.2';

const TESTED_STACK = ['26.07'];
const NAV = [
  ['incall', 'SDA'], ['trunk', 'Trunks'], ['user', 'Utilisateurs'], ['group', 'Groupes'], ['queue', 'Files d\'attente'], ['ivr', 'SVI'],
  ['schedule', 'Horaires'], ['voicemail', 'Messageries'], ['conference', 'Conférences'], ['switchboard', 'Standards'], ['outcall', 'Règles sortantes'], ['context', 'Contextes'],
];
const C = { edit: false, draft: new Map(), time: { on: true, date: null, min: 0 }, type: 'incall', root: null, dir: 'out', collapsed: new Set(), expanded: new Set(), showEmpty: false, scope: null, canvas: null, tree: null, sel: null, sim: { on: false, num: '', caller: '', mode: 'in' }, simR: null };

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
async function boot() {
  $('conn').textContent = 'Chargement…';
  document.body.classList.remove('idle');
  const scope = `${S.base}|${S.tenant}`;
  if (C.scope !== scope) { C.root = null; C.sel = null; C.collapsed.clear(); C.expanded.clear(); }
  C.draft.clear(); renderDraft(); // les objets sont relus : le brouillon ne vaut plus
  C.scope = scope;
  try {
    await reload();
    loaded();
    $('conn').textContent = `${new URL(S.base).host}`;
    draw();
  } catch (e) { loadFailed(e); }
}
async function reload() {
  await loadAll();
  await Promise.all([ensureAllDetails(), loadLiveMembers(), loadTrunkOperators()]);
  selfCheck();
  $('lookwarn').innerHTML = M.warns.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  if (C.root && !nodeExists(C.root)) C.root = null;
  if (!C.root) { const first = listOf('incall')[0] || listOf('user')[0]; C.root = first?.key || null; if (first) C.type = first.key.split(':')[0]; }
  renderNav();
  renderList();
}
const nodeExists = (k) => !!entity(k).obj;
// Auto-contrôle (convention Astrea) : forme des réponses dont le graphe dépend.
function selfCheck() {
  S.compatWarns = [];
  const p = [];
  const inc = M.lists.incall || [];
  if (inc.length && !inc.some((i) => i && 'destination' in i && Array.isArray(i.extensions))) p.push('GET /incalls ne contient plus destination / extensions');
  const ivr = M.lists.ivr || [];
  if (ivr.length && !ivr.some((i) => Array.isArray(i.choices))) p.push('GET /ivr ne contient plus les choix (choices)');
  const sch = M.lists.schedule || [];
  if (sch.length && !sch.some((s) => 'closed_destination' in s)) p.push('GET /schedules ne contient plus closed_destination');
  const v = stackVersion();
  if (v && !TESTED_STACK.some((t) => String(v).startsWith(t))) S.compatWarns.push(`Version de la stack ${v} non encore validée avec cet outil (validé : ${TESTED_STACK.join(', ')}). Le graphe peut être incomplet.`);
  console.info('[astrea] Call Flow Manager auto-contrôle', { incalls: inc.length, ivr: ivr.length, schedules: sch.length, problems: p });
  if (p.length) setReadonly(p.join(' ; ')); else showCompat();
}

// ---------------------------------------------------------------------------
// Colonne de gauche
// ---------------------------------------------------------------------------
function renderNav() {
  $('nav').innerHTML = NAV.map(([t, l]) => `<button data-type="${t}" class="${t === C.type ? 'active' : ''}" title="${esc(TYPES[t]?.help || '')}">${esc(l)}<span class="spacer"></span><span class="cf-count">${(M.lists[t] || []).length}</span></button>`).join('');
}
function renderList() {
  const q = $('q').value.trim().toLowerCase();
  const items = listOf(C.type).filter((x) => !q || `${x.title} ${x.sub}`.toLowerCase().includes(q));
  $('count').textContent = `${items.length} élément${items.length > 1 ? 's' : ''}`;
  $('list').innerHTML = items.map((x) => `<li data-key="${esc(x.key)}" class="${x.key === C.root ? 'sel' : ''}"><div><div>${esc(x.title)}</div>${x.sub ? `<div class="sub">${esc(x.sub)}</div>` : ''}</div></li>`).join('') || '<li class="muted">Aucun élément</li>';
}

// ---------------------------------------------------------------------------
// Graphe
// ---------------------------------------------------------------------------
function draw(keepView = false) {
  if (!C.canvas) C.canvas = createCanvas($('cf-view'), { onSelect: showDetail, onOpen: (k) => setRoot(k), onFold: fold, onClear: clearPort, onUndo: (k, p) => { const r = portOf({ nodeKey: k, portId: p }); if (r) revertKey(r.p.w.key); }, onCardDrop: cardDrop, onPortClick: portClick });
  if (!C.root) { $('cf-title').textContent = 'Parcours des appels'; $('cf-view').classList.add('empty'); return; }
  $('cf-view').classList.remove('empty');
  syncDir();
  const match = simMatch();
  // Mode Modifier : les sorties vides sont affichées (ce sont des cibles de dépôt).
  const caller = simActive() && callerOk() ? C.sim.caller.trim() : '';
  if (caller && M.blocklist === undefined) loadBlocklist().then(() => draw(true)); // une fois, en arrière-plan
  const td = TD();
  const build = () => buildTree(C.root, td, { collapsed: C.collapsed, expanded: C.expanded, showEmpty: (C.showEmpty || C.edit) && td === 'out', caller, dialScope: C.sim.mode, hit: td === 'dial' && ['internal', 'incall'].includes(match?.result?.kind) ? { ...match.result, number: match.number } : null });
  C.tree = build();
  applyTime(C.tree, timeW());
  // Appel suivi : une branche repliée sur le chemin est dépliée, puis l'arbre refait.
  C.simR = null;
  if (simActive()) {
    for (let i = 0; i < 8; i++) {
      C.simR = computeSim(simW(), match);
      if (!C.simR.expand.length) break;
      for (const k of C.simR.expand) { C.collapsed.delete(k); C.expanded.add(k); }
      C.tree = build(); applyTime(C.tree, timeW());
    }
  }
  const info = nodeInfo(C.root), t = TYPES[info.type] || {}; // objet choisi (le graphe peut commencer par son horaire)
  $('cf-title').textContent = `${t.label || ''} ${info.title}`;
  const nCards = `${C.tree.nodes.size} carte${C.tree.nodes.size > 1 ? 's' : ''}`;
  $('cf-sub').textContent = td === 'dial'
    ? `Appel ${C.sim.mode === 'int' ? 'interne' : 'sortant'} passé depuis ici · ${nCards}`
    : C.dir === 'out' ? `Où vont les appels · ${nCards}${info.sub ? ` · ${info.sub}` : ''}`
      : `Qui envoie des appels ici · ${C.tree.nodes.size - 1} origine${C.tree.nodes.size > 2 ? 's' : ''}`;
  // Aide : recalculée quand le mode change.
  const helpKey = `${C.dir}|${td}|${C.sim.mode}`;
  if (C.helpKey !== helpKey) { C.helpKey = helpKey; $('cf-help-box').innerHTML = ''; $('cf-help').innerHTML = ''; }
  if (!$('cf-hb')) $('cf-help').innerHTML = helpButton('cf-hb', 'Comment lire ce graphe');
  if (!$('cf-hb')) $('cf-help-box').innerHTML = helpBox('cf-hb', td === 'dial'
    ? 'Appel passé depuis la carte choisie à gauche (un utilisateur ; pour un groupe, un de ses membres ; ou un contexte), dans l\'ordre de recherche d\'Asterisk : numéros internes et règles sortantes du contexte de la ligne, puis contextes inclus (vérifié dans le code d\'Asterisk : numéro exact avant motif, motif le plus précis, contexte avant ses inclus). Interne : sans les règles sortantes. Sortant : chaque règle montre ce qui peut bloquer (autorisations d\'appels de l\'utilisateur, de ses groupes, de la règle ; horaire ; règle désactivée), ses motifs, le numéro envoyé et ses trunks jusqu\'à l\'opérateur. Tapez un numéro : le chemin pris s\'allume, avec le verdict des autorisations (vérifié dans wazo-agid).'
    : C.dir === 'out'
      ? 'Chaque carte est un objet Wazo ; ses sorties (à droite) sont les cas où l\'appel la quitte : débordements, touches de SVI, horaire fermé… Un lien en pointillé rejoint une carte déjà affichée ailleurs (boucle ou objet partagé). Un lien gris clair est une simple association (messagerie de l\'utilisateur), pas un routage. Les durées affichées sont celles de Wazo (sonnerie, délai du groupe ou de la file). « Suivre un appel » (bandeau du dessus) simule un appel entrant, interne ou sortant à partir de la carte choisie à gauche.'
      : 'Les cartes de gauche envoient des appels vers la carte choisie ; la sortie concernée est indiquée sur chacune. Seuls les routages lus dans confd sont trouvés (renvois vers un numéro interne compris).');
  C.treeId = (C.treeId || 0) + 1; // bandeau à recalculer
  C.canvas.render(C.tree, td, `${C.scope}|${C.root}|${td}${td === 'dial' ? C.sim.mode : ''}`, { keepView, edit: C.edit && td === 'out', changed: new Set(C.draft.keys()), sim: C.simR });
  // Nouveau chemin suivi : la vue le cadre (le reste du graphe reste visible, atténué).
  const sig = C.simR ? `${C.root}|${td}|${C.simR.steps.map((s) => s.key).join('>')}` : '';
  if (sig && sig !== C.simSig) C.canvas.fit(simKeys());
  C.simSig = sig;
  renderTime();
  renderFollow();
  autoScanKeys();
  if (C.sel && C.tree.nodes.has(C.sel)) C.canvas.select(C.sel, false); else closeDetail();
}
// Groupe affiché sans membre fixe et inscrits non lisibles (amid refusé) :
// recherche des touches de bascule, une fois par chargement, en arrière-plan.
function autoScanKeys() {
  if (M.keys || C.scanning || M.live) return;
  const need = [...C.tree.nodes.values()].some((n) => n.leaf?.ownerType === 'group' && !n.leaf.names.length);
  if (!need) return;
  C.scanning = true;
  scanGroupKeys().then(() => { C.scanning = false; const sel = C.sel; draw(true); const n = sel && C.tree.nodes.get(sel); if (n) { C.canvas.select(sel, false); showDetail(n); } });
}
function setRoot(k) {
  k = baseKey(k);
  if (!k || k.startsWith('leaf:')) return;
  C.root = k; C.collapsed.clear(); C.expanded.clear(); C.sel = null;
  const t = k.slice(0, k.indexOf(':'));
  if (NAV.some(([x]) => x === t) && t !== C.type) { C.type = t; renderNav(); }
  renderList();
  closeDetail();
  draw();
}
function fold(k) {
  const n = C.tree?.nodes.get(k);
  if (!n) return;
  if (n.folded) { C.collapsed.delete(k); C.expanded.add(k); } else { C.collapsed.add(k); C.expanded.delete(k); }
  draw(true);
}
function setDir(d) {
  C.dir = d; C.collapsed.clear(); C.expanded.clear();
  $('cf-help-box').innerHTML = '';
  draw();
}
// Appel passé (interne / sortant) : depuis un utilisateur, un groupe (un de ses membres) ou un contexte non entrant.
const dialOk = () => { const { type, obj } = entity(C.root || ''); return type === 'user' || type === 'group' || (type === 'context' && obj?.type !== 'incall'); };
// Sens de l'arbre affiché : la vue normale (lecture du dialplan) ; en simulation
// Interne / Sortant (demande de Brice, 16/10/2026 : seulement quand « Suivre
// un appel » est coché), arbre des appels passés ('dial').
const TD = () => (C.dir === 'out' && C.sim.on && C.sim.mode !== 'in' && dialOk() ? 'dial' : C.dir);
function syncDir() {
  if (C.sim.mode !== 'in' && !dialOk()) C.sim.mode = 'in';
  for (const b of document.querySelectorAll('[data-dir]')) b.classList.toggle('active', b.dataset.dir === C.dir);
  $('cf-empty').disabled = TD() !== 'out';
}

// ---------------------------------------------------------------------------
// Suivre un appel (demande de Brice, 16/10/2026 : dans le graphe, sans
// fenêtre, en partant de l'objet choisi à gauche). Le chemin d'un appel si
// personne ne décroche s'allume, avec l'instant de chaque étape ; le reste est
// atténué. Numéro demandé pour un trunk ou un contexte entrant (numéro reçu)
// et en « Numéros composés » (numéro composé). Calcul : dialsim.js.
// ---------------------------------------------------------------------------
// Ce que représente le numéro pour la carte de départ : 'in' (reçu), 'dial' (composé) ou '' (pas de numéro).
function numKind() {
  if (TD() === 'dial') return 'dial';
  const { type, obj } = entity(C.root || '');
  return C.dir === 'out' && (type === 'trunk' || (type === 'context' && obj?.type === 'incall')) ? 'in' : '';
}
const simActive = () => C.sim.on && C.dir !== 'in';
// Appelant extérieur (retour de Brice, 16/10/2026 : « un client d'une banque » qui
// appelle) : départ trunk, contexte entrant ou SDA.
const callerOk = () => { const { type, obj } = entity(C.root || ''); return TD() === 'out' && (type === 'trunk' || type === 'incall' || (type === 'context' && obj?.type === 'incall')); };
// SDA joignables depuis la carte de départ (trunk ou contexte entrant) : [{exten, ctx}].
function rootIncalls() {
  const { type, obj } = entity(C.root || '');
  const ctx = type === 'trunk' ? obj?.context : type === 'context' ? obj?.name : null;
  return ctx ? (M.lists.incall || []).flatMap((i) => (i.extensions || []).filter((x) => x.context === ctx).map((x) => ({ exten: x.exten, ctx }))) : [];
}
// Chemin suivi. Numéro reçu vide (trunk ou contexte entrant) : toutes les SDA
// sont des routes possibles, allumées ensemble ; routes = où arrive chacune.
function computeSim(w, match) {
  const blocked = C.sim.caller.trim() && callerOk() ? blockedBy(C.sim.caller) : null;
  if (!(numKind() === 'in' && !C.sim.num.trim())) { const R = simPath(C.tree, w, match, { blocked }); R.expand = R.expand ? [R.expand] : []; return R; }
  const U = { on: new Map(), ports: new Set(), ring: new Map(), steps: [], expand: [], end: '', routes: [] };
  for (const s of rootIncalls()) {
    const R = simPath(C.tree, w, simulate(s.exten, s.ctx), { blocked });
    for (const [k, v] of R.on) if (!U.on.has(k)) U.on.set(k, v);
    for (const p of R.ports) U.ports.add(p);
    for (const [k, v] of R.ring) if (!U.ring.has(k)) U.ring.set(k, v);
    if (R.expand) U.expand.push(R.expand);
    const land = R.steps.find((x) => !SIM_PASS.has(C.tree.nodes.get(x.key)?.info?.type) && C.tree.nodes.get(x.key)?.info?.type !== 'caller');
    const ln = land && C.tree.nodes.get(land.key);
    U.routes.push({ exten: s.exten, key: land?.key || null, type: ln?.info?.type || 'none', title: ln ? cardTitle(ln) : (R.end || 'aucune destination') });
  }
  U.end = U.routes.length ? '' : 'aucune SDA dans ce contexte';
  return U;
}
const cardTitle = (n) => { const lbl = TYPES[n.info?.type]?.label || ''; const ti = String(n.info?.title || ''); return ti.toLowerCase().startsWith(lbl.toLowerCase()) ? ti : `${lbl} ${ti}`.trim(); };
const simW = () => whenOf(C.time.date, C.time.min);
function simMatch() {
  const num = C.sim.num.trim(); const k = numKind();
  if (!C.sim.on || !num || !k) return null;
  const { type, obj } = entity(C.root);
  if (k === 'in') return simulate(num, type === 'trunk' ? obj.context : obj.name);
  // Appel passé : par l'utilisateur, ou par un membre du groupe (autorisations du groupe comprises).
  const user = dialUser(C.root);
  return simulate(num, type === 'context' ? obj.name : userContext(user), user, simW());
}
// Cartes du chemin suivi (cadrage), ou null.
const simKeys = () => (C.simR ? new Set([...C.simR.on.keys(), ...C.simR.ring.keys()]) : null);
// Ligne « Résultat » de l'appel suivi : où il arrive à chaque minute de la
// journée (premier objet après le trunk, le contexte, la SDA et les horaires).
const SIM_PASS = new Set(['trunk', 'context', 'incall', 'schedule']);
function simLanding(d) {
  const match = simMatch(); const out = [];
  for (let m = 0; m < 1440; m++) {
    const R = computeSim(whenOf(d, m), match);
    const s = R.steps.find((x, i) => !SIM_PASS.has(C.tree.nodes.get(x.key)?.info?.type) && C.tree.nodes.get(x.key)?.info?.type !== 'caller' && !(TD() === 'dial' && i === 0));
    const key = s?.key || null; const id = key || `none:${R.end}`;
    const last = out[out.length - 1];
    if (last && last.id === id) { last.end = m + 1; continue; }
    const n = key && C.tree.nodes.get(key); const lbl = TYPES[n?.info?.type]?.label || ''; const ti = n ? String(n.info.title) : (R.end || 'aucune destination');
    out.push({ id, start: m, end: m + 1, key, type: n?.info?.type || 'none', title: n && !ti.toLowerCase().startsWith(lbl.toLowerCase()) ? `${lbl} ${ti}`.trim() : ti });
  }
  return out;
}
const fmtS = (s) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`);
function renderFollow() {
  const k = numKind(), act = simActive();
  $('s-on').checked = C.sim.on; $('s-on').disabled = C.dir === 'in';
  // Type d'appel simulé : Entrant toujours ; Interne / Sortant depuis un utilisateur, un groupe ou un contexte.
  $('s-mode').hidden = !C.sim.on || C.dir !== 'out';
  for (const b of $('s-mode').querySelectorAll('[data-sm]')) { b.classList.toggle('active', b.dataset.sm === C.sim.mode); b.disabled = b.dataset.sm !== 'in' && !dialOk(); }
  // Libellés visibles devant les champs (retour de Brice : le texte indicatif disparaît à la saisie).
  $('s-num-l').hidden = !C.sim.on || !k;
  $('s-num-t').textContent = k === 'in' ? 'Appelé (SDA)' : 'Composé';
  $('s-num-l').title = k === 'in' ? 'Numéro que compose l\'appelant (une SDA du trunk). Vide : toutes les SDA sont des routes possibles.' : 'Numéro composé par l\'utilisateur ou depuis le contexte choisi.';
  $('s-num').placeholder = k === 'in' ? 'vide : toutes les SDA' : 'ex. 0805293535';
  if ($('s-num').value !== C.sim.num) $('s-num').value = C.sim.num;
  $('s-caller-l').hidden = !C.sim.on || !callerOk();
  if ($('s-caller').value !== C.sim.caller) $('s-caller').value = C.sim.caller;
  const R = act ? C.simR : null;
  $('s-trame').hidden = !R;
  if (!R) return;
  // Liste de blocage illisible : dit une fois, sans bloquer la simulation.
  const blk = C.sim.caller.trim() && callerOk() ? (M.blocklist === null ? '<span class="cf-tr-end">liste de blocage des utilisateurs illisible (droit confd.users.blocklist.read) : non vérifiée</span>' : blockedBy(C.sim.caller).size ? `<span class="cf-tr-end">appelant bloqué par ${[...blockedBy(C.sim.caller).keys()].map((u) => esc(fullName(M.userByUuid.get(u)) || u)).join(', ')}</span>` : '') : '';
  if (R.routes) {
    // Routes possibles (numéro appelé vide) : une pastille par SDA → où elle arrive à ce moment.
    $('s-trame').innerHTML = `<span class="cf-ln">Routes possibles</span><div class="cf-trs">${R.routes.map((x) => `<button type="button" class="cf-tr t-${esc(x.type)}" data-num="${esc(x.exten)}" title="Suivre l'appel vers ${esc(x.exten)}"><b>${esc(x.exten)}</b> → ${esc(x.title)}</button>`).join('')}${R.end ? `<span class="cf-tr-end">${esc(R.end)}</span>` : ''}${blk}</div>`;
    return;
  }
  // Trame : une pastille par étape (instant, carte, ce qui se passe), puis la fin.
  const chips = R.steps.map((s) => { const n = C.tree.nodes.get(s.key); const ty = n?.info?.type; const lbl = TYPES[ty]?.label || ''; const ti = String(n?.info?.title || ''); return `<button type="button" class="cf-tr t-${esc(ty || '')}" data-key="${esc(s.key)}" title="${esc(s.what)}"><b>${fmtS(s.t)}</b> ${ty === 'dial' ? esc(s.what) : esc(ti.toLowerCase().startsWith(lbl.toLowerCase()) ? ti : `${lbl} ${ti}`.trim())}${s.dur ? ` <span class="muted">${Number.isFinite(s.dur) ? fmtS(s.dur) : 'sans fin'}</span>` : ''}</button>`; });
  // Départ utilisateur ou contexte, sens « où vont les appels » : c'est un appel REÇU ; le rappeler.
  const { type: rt, obj: ro } = entity(C.root || '');
  const hint = TD() === 'out' && dialOk() && (rt === 'user' || rt === 'group' || ro?.type !== 'incall') ? '<button type="button" class="cf-tr-end cf-link" data-godial>appel reçu ; pour un appel passé depuis ici : Sortant</button>' : '';
  $('s-trame').innerHTML = `<span class="cf-ln">Trame</span><div class="cf-trs">${chips.join('<span class="cf-tr-arr">→</span>')}${R.end ? `<span class="cf-tr-end">${esc(R.end)}</span>` : ''}${blk}${hint}</div>`;
}

// ---------------------------------------------------------------------------
// Simulation date / heure (curseur sous le canevas). L'heure est celle du
// site (fuseau de l'horaire), sans conversion ; « Maintenant » prend l'heure
// du navigateur.
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
function setNow() {
  const d = new Date();
  C.time.date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  C.time.min = d.getHours() * 60 + d.getMinutes();
}
const timeW = () => (C.time.on && C.dir !== 'in' ? whenOf(C.time.date, C.time.min) : null);
// Lignes du bandeau : « Résultat » (où arrive l'appel, après tous les
// horaires) puis une ligne par horaire du parcours. Recalculées quand la date
// ou l'arbre change, pas à chaque mouvement du curseur.
const seg = (b, cls, label, text) => {
  const w = ((b.end - b.start) / 1440) * 100;
  return `<i class="${cls}" style="left:${(b.start / 1440) * 100}%;width:${w}%" title="${hhmm(b.start)}–${hhmm(b.end - 1)} : ${esc(label)}">${text && w > 9 ? `<span>${esc(text)}</span>` : ''}</i>`;
};
function renderLanes() {
  const d = C.time.date;
  const key = `${d.toDateString()}|${C.treeId}`;
  if (C.lanesKey === key) return;
  C.lanesKey = key;
  const scheds = C.dir !== 'in' ? schedulesIn(C.tree) : [];
  if (!scheds.length) { $('t-lanes').innerHTML = ''; C.landing = null; return; }
  // Trunk ou contexte entrant : le résultat dépend du numéro reçu, donc seulement avec un appel suivi.
  const viaSim = simActive() && C.simR && !(numKind() && !simMatch());
  C.landing = viaSim ? simLanding(d) : numKind() ? null : landingSegments(C.tree, d);
  const rows = C.landing ? [`<div class="cf-lane cf-result"><span class="cf-ln" title="Où arrive l'appel à chaque moment de la journée, une fois tous les horaires du parcours franchis">Résultat</span><div class="cf-lb">${C.landing.map((b) => seg(b, `r t-${b.type}`, b.title, b.title)).join('')}<b class="cf-cursor"></b></div></div>`] : [];
  for (const s of scheds) {
    rows.push(`<div class="cf-lane"><span class="cf-ln" title="${esc(s.name || '')}">${esc(s.name || `Horaire #${s.id}`)}</span><div class="cf-lb">${dayBands(s, d).map((b) => seg(b, `b-${b.k}`, b.label, b.k === 'exc' ? b.label.replace('Fermeture exceptionnelle', 'Ferm. exc.') : '')).join('')}<b class="cf-cursor"></b></div></div>`);
  }
  $('t-lanes').innerHTML = rows.join('');
}
function renderTime() {
  const d = C.time.date;
  $('t-date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('t-min').value = C.time.min;
  $('t-label').textContent = `${hhmm(C.time.min)} · ${d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}`;
  $('cf-time').classList.toggle('off', (!C.time.on && !simActive()) || C.dir === 'in');
  renderLanes();
  for (const c of $('t-lanes').querySelectorAll('.cf-cursor')) c.style.left = `${((C.time.min + 0.5) / 1440) * 100}%`;
  if (C.dir === 'in') { $('t-state').textContent = 'Simulation : sens « où vont les appels » ou « numéros composés »'; return; }
  if (!C.landing) { $('t-state').textContent = numKind() && !simMatch() ? (C.simR?.routes ? `Suivre un appel : ${C.simR.routes.length} route(s) possible(s), tapez ou choisissez le numéro appelé pour la trame` : 'Suivre un appel : tapez le numéro pour voir où il arrive') : schedulesIn(C.tree).length ? '' : 'Aucun horaire sur ce parcours'; return; }
  const now = C.landing.find((b) => C.time.min >= b.start && C.time.min < b.end);
  $('t-state').textContent = now ? `Arrive sur : ${now.title}` : '';
}
function updateTime() {
  if (!C.tree) return;
  applyTime(C.tree, timeW());
  // Appel suivi : le chemin dépend de l'heure (horaires) ; branche repliée → arbre refait.
  if (simActive()) {
    const R = computeSim(simW(), simMatch());
    if (R.expand.length) { draw(true); return; }
    C.simR = R;
  }
  C.canvas.refreshTime(simActive() ? C.simR : null);
  renderTime();
  renderFollow();
}

// ---------------------------------------------------------------------------
// Fiche (panneau de droite)
// ---------------------------------------------------------------------------
function closeDetail() { C.sel = null; $('detail').hidden = true; $('main').classList.add('no-detail'); C.canvas?.select(null, false); }
function showDetail(n) {
  if (!n) return closeDetail();
  C.sel = n.key;
  const info = n.leaf ? n.info : nodeInfo(n.key);
  const t = TYPES[info.type] || { label: info.type };
  $('d-name').textContent = info.title;
  const rows = facts(n.key, n.leaf).map(([l, v, h]) => `<dt${h ? ` title="${esc(h)}"` : ''}>${esc(l)}</dt><dd>${esc(v)}</dd>`).join('');
  const outs = (n.ports || []).filter((p) => p.to).map((p) => `<dt title="${esc(p.help || '')}">${esc(p.label)}</dt><dd>${esc(p.note || '')}</dd>`).join('');
  let refs = '';
  if (!n.leaf) {
    const from = reverseIndex().get(baseKey(n.key)) || [];
    refs = from.length
      ? `<ul class="list cf-refs">${from.map((r) => { const i = nodeInfo(r.from); return `<li data-key="${esc(r.from)}" title="Partir de cette carte"><div><div>${esc(`${TYPES[i.type]?.label || ''} ${i.title}`)}</div><div class="sub">${esc([r.label, r.note].filter(Boolean).join(' · '))}</div></div></li>`; }).join('')}</ul>`
      : '<p class="muted small">Aucun routage lu vers cet objet.</p>';
  }
  $('d-body').innerHTML = `
    <div class="titlerow"><h3 class="cf-dtype">${esc(t.label)}</h3>${helpButton('d-hb', `Aide : ${t.label}`)}</div>${helpBox('d-hb', t.help || '')}
    ${rows ? `<div class="dsec"><dl>${rows}</dl></div>` : ''}
    ${outs && C.dir === 'out' ? `<div class="dsec"><h4>Sorties</h4><dl>${outs}</dl></div>` : ''}
    ${n.leaf?.ownerType === 'group' ? `<div class="btnrow"><button id="d-keys" title="Lit les touches de fonction de chaque utilisateur du tenant (une lecture par utilisateur)">${M.keys ? 'Relire les touches de bascule' : 'Chercher les touches de bascule'}</button></div><div id="d-keys-st" class="muted small"></div>` : ''}
    ${C.edit && C.dir === 'out' && schedOwner(n.key) ? (() => {
      // Deux actions bien distinctes : QUEL horaire garde cet objet (association) / CE QUE contient l'horaire (heures).
      const own = schedOwner(n.key), ot = ownerTitle({ key: own }), has = (entity(own).obj.schedules || []).length;
      return `<div class="dsec"><h4>Horaire de ${esc(ot)}</h4><div class="btnrow"><button id="d-sched" title="Choisir quel horaire est vérifié avant ${esc(ot)} (ne change pas les heures de l'horaire ; brouillon)">${has ? 'Remplacer par un autre horaire…' : 'Associer un horaire…'}</button>${entity(n.key).owner ? `<button id="d-unsched" class="danger" title="${esc(ot)} n'aura plus d'horaire : ses appels passent toujours (brouillon ; touche Suppr)">Retirer l'horaire de ${esc(ot)}</button>` : ''}</div></div>`;
    })() : ''}
    ${C.edit && C.dir === 'out' && cfgOfNode(n) ? `<div class="btnrow"><button id="d-group" class="primary" title="Toutes les options de l'objet, en sections dépliables (brouillon)">${CFG_LABEL[cfgOfNode(n).k]}</button></div>` : ''}
    ${C.edit && n.key.startsWith('schedule:') ? (() => { const sc = entity(n.key).obj; const u = schedUsage(sc); return `<div class="btnrow"><button id="d-periods" class="primary" title="Change les heures d'ouverture, la destination si fermé et les fermetures exceptionnelles de l'horaire « ${esc(sc.name)} ». ${u > 1 ? `Il est utilisé par ${u} objets : tous sont concernés.` : 'Le changement vaut pour tout objet qui utilise cet horaire.'} (brouillon)">Modifier les heures de « ${esc(sc.name)} »…</button></div>${u > 1 ? `<p class="small muted">Horaire partagé par ${u} objets : modifier ses heures les concerne tous.</p>` : ''}`; })() : ''}
    ${C.edit && C.dir === 'out' && !entity(n.key).owner && incomingPort(n) ? `<div class="btnrow"><button id="d-replace" title="Choisir une autre destination pour la sortie « ${esc(incomingPort(n).p.label)} » de ${esc(ownerTitle(incomingPort(n).n))} (brouillon)">Remplacer…</button><button id="d-remove" class="danger" title="Vide la sortie « ${esc(incomingPort(n).p.label)} » de ${esc(ownerTitle(incomingPort(n).n))} (brouillon ; touche Suppr)">Retirer de cette sortie</button></div>` : ''}
    ${n.leaf ? '' : `<div class="dsec"><h4>Arrive depuis</h4>${refs}</div>`}
    ${n.leaf ? '' : `<div class="btnrow">${baseKey(n.key) !== C.root ? '<button id="d-root" class="primary">Partir de cette carte</button>' : ''}<button id="d-in">${C.dir === 'in' && n.key === C.root ? 'Où vont les appels' : 'Qui arrive ici'}</button></div>`}`;
  $('detail').hidden = false;
  $('main').classList.remove('no-detail');
  const r = $('d-root'); if (r) r.onclick = () => setRoot(n.key);
  const rm = $('d-remove'); if (rm) rm.onclick = removeSelected;
  const rp = $('d-replace'); if (rp) rp.onclick = () => { const r = incomingPort(n); if (r) openDest({ nodeKey: r.n.key, portId: n.port }); };
  const ds = $('d-sched'); if (ds) ds.onclick = () => openSchedule(schedOwner(n.key));
  const du = $('d-unsched'); if (du) du.onclick = removeSelected;
  const dp = $('d-periods'); if (dp) dp.onclick = () => openPeriods(entity(n.key).id);
  const dg = $('d-group'); if (dg) dg.onclick = () => openCfg(cfgOfNode(n));
  const i = $('d-in'); if (i) i.onclick = () => { if (baseKey(n.key) !== C.root) setRoot(n.key); setDir(C.dir === 'in' && baseKey(n.key) === C.root ? 'out' : 'in'); };
  for (const li of $('d-body').querySelectorAll('.cf-refs li')) li.onclick = () => setRoot(li.dataset.key);
  const k = $('d-keys');
  if (k) k.onclick = async () => {
    k.disabled = true;
    await scanGroupKeys((d, t) => { $('d-keys-st').textContent = `Lecture des touches : ${d} / ${t} utilisateurs…`; });
    draw(true);
    const again = C.tree.nodes.get(n.key);
    if (again) { C.canvas.select(n.key, false); showDetail(again); }
  };
}

// ---------------------------------------------------------------------------
// Mode Modifier : palette, brouillon, aperçu, écriture. Lot 2a : destinations ;
// lot 2b : sorties des horaires (fermé, fermetures exceptionnelles) et
// association d'un horaire à un objet. Pas modifiables : renvois d'appel
// (numéros libres), membres.
// ---------------------------------------------------------------------------
const PALETTE = [
  ['user', 'Utilisateur'], ['group', 'Groupe'], ['queue', 'File d\'attente'], ['ivr', 'SVI'], ['voicemail', 'Messagerie'],
  ['switchboard', 'Standard'], ['conference', 'Conférence'], ['extension', 'Numéro'], ['sound', 'Fichier son'], ['hangup', 'Raccrocher'],
  ['schedule', 'Horaire'],
];
const PAL_HELP = {
  extension: 'Numéro composé dans un contexte (interne, autre site…). Si le numéro correspond à un objet Wazo, le graphe le montre à sa place.',
  sound: 'Joue un fichier son du serveur puis raccroche. Nom du fichier tel que Wazo le stocke (ex. un son importé dans « Sons »).',
  hangup: 'Termine l\'appel avec la tonalité choisie.',
  schedule: 'À déposer sur une CARTE (SDA, utilisateur, groupe, file d\'attente), pas sur une sortie : associe un horaire à cet objet. Un seul horaire par objet.',
};
// Carte grisée : aucun objet de ce type dans le tenant (la poser propose de le créer).
const paletteEmpty = (t) => (ENTITY_DEST[t] || t === 'schedule') && !listOf(t).length;
function renderPalette() {
  $('cf-palette').innerHTML = PALETTE.map(([t, l]) => {
    const empty = paletteEmpty(t);
    const tip = empty ? (CREATABLE.has(t) ? `Aucun objet de ce type : posez la carte pour en créer un. ${PAL_HELP[t] || TYPES[t]?.help || ''}` : 'Aucun utilisateur : créez-le d\'abord dans User Manager ou le portail.') : PAL_HELP[t] || TYPES[t]?.help || '';
    return `<div class="cf-chip t-${t}${empty ? ' empty' : ''}" data-pal="${t}" title="${esc(tip)}"><span class="cf-badge">${esc(TYPES[t]?.badge || '?')}</span>${esc(l)}</div>`;
  }).join('');
  $('pal-help').innerHTML = helpButton('pal-hb', 'Comment modifier');
  $('pal-help-box').innerHTML = helpBox('pal-hb', 'Glissez une carte de la palette, ou une carte déjà présente dans le graphe, sur une sortie (Pas de réponse, Touche 1, Destination…) : un dialogue demande l\'objet visé et ses options, puis la modification part dans le brouillon (point orange). × sur une sortie la vide ; ↶ annule une modification (retour à la valeur d\'origine) ; la liste du brouillon (clic sur le compteur) permet aussi d\'annuler ligne par ligne ; une carte sélectionnée se retire de sa sortie par « Retirer de cette sortie » ou la touche Suppr. Rien n\'est écrit avant « Appliquer… », qui montre l\'avant / après, télécharge une sauvegarde JSON, relit chaque objet sur le serveur et n\'écrit que ce qui change, une fois par objet. Horaires : leurs sorties Fermé et Fermetures exceptionnelles se modifient comme les autres ; la carte « Horaire » de la palette se dépose sur une carte (SDA, utilisateur, groupe, file d\'attente) pour lui associer un horaire ; sur une carte horaire sélectionnée, « Retirer l\'horaire » ou Suppr le retire de son objet. Carte grisée : aucun objet de ce type ; la poser ouvre un panneau de création (l\'objet est créé tout de suite dans Wazo, puis branché par le brouillon). Toute carte sélectionnée a un bouton « Régler … » pour toutes ses options.');
}
function setEdit(on) {
  if (!on && C.draft.size) {
    confirmModal(`<h3>Quitter le mode Modifier ?</h3><p>${C.draft.size} modification${C.draft.size > 1 ? 's' : ''} du brouillon ser${C.draft.size > 1 ? 'ont' : 'a'} abandonnée${C.draft.size > 1 ? 's' : ''}.</p>`, () => { cancelDraft(); setEdit(false); }, 'Abandonner');
    return;
  }
  C.edit = on;
  if (on && C.dir !== 'out') { setDir('out'); }
  $('cf-edit-bar').hidden = !on;
  $('pal-help-box').hidden = !on;
  $('cf-edit').textContent = on ? 'Quitter le mode édition' : 'Mode édition';
  $('cf-edit').classList.toggle('primary', !on);
  if (on) renderPalette();
  draw(true);
}
function renderDraft() {
  const n = C.draft.size;
  $('cf-draft-n').textContent = n ? `${n} modification${n > 1 ? 's' : ''} dans le brouillon — voir / annuler` : 'Aucune modification';
  $('cf-draft-n').classList.toggle('cf-link', !!n);
  $('cf-draft-cancel').disabled = !n;
  $('cf-draft-apply').disabled = !n;
  const sel = C.sel && C.tree?.nodes.get(C.sel); if (sel) showDetail(sel); // fiche à jour du brouillon
}
// Sortie visée (nœud + port) → objet du port, s'il est modifiable.
function portOf(t) {
  const n = C.tree?.nodes.get(t.nodeKey); const p = n?.ports?.find((x) => x.id === t.portId);
  return p?.w ? { n, p } : null;
}
// Objet modifié (brouillon, aperçu) : pour une sortie d'horaire, l'horaire lui-même (il peut être partagé).
const whereOf = (n, p) => (p.w.k === 'sched' || p.w.k === 'sched_exc' ? `Horaire ${M.by.schedule?.get(String(p.w.id))?.name || p.w.id}` : ownerTitle(n));
const ownerTitle = (n) => { const k = entity(n.key).owner || n.key; const i = nodeInfo(k); return `${TYPES[i.type]?.label || ''} ${i.title}`.trim(); };
function addDraft(w, dest, meta) {
  const cur = C.draft.get(w.key);
  const before = cur ? cur.before : JSON.parse(JSON.stringify(getDest(w)));
  setDest(w, dest);
  if (sameValue(w, before, dest)) C.draft.delete(w.key); else C.draft.set(w.key, { w, before, after: dest, ...meta });
  M.rev = null; // index inverse à refaire
  draw(true); renderDraft();
}
function cancelDraft() {
  for (const e of [...C.draft.values()].reverse()) setDest(e.w, e.before);
  C.draft.clear(); M.rev = null;
  draw(true); renderDraft();
}
// Annuler UNE modification : la sortie reprend la valeur lue sur le serveur.
function revertKey(wkey) {
  const e = C.draft.get(wkey); if (!e) return;
  setDest(e.w, e.before);
  C.draft.delete(wkey); M.rev = null;
  draw(true); renderDraft();
}
// Liste du brouillon (clic sur le compteur) : une ligne par modification, ↶ pour l'annuler.
function showDraftList() {
  if (!C.draft.size) return;
  const html = () => `<h3>Brouillon</h3><p class="small muted">Rien n'est encore écrit. ↶ annule une modification : la sortie reprend sa valeur d'origine.</p>
    <div class="cf-diffwrap"><table class="diff"><thead><tr><th>Objet</th><th>Sortie</th><th>Avant</th><th>Après</th><th></th></tr></thead><tbody>${[...C.draft.entries()].map(([k, e]) => `<tr><td>${esc(e.where)}</td><td>${esc(e.slot)}</td><td>${esc(valLabel(e.w, e.before))}</td><td><strong>${esc(valLabel(e.w, e.after))}</strong></td><td><button class="icon cf-undo" data-revert="${esc(k)}" title="Annuler cette modification">↶</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Brouillon vide.</td></tr>'}</tbody></table></div>`;
  confirmModal(html(), () => true, 'Fermer');
  $('modal-body').onclick = (ev) => { const b = ev.target.closest('[data-revert]'); if (!b) return; revertKey(b.dataset.revert); $('modal-body').innerHTML = html(); };
}
// Carte sélectionnée en mode Modifier : la retirer de la sortie qui y mène (= vider cette sortie).
function incomingPort(n) {
  const parent = n?.parent && C.tree.nodes.get(n.parent);
  const p = parent?.ports?.find((x) => x.id === n.port);
  return p?.w ? { n: parent, p } : null;
}
// ---- Lot 2b : associer / retirer un horaire (un seul par objet, vérifié dans confd) ----
const SCHED_TYPES = new Set(['incall', 'user', 'group', 'queue']);
// Objet auquel un horaire peut être associé, depuis une carte (une carte horaire « condition » → son objet).
function schedOwner(k) {
  k = baseKey(k);
  const e = entity(k); const o = e.owner || k; const t = o.slice(0, o.indexOf(':'));
  return SCHED_TYPES.has(t) && entity(o).obj ? o : null;
}
// Nombre d'objets qui utilisent un horaire (copie locale : brouillon compris).
const schedUsage = (s) => (s ? [...SCHED_TYPES].reduce((n, t) => n + (M.lists[t] || []).filter((o) => (o.schedules || []).some((x) => String(x.id) === String(s.id))).length, 0) : 0);
const assocW = (owner) => ({ k: 'sched_assoc', id: owner, f: 'schedule', key: `sched_assoc:${owner}:schedule` });
function openSchedule(owner) {
  const w = assocW(owner); const cur = getDest(w);
  const items = listOf('schedule');
  const title = (() => { const i = nodeInfo(owner); return `${TYPES[i.type]?.label || ''} ${i.title}`.trim(); })();
  confirmModal(`<div class="titlerow"><h3>Horaire de ${esc(title)}</h3>${helpButton('ds-hb', 'Aide')}</div>${helpBox('ds-hb', 'L\'horaire est vérifié avant l\'objet : ouvert → l\'appel continue vers lui ; fermé → destination de fermeture de l\'horaire ; fermeture exceptionnelle → sa destination. Wazo n\'accepte qu\'un horaire par objet : en changer retire l\'ancien puis associe le nouveau (deux écritures). Rien n\'est écrit avant « Appliquer… ».')}
    <p class="muted small">Actuellement : ${esc(destLabel(cur))}</p>
    <label>Horaire <select id="ds-obj" size="8" class="cf-dd-list"><option value="">— Aucun horaire —</option>${items.map((x) => { const id = x.key.slice(9); return `<option value="${esc(id)}"${cur && String(cur.schedule_id) === id ? ' selected' : ''}>${esc(x.title)}${x.sub ? ` — ${esc(x.sub)}` : ''}</option>`; }).join('')}</select></label>`, () => {
    const v = $('ds-obj').value;
    addDraft(w, v ? { type: 'schedule', schedule_id: Number(v) } : null, { where: title, slot: 'Horaire' });
    return true;
  }, 'Ajouter au brouillon');
  $('ds-obj').ondblclick = () => $('modal-ok').click();
}
function removeSelected() {
  const n = C.sel && C.tree?.nodes.get(C.sel);
  // Carte horaire « condition » sélectionnée : Suppr retire l'horaire de son objet.
  const own = n && entity(n.key).owner;
  if (own) { addDraft(assocW(own), null, { where: ownerTitle(n), slot: 'Horaire' }); closeDetail(); return; }
  const r = incomingPort(n);
  if (!r) { toast('Cette carte n\'est pas reliée par une sortie modifiable.'); return; }
  addDraft(r.p.w, null, { where: whereOf(r.n, r.p), slot: r.p.label });
  closeDetail();
}
function clearPort(nodeKey, portId) {
  const r = portOf({ nodeKey, portId }); if (!r) return;
  addDraft(r.p.w, null, { where: whereOf(r.n, r.p), slot: r.p.label });
}
function cardDrop(cardKey, t) {
  const e = entity(cardKey); const k = e.owner || cardKey; const type = k.slice(0, k.indexOf(':'));
  if (!ENTITY_DEST[type]) { toast('Cette carte ne peut pas être une destination.'); return; }
  openDest(t, { type, id: entity(k).id });
}
// Dialogue de destination (dest-editor.js, norme d'édition) : depuis une carte
// déposée (type, voire objet, déjà choisis) ou un clic sur la sortie.
function openDest(t, preset = {}) {
  const r = portOf(t); if (!r) return;
  const { n, p } = r;
  if ((p.w.k === 'ivr' || p.w.k === 'ivr_choice') && C.draft.has(`ivr_cfg:${p.w.id}:cfg`)) { toast('Ce SVI a un réglage complet dans le brouillon : modifiez-le par « Régler le SVI… », ou appliquez d\'abord.', 7000); return; }
  const sched = p.periods ? M.by.schedule?.get(String(p.periods)) : null;
  openDestEditor({ title: p.label, owner: whereOf(n, p), cur: getDest(p.w), type: preset.type, id: preset.id, help: p.help, creatable: CREATABLE, onCreate: (type) => createFor(type, t),
    periods: sched ? { name: sched.name, shared: schedUsage(sched), open: () => openPeriods(sched.id) } : null },
  (d) => addDraft(p.w, d, { where: whereOf(n, p), slot: p.label }));
}
// Libellé d'une valeur du brouillon (destination, horaire associé, plages).
function valLabel(w, v) {
  if (w.k === 'group_cfg') {
    // Résumé comparable avant / après d'un réglage de groupe.
    const f = v?.fields || {};
    return [`« ${f.label || '?'} »`, f.enabled === false ? 'DÉSACTIVÉ' : '', STRATEGY[f.ring_strategy] || f.ring_strategy, f.timeout ? `${f.timeout} s au total` : 'sans limite', `${f.user_timeout ?? '?'} s / membre`, `pause ${f.retry_delay ?? 0} s`,
      `${(v?.users || []).length + (v?.exts || []).length} membre(s) : ${[...(v?.users || []).map((m) => fullName(M.userByUuid.get(m.uuid)) || m.uuid), ...(v?.exts || []).map((m) => m.exten)].join(', ') || 'aucun'}`,
      v?.extension ? `n° ${v.extension.exten}` : 'sans numéro', f.max_calls ? `max ${f.max_calls} appels` : '', f.music_on_hold ? `musique ${f.music_on_hold}` : 'sonnerie',
      (v?.perms || []).length ? `${v.perms.length} autorisation(s)` : ''].filter(Boolean).join(' · ');
  }
  if (w.k === 'queue_cfg') {
    const f = v?.fields || {}, o = v?.opts || {};
    return [f.label ? `« ${f.label} »` : '', f.enabled === false ? 'DÉSACTIVÉE' : '', QSTRAT[o.strategy || 'ringall'] || o.strategy, f.timeout ? `${f.timeout} s au total` : 'sans limite', `${o.timeout || 15} s / agent`, `pause ${o.retry || 5} s`,
      `${(v?.agents || []).length} agent(s)${(v?.agents || []).length ? ` : ${(v.agents).map((a) => agentName(M.by.agent?.get(String(a.id))) || `#${a.id}`).join(', ')}` : ''}`,
      `${(v?.users || []).length} utilisateur(s)${(v?.users || []).length ? ` : ${v.users.map((m) => fullName(M.userByUuid.get(m.uuid)) || m.uuid).join(', ')}` : ''}`,
      v?.extension ? `n° ${v.extension.exten}` : 'sans numéro', `${Object.keys(o).length} option(s) Asterisk`].filter(Boolean).join(' · ');
  }
  if (w.k === 'outcall_cfg') {
    const f = v?.fields || {};
    const tr = (p) => [p.strip_digits ? `retire ${p.strip_digits}` : '', p.external_prefix ? `ajoute ${p.external_prefix}` : ''].filter(Boolean).join(', ');
    return [`« ${f.name || '?'} »`, f.enabled === false ? 'DÉSACTIVÉE' : '', `motifs : ${(v?.patterns || []).map((p) => `${p.exten}${tr(p) ? ` (${tr(p)})` : ''}`).join(', ') || 'aucun'}`,
      `trunks : ${(v?.trunks || []).map((id) => nodeInfo(`trunk:${id}`).title).join(' puis ') || 'aucun'}`].filter(Boolean).join(' · ');
  }
  if (w.k === 'sb_cfg') {
    const f = v?.fields || {};
    return [`« ${f.name || '?'} »`, f.timeout ? `${f.timeout} s avant débordement` : 'sans limite', `${(v?.users || []).length} opérateur(s)${(v?.users || []).length ? ` : ${v.users.map((m) => fullName(M.userByUuid.get(m.uuid)) || m.uuid).join(', ')}` : ''}`,
      f.queue_music_on_hold ? `musique ${f.queue_music_on_hold}` : ''].filter(Boolean).join(' · ');
  }
  if (w.k === 'ivr_cfg') {
    const f = v?.fields || {};
    return [`« ${f.name || '?'} »`, `${f.timeout ?? '?'} s`, `${f.max_tries ?? '?'} essais`, `touches : ${(v?.choices || []).map((c) => `${c.exten} → ${destLabel(c.destination)}`).join(' ; ') || 'aucune'}`,
      `sans saisie : ${destLabel(v?.timeout_destination)}`, `invalide : ${destLabel(v?.invalid_destination)}`, `trop d'essais : ${destLabel(v?.abort_destination)}`].join(' · ');
  }
  if (w.k === 'user_cfg') {
    const FWL = { unconditional: 'immédiat', busy: 'si occupé', noanswer: 'si pas de réponse' };
    const fw = Object.entries(v?.forwards || {}).filter(([, x]) => x.enabled).map(([k, x]) => `renvoi ${FWL[k]} → ${x.destination}`);
    return [`sonne ${v?.fields?.ring_seconds ?? '?'} s`, `${v?.fields?.simultaneous_calls ?? '?'} appel(s) simultané(s)`, v?.dnd ? 'NPD' : '', v?.incallfilter ? 'filtrage' : '', ...fw].filter(Boolean).join(' · ');
  }
  // Réglages simples (obj-editors.js) : liste des champs renseignés.
  // Codes jamais affichés (SECRET_KEYS) : « *** ».
  if (/^(incall|vm|conf|schedgen)_cfg$/.test(w.k)) {
    const FL = { name: 'nom', number: 'n°', context: 'contexte', email: 'e-mail', description: 'description', timezone: 'fuseau', enabled: 'activé', password: 'code', pin: 'code participant', admin_pin: 'code animateur',
      language: 'langue', max_messages: 'messages max.', attach_audio: 'pièce jointe', delete_messages: 'suppression après envoi', ask_password: 'demande du code', pager: 'pager', max_users: 'participants max.', record: 'enregistrée',
      music_on_hold: 'musique', preprocess_subroutine: 'sous-routine', caller_id_mode: 'nom affiché', caller_id_name: 'texte', greeting_sound: 'accueil', quiet_join_leave: 'arrivées silencieuses', announce_join_leave: 'annonce des arrivées', announce_user_count: 'nombre annoncé', announce_only_user: '« vous êtes seul »' };
    return Object.entries(redact(v?.fields || {})).filter(([, x]) => x !== null && x !== '' && x !== false).map(([k, x]) => (x === true ? FL[k] || k : `${FL[k] || k} ${x}`)).join(' · ') || '—';
  }
  if (w.k !== 'sched_periods') return destLabel(v);
  const o = (v?.open_periods || []).map(periodText).join(' ; ') || 'aucune plage (toujours fermé)';
  // Jours de fermeture exceptionnelle (une période par mois : on compte les jours).
  const x = (v?.exceptional_periods || []).reduce((n, p) => n + ((p.month_days || []).length && (p.months || []).length ? p.month_days.length * p.months.length : 1), 0);
  return `Ouvert ${o} · si fermé : ${destLabel(v?.closed_destination)}${x ? ` · ${x} jour${x > 1 ? 's' : ''} de fermeture exceptionnelle` : ''}`;
}
// Clic sur ✎ (mode Modifier) : changer la destination et/ou les plages de l'horaire.
// Réglage complet d'un groupe (group-editor.js) : réglages + membres + numéro +
// autorisations dans une entrée « group_cfg » ; débordements et horaire dans
// leurs entrées habituelles (group_fb, sched_assoc), pour ne jamais écrire deux
// fois la même chose.
function openGroupFor(uuid) {
  const g = M.groupByUuid?.get(uuid); if (!g) return;
  openGroupEditor(g, (r) => {
    const where = `Groupe ${g.label || g.name}`;
    addDraft({ k: 'group_cfg', id: uuid, f: 'cfg', key: `group_cfg:${uuid}:cfg` }, r.cfg, { where, slot: 'Réglages du groupe' });
    for (const [f, d] of [['noanswer', r.noanswer], ['congestion', r.congestion]]) addDraft({ k: 'group_fb', id: uuid, f, key: `group_fb:${uuid}:${f}` }, d, { where, slot: f === 'noanswer' ? 'Pas de réponse' : 'Encombré' });
    addDraft(assocW(`group:${g.id}`), r.schedule ? { type: 'schedule', schedule_id: r.schedule } : null, { where, slot: 'Horaire' });
  });
}
// Réglage complet d'une file (queue-editor.js) : réglages + options Asterisk +
// membres + numéro dans « queue_cfg » ; débordements (queue_fb), seuils
// d'attente (queue) et horaire (sched_assoc) dans leurs entrées habituelles.
function openQueueFor(id) {
  const q = M.by.queue?.get(String(id)); if (!q) return;
  openQueueEditor(q, (r) => {
    const where = `File d'attente ${q.label || q.name}`;
    addDraft({ k: 'queue_cfg', id: q.id, f: 'cfg', key: `queue_cfg:${q.id}:cfg` }, r.cfg, { where, slot: 'Réglages de la file' });
    for (const f of ['noanswer', 'busy', 'congestion', 'fail']) addDraft({ k: 'queue_fb', id: q.id, f, key: `queue_fb:${q.id}:${f}` }, r.fb[f], { where, slot: { noanswer: 'Pas de réponse', busy: 'Occupé', congestion: 'Encombré', fail: 'Échec' }[f] });
    addDraft({ k: 'queue', id: q.id, f: 'wait_time_destination', key: `queue:${q.id}:wait_time_destination` }, r.wait.time, { where, slot: 'Attente trop longue' });
    addDraft({ k: 'queue', id: q.id, f: 'wait_ratio_destination', key: `queue:${q.id}:wait_ratio_destination` }, r.wait.ratio, { where, slot: 'Trop d\'appelants' });
    addDraft(assocW(`queue:${q.id}`), r.schedule ? { type: 'schedule', schedule_id: r.schedule } : null, { where, slot: 'Horaire' });
  });
}
// Réglage complet d'un SVI (ivr-editor.js) : une entrée « ivr_cfg » (un PUT).
// Pas de mélange avec les sorties du même SVI modifiées une à une dans le brouillon.
function openIvrFor(id) {
  const o = M.by.ivr?.get(String(id)); if (!o) return;
  if ([...C.draft.keys()].some((k) => k.startsWith(`ivr:${id}:`) || k.startsWith(`ivr_choice:${id}:`))) { toast('Appliquez ou annulez d\'abord les sorties de ce SVI modifiées dans le brouillon, puis rouvrez son réglage.', 7000); return; }
  openIvrEditor(o, (cfg) => addDraft({ k: 'ivr_cfg', id: o.id, f: 'cfg', key: `ivr_cfg:${o.id}:cfg` }, cfg, { where: `SVI ${o.name}`, slot: 'Réglages du SVI' }));
}
// Réglage d'un standard (sb-editor.js) : « sb_cfg » + débordement (sb_fb).
function openSbFor(uuid) {
  const s = M.by.switchboard?.get(String(uuid)); if (!s) return;
  openSbEditor(s, (r) => {
    const where = `Standard ${s.name}`;
    addDraft({ k: 'sb_cfg', id: s.uuid, f: 'cfg', key: `sb_cfg:${s.uuid}:cfg` }, r.cfg, { where, slot: 'Réglages du standard' });
    addDraft({ k: 'sb_fb', id: s.uuid, f: 'noanswer', key: `sb_fb:${s.uuid}:noanswer` }, r.noanswer, { where, slot: 'Pas de réponse' });
  });
}
// Autres cartes (obj-editors.js) : une entrée « <type>_cfg » chacune.
function openSimpleFor(k, id) {
  const e = entity(`${k}:${id}`); const o = e.obj; if (!o) return;
  const title = nodeInfo(`${k}:${id}`).title;
  const add = (wk, slot) => (v) => addDraft({ k: wk, id, f: 'cfg', key: `${wk}:${id}:cfg` }, v, { where: `${TYPES[k]?.label || k} ${title}`, slot });
  if (k === 'incall') openIncallEditor(o, title, add('incall_cfg', 'Réglages de la SDA'));
  if (k === 'voicemail') openVmEditor(o, add('vm_cfg', 'Réglages de la messagerie'));
  if (k === 'conference') openConfEditor(o, add('conf_cfg', 'Réglages de la conférence'));
  if (k === 'schedule') openSchedGenEditor(o, schedUsage(o), add('schedgen_cfg', 'Nom, fuseau, activation'), () => openPeriods(o.id));
}
// Règle sortante (outcall-editor.js) : « outcall_cfg » + horaire (sched_assoc).
function openOutcallFor(id) {
  const o = M.by.outcall?.get(String(id)); if (!o) return;
  openOutcallEditor(o, (r) => {
    const where = `Règle sortante ${o.name}`;
    addDraft({ k: 'outcall_cfg', id: o.id, f: 'cfg', key: `outcall_cfg:${o.id}:cfg` }, r.cfg, { where, slot: 'Réglages, motifs, trunks' });
    addDraft(assocW(`outcall:${o.id}`), r.schedule ? { type: 'schedule', schedule_id: r.schedule } : null, { where, slot: 'Horaire' });
  });
}
function openUserFor(uuid) {
  const u = M.userByUuid?.get(uuid); if (!u) return;
  openUserEditor(u, (v) => addDraft({ k: 'user_cfg', id: uuid, f: 'cfg', key: `user_cfg:${uuid}:cfg` }, v, { where: `Utilisateur ${fullName(u)}`, slot: 'Sonnerie, services, renvois' }));
}
const CFG_LABEL = { group: 'Régler le groupe…', queue: 'Régler la file d\'attente…', ivr: 'Régler le SVI…', switchboard: 'Régler le standard…', incall: 'Régler la SDA…', user: 'Régler l\'utilisateur…', voicemail: 'Régler la messagerie…', conference: 'Régler la conférence…', schedule: 'Régler l\'horaire…', outcall: 'Régler la règle sortante…' };
const CFG_DIFF = { group_cfg: groupCfgDiff, queue_cfg: queueCfgDiff, ivr_cfg: ivrCfgDiff, sb_cfg: sbCfgDiff, incall_cfg: incallCfgDiff, user_cfg: userCfgDiff, vm_cfg: vmCfgDiff, conf_cfg: confCfgDiff, schedgen_cfg: schedCfgDiff, outcall_cfg: outcallCfgDiff };
const openCfg = (c) => {
  if (!c) return;
  if (c.k === 'group') openGroupFor(c.id); else if (c.k === 'queue') openQueueFor(c.id); else if (c.k === 'ivr') openIvrFor(c.id); else if (c.k === 'switchboard') openSbFor(c.id);
  else if (c.k === 'user') openUserFor(c.id); else if (c.k === 'outcall') openOutcallFor(c.id); else openSimpleFor(c.k, c.id);
};
// Objet réglable concerné par une carte : le groupe / la file / le SVI, leur
// carte « membres » ou une mini-carte membre.
const cfgOfNode = (n) => {
  if (!n) return null;
  const k = n.leaf ? null : baseKey(n.key);
  if (k?.startsWith('group:')) return { k: 'group', id: entity(k).obj?.uuid };
  if (k?.startsWith('queue:')) return { k: 'queue', id: entity(k).obj?.id };
  if (k?.startsWith('ivr:')) return { k: 'ivr', id: entity(k).obj?.id };
  if (k?.startsWith('switchboard:')) return { k: 'switchboard', id: entity(k).obj?.uuid };
  if (k?.startsWith('user:')) return { k: 'user', id: entity(k).obj?.uuid };
  if (k?.startsWith('outcall:')) return { k: 'outcall', id: entity(k).id };
  for (const t of ['incall', 'voicemail', 'conference', 'schedule']) if (k?.startsWith(`${t}:`) && entity(k).obj) return { k: t, id: entity(k).id };
  const lf = n.leaf;
  if (lf?.type === 'member') return { k: 'group', id: entity(lf.group).obj?.uuid };
  if (lf?.ownerType === 'group' && n.parent?.startsWith('group:')) return { k: 'group', id: entity(n.parent).obj?.uuid };
  if (lf?.ownerType === 'queue' && n.parent?.startsWith('queue:')) return { k: 'queue', id: entity(n.parent).obj?.id };
  return null;
};
function portClick(nodeKey, portId) {
  const n = C.tree?.nodes.get(nodeKey); const p = n?.ports?.find((x) => x.id === portId); if (!p) return;
  if (p.cfg) { openCfg(p.cfg); return; }
  if (p.w) { openDest({ nodeKey, portId }); return; }
  // Sortie d'horaire sans destination modifiable (« Ouvert ») : seulement les heures.
  const sched = p.periods ? M.by.schedule?.get(String(p.periods)) : null;
  if (sched) openDestEditor({ title: p.label, owner: ownerTitle(n), canDest: false, periods: { name: sched.name, shared: schedUsage(sched), open: () => openPeriods(sched.id) } }, () => {});
}// Éditeur d'horaire (sched-editor.js) : grille de la semaine à peindre, « si
// fermé », calendrier annuel des fermetures exceptionnelles + fériés fixes.
function openPeriods(schedId) {
  const s = M.by.schedule?.get(String(schedId)); if (!s) return;
  const w = { k: 'sched_periods', id: s.id, f: 'periods', key: `sched_periods:${s.id}:periods` };
  // Les destinations des fermetures sont repérées par leur rang : pas de mélange dans un même brouillon.
  if ([...C.draft.keys()].some((k) => k.startsWith(`sched_exc:${s.id}:`))) { toast('Appliquez ou annulez d\'abord les destinations des fermetures exceptionnelles de cet horaire (brouillon), puis rouvrez l\'horaire.', 7000); return; }
  openScheduleEditor(s, (val) => addDraft(w, val, { where: `Horaire ${s.name}`, slot: 'Plages, si fermé, fermetures' }));
}
// Palette : glisser une carte (pointeur) jusqu'à une sortie du canevas.
$('cf-palette').addEventListener('pointerdown', (e) => {
  const chip = e.target.closest('[data-pal]'); if (!chip || e.button !== 0) return;
  e.preventDefault();
  const ghost = chip.cloneNode(true); ghost.classList.add('cf-ghost'); document.body.appendChild(ghost);
  const move = (ev) => { ghost.style.left = `${ev.clientX + 10}px`; ghost.style.top = `${ev.clientY + 10}px`; C.canvas?.hover(ev.clientX, ev.clientY, chip.dataset.pal === 'schedule' ? (k) => !!schedOwner(k) : null); };
  const up = (ev) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    ghost.remove();
    // Horaire : se dépose sur une CARTE (SDA, utilisateur, groupe, file), pas sur une sortie.
    const type = chip.dataset.pal, empty = paletteEmpty(type);
    if (type === 'schedule') {
      const k = C.canvas?.cardAt(ev.clientX, ev.clientY); C.canvas?.hover(null);
      const owner = k && schedOwner(k);
      if (!owner) { toast('Lâchez l\'horaire sur une carte SDA, utilisateur, groupe ou file d\'attente.'); return; }
      // Aucun horaire : création, puis association (brouillon).
      if (empty) openCreate('schedule', (id) => addDraft(assocW(owner), { type: 'schedule', schedule_id: Number(id) }, { where: ownerTitle({ key: owner }), slot: 'Horaire' }), reloadKeepDraft);
      else openSchedule(owner);
      return;
    }
    const t = C.canvas?.portAt(ev.clientX, ev.clientY); C.canvas?.hover(null);
    if (!t) { toast('Lâchez la carte sur une sortie modifiable (ligne d\'une carte du graphe).'); return; }
    if (empty && !CREATABLE.has(type)) { toast('Aucun utilisateur : créez-le d\'abord dans User Manager ou le portail.', 6000); return; }
    if (empty) createFor(type, t); else openDest(t, { type });
  };
  move(e);
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
// Création (create.js) : relecture du serveur sans perdre le brouillon (ses
// valeurs sont réappliquées à la copie fraîche), puis branchement sur la sortie.
async function reloadKeepDraft() {
  try { await reload(); } catch (e) { loadFailed(e); return; }
  for (const e of C.draft.values()) setDest(e.w, e.after);
  M.rev = null; draw(true); if (C.edit) renderPalette();
}
function createFor(type, t) { openCreate(type, (id) => openDest(t, { type, id: String(id) }), reloadKeepDraft); }
// Appliquer : aperçu (relu sur le serveur), sauvegarde JSON, écriture, relecture.
async function applyDraft() {
  if (!C.draft.size || !canWrite()) return;
  const entries = [...C.draft.values()];
  let ops;
  try { ops = await prepare(entries.map((e) => ({ w: e.w, after: e.after }))); } catch (e) { toast(`Lecture avant écriture impossible : ${e.message}`, 8000); return; }
  const writes = ops.filter((o) => o.changed);
  const rows = entries.map((e) => `<tr><td>${esc(e.where)}</td><td>${esc(e.slot)}${CFG_DIFF[e.w.k] ? `<br><span class="small muted">Modifié : ${esc(CFG_DIFF[e.w.k](e.before, e.after) || '—')}</span>` : ''}</td><td>${esc(valLabel(e.w, e.before))}</td><td><strong>${esc(valLabel(e.w, e.after))}</strong></td></tr>`).join('');
  confirmModal(`<h3>Appliquer le brouillon</h3>
    <p class="small muted">${writes.length} écriture${writes.length > 1 ? 's' : ''} (une requête par partie modifiée)${ops.length > writes.length ? `, ${ops.length - writes.length} objet${ops.length - writes.length > 1 ? 's' : ''} déjà à jour sur le serveur` : ''}. Une sauvegarde JSON de l'état actuel est téléchargée avant d'écrire.</p>
    <div class="cf-diffwrap"><table class="diff"><thead><tr><th>Objet</th><th>Sortie</th><th>Avant</th><th>Après</th></tr></thead><tbody>${rows}</tbody></table></div>`, async () => {
    downloadJson(`astrea-callflow-sauvegarde-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
      // Format 2 (16/10/2026) : une ligne par écriture, avec méthode, état d'avant et
      // contenu envoyé — ce qu'il faut à « Restaurer… » (restore.js) pour la défaire.
      { outil: 'Call Flow Manager', format: 2, serveur: S.base, tenant: S.tenant, date: new Date().toISOString(), codes: 'masqués (***) : non restaurables depuis ce fichier',
        ecritures: redact(writes.map((o) => ({ method: o.method || 'PUT', path: o.path, before: o.before ?? null, body: o.body ?? null, ...(o.run ? { numero: true } : {}) }))) });
    const res = await execute(ops);
    const bad = res.filter((x) => !x.ok);
    console.info('[astrea] Call Flow : écriture', res);
    C.draft.clear(); renderDraft();
    try { await reload(); } catch (e) { loadFailed(e); }
    draw(true);
    setTimeout(() => {
      if (!bad.length) toast(`${res.filter((x) => x.ok && !x.skipped).length} objet${writes.length > 1 ? 's' : ''} mis à jour.`, 5000);
      else confirmModal(`<h3>Écriture partielle</h3><p>${bad.length} erreur${bad.length > 1 ? 's' : ''} ; le graphe a été relu depuis le serveur.</p><ul class="small">${bad.map((b) => `<li><code>${esc(b.path)}</code> : ${esc(b.error)}</li>`).join('')}</ul>`, () => true, 'Fermer');
    }, 0);
    return true;
  }, 'Appliquer');
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------
$('cf-edit').onclick = () => setEdit(!C.edit);
$('cf-draft-cancel').onclick = () => confirmModal(`<h3>Annuler le brouillon ?</h3><p>Les ${C.draft.size} modification${C.draft.size > 1 ? 's' : ''} non écrite${C.draft.size > 1 ? 's' : ''} sont abandonnée${C.draft.size > 1 ? 's' : ''}.</p>`, () => cancelDraft(), 'Annuler le brouillon');
$('cf-draft-apply').onclick = applyDraft;
// Restaurer : seulement brouillon vide (sinon la relecture effacerait le brouillon).
$('cf-restore').onclick = () => {
  if (!canWrite()) return;
  if (C.draft.size) { toast('Appliquez ou annulez d\'abord le brouillon, puis restaurez.', 6000); return; }
  openRestore(async () => { try { await reload(); } catch (e) { loadFailed(e); } draw(true); });
};
$('cf-draft-n').onclick = showDraftList;
// Suppr / Retour arrière sur une carte sélectionnée (mode Modifier, hors champ de saisie).
document.addEventListener('keydown', (e) => {
  if (!C.edit || !C.sel || !$('modal').hidden || e.target?.closest?.('input, select, textarea')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
});
window.addEventListener('beforeunload', (e) => { if (C.draft.size) { e.preventDefault(); e.returnValue = ''; } });
$('nav').onclick = (e) => {
  const b = e.target.closest('[data-type]'); if (!b) return;
  C.type = b.dataset.type; $('q').value = '';
  renderNav(); renderList();
};
$('list').onclick = (e) => { const li = e.target.closest('li[data-key]'); if (li) setRoot(li.dataset.key); };
$('q').oninput = renderList;
for (const b of document.querySelectorAll('[data-dir]')) b.onclick = () => setDir(b.dataset.dir);
$('cf-empty').onchange = () => { C.showEmpty = $('cf-empty').checked; draw(true); };
$('cf-in').onclick = () => C.canvas?.zoom(1.2);
$('cf-out').onclick = () => C.canvas?.zoom(1 / 1.2);
$('cf-fit').onclick = () => C.canvas?.fit(simKeys()); // appel suivi : cadre son chemin
$('cf-reset').onclick = () => C.canvas?.resetLayout();
const doReload = async () => { C.draft.clear(); renderDraft(); try { await reload(); draw(true); } catch (e) { loadFailed(e); } };
$('cf-reload').onclick = () => (C.draft.size
  ? confirmModal(`<h3>Recharger ?</h3><p>Le brouillon (${C.draft.size} modification${C.draft.size > 1 ? 's' : ''}) sera abandonné.</p>`, doReload, 'Recharger')
  : doReload());
$('d-close').onclick = closeDetail;
setNow();
$('t-min').oninput = () => { C.time.min = Number($('t-min').value); updateTime(); };
$('t-date').onchange = () => { const [y, m, d] = $('t-date').value.split('-').map(Number); if (y) { C.time.date = new Date(y, m - 1, d); updateTime(); } };
const shiftDay = (n) => { const d = C.time.date; C.time.date = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); updateTime(); };
$('t-prev').onclick = () => shiftDay(-1);
$('t-next').onclick = () => shiftDay(1);
$('t-now').onclick = () => { setNow(); updateTime(); };
$('t-on').onchange = () => { C.time.on = $('t-on').checked; updateTime(); };
// Suivre un appel : case, numéro (recalcul à la frappe), clic sur une étape de la trame → la carte.
$('s-on').onchange = () => { C.sim.on = $('s-on').checked; draw(true); if (C.sim.on && numKind()) $('s-num').focus(); };
$('s-num').oninput = () => { C.sim.num = $('s-num').value; draw(true); };
$('s-caller').oninput = () => { C.sim.caller = $('s-caller').value; draw(true); };
// Type d'appel : l'arbre change (vue normale ↔ appels passés).
const setSimMode = (m) => { C.sim.mode = m; C.collapsed.clear(); C.expanded.clear(); draw(); };
$('s-mode').onclick = (e) => { const b = e.target.closest('[data-sm]'); if (b && !b.disabled) setSimMode(b.dataset.sm); };
$('s-trame').onclick = (e) => { if (e.target.closest('[data-godial]')) { setSimMode('out'); return; } const u = e.target.closest('[data-num]'); if (u) { C.sim.num = u.dataset.num; draw(true); return; } const b = e.target.closest('[data-key]'); if (!b) return; const n = C.tree?.nodes.get(b.dataset.key); if (n) { C.canvas.select(n.key, false); C.canvas.focus(n.key); showDetail(n); } };
$('t-help').innerHTML = helpButton('t-hb', 'Simulation de la date et de l\'heure');
$('t-help-box').innerHTML = helpBox('t-hb', 'Choisissez un jour et une heure : les branches qui ne s\'appliquent pas à ce moment sont atténuées (ouvert → sorties normales de la SDA, de l\'utilisateur, du groupe… ; fermé → destination de fermeture ; fermeture exceptionnelle → sa destination, prioritaire). Règles lues dans le code de Wazo : fermetures exceptionnelles d\'abord, puis plages d\'ouverture, sinon fermé ; bornes horaires incluses à la minute (une plage 09:00–12:30 couvre 12:30). L\'heure est celle du site (fuseau de l\'horaire). Le bandeau montre la journée choisie : la ligne « Résultat » indique où arrive l\'appel une fois tous les horaires franchis (couleur de la carte d\'arrivée), puis une ligne par horaire du parcours (vert ouvert, gris fermé, rouge fermeture exceptionnelle). Survolez une tranche pour ses heures exactes.');
// Le canevas reprend sa taille avec la fenêtre (cadre du portail redimensionné).
window.addEventListener('resize', () => { clearTimeout(window.__cfR); window.__cfR = setTimeout(() => C.canvas?.fit(), 200); });

connect(boot);
