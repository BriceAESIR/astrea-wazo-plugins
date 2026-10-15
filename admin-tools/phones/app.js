// DECT Manager (Astrea Admin Tools) — vue d'ensemble des bases DECT et des
// lignes Wazo qui y sont provisionnées, affectation / retrait / déplacement.
// Vérifié dans le code Wazo (13/10/2026, wazo-confd master, wazo-provd-plugins
// v87 et Gigaset Nx70) :
//  - une ligne est associée à UN appareil (line.device_id) à une position
//    (line.position) ; position N = compte N (account.N) de la base ;
//  - PUT/DELETE /lines/{id}/devices/{device_id} : association refusée si la
//    ligne a déjà un appareil (déplacer = dissocier puis associer) ou si la
//    position est prise ; la ligne doit avoir un utilisateur et une extension ;
//  - PUT /lines/{id} (objet complet) ne contrôle PAS l'unicité de la position
//    sur l'appareil : l'appli la vérifie elle-même ;
//  - confd régénère la config provd, mais ne synchronise pas l'appareil.
// Supposé, à vérifier en réel : GET /lines renvoie device_id et position ;
// un PUT /lines/{id} avec l'objet relu par GET est accepté.
import { S, $, esc, toast, api, listAll, confirmModal, connect, fullName, canWrite, setReadonly, showCompat, loaded, loadFailed, provd, provdDevice, updateProvdOptions, downloadJson, calldGet } from '../common/core.js?v=0.36.1';
import { CATALOG, randomPassword, checkField } from './catalog.js?v=0.36.1';

// Comptes SIP par modèle (_NB_SIP_ACCOUNTS / plugin-info des plugins provd).
const DECT_MAX = {
  W60B: 8, W70B: 10, W75B: 20, W75DM: 20, W80B: 100, W80DM: 100, W90B: 250, W90DM: 250,
  'N610 IP PRO': 8, 'N670 IP PRO': 20, 'N770 IP PRO': 100, 'N870 IP PRO': 250, 'N870E IP PRO': 250,
  'N720 IP PRO': 100, 'N720 DM PRO': 100, 'N510 IP PRO': 6,
};
// Modèle normalisé (majuscules, espaces, préfixe de marque retiré) → clé de DECT_MAX.
const norm = (s) => String(s || '').toUpperCase().replace(/^(YEALINK|GIGASET)\s+/, '').replace(/\s+/g, ' ').trim();
const DECT_KEYS = new Map(Object.keys(DECT_MAX).map((k) => [norm(k), k]));
const dectModel = (d) => (d ? DECT_KEYS.get(norm(d.model)) || null : null);
const maxOf = (d) => DECT_MAX[dectModel(d)] || 0;
const isDect = (d) => !!dectModel(d);
// plan : déplacements en attente (glisser-déposer), id de ligne → { dev, pos }.
const D = { devices: [], lines: [], users: [], byLineUsers: new Map(), sel: null, scope: null, plan: new Map() };

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
async function boot() {
  $('conn').textContent = 'Chargement…';
  document.body.classList.remove('idle');
  const scope = `${S.base}|${S.tenant}`;
  if (D.scope !== scope) { D.sel = null; D.plan.clear(); }
  D.scope = scope;
  try {
    await reload();
    loaded();
    $('conn').textContent = `${new URL(S.base).host}`;
  } catch (e) { loadFailed(e); }
}
// État d'enregistrement SIP des lignes (wazo-calld GET /lines, ACL calld.lines.read ;
// vérifié dans le code : registered = contact PJSIP joignable, true/false/null).
// Un appareil est « connecté » si une de ses lignes est enregistrée : c'est ce
// qui permet la synchronisation (NOTIFY check-sync envoyé au contact SIP).
async function loadReg() {
  try {
    const items = await calldGet('/lines');
    D.reg = new Map((Array.isArray(items) ? items : items?.items || []).map((x) => [x.id, x]));
    D.regOk = true;
  } catch (e) { D.regOk = false; D.regErr = e.message; console.warn('[astrea] état des lignes', e.message); }
}
// 'on' | 'off' | 'call' | 'unknown' + nombre de lignes enregistrées.
function devState(d) {
  const ls = D.lines.filter((l) => l.device_id === d?.id);
  if (!D.regOk || !ls.length) return { st: 'unknown', on: 0, n: ls.length };
  const r = ls.map((l) => D.reg.get(l.id));
  const on = r.filter((x) => x?.registered === true).length;
  const calls = r.reduce((s, x) => s + (x?.current_call_count || 0), 0);
  const st = on ? (calls ? 'call' : 'on') : r.every((x) => x?.registered === false) ? 'off' : 'unknown';
  return { st, on, n: ls.length, calls };
}
// Pastille d'une ligne (tableau des comptes DECT).
function lineDot(l) {
  const r = D.regOk ? D.reg.get(l.id) : null;
  const st = !r || r.registered == null ? 'unknown' : r.registered ? (r.current_call_count ? 'call' : 'on') : 'off';
  return `<span class="st ${st}" title="${ST_TEXT[st]}"></span>`;
}
const ST_TEXT = { on: 'connecté', call: 'connecté, en appel', off: 'non connecté', unknown: 'état inconnu' };
function stDot(d) {
  const s = devState(d);
  const tip = s.st === 'unknown' && !D.regOk ? `état d'enregistrement indisponible (${D.regErr || 'droits calld ?'})` : `${ST_TEXT[s.st]} · ${s.on}/${s.n} ligne(s) enregistrée(s)`;
  return `<span class="st ${s.st}" title="${esc(tip)}"></span>`;
}
function stText(d) {
  const s = devState(d);
  if (!D.regOk) return 'état d\'enregistrement indisponible';
  if (!s.n) return 'aucune ligne';
  return `${ST_TEXT[s.st]} (${s.on}/${s.n} ligne(s) enregistrée(s))`;
}
// Avertissement à afficher avant une synchronisation.
function syncWarn(ids) {
  const off = [...new Set(ids.filter(Boolean))].map(devById).filter((d) => d && devState(d).st === 'off');
  return off.length ? `<div class="warn">Non connecté(s) à la stack : ${off.map((d) => esc(d.mac || d.description || d.id)).join(', ')}. La synchronisation ne les atteindra pas ; ils prendront la configuration à leur prochain démarrage ou provisionnement.</div>` : '';
}
async function reload() {
  const [devices, lines, users] = await Promise.all([listAll('/devices'), listAll('/lines'), listAll('/users'), loadReg()]);
  selfCheck(devices, lines);
  D.devices = devices;
  D.lines = lines;
  D.users = users.sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  D.byLineUsers = new Map();
  D.userLine = new Map(); // id de ligne → ligne vue depuis l'utilisateur (porte is_webrtc)
  for (const u of users) for (const l of u.lines || []) {
    if (!D.byLineUsers.has(l.id)) D.byLineUsers.set(l.id, []);
    D.byLineUsers.get(l.id).push(u);
    D.userLine.set(l.id, l);
  }
  render();
}
function selfCheck(devices, lines) {
  S.compatWarns = [];
  const problems = [];
  if (lines.length && !lines.some((l) => l && 'device_id' in l && 'position' in l)) problems.push('les lignes n\'indiquent plus leur appareil et leur position (device_id / position absents de GET /lines)');
  if (devices.length && !devices.some((d) => d && 'model' in d && 'mac' in d)) problems.push('format des appareils inattendu (model / mac absents)');
  console.info('[astrea] DECT auto-contrôle', { problems });
  if (problems.length) setReadonly(problems.join(' ; ')); else showCompat();
}

