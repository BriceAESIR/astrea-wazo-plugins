// Call Flow Manager (Astrea Admin Tools) — vue graphique du parcours des
// appels : lecture (lot 1) et modification des destinations par glisser-
// déposer (lot 2a, brouillon puis aperçu, sauvegarde, écriture).
// Cadrage : astrea-wazo-dev/docs/CALLFLOW-MANAGER.md.
// Modèle (sources confd vérifiées) : model.js ; canevas : canvas.js ; écriture : write.js.
import { S, $, esc, toast, connect, setReadonly, showCompat, loaded, loadFailed, stackVersion, helpButton, helpBox, canWrite, confirmModal, downloadJson } from '../common/core.js?v=0.35.5';
import { M, TYPES, loadAll, ensureAllDetails, loadLiveMembers, scanGroupKeys, buildTree, reverseIndex, facts, listOf, nodeInfo, entity, applyTime, whenOf, dayBands, schedulesIn, landingSegments, destLabel, periodText } from './model.js?v=0.35.5';
import { createCanvas } from './canvas.js?v=0.35.5';
import { getDest, setDest, sameValue, prepare, execute } from './write.js?v=0.35.5';
import { openScheduleEditor, fillSoundSelect } from './sched-editor.js?v=0.35.5';

const TESTED_STACK = ['26.07'];
const NAV = [
  ['incall', 'SDA'], ['trunk', 'Trunks'], ['user', 'Utilisateurs'], ['group', 'Groupes'], ['queue', 'Files d\'attente'], ['ivr', 'SVI'],
  ['schedule', 'Horaires'], ['voicemail', 'Messageries'], ['conference', 'Conférences'], ['switchboard', 'Standards'], ['outcall', 'Règles sortantes'], ['context', 'Contextes'],
];
const C = { edit: false, draft: new Map(), time: { on: true, date: null, min: 0 }, type: 'incall', root: null, dir: 'out', collapsed: new Set(), expanded: new Set(), showEmpty: false, scope: null, canvas: null, tree: null, sel: null };

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
  await Promise.all([ensureAllDetails(), loadLiveMembers()]);
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
  // Mode Modifier : les sorties vides sont affichées (ce sont des cibles de dépôt).
  C.tree = buildTree(C.root, C.dir, { collapsed: C.collapsed, expanded: C.expanded, showEmpty: (C.showEmpty || C.edit) && C.dir === 'out' });
  const info = nodeInfo(C.root), t = TYPES[info.type] || {}; // objet choisi (le graphe peut commencer par son horaire)
  $('cf-title').textContent = `${t.label || ''} ${info.title}`;
  $('cf-sub').textContent = C.dir === 'out'
    ? `Où vont les appels · ${C.tree.nodes.size} carte${C.tree.nodes.size > 1 ? 's' : ''}${info.sub ? ` · ${info.sub}` : ''}`
    : `Qui envoie des appels ici · ${C.tree.nodes.size - 1} origine${C.tree.nodes.size > 2 ? 's' : ''}`;
  if (!$('cf-hb')) $('cf-help').innerHTML = helpButton('cf-hb', 'Comment lire ce graphe');
  if (!$('cf-hb')) $('cf-help-box').innerHTML = helpBox('cf-hb', C.dir === 'out'
    ? 'Chaque carte est un objet Wazo ; ses sorties (à droite) sont les cas où l\'appel la quitte : débordements, touches de SVI, horaire fermé… Un lien en pointillé rejoint une carte déjà affichée ailleurs (boucle ou objet partagé). Un lien gris clair est une simple association (messagerie de l\'utilisateur), pas un routage. Les durées affichées sont celles de Wazo (sonnerie, délai du groupe ou de la file).'
    : 'Les cartes de gauche envoient des appels vers la carte choisie ; la sortie concernée est indiquée sur chacune. Seuls les routages lus dans confd sont trouvés (renvois vers un numéro interne compris).');
  C.treeId = (C.treeId || 0) + 1; // bandeau à recalculer
  applyTime(C.tree, timeW());
  C.canvas.render(C.tree, C.dir, `${C.scope}|${C.root}|${C.dir}`, { keepView, edit: C.edit && C.dir === 'out', changed: new Set(C.draft.keys()) });
  renderTime();
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
  for (const b of document.querySelectorAll('[data-dir]')) b.classList.toggle('active', b.dataset.dir === d);
  $('cf-empty').disabled = d === 'in';
  $('cf-help-box').innerHTML = '';
  draw();
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
const timeW = () => (C.time.on && C.dir === 'out' ? whenOf(C.time.date, C.time.min) : null);
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
  const scheds = C.dir === 'out' ? schedulesIn(C.tree) : [];
  if (!scheds.length) { $('t-lanes').innerHTML = ''; C.landing = null; return; }
  C.landing = landingSegments(C.tree, d);
  const rows = [`<div class="cf-lane cf-result"><span class="cf-ln" title="Où arrive l'appel à chaque moment de la journée, une fois tous les horaires du parcours franchis">Résultat</span><div class="cf-lb">${C.landing.map((b) => seg(b, `r t-${b.type}`, b.title, b.title)).join('')}<b class="cf-cursor"></b></div></div>`];
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
  $('cf-time').classList.toggle('off', !C.time.on || C.dir !== 'out');
  renderLanes();
  for (const c of $('t-lanes').querySelectorAll('.cf-cursor')) c.style.left = `${((C.time.min + 0.5) / 1440) * 100}%`;
  if (C.dir !== 'out') { $('t-state').textContent = 'Simulation : sens « où vont les appels » seulement'; return; }
  if (!C.landing) { $('t-state').textContent = 'Aucun horaire sur ce parcours'; return; }
  const now = C.landing.find((b) => C.time.min >= b.start && C.time.min < b.end);
  $('t-state').textContent = now ? `Arrive sur : ${now.title}` : '';
}
function updateTime() {
  if (!C.tree) return;
  applyTime(C.tree, timeW());
  C.canvas.refreshTime();
  renderTime();
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
    const from = reverseIndex().get(n.key) || [];
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
    ${C.edit && n.key.startsWith('schedule:') ? (() => { const sc = entity(n.key).obj; const u = schedUsage(sc); return `<div class="btnrow"><button id="d-periods" class="primary" title="Change les heures d'ouverture, la destination si fermé et les fermetures exceptionnelles de l'horaire « ${esc(sc.name)} ». ${u > 1 ? `Il est utilisé par ${u} objets : tous sont concernés.` : 'Le changement vaut pour tout objet qui utilise cet horaire.'} (brouillon)">Modifier les heures de « ${esc(sc.name)} »…</button></div>${u > 1 ? `<p class="small muted">Horaire partagé par ${u} objets : modifier ses heures les concerne tous.</p>` : ''}`; })() : ''}
    ${C.edit && C.dir === 'out' && !entity(n.key).owner && incomingPort(n) ? `<div class="btnrow"><button id="d-remove" class="danger" title="Vide la sortie « ${esc(incomingPort(n).p.label)} » de ${esc(ownerTitle(incomingPort(n).n))} (brouillon ; touche Suppr)">Retirer de cette sortie</button></div>` : ''}
    ${n.leaf ? '' : `<div class="dsec"><h4>Arrive depuis</h4>${refs}</div>`}
    ${n.leaf ? '' : `<div class="btnrow">${n.key !== C.root ? '<button id="d-root" class="primary">Partir de cette carte</button>' : ''}<button id="d-in">${C.dir === 'in' && n.key === C.root ? 'Où vont les appels' : 'Qui arrive ici'}</button></div>`}`;
  $('detail').hidden = false;
  $('main').classList.remove('no-detail');
  const r = $('d-root'); if (r) r.onclick = () => setRoot(n.key);
  const rm = $('d-remove'); if (rm) rm.onclick = removeSelected;
  const ds = $('d-sched'); if (ds) ds.onclick = () => openSchedule(schedOwner(n.key));
  const du = $('d-unsched'); if (du) du.onclick = removeSelected;
  const dp = $('d-periods'); if (dp) dp.onclick = () => openPeriods(entity(n.key).id);
  const i = $('d-in'); if (i) i.onclick = () => { if (n.key !== C.root) setRoot(n.key); setDir(C.dir === 'in' && n.key === C.root ? 'out' : 'in'); };
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
const ENTITY_DEST = { user: 'user_id', group: 'group_id', queue: 'queue_id', ivr: 'ivr_id', voicemail: 'voicemail_id', conference: 'conference_id', switchboard: 'switchboard_uuid' };
const RINGS = new Set(['user', 'group', 'queue', 'switchboard']);
const PAL_HELP = {
  extension: 'Numéro composé dans un contexte (interne, autre site…). Si le numéro correspond à un objet Wazo, le graphe le montre à sa place.',
  sound: 'Joue un fichier son du serveur puis raccroche. Nom du fichier tel que Wazo le stocke (ex. un son importé dans « Sons »).',
  hangup: 'Termine l\'appel avec la tonalité choisie.',
  schedule: 'À déposer sur une CARTE (SDA, utilisateur, groupe, file d\'attente), pas sur une sortie : associe un horaire à cet objet. Un seul horaire par objet.',
};
function renderPalette() {
  $('cf-palette').innerHTML = PALETTE.map(([t, l]) => `<div class="cf-chip t-${t}" data-pal="${t}" title="${esc(PAL_HELP[t] || TYPES[t]?.help || '')}"><span class="cf-badge">${esc(TYPES[t]?.badge || '?')}</span>${esc(l)}</div>`).join('');
  $('pal-help').innerHTML = helpButton('pal-hb', 'Comment modifier');
  $('pal-help-box').innerHTML = helpBox('pal-hb', 'Glissez une carte de la palette, ou une carte déjà présente dans le graphe, sur une sortie (Pas de réponse, Touche 1, Destination…) : un dialogue demande l\'objet visé et ses options, puis la modification part dans le brouillon (point orange). × sur une sortie la vide ; ↶ annule une modification (retour à la valeur d\'origine) ; la liste du brouillon (clic sur le compteur) permet aussi d\'annuler ligne par ligne ; une carte sélectionnée se retire de sa sortie par « Retirer de cette sortie » ou la touche Suppr. Rien n\'est écrit avant « Appliquer… », qui montre l\'avant / après, télécharge une sauvegarde JSON, relit chaque objet sur le serveur et n\'écrit que ce qui change, une fois par objet. Horaires : leurs sorties Fermé et Fermetures exceptionnelles se modifient comme les autres ; la carte « Horaire » de la palette se dépose sur une carte (SDA, utilisateur, groupe, file d\'attente) pour lui associer un horaire ; sur une carte horaire sélectionnée, « Retirer l\'horaire » ou Suppr le retire de son objet. Pas encore modifiables : renvois d\'appel de l\'utilisateur, membres.');
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
// Dialogue : objet visé et options de la destination.
function openDest(t, preset) {
  const r = portOf(t); if (!r) return;
  const { n, p } = r; const type = preset.type;
  const cur = getDest(p.w);
  const same = cur?.type === type ? cur : null;
  const label = PALETTE.find(([x]) => x === type)?.[1] || type;
  let body = '';
  if (ENTITY_DEST[type]) {
    const items = listOf(type);
    const sel = preset.id ?? (same ? String(same[ENTITY_DEST[type]]) : '');
    body += `<label>Rechercher <input id="dd-q" placeholder="Nom, numéro…"></label>
      <select id="dd-obj" size="8" class="cf-dd-list">${items.map((x) => { const id = x.key.slice(x.key.indexOf(':') + 1); return `<option value="${esc(id)}"${id === String(sel) ? ' selected' : ''}>${esc(x.title)}${x.sub ? ` — ${esc(x.sub)}` : ''}</option>`; }).join('')}</select>`;
    if (RINGS.has(type)) body += `<label title="Durée pendant laquelle cette destination sonne quand elle est atteinte par cette sortie. Vide : durée réglée sur l'objet lui-même (supposé : ring_time de la destination prime sur celle de l'objet).">Durée de sonnerie (s) <input id="dd-ring" type="number" min="0" placeholder="par défaut" value="${esc(same?.ring_time ?? '')}"></label>`;
    if (type === 'voicemail') body += `<label>Message d'accueil <select id="dd-greet"><option value="">Par défaut</option><option value="unavailable"${same?.greeting === 'unavailable' ? ' selected' : ''}>Indisponible</option><option value="busy"${same?.greeting === 'busy' ? ' selected' : ''}>Occupé</option></select></label>
      <label class="inline"><input type="checkbox" id="dd-skip"${same?.skip_instructions ? ' checked' : ''}> Ne pas lire les instructions (bip direct)</label>`;
  } else if (type === 'extension') {
    const ctx = (M.lists.context || []).filter((c) => c.type !== 'incall');
    body += `<label>Numéro <input id="dd-exten" value="${esc(same?.exten || '')}" placeholder="ex. 1001"></label>
      <label>Contexte <select id="dd-ctx">${ctx.map((c) => `<option value="${esc(c.name)}"${same?.context === c.name ? ' selected' : ''}>${esc(c.label || c.name)} (${esc(c.type)})</option>`).join('')}</select></label>`;
  } else if (type === 'sound') {
    body += `<label>Fichier son <select id="dd-file"><option value="">Chargement des sons…</option></select></label>
      <label class="inline"><input type="checkbox" id="dd-skip"${same?.skip ? ' checked' : ''}> L'appelant peut l'interrompre</label>
      <label class="inline"><input type="checkbox" id="dd-noans"${same?.no_answer ? ' checked' : ''}> Sans décrocher (pré-décroché)</label>`;
  } else if (type === 'hangup') {
    body += `<label>Tonalité <select id="dd-cause"><option value="normal">Normale</option><option value="busy"${same?.cause === 'busy' ? ' selected' : ''}>Occupé</option><option value="congestion"${same?.cause === 'congestion' ? ' selected' : ''}>Encombré</option></select></label>`;
  }
  const help = `${p.help || ''} Actuellement : ${destLabel(cur)}. La modification va dans le brouillon ; rien n'est écrit avant « Appliquer… ».`;
  confirmModal(`<div class="titlerow"><h3>${esc(p.label)} → ${esc(label)}</h3>${helpButton('dd-hb', 'Aide')}</div>${helpBox('dd-hb', help)}
    <p class="muted small">${esc(ownerTitle(n))} · actuellement : ${esc(destLabel(cur))}</p>${body}<p id="dd-err" class="error small"></p>`, () => {
    const err = (m) => { $('dd-err').textContent = m; return false; };
    let d;
    if (ENTITY_DEST[type]) {
      const v = $('dd-obj').value; if (!v) return err('Choisissez un objet dans la liste.');
      d = { type, [ENTITY_DEST[type]]: type === 'switchboard' ? v : Number(v) };
      const ring = $('dd-ring')?.value; if (ring) d.ring_time = Number(ring);
      if (type === 'voicemail') { if ($('dd-greet').value) d.greeting = $('dd-greet').value; if ($('dd-skip').checked) d.skip_instructions = true; }
    } else if (type === 'extension') {
      const x = $('dd-exten').value.trim(); if (!/^[0-9*#]{1,255}$/.test(x)) return err('Numéro : chiffres, * et # seulement.');
      d = { type, exten: x, context: $('dd-ctx').value };
    } else if (type === 'sound') {
      const f = $('dd-file').value.trim(); if (!f) return err('Choisissez un fichier son.');
      d = { type, filename: f, skip: $('dd-skip').checked, no_answer: $('dd-noans').checked };
    } else if (type === 'hangup') d = { type, cause: $('dd-cause').value };
    addDraft(p.w, d, { where: whereOf(n, p), slot: p.label });
    return true;
  }, 'Ajouter au brouillon');
  if (type === 'sound') fillSoundSelect($('dd-file'), same?.filename);
  // Filtre de la liste (le dialogue est déjà dans le DOM).
  const q = $('dd-q'), list = $('dd-obj');
  if (q && list) {
    const all = [...list.options].map((o) => [o, o.textContent.toLowerCase()]);
    q.oninput = () => { const s = q.value.trim().toLowerCase(); for (const [o, txt] of all) o.hidden = !!s && !txt.includes(s); };
    list.ondblclick = () => $('modal-ok').click();
    (list.selectedOptions[0] || list).scrollIntoView?.({ block: 'nearest' });
    q.focus();
  }
}
// Libellé d'une valeur du brouillon (destination, horaire associé, plages).
function valLabel(w, v) {
  if (w.k !== 'sched_periods') return destLabel(v);
  const o = (v?.open_periods || []).map(periodText).join(' ; ') || 'aucune plage (toujours fermé)';
  // Jours de fermeture exceptionnelle (une période par mois : on compte les jours).
  const x = (v?.exceptional_periods || []).reduce((n, p) => n + ((p.month_days || []).length && (p.months || []).length ? p.month_days.length * p.months.length : 1), 0);
  return `Ouvert ${o} · si fermé : ${destLabel(v?.closed_destination)}${x ? ` · ${x} jour${x > 1 ? 's' : ''} de fermeture exceptionnelle` : ''}`;
}
// Clic sur ✎ (mode Modifier) : changer la destination et/ou les plages de l'horaire.
function portClick(nodeKey, portId) {
  const n = C.tree?.nodes.get(nodeKey); const p = n?.ports?.find((x) => x.id === portId); if (!p) return;
  const types = PALETTE.filter(([t]) => t !== 'schedule');
  const sched = p.periods ? M.by.schedule?.get(String(p.periods)) : null;
  confirmModal(`<h3>${esc(p.label)} — ${esc(p.w ? whereOf(n, p) : ownerTitle(n))}</h3>
    ${p.w ? `<p class="small muted">Actuellement : ${esc(destLabel(getDest(p.w)))}. Nouvelle destination :</p><div class="cf-palette cf-choose">${types.map(([t, l]) => `<button class="cf-chip t-${t}" data-choose="${t}"><span class="cf-badge">${esc(TYPES[t]?.badge || '?')}</span>${esc(l)}</button>`).join('')}</div>` : ''}
    ${sched ? `<p class="small muted">${p.w ? 'Ou bien les heures' : 'Heures'} de l'horaire « ${esc(sched.name)} » : heures d'ouverture, destination si fermé, fermetures exceptionnelles${schedUsage(sched) > 1 ? ` — horaire partagé par ${schedUsage(sched)} objets, tous concernés` : ''}.</p><div class="btnrow"><button id="ch-periods" class="primary">Modifier les heures de « ${esc(sched.name)} »…</button></div>` : ''}`, () => true, 'Fermer');
  $('modal-body').onclick = (ev) => {
    const b = ev.target.closest('[data-choose]');
    if (b) { openDest({ nodeKey, portId }, { type: b.dataset.choose }); return; }
    if (ev.target.closest('#ch-periods')) openPeriods(sched.id);
  };
}
// Éditeur d'horaire (sched-editor.js) : grille de la semaine à peindre, « si
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
    if (chip.dataset.pal === 'schedule') {
      const k = C.canvas?.cardAt(ev.clientX, ev.clientY); C.canvas?.hover(null);
      const owner = k && schedOwner(k);
      if (owner) openSchedule(owner); else toast('Lâchez l\'horaire sur une carte SDA, utilisateur, groupe ou file d\'attente.');
      return;
    }
    const t = C.canvas?.portAt(ev.clientX, ev.clientY); C.canvas?.hover(null);
    if (t) openDest(t, { type: chip.dataset.pal }); else toast('Lâchez la carte sur une sortie modifiable (ligne d\'une carte du graphe).');
  };
  move(e);
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
// Appliquer : aperçu (relu sur le serveur), sauvegarde JSON, écriture, relecture.
async function applyDraft() {
  if (!C.draft.size || !canWrite()) return;
  const entries = [...C.draft.values()];
  let ops;
  try { ops = await prepare(entries.map((e) => ({ w: e.w, after: e.after }))); } catch (e) { toast(`Lecture avant écriture impossible : ${e.message}`, 8000); return; }
  const writes = ops.filter((o) => o.changed);
  const rows = entries.map((e) => `<tr><td>${esc(e.where)}</td><td>${esc(e.slot)}</td><td>${esc(valLabel(e.w, e.before))}</td><td><strong>${esc(valLabel(e.w, e.after))}</strong></td></tr>`).join('');
  confirmModal(`<h3>Appliquer le brouillon</h3>
    <p class="small muted">${writes.length} écriture${writes.length > 1 ? 's' : ''} (une par objet)${ops.length > writes.length ? `, ${ops.length - writes.length} objet${ops.length - writes.length > 1 ? 's' : ''} déjà à jour sur le serveur` : ''}. Une sauvegarde JSON de l'état actuel est téléchargée avant d'écrire.</p>
    <div class="cf-diffwrap"><table class="diff"><thead><tr><th>Objet</th><th>Sortie</th><th>Avant</th><th>Après</th></tr></thead><tbody>${rows}</tbody></table></div>`, async () => {
    downloadJson(`astrea-callflow-sauvegarde-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
      { outil: 'Call Flow Manager', serveur: S.base, tenant: S.tenant, date: new Date().toISOString(), avant: ops.map((o) => ({ path: o.path, before: o.before })), envoye: writes.map((o) => ({ path: o.path, body: o.body })) });
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
$('cf-fit').onclick = () => C.canvas?.fit();
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
$('t-help').innerHTML = helpButton('t-hb', 'Simulation de la date et de l\'heure');
$('t-help-box').innerHTML = helpBox('t-hb', 'Choisissez un jour et une heure : les branches qui ne s\'appliquent pas à ce moment sont atténuées (ouvert → sorties normales de la SDA, de l\'utilisateur, du groupe… ; fermé → destination de fermeture ; fermeture exceptionnelle → sa destination, prioritaire). Règles lues dans le code de Wazo : fermetures exceptionnelles d\'abord, puis plages d\'ouverture, sinon fermé ; bornes horaires incluses à la minute (une plage 09:00–12:30 couvre 12:30). L\'heure est celle du site (fuseau de l\'horaire). Le bandeau montre la journée choisie : la ligne « Résultat » indique où arrive l\'appel une fois tous les horaires franchis (couleur de la carte d\'arrivée), puis une ligne par horaire du parcours (vert ouvert, gris fermé, rouge fermeture exceptionnelle). Survolez une tranche pour ses heures exactes.');
// Le canevas reprend sa taille avec la fenêtre (cadre du portail redimensionné).
window.addEventListener('resize', () => { clearTimeout(window.__cfR); window.__cfR = setTimeout(() => C.canvas?.fit(), 200); });

connect(boot);
