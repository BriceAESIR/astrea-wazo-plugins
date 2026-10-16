// Call Flow Manager — canevas : disposition en arbre (gauche → droite, comme
// une carte mentale), cartes HTML, liens SVG, déplacement du canevas, zoom,
// déplacement des cartes (avec leur sous-arbre), repli des branches.
// Positions manuelles gardées dans le navigateur (localStorage, try/catch).
import { esc } from '../common/core.js?v=0.38.0';
import { TYPES } from './model.js?v=0.38.0';

const W = 236, GAP_X = 104, GAP_Y = 18;
const POS_KEY = 'astrea-callflow-pos-v1';

function loadPos(k) { try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}')[k] || {}; } catch { return {}; } }
function savePos(k, pos) {
  try {
    const all = JSON.parse(localStorage.getItem(POS_KEY) || '{}');
    if (Object.keys(pos).length) all[k] = pos; else delete all[k];
    // Garde-fou : 200 vues au plus (les plus anciennes sont retirées).
    const keys = Object.keys(all); for (const x of keys.slice(0, Math.max(0, keys.length - 200))) delete all[x];
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch { /* stockage indisponible */ }
}

export function createCanvas(viewport, { onSelect, onOpen, onFold, onClear, onUndo, onCardDrop, onPortClick }) {
  // Pointes de flèche en unités du dessin (userSpaceOnUse) : elles ne grossissent
  // pas avec l'épaisseur du trait (attache horaire → objet) ; une pointe par couleur.
  const mk = (id) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"></path></marker>`;
  viewport.innerHTML = `<div class="cf-stage"><svg class="cf-links" width="1" height="1" aria-hidden="true"><defs>${mk('cf-arrow')}${mk('cf-arrow-g')}</defs><g></g></svg><div class="cf-cards"></div></div>`;
  const stage = viewport.querySelector('.cf-stage');
  const g = viewport.querySelector('.cf-links g');
  const cards = viewport.querySelector('.cf-cards');
  const V = { tx: 40, ty: 40, s: 1, tree: null, dir: 'out', pos: {}, manual: {}, storeKey: '', sel: null, edit: false, changed: new Set() };

  const apply = () => { stage.style.transform = `translate(${V.tx}px, ${V.ty}px) scale(${V.s})`; viewport.style.setProperty('--cf-scale', V.s); };
  const el = (k) => cards.querySelector(`.cf-node[data-key="${CSS.escape(k)}"]`);

  // -------------------------------------------------------------------------
  // Rendu
  // -------------------------------------------------------------------------
  function cardHtml(n) {
    const t = TYPES[n.info.type] || { label: n.info.type, badge: '?' };
    const hasKids = n.kids.length > 0;
    const fold = n.folded ? '<button class="cf-fold" data-fold title="Déplier">+</button>' : hasKids && n.depth > 0 ? '<button class="cf-fold" data-fold title="Replier">−</button>' : '';
    // Mode Modifier : sorties modifiables marquées (cible de dépôt), × pour vider, point orange si modifiée.
    const ports = (n.ports || []).map((p) => {
      // ed : cible de dépôt (destination modifiable) ; clk : cliquable (aussi les sorties d'un horaire, pour ses plages).
      const ed = V.edit && p.w;
      const clk = V.edit && (p.w || p.periods || p.cfg);
      const cls = [p.to ? '' : p.info ? 'info' : 'empty', p.npd ? 'npd' : '', p.assoc ? 'assoc' : '', p.inactive ? 'inactive' : '', clk ? 'editable' : '', ed && V.changed.has(p.w.key) ? 'changed' : ''].filter(Boolean).join(' ');
      return `<li data-port="${esc(p.id)}"${ed ? ` data-w="${esc(p.w.key)}"` : ''} class="${cls}" title="${esc(clk ? `${p.help || ''} — cliquez pour modifier${ed ? ', ou déposez une carte ici' : ''}.` : p.help || '')}"><span class="cf-pl">${esc(p.label)}</span>${p.note ? `<span class="cf-pn">${esc(p.note)}</span>` : ''}${p.to || p.info ? '' : '<span class="cf-pn">non réglé</span>'}${ed && V.changed.has(p.w.key) ? '<button class="cf-x cf-undo" data-undo title="Annuler cette modification : la sortie reprend sa valeur d\'origine">↶</button>' : ''}${ed && p.to ? '<button class="cf-x" data-clear title="Vider cette sortie (aucune destination ; modification du brouillon)">×</button>' : ''}${p.self ? '<span class="cf-pn cf-self">↺ revient ici</span>' : '<i class="cf-dot"></i>'}</li>`;
    }).join('');
    return `<div class="cf-node t-${esc(n.info.type)}${n.depth === 0 ? ' root' : ''}${n.key === V.sel ? ' sel' : ''}${n.dim ? ' dim' : ''}${n.info.dnd ? ' npd' : ''}${n.info.type === 'member' ? ' mini' : ''}" data-key="${esc(n.key)}" style="width:${n.info.type === 'member' ? 170 : W}px">
      <div class="cf-head" title="${esc(t.help || '')}"><span class="cf-badge">${esc(t.badge)}</span><div class="cf-txt"><div class="cf-type">${esc(t.label)}${n.key.startsWith('schedule:') ? `<span class="cf-state${n.timeOpen ? ' open' : ''}">${esc(n.timeLabel || '')}</span>` : ''}${n.copy ? '<span class="cf-rep" title="Même objet que sur une autre branche : il est répété pour montrer cette route jusqu\'au bout. Une modification de ses réglages vaut pour toutes ses cartes.">répété</span>' : ''}${n.guardedBy ? `<span class="cf-gpill" title="Cet objet est gardé par l'horaire « ${esc(n.guardedBy)} » (carte précédente) : il n'est atteint que si l'horaire est ouvert.">Horaire ${esc(n.guardedBy)}</span>` : ''}</div><div class="cf-title">${esc(n.info.title)}</div>${n.info.sub ? `<div class="cf-sub">${esc(n.info.sub)}</div>` : ''}</div>${fold}</div>
      ${n.guardOf ? `<div class="cf-guard" title="Horaire vérifié avant cet objet : ouvert → l'appel continue vers lui ; sinon → fermeture ou fermeture exceptionnelle.">Condition de : <strong>${esc(n.guardOf)}</strong></div>` : ''}
      ${ports ? `<ul class="cf-ports">${ports}</ul>` : ''}<i class="cf-in"></i></div>`;
  }
  function render(tree, dir, storeKey, { keepView = false, edit = false, changed = new Set() } = {}) {
    V.tree = tree; V.dir = dir; V.storeKey = storeKey; V.edit = edit; V.changed = changed;
    viewport.classList.toggle('editing', edit);
    V.manual = loadPos(storeKey);
    cards.innerHTML = [...tree.nodes.values()].map(cardHtml).join('');
    layout();
    draw();
    if (!keepView) fit();
  }
  // Arbre « propre » : feuilles empilées, parent centré sur ses enfants.
  function layout() {
    const H = new Map();
    for (const n of V.tree.nodes.values()) H.set(n.key, el(n.key)?.offsetHeight || 60);
    const auto = {};
    const sign = V.dir === 'in' ? -1 : 1;
    const place = (n, top) => {
      const h = H.get(n.key); const x = sign * n.depth * (W + GAP_X);
      if (!n.kids.length) { auto[n.key] = [x, top]; return top + h + GAP_Y; }
      let y = top;
      for (const c of n.kids) y = place(c, y);
      const a = auto[n.kids[0].key][1], b = auto[n.kids[n.kids.length - 1].key][1] + H.get(n.kids[n.kids.length - 1].key);
      const ny = Math.max(top, (a + b) / 2 - h / 2);
      auto[n.key] = [x, ny];
      return Math.max(y, ny + h + GAP_Y);
    };
    place(V.tree.root, 0);
    V.pos = {};
    for (const n of V.tree.nodes.values()) {
      const p = V.manual[n.key] || auto[n.key];
      V.pos[n.key] = p;
      const e = el(n.key); if (e) { e.style.left = `${p[0]}px`; e.style.top = `${p[1]}px`; }
    }
  }
  // Point d'une sortie (à droite de la carte) et point d'entrée (à gauche, au niveau de l'en-tête).
  function portPoint(k, portId) {
    const e = el(k), p = V.pos[k]; if (!e || !p) return null;
    const li = portId ? e.querySelector(`li[data-port="${CSS.escape(portId)}"]`) : null;
    const y = li ? li.offsetTop + li.offsetHeight / 2 : (e.querySelector('.cf-head')?.offsetHeight || 40) / 2;
    return [p[0] + e.offsetWidth, p[1] + y];
  }
  function inPoint(k) {
    const e = el(k), p = V.pos[k]; if (!e || !p) return null;
    return [p[0], p[1] + (e.querySelector('.cf-head')?.offsetHeight || 40) / 2];
  }
  function path(a, b) {
    const back = b[0] < a[0] + 20;
    const dx = back ? 90 : Math.max(36, (b[0] - a[0]) / 2);
    return `M${a[0]} ${a[1]} C${a[0] + dx} ${a[1]} ${b[0] - dx} ${b[1]} ${b[0]} ${b[1]}`;
  }
  function draw() {
    const out = [];
    const line = (a, b, cls) => { if (a && b) out.push(`<path class="${cls}" d="${path(a, b)}" marker-end="url(#${/\bguard\b/.test(cls) && !/\binactive\b/.test(cls) ? 'cf-arrow-g' : 'cf-arrow'})"></path>`); };
    // Lien inactif (simulation horaire) : sortie inactive ou carte d'origine atténuée.
    const off = (k, port) => { const n = V.tree.nodes.get(k); return !!(n?.dim || n?.ports?.find((p) => p.id === port)?.inactive); };
    // Sortie « Ouvert » d'un horaire vers l'objet qu'il garde : lien épais (attache).
    const guard = (k, port) => (V.tree.nodes.get(k)?.ports?.find((p) => p.id === port)?.guard ? ' guard' : '');
    for (const n of V.tree.nodes.values()) {
      if (!n.parent) continue;
      // Sens « où vont les appels » : sortie du parent → entrée de l'enfant ;
      // sens « qui arrive ici » : sortie de l'enfant (l'appelant) → entrée du parent.
      if (V.dir === 'in') line(portPoint(n.key, n.port), inPoint(n.parent), 'cf-edge');
      else line(portPoint(n.parent, n.port), inPoint(n.key), `cf-edge${n.edge?.assoc ? ' assoc' : ''}${guard(n.parent, n.port)}${off(n.parent, n.port) ? ' inactive' : ''}`);
    }
    // Membres d'un groupe → sortie « pas de réponse » (convergence).
    if (V.dir !== 'in') for (const n of V.tree.nodes.values()) if (n.flowTo) line(portPoint(n.key, n.ports?.find((p) => p.info)?.id || null), inPoint(n.flowTo), `cf-edge flow${n.dim || V.tree.nodes.get(n.flowTo)?.dim ? ' inactive' : ''}`);
    for (const c of V.tree.cross) {
      if (V.dir === 'in') line(portPoint(c.to, c.port), inPoint(c.from), 'cf-edge cross');
      else line(portPoint(c.from, c.port), inPoint(c.to), `cf-edge cross${c.edge?.assoc ? ' assoc' : ''}${guard(c.from, c.port)}${off(c.from, c.port) ? ' inactive' : ''}`);
    }
    g.innerHTML = out.join('');
  }
  // Simulation horaire : met à jour les classes sans refaire la disposition.
  function refreshTime() {
    if (!V.tree) return;
    for (const n of V.tree.nodes.values()) {
      const e = el(n.key); if (!e) continue;
      e.classList.toggle('dim', !!n.dim);
      for (const p of n.ports || []) e.querySelector(`li[data-port="${CSS.escape(p.id)}"]`)?.classList.toggle('inactive', !!p.inactive);
      const s = e.querySelector('.cf-state'); if (s) { s.textContent = n.timeLabel || ''; s.classList.toggle('open', !!n.timeOpen); }
    }
    draw();
  }

  // -------------------------------------------------------------------------
  // Vue : ajuster, zoom
  // -------------------------------------------------------------------------
  function bbox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [k, p] of Object.entries(V.pos)) { const e = el(k); if (!e) continue; x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0] + e.offsetWidth); y1 = Math.max(y1, p[1] + e.offsetHeight); }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: W, y1: 60 };
  }
  function fit() {
    const b = bbox(), vw = viewport.clientWidth || 800, vh = viewport.clientHeight || 600;
    V.s = Math.max(0.3, Math.min(1, (vw - 48) / (b.x1 - b.x0), (vh - 48) / (b.y1 - b.y0)));
    V.tx = (vw - (b.x1 - b.x0) * V.s) / 2 - b.x0 * V.s;
    V.ty = Math.max(24, (vh - (b.y1 - b.y0) * V.s) / 2) - b.y0 * V.s;
    apply();
  }
  function zoomAt(f, px, py) {
    const s = Math.max(0.2, Math.min(2, V.s * f));
    V.tx = px - (px - V.tx) * (s / V.s); V.ty = py - (py - V.ty) * (s / V.s); V.s = s; apply();
  }
  const zoom = (f) => zoomAt(f, viewport.clientWidth / 2, viewport.clientHeight / 2);
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // -------------------------------------------------------------------------
  // Pointeur : déplacer le canevas (fond) ou une carte (avec son sous-arbre)
  // -------------------------------------------------------------------------
  const subtree = (k) => { const n = V.tree.nodes.get(k); const out = [k]; for (const c of n?.kids || []) out.push(...subtree(c.key)); return out; };
  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const card = e.target.closest('.cf-node');
    drag = { x: e.clientX, y: e.clientY, moved: false, card: card?.dataset.key || null, tx: V.tx, ty: V.ty };
    if (drag.card) drag.keys = (e.altKey ? [drag.card] : subtree(drag.card)).map((k) => [k, [...V.pos[k]]]);
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    // Capture seulement une fois le geste commencé : le clic et le double-clic
    // gardent la carte pour cible.
    if (!drag.moved) try { viewport.setPointerCapture(e.pointerId); } catch { /* */ }
    drag.moved = true;
    if (!drag.card) { viewport.classList.add('panning'); V.tx = drag.tx + dx; V.ty = drag.ty + dy; apply(); return; }
    viewport.classList.add('moving');
    for (const [k, p] of drag.keys) {
      V.pos[k] = [p[0] + dx / V.s, p[1] + dy / V.s];
      const c = el(k); c.style.left = `${V.pos[k][0]}px`; c.style.top = `${V.pos[k][1]}px`;
      if (V.edit) c.classList.add('dragcard'); // laisse passer le pointeur vers la sortie visée
    }
    if (V.edit) hover(e.clientX, e.clientY);
    draw();
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    viewport.classList.remove('panning', 'moving');
    // Mode Modifier : carte lâchée sur une sortie modifiable → elle revient à
    // sa place et devient la nouvelle destination (dialogue côté app). La
    // sortie est cherchée AVANT de rendre la carte déplacée au pointeur.
    const target = d.card && d.moved && V.edit && e ? portAt(e.clientX, e.clientY) : null;
    for (const c of cards.querySelectorAll('.dragcard')) c.classList.remove('dragcard');
    hover(null);
    if (target && target.nodeKey !== d.card) {
      for (const [k, p] of d.keys) { V.pos[k] = p; const c = el(k); c.style.left = `${p[0]}px`; c.style.top = `${p[1]}px`; }
      draw();
      onCardDrop?.(d.card, target);
      return;
    }
    if (d.card && d.moved) { for (const [k] of d.keys) V.manual[k] = V.pos[k]; savePos(V.storeKey, V.manual); }
    else if (!d.moved) select(d.card, true);
  };
  // Sortie modifiable sous le pointeur (coordonnées écran).
  function portAt(x, y) {
    const li = document.elementFromPoint(x, y)?.closest?.('li[data-w]');
    const card = li?.closest('.cf-node');
    return li && card && viewport.contains(li) ? { nodeKey: card.dataset.key, portId: li.dataset.port } : null;
  }
  // Carte sous le pointeur (dépôt d'un horaire sur une carte).
  function cardAt(x, y) {
    const c = document.elementFromPoint(x, y)?.closest?.('.cf-node');
    return c && viewport.contains(c) ? c.dataset.key : null;
  }
  // Survol pendant un glisser : sortie visée, ou carte visée si cardOk est fourni.
  function hover(x, y, cardOk) {
    for (const li of cards.querySelectorAll('li.dropover')) li.classList.remove('dropover');
    for (const c of cards.querySelectorAll('.cf-node.dropcard')) c.classList.remove('dropcard');
    if (x == null) return null;
    if (cardOk) { const k = cardAt(x, y); if (k && cardOk(k)) el(k)?.classList.add('dropcard'); return k; }
    const t = portAt(x, y);
    if (t) el(t.nodeKey)?.querySelector(`li[data-port="${CSS.escape(t.portId)}"]`)?.classList.add('dropover');
    return t;
  }
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  viewport.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fold]'); if (b) return onFold?.(b.closest('.cf-node').dataset.key);
    const x = e.target.closest('[data-clear]'); if (x) return onClear?.(x.closest('.cf-node').dataset.key, x.closest('li').dataset.port);
    const u = e.target.closest('[data-undo]'); if (u) return onUndo?.(u.closest('.cf-node').dataset.key, u.closest('li').dataset.port);
    // Clic sur une sortie modifiable (mode Modifier) : choix de l'action.
    const li = V.edit && !e.target.closest('button') && e.target.closest('li.editable');
    if (li) onPortClick?.(li.closest('.cf-node').dataset.key, li.dataset.port);
  });
  viewport.addEventListener('dblclick', (e) => { const c = e.target.closest('.cf-node'); if (c && !e.target.closest('button')) onOpen?.(c.dataset.key); });

  function select(k, notify) {
    V.sel = k;
    for (const c of cards.querySelectorAll('.cf-node.sel')) c.classList.remove('sel');
    if (k) el(k)?.classList.add('sel');
    if (notify) onSelect?.(k ? V.tree.nodes.get(k) : null);
  }
  function resetLayout() { V.manual = {}; savePos(V.storeKey, {}); layout(); draw(); fit(); }
  // Recentrer sur une carte (sans changer le zoom).
  function focus(k) { const p = V.pos[k], e = el(k); if (!p || !e) return; V.tx = viewport.clientWidth / 2 - (p[0] + e.offsetWidth / 2) * V.s; V.ty = viewport.clientHeight / 3 - p[1] * V.s; apply(); }
  apply();
  return { render, refreshTime, fit, zoom, resetLayout, select, focus, portAt, cardAt, hover, get hasManual() { return Object.keys(V.manual).length > 0; } };
}