// ---------------------------------------------------------------------------
// Modèle
// ---------------------------------------------------------------------------
const bases = () => D.devices.filter(isDect).sort((a, b) => baseName(a).localeCompare(baseName(b), 'fr'));
const baseName = (d) => d.mac || d.description || `Appareil ${d.id}`; // MAC (description au survol)
// État affiché = état Wazo + déplacements en attente.
const eff = (l) => D.plan.get(l.id) || { dev: l.device_id, pos: l.position };
const posOf = (l) => eff(l).pos;
const linesOf = (devId) => D.lines.filter((l) => eff(l).dev === devId).sort((a, b) => (posOf(a) ?? 1e9) - (posOf(b) ?? 1e9));
const lineUsers = (l) => D.byLineUsers.get(l.id) || l.users || [];
const lineNumber = (l) => (l.extensions || [])[0]?.exten || '';
// Ligne WebRTC (champ is_webrtc de confd, sur la ligne ou dans user.lines) :
// pas provisionnable sur une base DECT.
const isWebrtc = (l) => l?.is_webrtc === true || D.userLine?.get(l?.id)?.is_webrtc === true;
const lineLabel = (l) => isWebrtc(l) ? `WebRTC ${l.name || ''}`.trim() : `${(l.protocol || (l.endpoint_sip ? 'sip' : '')).toUpperCase()} ${l.name || l.endpoint_sip?.name || l.endpoint_sip?.username || `#${l.id}`}`.trim();
const devById = (id) => D.devices.find((d) => d.id === id);
const devLabel = (d) => (d ? `${[d.vendor, d.model].filter(Boolean).join(' ') || 'appareil'} ${d.description || d.mac || d.ip || ''}`.trim() : '');
function usedPositions(devId, exceptLineId) {
  return new Set(linesOf(devId).filter((l) => l.id !== exceptLineId && posOf(l)).map(posOf));
}
function freePositions(dev, exceptLineId) {
  const used = usedPositions(dev.id, exceptLineId);
  const out = [];
  for (let p = 1; p <= maxOf(dev); p++) if (!used.has(p)) out.push(p);
  return out;
}
const ranges = (ps) => {
  const r = [];
  for (const p of ps) { const last = r[r.length - 1]; if (last && p === last[1] + 1) last[1] = p; else r.push([p, p]); }
  return r.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
};
// Alertes d'une base : [{ level: 'bad' | 'warn', text }]
function alertsOf(dev) {
  const max = maxOf(dev);
  const ls = linesOf(dev.id);
  const out = [];
  const count = new Map();
  for (const l of ls) if (posOf(l)) count.set(posOf(l), (count.get(posOf(l)) || 0) + 1);
  const dups = [...count].filter(([, n]) => n > 1).map(([p]) => p);
  if (dups.length) out.push({ level: 'bad', text: `Plusieurs lignes au compte ${dups.join(', ')} : une seule est réellement provisionnée.` });
  const over = ls.filter((l) => posOf(l) > max).map(posOf);
  if (over.length) out.push({ level: 'bad', text: `Compte(s) ${over.join(', ')} au-delà du maximum du ${dev.model} (${max}) : non provisionnés.` });
  if (ls.some((l) => !posOf(l))) out.push({ level: 'warn', text: 'Ligne sans position.' });
  const orphan = ls.filter((l) => !lineUsers(l).length);
  if (orphan.length) out.push({ level: 'warn', text: `${orphan.length} ligne(s) sans utilisateur.` });
  if (ls.length >= max) out.push({ level: 'warn', text: `Base pleine (${ls.length}/${max}).` });
  if (/yealink/i.test(`${dev.vendor} ${dev.plugin}`) && /v86\b/.test(dev.plugin || '')) out.push({ level: 'bad', text: `Plugin provd ${dev.plugin} : il ne gère pas les bases DECT (utiliser wazo-yealink-v87).` });
  if (!dev.plugin) out.push({ level: 'warn', text: 'Aucun plugin provd associé.' });
  if (dev.status && dev.status !== 'configured') out.push({ level: 'warn', text: `État de provisionnement : ${dev.status}.` });
  if (!ls.length && /^W(75|80|90)B$/.test(dectModel(dev))) out.push({ level: 'warn', text: 'Aucun compte : base secondaire d\'un multicellule ? (seule la base maître porte les comptes).' });
  return out;
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
let VIEW = 'dect'; // 'dect' | 'config'
function render() {
  renderList();
  if (VIEW === 'config') { renderDevList(); renderCfg(); } else renderBase();
}
function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const bs = bases();
  const ul = $('baselist');
  ul.innerHTML = '';
  for (const d of bs) {
    const hay = `${baseName(d)} ${d.description || ''} ${d.model} ${d.mac || ''} ${d.ip || ''}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const n = linesOf(d.id).length, max = maxOf(d);
    const al = alertsOf(d);
    const li = document.createElement('li');
    li.className = D.sel === d.id ? 'sel' : '';
    li.dataset.dev = d.id; // cible de dépôt (déplacer un compte vers cette base)
    if (d.description) li.title = d.description;
    li.innerHTML = `<span>${stDot(d)}${esc(baseName(d))}${al.length ? `<span class="dot${al.some((a) => a.level === 'bad') ? ' bad' : ''}" title="${esc(al.map((a) => a.text).join('\n'))}"></span>` : ''}</span><span class="sub">${esc(d.model)} · <span class="occ${n >= max ? ' full' : ''}">${n}/${max}</span></span>`;
    li.onclick = () => { D.sel = d.id; render(); };
    ul.appendChild(li);
  }
  const total = bs.reduce((s, d) => s + linesOf(d.id).length, 0);
  $('count').textContent = `${bs.length} base(s) DECT · ${total} compte(s)`;
  // Recherche d'un utilisateur / numéro : où est son DECT ?
  const hits = q ? D.lines.filter((l) => isDect(devById(l.device_id)) && `${lineUsers(l).map(fullName).join(' ')} ${lineNumber(l)}`.toLowerCase().includes(q)) : [];
  $('found').hidden = !hits.length;
  $('found').innerHTML = hits.map((l) => `<div class="hit" data-dev="${l.device_id}"><strong>${esc(lineUsers(l).map(fullName).join(', ') || 'sans utilisateur')}</strong> ${esc(lineNumber(l))}<br><span class="muted small">${esc(baseName(devById(l.device_id)))} · compte ${l.position ?? '?'}</span></div>`).join('');
}
function renderBase() {
  const d = devById(D.sel);
  $('empty').hidden = !!d;
  $('base').hidden = !d;
  if (!d) {
    // Aucune base reconnue : montrer ce que la stack contient (diagnostic).
    if (!bases().length) {
      const models = new Map();
      for (const x of D.devices) { const k = `${x.vendor || '?'} ${x.model || '(modèle inconnu)'}`; models.set(k, (models.get(k) || 0) + 1); }
      $('empty').innerHTML = `<p>Aucune base DECT reconnue sur cette stack.</p><p class="muted small">Appareils trouvés (${D.devices.length}) : ${esc([...models].map(([k, n]) => `${k} ×${n}`).join(', ') || 'aucun')}.</p><p class="muted small">Modèles reconnus : ${esc(Object.keys(DECT_MAX).join(', '))}. Une base pas encore provisionnée (autoprov, modèle inconnu) n'apparaît pas.</p>`;
      console.info('[astrea] DECT appareils', D.devices.map((x) => ({ id: x.id, vendor: x.vendor, model: x.model, plugin: x.plugin, status: x.status })));
    } else $('empty').textContent = 'Choisissez une base DECT.';
    return;
  }
  const max = maxOf(d);
  const ls = linesOf(d.id);
  $('b-name').textContent = `${[d.vendor, d.model].filter(Boolean).join(' ')} · ${baseName(d)}`;
  $('b-tech').textContent = [stText(d), d.mac && `MAC ${d.mac}`, d.ip && `IP publique de la base ${d.ip}`, d.version && `firmware ${d.version}`, d.plugin && `plugin ${d.plugin}`, d.status && `état ${d.status}`].filter(Boolean).join(' · ');
  $('b-warn').innerHTML = alertsOf(d).map((a) => `<div class="warn">${a.level === 'bad' ? `<span class="error">${esc(a.text)}</span>` : esc(a.text)}</div>`).join('');
  $('b-title').textContent = `Comptes · ${ls.length}/${max}`;
  // Une ligne par compte (1..max) : les comptes libres sont des cibles de
  // glisser-déposer. Grandes bases (W80/W90) : jusqu'au dernier compte
  // utilisé + 10, puis une ligne « comptes libres suivants ».
  const lastUsed = Math.max(0, ...ls.map(posOf).filter((p) => p && p <= max));
  const shown = max <= 40 ? max : Math.min(max, lastUsed + 10);
  const rowOf = (l, dup) => {
    const us = lineUsers(l);
    const moved = D.plan.has(l.id);
    const was = moved ? `<div class="muted small">avant : ${l.device_id === d.id ? '' : `${esc(baseName(devById(l.device_id)) || 'aucune base')}, `}compte ${l.position ?? '?'}</div>` : '';
    return `<tr draggable="true" data-line="${l.id}" data-pos="${posOf(l) ?? ''}" class="${dup ? 'dup' : ''}${moved ? ' changed' : ''}"><td>${lineDot(l)}${posOf(l) ?? '—'}</td><td>${esc(us.map(fullName).join(', ')) || '<span class="muted">sans utilisateur</span>'}${was}</td><td>${esc(lineNumber(l))}</td><td class="muted small">${esc(lineLabel(l))}</td>
      <td><button data-act="remove" data-line="${l.id}" class="danger">Retirer</button></td></tr>`;
  };
  const rows = [];
  for (let p = 1; p <= shown; p++) {
    const here = ls.filter((l) => posOf(l) === p);
    if (!here.length) rows.push(`<tr class="free" data-pos="${p}"><td>${p}</td><td colspan="4" class="muted">libre</td></tr>`);
    else here.forEach((l) => rows.push(rowOf(l, here.length > 1)));
  }
  if (shown < max) rows.push(`<tr class="free" data-pos="${shown + 1}"><td>${shown + 1}–${max}</td><td colspan="4" class="muted">comptes libres suivants</td></tr>`);
  for (const l of ls.filter((x) => !posOf(x) || posOf(x) > max)) rows.push(rowOf(l, true)); // sans position / hors maximum
  $('b-rows').innerHTML = rows.join('');
  const free = freePositions(d);
  $('b-free').textContent = free.length ? `Comptes libres : ${ranges(free)}. Glissez un compte sur un autre pour échanger, sur un compte libre ou sur une base de la liste pour le déplacer.` : 'Aucun compte libre.';
  $('b-assign').disabled = !free.length;
  renderPlanBar();
}
// Barre « modifications en attente » (tous les déplacements, toutes bases).
function renderPlanBar() {
  const n = pendingChanges().length;
  $('b-plan').hidden = !n;
  $('b-save').textContent = `Enregistrer (${n})`;
  $('b-pending').textContent = `${n} déplacement(s) en attente, non écrit(s) dans Wazo.`;
}
const pendingChanges = () => [...D.plan].map(([id, to]) => ({ line: D.lines.find((l) => l.id === id), to }))
  .filter((c) => c.line && (c.to.dev !== c.line.device_id || c.to.pos !== c.line.position));

