// Call Flow Manager (Astrea Admin Tools) — vue graphique du parcours des
// appels (lot 1 : lecture seule). Cadrage : astrea-wazo-dev/docs/CALLFLOW-MANAGER.md.
// Modèle (sources confd vérifiées) : model.js ; canevas : canvas.js.
import { S, $, esc, connect, setReadonly, showCompat, loaded, loadFailed, stackVersion, helpButton, helpBox } from '../common/core.js?v=0.32.1';
import { M, TYPES, loadAll, ensureAllDetails, loadLiveMembers, scanGroupKeys, buildTree, reverseIndex, facts, listOf, nodeInfo, applyTime, whenOf, dayBands, scheduleState } from './model.js?v=0.32.1';
import { createCanvas } from './canvas.js?v=0.32.1';

const TESTED_STACK = ['26.07'];
const NAV = [
  ['incall', 'SDA'], ['trunk', 'Trunks'], ['user', 'Utilisateurs'], ['group', 'Groupes'], ['queue', 'Files'], ['ivr', 'SVI'],
  ['schedule', 'Horaires'], ['voicemail', 'Messageries'], ['conference', 'Conférences'], ['switchboard', 'Standards'], ['outcall', 'Règles sortantes'], ['context', 'Contextes'],
];
const C = { time: { on: true, date: null, min: 0 }, type: 'incall', root: null, dir: 'out', collapsed: new Set(), expanded: new Set(), showEmpty: false, scope: null, canvas: null, tree: null, sel: null };

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
async function boot() {
  $('conn').textContent = 'Chargement…';
  document.body.classList.remove('idle');
  const scope = `${S.base}|${S.tenant}`;
  if (C.scope !== scope) { C.root = null; C.sel = null; C.collapsed.clear(); C.expanded.clear(); }
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
const nodeExists = (k) => { const i = k.indexOf(':'); return !!M.by[k.slice(0, i)]?.has(k.slice(i + 1)); };
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
  if (!C.canvas) C.canvas = createCanvas($('cf-view'), { onSelect: showDetail, onOpen: (k) => setRoot(k), onFold: fold });
  if (!C.root) { $('cf-title').textContent = 'Parcours des appels'; $('cf-view').classList.add('empty'); return; }
  $('cf-view').classList.remove('empty');
  C.tree = buildTree(C.root, C.dir, { collapsed: C.collapsed, expanded: C.expanded, showEmpty: C.showEmpty && C.dir === 'out' });
  const info = C.tree.root.info, t = TYPES[info.type] || {};
  $('cf-title').textContent = `${t.label || ''} ${info.title}`;
  $('cf-sub').textContent = C.dir === 'out'
    ? `Où vont les appels · ${C.tree.nodes.size} carte${C.tree.nodes.size > 1 ? 's' : ''}${info.sub ? ` · ${info.sub}` : ''}`
    : `Qui envoie des appels ici · ${C.tree.nodes.size - 1} origine${C.tree.nodes.size > 2 ? 's' : ''}`;
  if (!$('cf-hb')) $('cf-help').innerHTML = helpButton('cf-hb', 'Comment lire ce graphe');
  if (!$('cf-hb')) $('cf-help-box').innerHTML = helpBox('cf-hb', C.dir === 'out'
    ? 'Chaque carte est un objet Wazo ; ses sorties (à droite) sont les cas où l\'appel la quitte : débordements, touches de SVI, horaire fermé… Un lien en pointillé rejoint une carte déjà affichée ailleurs (boucle ou objet partagé). Un lien gris clair est une simple association (messagerie de l\'utilisateur), pas un routage. Les durées affichées sont celles de Wazo (sonnerie, délai du groupe ou de la file).'
    : 'Les cartes de gauche envoient des appels vers la carte choisie ; la sortie concernée est indiquée sur chacune. Seuls les routages lus dans confd sont trouvés (renvois vers un numéro interne compris).');
  applyTime(C.tree, timeW());
  C.canvas.render(C.tree, C.dir, `${C.scope}|${C.root}|${C.dir}`, { keepView });
  renderTime();
  if (C.sel && C.tree.nodes.has(C.sel)) C.canvas.select(C.sel, false); else closeDetail();
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
// Premier horaire du parcours affiché (le plus proche de la carte de départ).
const firstSchedule = () => { for (const k of C.tree?.nodes.keys() || []) if (k.startsWith('schedule:')) return M.by.schedule?.get(k.slice(9)); return null; };
function renderTime() {
  const d = C.time.date;
  $('t-date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('t-min').value = C.time.min;
  $('t-label').textContent = `${hhmm(C.time.min)} · ${d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}`;
  $('cf-time').classList.toggle('off', !C.time.on || C.dir !== 'out');
  const s = firstSchedule();
  if (!s) { $('t-bands').innerHTML = ''; $('t-state').textContent = C.dir === 'out' ? 'Aucun horaire sur ce parcours' : 'Simulation : sens « où vont les appels » seulement'; return; }
  $('t-bands').innerHTML = dayBands(s, d).map((b) => `<i class="b-${b.k}" style="left:${(b.start / 1440) * 100}%;width:${((b.end - b.start) / 1440) * 100}%" title="${hhmm(b.start)}–${hhmm(b.end - 1)} : ${esc(b.label)}"></i>`).join('');
  $('t-state').textContent = `${s.name || 'Horaire'} : ${scheduleState(s, whenOf(d, C.time.min)).label}`;
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
    ${n.leaf ? '' : `<div class="dsec"><h4>Arrive depuis</h4>${refs}</div>`}
    ${n.leaf ? '' : `<div class="btnrow">${n.key !== C.root ? '<button id="d-root" class="primary">Partir de cette carte</button>' : ''}<button id="d-in">${C.dir === 'in' && n.key === C.root ? 'Où vont les appels' : 'Qui arrive ici'}</button></div>`}`;
  $('detail').hidden = false;
  $('main').classList.remove('no-detail');
  const r = $('d-root'); if (r) r.onclick = () => setRoot(n.key);
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
// Événements
// ---------------------------------------------------------------------------
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
$('cf-reload').onclick = async () => { try { await reload(); draw(true); } catch (e) { loadFailed(e); } };
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
$('t-help-box').innerHTML = helpBox('t-hb', 'Choisissez un jour et une heure : les branches qui ne s\'appliquent pas à ce moment sont atténuées (ouvert → sorties normales de la SDA, de l\'utilisateur, du groupe… ; fermé → destination de fermeture ; période exceptionnelle → sa destination, prioritaire). Règles lues dans le code de Wazo : exceptions d\'abord, puis plages d\'ouverture, sinon fermé ; bornes horaires incluses à la minute (une plage 09:00–12:30 couvre 12:30). L\'heure est celle du site (fuseau de l\'horaire). Le bandeau du curseur montre la journée du premier horaire du parcours : vert ouvert, gris fermé, rouge exception.');
// Le canevas reprend sa taille avec la fenêtre (cadre du portail redimensionné).
window.addEventListener('resize', () => { clearTimeout(window.__cfR); window.__cfR = setTimeout(() => C.canvas?.fit(), 200); });

connect(boot);