// ---------------------------------------------------------------------------
// Glisser-déposer : sur un compte libre = déplacer ; sur un compte occupé =
// échanger ; sur une base de la liste = premier compte libre de cette base.
// ---------------------------------------------------------------------------
let dragLine = null;
function planMove(line, dev, pos) {
  const orig = { dev: line.device_id, pos: line.position };
  if (orig.dev === dev && orig.pos === pos) D.plan.delete(line.id); else D.plan.set(line.id, { dev, pos });
}
function dropOnPos(pos) {
  const line = D.lines.find((l) => l.id === dragLine);
  const d = devById(D.sel);
  if (!line || !d || !pos) return;
  const from = eff(line);
  if (from.dev === d.id && from.pos === pos) return;
  if (pos > maxOf(d)) { toast(`Le ${d.model} n'a que ${maxOf(d)} comptes.`); return; }
  const other = linesOf(d.id).find((l) => l.id !== line.id && posOf(l) === pos);
  if (other) {
    if (from.dev !== d.id) { toast('Échange possible seulement sur la même base : déposez sur un compte libre.'); return; }
    planMove(other, d.id, from.pos);
  }
  planMove(line, d.id, pos);
  render();
}
function dropOnBase(devId) {
  const line = D.lines.find((l) => l.id === dragLine);
  const b = devById(devId);
  if (!line || !b || eff(line).dev === devId) return;
  const free = freePositions(b);
  if (!free.length) { toast(`${baseName(b)} est pleine.`); return; }
  planMove(line, devId, free[0]);
  toast(`${lineUsers(line).map(fullName).join(', ') || 'Ligne'} → ${baseName(b)}, compte ${free[0]} (à enregistrer)`);
  render();
}
function wireDragDrop() {
  const rows = $('b-rows'), list = $('baselist');
  const clear = () => document.querySelectorAll('.dragging, .dropover').forEach((x) => x.classList.remove('dragging', 'dropover'));
  rows.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-line]');
    if (!tr) return;
    dragLine = Number(tr.dataset.line);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragLine));
    requestAnimationFrame(() => tr.classList.add('dragging'));
  });
  const over = (e, el) => { if (dragLine == null || !el) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; document.querySelectorAll('.dropover').forEach((x) => x !== el && x.classList.remove('dropover')); el.classList.add('dropover'); };
  rows.addEventListener('dragover', (e) => over(e, e.target.closest('tr[data-pos]')));
  list.addEventListener('dragover', (e) => over(e, e.target.closest('li[data-dev]')));
  rows.addEventListener('drop', (e) => { const tr = e.target.closest('tr[data-pos]'); if (dragLine == null || !tr) return; e.preventDefault(); dropOnPos(Number(tr.dataset.pos)); dragLine = null; clear(); });
  list.addEventListener('drop', (e) => { const li = e.target.closest('li[data-dev]'); if (dragLine == null || !li) return; e.preventDefault(); dropOnBase(li.dataset.dev); dragLine = null; clear(); });
  document.addEventListener('dragend', () => { dragLine = null; clear(); });
}
// ---------------------------------------------------------------------------
// Écritures
// ---------------------------------------------------------------------------
// Position d'une ligne : objet complet relu puis réécrit (PUT /lines/{id}).
async function setPosition(lineId, pos) {
  const l = await api('GET', `/lines/${lineId}`);
  if (l.position === pos) return;
  l.position = pos;
  await api('PUT', `/lines/${lineId}`, l);
}
// Met la ligne sur `devId` au compte `pos` (dissocie d'abord l'appareil actuel).
// En cas d'échec après dissociation, tente de la remettre où elle était.
async function placeLine(lineId, devId, pos) {
  await reloadLines();
  const line = D.lines.find((l) => l.id === lineId);
  if (!line) throw new Error(`ligne ${lineId} introuvable`);
  if (usedPositions(devId, lineId).has(pos)) throw new Error(`le compte ${pos} de cette base vient d'être pris : rechargez.`);
  const from = { dev: line.device_id, pos: line.position };
  if (from.dev) await api('DELETE', `/lines/${lineId}/devices/${from.dev}`);
  try {
    await setPosition(lineId, pos);
    await api('PUT', `/lines/${lineId}/devices/${devId}`);
  } catch (e) {
    if (from.dev) {
      try { await setPosition(lineId, from.pos); await api('PUT', `/lines/${lineId}/devices/${from.dev}`); e.message += ' (ligne remise à sa place d\'origine)'; } catch { e.message += ' (ATTENTION : la ligne n\'a pas pu être remise sur son appareil d\'origine)'; }
    }
    throw e;
  }
  return from.dev;
}
async function reloadLines() { D.lines = await listAll('/lines'); }
async function syncDevices(ids) {
  for (const id of new Set(ids.filter(Boolean))) {
    try { await api('GET', `/devices/${id}/synchronize`); } catch (e) { toast(`Synchronisation de ${devLabel(devById(id))} impossible : ${e.message}`, 6000); }
  }
}
const syncBox = (checked = true) => `<label class="inline"><input type="checkbox" id="m-sync"${checked ? ' checked' : ''}> Synchroniser les appareils concernés (redémarrage possible des bases et postes)</label>`;
async function run(label, fn) {
  try { await fn(); toast(label); } catch (e) { toast(e.message, 9000); console.error(e); }
  try { await reload(); } catch (e) { toast(e.message, 6000); }
}

// Affecter : choisir un utilisateur et l'une de ses lignes, puis un compte libre.
function openAssign() {
  if (!canWrite() || hasPending()) return;
  const d = devById(D.sel);
  const free = freePositions(d);
  let pick = null;
  confirmModal(`<h3>Affecter un utilisateur à ${esc(baseName(d))}</h3>
    <label>Utilisateur ou numéro <input id="m-q" placeholder="Nom, extension…"></label>
    <ul id="m-list" class="pick"></ul>
    <label>Compte (position) <select id="m-pos">${free.map((p) => `<option value="${p}">${p}</option>`).join('')}</select></label>
    <div id="m-note"></div>${syncBox()}`, async () => {
    if (!pick) { toast('Choisissez une ligne.'); return false; }
    const pos = Number($('m-pos').value);
    const sync = $('m-sync').checked;
    await run(`${fullName(pick.user)} affecté(e) au compte ${pos}`, async () => {
      const old = await placeLine(pick.line.id, d.id, pos);
      if (sync) await syncDevices([d.id, old]);
    });
  }, 'Affecter');
  const draw = () => {
    const q = $('m-q').value.trim().toLowerCase();
    const items = [];
    for (const u of D.users) {
      if (q && !`${fullName(u)} ${u.username || ''} ${(u.lines || []).map((l) => (l.extensions || []).map((e) => e.exten).join(' ')).join(' ')}`.toLowerCase().includes(q)) continue;
      for (const ul of u.lines || []) {
        const l = D.lines.find((x) => x.id === ul.id) || ul;
        if (isWebrtc(l)) continue; // WebRTC : navigateur / appli, pas une base DECT
        items.push({ user: u, line: l });
      }
      if (items.length > 60) break;
    }
    $('m-list').innerHTML = items.map((it, i) => {
      const here = it.line.device_id === d.id;
      const where = it.line.device_id ? (here ? `déjà sur cette base (compte ${it.line.position})` : `sur ${devLabel(devById(it.line.device_id))}`) : 'sans appareil';
      return `<li data-i="${i}" class="${here ? 'off' : ''}${pick && pick.line.id === it.line.id ? ' sel' : ''}"><span>${esc(fullName(it.user))} <span class="muted">${esc(lineNumber(it.line))}</span></span><span class="muted small">${esc(lineLabel(it.line))} · ${esc(where)}</span></li>`;
    }).join('') || '<li class="off">Aucun résultat</li>';
    $('m-list').onclick = (e) => {
      const li = e.target.closest('li[data-i]');
      if (!li || li.classList.contains('off')) return;
      pick = items[Number(li.dataset.i)];
      const other = pick.line.device_id && pick.line.device_id !== d.id ? devById(pick.line.device_id) : null;
      $('m-note').innerHTML = other ? `<div class="warn">Cette ligne est provisionnée sur ${esc(devLabel(other))}. Wazo n'associe une ligne qu'à un seul appareil : elle sera retirée de cet appareil (il ne la recevra plus par provisionnement).</div>` : '';
      draw();
    };
  };
  $('m-q').oninput = draw;
  draw();
  $('m-q').focus();
}
function openRemove(lineId) {
  if (!canWrite() || hasPending()) return;
  const line = D.lines.find((l) => l.id === lineId);
  const d = devById(line.device_id);
  confirmModal(`<h3>Retirer de la base</h3><p>${esc(lineUsers(line).map(fullName).join(', ') || 'Ligne sans utilisateur')} ${esc(lineNumber(line))} (compte ${line.position ?? '?'}) ne sera plus provisionnée sur ${esc(baseName(d))}. La ligne et l'utilisateur restent dans Wazo. Sur la base, le compte est désactivé et ses identifiants effacés.</p>${linesOf(d.id).length === 1 ? lastLineWarn(d) : ''}${syncWarn([d.id])}${syncBox()}`, async () => {
    const sync = $('m-sync').checked;
    await run('Ligne retirée de la base', async () => {
      await api('DELETE', `/lines/${lineId}/devices/${d.id}`);
      if (sync) await syncDevices([d.id]);
    });
  }, 'Retirer');
}

// Déplacements en attente : une action immédiate (affecter, retirer) attend
// qu'ils soient enregistrés ou annulés.
function hasPending() {
  if (!pendingChanges().length) return false;
  toast('Des déplacements sont en attente : enregistrez-les ou annulez-les d\'abord.', 5000);
  return true;
}
// Dernière ligne retirée d'une base : confd remet l'appareil en autoprov.
const lastLineWarn = (d) => `<div class="warn"><span class="error">C'est la dernière ligne de ${esc(baseName(d))} : Wazo remet alors la base en mode autoprovisionnement (configuration d'attente, plus aucun compte).</span></div>`;
const who = (l) => `${lineUsers(l).map(fullName).join(', ') || 'Ligne sans utilisateur'} ${lineNumber(l)}`.trim();
// Enregistre tous les déplacements : contrôle final (pas de doublon, maximum
// du modèle), relecture des lignes (rien n'a bougé entre-temps), puis :
// dissociation des lignes qui changent de base, positions, réassociation.
function savePlan() {
  if (!canWrite()) return;
  const changes = pendingChanges();
  if (!changes.length) { D.plan.clear(); render(); return; }
  const devs = [...new Set(changes.flatMap((c) => [c.line.device_id, c.to.dev]).filter(Boolean))];
  for (const id of devs) {
    const b = devById(id);
    const seen = new Set();
    for (const l of linesOf(id)) {
      const p = posOf(l);
      if (p > maxOf(b)) { toast(`${baseName(b)} : compte ${p} au-delà du maximum (${maxOf(b)}).`, 6000); return; }
      if (p && seen.has(p) && changes.some((c) => c.to.dev === id && c.to.pos === p)) { toast(`${baseName(b)} : deux lignes au compte ${p}.`, 6000); return; }
      seen.add(p);
    }
  }
  const place = (dev, pos) => (dev ? `${esc(baseName(devById(dev)) || '?')} · compte ${pos ?? '?'}` : 'aucune base');
  confirmModal(`<h3>Enregistrer ${changes.length} déplacement(s)</h3>
    <table class="diff"><tr><th>Ligne</th><th>Avant</th><th>Après</th></tr>${changes.map((c) => `<tr><td>${esc(who(c.line))}</td><td>${place(c.line.device_id, c.line.position)}</td><td><strong>${place(c.to.dev, c.to.pos)}</strong></td></tr>`).join('')}</table>
    ${devs.filter((id) => !linesOf(id).length).map((id) => lastLineWarn(devById(id))).join('')}<p class="muted small">Chaque base concernée reçoit sa nouvelle configuration ; le combiné qui utilisait un compte doit être réaffecté sur la page web de la base si le compte change.</p>${syncWarn(devs)}${syncBox()}`, async () => {
    const sync = $('m-sync').checked;
    D.plan.clear(); // l'état réel est relu après l'écriture, réussie ou non
    await run(`${changes.length} déplacement(s) enregistré(s)`, async () => {
      const fresh = await listAll('/lines');
      const moving = new Set(changes.map((c) => c.line.id));
      for (const c of changes) {
        const f = fresh.find((l) => l.id === c.line.id);
        if (!f || f.device_id !== c.line.device_id || f.position !== c.line.position) throw new Error(`${who(c.line)} a été modifiée entre-temps : rien n'a été écrit, refaites le déplacement.`);
        if (fresh.some((l) => !moving.has(l.id) && l.device_id === c.to.dev && l.position === c.to.pos)) throw new Error(`Compte ${c.to.pos} de ${baseName(devById(c.to.dev))} pris entre-temps : rien n'a été écrit.`);
      }
      const cross = changes.filter((c) => c.to.dev !== c.line.device_id);
      try {
        for (const c of cross) if (c.line.device_id) await api('DELETE', `/lines/${c.line.id}/devices/${c.line.device_id}`);
        for (const c of changes) await setPosition(c.line.id, c.to.pos);
        for (const c of cross) await api('PUT', `/lines/${c.line.id}/devices/${c.to.dev}`);
      } catch (e) { e.message += ' — écriture interrompue : l\'état réel est rechargé, vérifiez les bases concernées.'; throw e; }
      if (sync) await syncDevices(devs);
    });
  }, 'Enregistrer');
}
// ===========================================================================
// Configuration des appareils (options provd astrea_settings → astrea_params)
// ===========================================================================
// astrea_settings = { idOption: { champ: valeur } | { __reset: 1 } } : ce que
// l'appli affiche ; astrea_params = paramètres Yealink plats, lus par le bloc
// v5 du template. Option décochée après avoir été appliquée : ses clés sont
// écrites à %NULL% (valeur vide Yealink, utilisée aussi par Wazo), sauf
// `keep` (VLAN, mot de passe : le modèle de provisionnement Wazo les réécrit).
const C = { sel: null, orig: {}, edit: {}, loading: false, tpl: null };
// Modèle de provisionnement de l'appareil (« Provisioning > Périphériques » du
// portail) = configuration provd désignée par device.template_id (défaut :
// defaultconfigdevice). Lu pour afficher ce qui s'applique quand une option
// Astrea est décochée (VLAN, mot de passe admin). Cache par id.
const tplCache = new Map();
async function deviceTemplate(d) {
  const id = d.template_id || 'defaultconfigdevice';
  if (!tplCache.has(id)) {
    tplCache.set(id, provd('GET', `/cfg_mgr/configs/${encodeURIComponent(id)}`).then((r) => r?.config || null).catch((e) => { console.warn('[astrea] modèle', id, e.message); return null; }));
  }
  const cfg = await tplCache.get(id);
  return cfg ? { id, label: cfg.label || cfg.raw_config?.label || id, raw: cfg.raw_config || {} } : { id, label: id, raw: null };
}
const NOT_RESET = new Set(['vlan', 'adminpw']);
// Préfixes MAC Yealink (OUI) relevés sur les parcs : la MAC donne la marque,
// pas le modèle (le même préfixe sert aux postes et aux bases DECT). Liste
// non exhaustive, à compléter.
const YEALINK_OUI = /^(00:15:65|80:5e:0c|80:5e:c0|24:9a:d8|44:db:d2|c4:fc:22)/i;
const isYealink = (d) => /yealink/i.test(`${d.vendor} ${d.plugin}`) || YEALINK_OUI.test(d.mac || '');
// Modèle inconnu (appareil déclaré par sa MAC, jamais connecté) : traité comme
// un poste, sans les options propres à certains modèles.
const kindOf = (d) => (!d ? null : isDect(d) ? 'dect' : isYealink(d) ? 'phone' : null);
const modelLabel = (d) => d.model || 'modèle inconnu';
// Appareils nommés par leur MAC (la description est un texte libre, souvent
// long) ; la description reste au survol et dans la recherche.
const devName = (d) => d.mac || d.description || `Appareil ${d.id}`;
const devUsers = (d) => [...new Set(D.lines.filter((l) => l.device_id === d.id).flatMap((l) => lineUsers(l).map(fullName)))];
// Sous-titre dans la liste : téléphone = « Nom · extension » de ses lignes ;
// base DECT = nombre de comptes (pas de noms).
function devSub(d) {
  const ls = D.lines.filter((l) => l.device_id === d.id);
  if (kindOf(d) === 'dect') return ls.length ? `${ls.length} compte${ls.length > 1 ? 's' : ''}` : '';
  return ls.map((l) => [lineUsers(l).map(fullName).join(', '), lineNumber(l)].filter(Boolean).join(' · ')).filter(Boolean).join(' / ');
}
const cfgDevices = () => D.devices.filter(kindOf).sort((a, b) => devName(a).localeCompare(devName(b), 'fr'));
const optsFor = (d) => CATALOG.filter((o) => o.kinds.includes(kindOf(d)) && (!o.models || o.models.test(String(d.model || '').toUpperCase())));
// Valeurs de départ quand on coche : défaut Yealink s'il est connu, sinon valeur proposée.
const defaults = (o) => Object.fromEntries(o.fields.map((f) => [f.key, f.type === 'password' ? randomPassword() : f.ydef ?? f.def]));
const stable = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}` : JSON.stringify(x));
function buildParams(settings) {
  const out = {};
  for (const o of CATALOG) {
    const s = settings?.[o.id];
    if (!s) continue;
    if (s.__reset) { if (!NOT_RESET.has(o.id)) for (const k of Object.keys(o.params(defaults(o)))) out[k] = '%NULL%'; }
    else Object.assign(out, o.params(s));
  }
  return out;
}
const isOn = (s) => !!s && !s.__reset;

function renderDevList() {
  const q = $('c-search').value.trim().toLowerCase();
  const ul = $('devlist');
  ul.innerHTML = '';
  const all = cfgDevices();
  for (const d of all) {
    const users = devUsers(d);
    if (q && !`${devName(d)} ${d.mac || ''} ${d.model || ''} ${users.join(' ')}`.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.className = C.sel === d.id ? 'sel' : '';
    if (d.description && devName(d) !== d.description) li.title = d.description;
    li.innerHTML = `<span>${stDot(d)}${esc(devName(d))}${devSub(d) ? `<br><span class="muted small">${esc(devSub(d))}</span>` : ''}</span><span class="sub">${esc(modelLabel(d))}${kindOf(d) === 'dect' ? ' · DECT' : ''}</span>`;
    li.onclick = () => guardCfg(() => selectDevice(d.id));
    ul.appendChild(li);
  }
  $('c-count').textContent = `${all.length} appareil(s) Yealink`;
}
async function selectDevice(id) {
  C.sel = id; C.loading = true;
  renderDevList(); renderCfg();
  try {
    const [pd, tpl] = await Promise.all([provdDevice(id), deviceTemplate(devById(id))]);
    if (C.sel !== id) return;
    C.tpl = tpl;
    const s = pd.options?.astrea_settings;
    C.orig = s && typeof s === 'object' ? s : {};
    C.edit = JSON.parse(JSON.stringify(C.orig));
  } catch (e) { toast(e.message, 8000); C.orig = {}; C.edit = {}; }
  C.loading = false;
  renderCfg();
}
const cfgDirty = () => stable(C.edit) !== stable(C.orig);
function guardCfg(fn) {
  if (!cfgDirty()) return fn();
  confirmModal('<p>Des options ne sont pas enregistrées sur cet appareil. Les abandonner ?</p>', fn, 'Abandonner');
}
function fieldHtml(o, f, val, off = false) {
  const id = off ? '' : `f-${o.id}-${f.key}`;
  const attrs = off ? 'disabled' : `id="${id}" data-opt="${o.id}" data-key="${f.key}"`;
  if (f.type === 'select') return `<label>${esc(f.label)} <select ${attrs}>${f.options.filter(([v, , re]) => !re || re.test(String(devById(C.sel)?.model || '').toUpperCase()) || String(val) === v).map(([v, l]) => `<option value="${esc(v)}"${String(val) === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  if (f.type === 'days') return `<div class="days"><span class="muted small">${esc(f.label)}</span>${f.options.map(([v, l]) => `<label class="inline"><input type="checkbox" data-opt="${o.id}" data-key="${f.key}" data-day="${v}"${String(val).includes(v) ? ' checked' : ''}> ${esc(l)}</label>`).join('')}</div>`;
  if (f.type === 'password') return `<label>${esc(f.label)} <span class="pwrow"><input ${attrs} value="${esc(val)}" maxlength="32" autocomplete="off" spellcheck="false"><button data-gen="${o.id}" data-key="${f.key}">Générer</button></span></label>`;
  if (f.type === 'time') return `<label>${esc(f.label)} <input type="time" ${attrs} value="${esc(val)}"></label>`;
  return `<label>${esc(f.label)} <input type="number" ${attrs} min="${f.min}" max="${f.max}" value="${esc(val)}"></label>`;
}
function renderCfg() {
  const d = devById(C.sel);
  $('cfg').hidden = !d;
  $('empty').hidden = !!d;
  if (!d) { $('empty').textContent = 'Choisissez un appareil.'; return; }
  $('c-name').textContent = `${[d.vendor, d.model].filter(Boolean).join(' ')} · ${devName(d)}`;
  $('c-tech').textContent = [stText(d), d.mac && `MAC ${d.mac}`, d.ip && `IP publique ${kindOf(d) === 'dect' ? 'de la base' : 'de l\'appareil'} ${d.ip}`, d.version && `firmware ${d.version}`, d.plugin && `plugin ${d.plugin}`, devUsers(d).length && `utilisateur(s) : ${devUsers(d).join(', ')}`].filter(Boolean).join(' · ');
  const warn = [];
  if (kindOf(d) === 'dect' && /v86\b/.test(d.plugin || '')) warn.push('Plugin v86 : il ne gère pas les bases DECT, les options ne seront pas appliquées.');
  $('c-warn').innerHTML = warn.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  if (C.loading) { $('c-opts').innerHTML = '<p class="muted">Lecture de la configuration…</p>'; $('c-save').disabled = true; return; }
  $('c-opts').innerHTML = optsFor(d).map((o) => {
    const s = C.edit[o.id];
    const on = isOn(s);
    const changed = stable(s) !== stable(C.orig[o.id]);
    return `<div class="page opt${on ? ' on' : ''}${changed ? ' changed' : ''}">
      <div class="opthead"><label class="inline"><input type="checkbox" data-toggle="${o.id}"${on ? ' checked' : ''}> <strong>${esc(o.label)}</strong></label>${o.reboot ? '<span class="tag">redémarre l\'appareil</span>' : ''}${s?.__reset ? '<span class="tag">retour à la valeur par défaut à l\'enregistrement</span>' : ''}</div>
      <details><summary class="muted small">Aide</summary><p class="muted small">${esc(o.help)}</p></details>
      ${on ? `<div class="fields">${o.fields.map((f) => fieldHtml(o, f, s[f.key] ?? f.def)).join('')}</div>` : offHtml(o)}
    </div>`;
  }).join('') || '<p class="muted">Aucune option pour ce modèle.</p>';
  $('c-save').disabled = !cfgDirty();
  $('c-bulk').disabled = !Object.values(C.edit).some(isOn) && !Object.values(C.edit).some((s) => s?.__reset);
}
// VLAN / mot de passe décochés : valeurs du modèle de provisionnement de l'appareil.
function templateText(o) {
  if (!['vlan', 'adminpw'].includes(o.id) || !C.tpl) return '';
  const name = `modèle « ${esc(C.tpl.label)} »`;
  const r = C.tpl.raw;
  if (!r) return `${name} (illisible : droits provd ?).`;
  if (o.id === 'vlan') {
    const on = r.vlan_enabled === true || r.vlan_enabled === 1 || r.vlan_enabled === '1';
    return on ? `<strong>VLAN ${esc(r.vlan_id ?? '?')}</strong>, priorité ${esc(r.vlan_priority ?? 'non définie')}${r.vlan_pc_port_id ? `, port PC VLAN ${esc(r.vlan_pc_port_id)}` : ''} — ${name}.` : `<strong>pas de VLAN</strong> (untag) — ${name}.`;
  }
  if (!r.admin_password) return `aucun mot de passe admin défini dans le ${name} (valeur par défaut du poste).`;
  return `utilisateur <strong>${esc(r.admin_username || 'admin')}</strong>, mot de passe <span class="pwmask" data-pw="${esc(r.admin_password)}">••••••••</span> <button class="linkbtn" data-reveal>Afficher</button> — ${name}.`;
}
// Option décochée : ce qui s'applique quand Astrea n'écrit rien (grisé).
function offHtml(o) {
  const tplText = templateText(o);
  if (tplText) return `<p class="muted small offval">Décoché : ${tplText}</p>`;
  if (o.offText) return `<p class="muted small offval">Décoché : ${esc(o.offText)}</p>`;
  return `<div class="fields off">${o.fields.map((f) => (f.ydef !== undefined ? fieldHtml(o, f, f.ydef, true) : `<label>${esc(f.label)} <span class="muted small">${esc(f.ydefText || 'défaut Yealink')}</span></label>`)).join('')}<span class="muted small">Valeur par défaut Yealink (rien n'est écrit)</span></div>`;
}
function readField(el) {
  const o = C.edit[el.dataset.opt];
  if (!isOn(o)) return;
  if (el.dataset.day !== undefined) {
    const days = [...document.querySelectorAll(`input[data-opt="${el.dataset.opt}"][data-key="${el.dataset.key}"][data-day]`)].filter((x) => x.checked).map((x) => x.dataset.day).sort().join('');
    o[el.dataset.key] = days;
  } else o[el.dataset.key] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
  $('c-save').disabled = !cfgDirty();
}
function toggleOpt(id, on) {
  const o = CATALOG.find((x) => x.id === id);
  if (on) C.edit[id] = isOn(C.orig[id]) ? JSON.parse(JSON.stringify(C.orig[id])) : defaults(o);
  else if (isOn(C.orig[id]) || C.orig[id]?.__reset) C.edit[id] = { __reset: 1 }; // déjà appliquée : remise à zéro
  else delete C.edit[id];
  if (!on && NOT_RESET.has(id) && C.edit[id]?.__reset) delete C.edit[id]; // VLAN / mot de passe : le modèle Wazo reprend la main
  renderCfg();
}
// Contrôle des champs ; renvoie la liste des erreurs.
function validate(settings, d) {
  const errs = [];
  for (const o of optsFor(d)) {
    const s = settings[o.id];
    if (!isOn(s)) continue;
    for (const f of o.fields) { const r = checkField(f, s[f.key]); if (r.err) errs.push(`${o.label} : ${r.err}`); else s[f.key] = r.v; }
  }
  return errs;
}
const paramLines = (p) => Object.keys(p).sort().map((k) => `${k} = ${p[k]}`);
function saveCfg() {
  if (!canWrite()) return;
  const d = devById(C.sel);
  const next = JSON.parse(JSON.stringify(C.edit));
  const errs = validate(next, d);
  if (errs.length) { toast(errs.join(' · '), 8000); return; }
  const before = buildParams(C.orig), after = buildParams(next);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((k) => before[k] !== after[k]);
  const reboot = CATALOG.some((o) => o.reboot && stable(next[o.id]) !== stable(C.orig[o.id]));
  confirmModal(`<h3>Enregistrer ${esc(devName(d))}</h3>
    ${keys.length ? `<table class="diff"><tr><th>Paramètre Yealink</th><th>Avant</th><th>Après</th></tr>${keys.map((k) => `<tr><td><code>${esc(k)}</code></td><td class="muted">${esc(before[k] ?? '—')}</td><td><strong>${esc(after[k] ?? '(n\'est plus écrit)')}</strong></td></tr>`).join('')}</table>` : '<p class="muted">Aucun paramètre modifié.</p>'}
    ${reboot ? '<div class="warn">VLAN ou mot de passe modifié : l\'appareil redémarrera en appliquant sa configuration.</div>' : ''}${syncWarn([d.id])}
    <label class="inline"><input type="checkbox" id="m-sync"${reboot ? '' : ' checked'}> Synchroniser l'appareil maintenant (sinon : au prochain redémarrage ou provisionnement planifié)</label>`, async () => {
    const sync = $('m-sync').checked;
    try {
      await updateProvdOptions(d.id, (opts) => applySettings(opts, next));
      if (sync) await api('GET', `/devices/${d.id}/synchronize`);
      toast('Configuration enregistrée');
    } catch (e) { toast(e.message, 9000); }
    await selectDevice(d.id);
  }, 'Enregistrer');
}
// Écrit astrea_settings / astrea_params dans les options provd (retirés si vides).
function applySettings(opts, settings) {
  const s = Object.fromEntries(Object.entries(settings).filter(([, v]) => v));
  const p = buildParams(s);
  if (Object.keys(s).length) opts.astrea_settings = s; else delete opts.astrea_settings;
  if (Object.keys(p).length) opts.astrea_params = p; else delete opts.astrea_params;
}
// Appliquer les options cochées (ou les retirer) sur d'autres appareils.
function openBulk() {
  if (!canWrite() || cfgDirty()) { if (cfgDirty()) toast('Enregistrez ou annulez d\'abord les modifications de cet appareil.', 5000); return; }
  const d = devById(C.sel);
  const chosen = optsFor(d).filter((o) => isOn(C.edit[o.id]));
  if (!chosen.length) { toast('Cochez d\'abord les options à appliquer sur cet appareil.'); return; }
  const kind = kindOf(d);
  const targets = cfgDevices().filter((x) => kindOf(x) === kind && x.id !== d.id);
  confirmModal(`<h3>Appliquer à d'autres appareils</h3>
    <p>Options : ${chosen.map((o) => `<strong>${esc(o.label)}</strong>`).join(', ')}${chosen.some((o) => o.id === 'adminpw') ? ' <span class="muted small">(un mot de passe différent est généré pour chaque appareil)</span>' : ''}.</p>
    <label>Action <select id="m-mode"><option value="set">Appliquer ces options avec ces valeurs (les autres options de chaque appareil sont conservées)</option><option value="reset">Retirer ces options (retour au modèle de la stack / valeur par défaut)</option></select></label>
    <label>Filtrer <input id="m-q" placeholder="Nom, modèle, utilisateur…"></label>
    <div class="btnrow"><button id="m-all">Tout cocher</button><button id="m-none">Tout décocher</button><span id="m-n" class="muted small" style="align-self:center"></span></div>
    <label class="inline"><input type="checkbox" id="m-withusers" checked> Seulement les appareils avec un utilisateur</label>
    <ul id="m-devs" class="pick">${targets.map((x) => `<li data-users="${devUsers(x).length}"><label class="inline"><input type="checkbox" data-dev="${esc(x.id)}"> ${esc(devName(x))} <span class="muted small">${esc(modelLabel(x))}${devUsers(x).length ? ' · ' + esc(devUsers(x).join(', ')) : ''}</span>${devUsers(x).length ? '' : ' <span class="tag">sans ligne</span>'}</label></li>`).join('') || '<li class="off">Aucun autre appareil de ce type.</li>'}</ul>
    <label class="inline"><input type="checkbox" id="m-sync"> Synchroniser les appareils (${chosen.some((o) => o.reboot) ? 'ils redémarreront' : 'redémarrage possible'})</label>
    <p class="muted small">Les options non disponibles sur un modèle sont ignorées pour cet appareil. Une sauvegarde des options actuelles est téléchargée avant d'écrire.</p>`, async () => {
    const ids = [...document.querySelectorAll('#m-devs input[data-dev]:checked')].map((x) => x.dataset.dev);
    if (!ids.length) { toast('Cochez au moins un appareil.'); return false; }
    const mode = $('m-mode').value, sync = $('m-sync').checked;
    await bulkApply(ids, chosen, mode, sync);
  }, 'Appliquer');
  const count = () => { $('m-n').textContent = `${document.querySelectorAll('#m-devs input[data-dev]:checked').length} sélectionné(s)`; };
  $('m-devs').onchange = count;
  $('m-all').onclick = () => { document.querySelectorAll('#m-devs li:not([hidden]) input[data-dev]').forEach((x) => (x.checked = true)); count(); };
  $('m-none').onclick = () => { document.querySelectorAll('#m-devs input[data-dev]').forEach((x) => (x.checked = false)); count(); };
  // Filtres : texte + « avec un utilisateur » (un appareil masqué est décoché).
  const filter = () => {
    const q = $('m-q').value.trim().toLowerCase(), withUsers = $('m-withusers').checked;
    document.querySelectorAll('#m-devs li[data-users]').forEach((li) => {
      li.hidden = (!!q && !li.textContent.toLowerCase().includes(q)) || (withUsers && li.dataset.users === '0');
      if (li.hidden) li.querySelector('input').checked = false;
    });
    count();
  };
  $('m-q').oninput = filter;
  $('m-withusers').onchange = filter;
  filter();
  count();
}
async function bulkApply(ids, chosen, mode, sync) {
  const backup = [];
  let ok = 0, ko = 0;
  for (const [i, id] of ids.entries()) {
    toast(`Appareil ${i + 1}/${ids.length}…`, 60000);
    const dev = devById(id);
    try {
      await updateProvdOptions(id, (opts) => {
        backup.push({ id, mac: dev?.mac, model: dev?.model, astrea_settings: opts.astrea_settings ?? null, astrea_params: opts.astrea_params ?? null });
        const s = { ...(opts.astrea_settings || {}) };
        for (const o of chosen) {
          if (!optsFor(dev).includes(o)) continue;
          if (mode === 'set') s[o.id] = o.id === 'adminpw' ? { pwd: randomPassword() } : JSON.parse(JSON.stringify(C.edit[o.id]));
          else if (NOT_RESET.has(o.id)) delete s[o.id];
          else s[o.id] = { __reset: 1 };
        }
        applySettings(opts, s);
      });
      if (sync) await api('GET', `/devices/${id}/synchronize`);
      ok++;
    } catch (e) { ko++; console.error(devName(dev || { id }), e); }
  }
  downloadJson(`astrea-phones-sauvegarde-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, { app: 'astrea-phones', created: new Date().toISOString(), base: S.base, tenant: S.tenant, devices: backup });
  toast(`${ok} appareil(s) mis à jour${ko ? `, ${ko} en erreur (console)` : ''}. Sauvegarde des options précédentes téléchargée.`, 9000);
}

// Bascule Bases DECT / Configuration.
function setView(v) {
  VIEW = v;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('side-dect').hidden = v !== 'dect';
  $('side-config').hidden = v !== 'config';
  if (v === 'dect') { $('cfg').hidden = true; renderBase(); }
  else { $('base').hidden = true; $('empty').hidden = !!C.sel; if (!C.sel) $('empty').textContent = 'Choisissez un appareil.'; renderDevList(); renderCfg(); }
}
// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
$('search').oninput = renderList;
$('found').onclick = (e) => { const h = e.target.closest('.hit'); if (h) { D.sel = h.dataset.dev; render(); } };
$('b-assign').onclick = openAssign;
$('b-sync').onclick = () => {
  if (!canWrite()) return;
  const off = devState(devById(D.sel)).st === 'off';
  syncDevices([D.sel]).then(() => toast(off ? 'Synchronisation demandée, mais la base n\'est pas connectée à la stack : elle ne la recevra pas.' : 'Synchronisation demandée', off ? 7000 : 2600));
};
$('b-rows').onclick = (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'remove') openRemove(Number(b.dataset.line));
};
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => {
  const go = () => setView(b.dataset.view);
  if (b.dataset.view === 'config' && pendingChanges().length) { toast('Des déplacements DECT sont en attente : enregistrez-les ou annulez-les d\'abord.', 5000); return; }
  if (b.dataset.view === 'dect') guardCfg(go); else go();
}));
$('c-search').oninput = renderDevList;
$('c-opts').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.toggle) return toggleOpt(t.dataset.toggle, t.checked);
  if (t.dataset.opt) readField(t);
});
$('c-opts').addEventListener('input', (e) => { if (e.target.dataset.opt && !e.target.dataset.day && e.target.tagName === 'INPUT') readField(e.target); });
$('c-opts').addEventListener('click', (e) => {
  const rv = e.target.closest('button[data-reveal]');
  if (rv) { e.preventDefault(); const m = rv.previousElementSibling; const shown = m.textContent !== '••••••••'; m.textContent = shown ? '••••••••' : m.dataset.pw; rv.textContent = shown ? 'Afficher' : 'Masquer'; return; }
  const b = e.target.closest('button[data-gen]');
  if (!b) return;
  e.preventDefault();
  const inp = $(`f-${b.dataset.gen}-${b.dataset.key}`);
  inp.value = randomPassword();
  readField(inp);
});
$('c-save').onclick = saveCfg;
$('c-revert').onclick = () => { C.edit = JSON.parse(JSON.stringify(C.orig)); renderCfg(); };
$('c-bulk').onclick = openBulk;$('b-save').onclick = savePlan;
$('b-revert').onclick = () => { D.plan.clear(); render(); };
window.addEventListener('beforeunload', (e) => { if (pendingChanges().length || cfgDirty()) { e.preventDefault(); e.returnValue = ''; } });
wireDragDrop();
// État d'enregistrement rafraîchi toutes les minutes (pastilles seulement).
setInterval(async () => {
  if (document.hidden || !S.token) return;
  await loadReg();
  if (VIEW === 'config') renderDevList(); else renderList();
}, 60000);
connect(boot);
