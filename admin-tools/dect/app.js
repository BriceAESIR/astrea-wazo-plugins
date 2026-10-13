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
import { S, $, esc, toast, api, listAll, confirmModal, connect, fullName, canWrite, setReadonly, showCompat, loaded, loadFailed } from '../common/core.js?v=0.18.0';

// Comptes SIP par modèle (_NB_SIP_ACCOUNTS / plugin-info des plugins provd).
const DECT_MAX = {
  W60B: 8, W70B: 10, W75B: 20, W75DM: 20, W80B: 100, W80DM: 100, W90B: 250, W90DM: 250,
  'N610 IP PRO': 8, 'N670 IP PRO': 20, 'N770 IP PRO': 100, 'N870 IP PRO': 250, 'N870E IP PRO': 250,
  'N720 IP PRO': 100, 'N720 DM PRO': 100, 'N510 IP PRO': 6,
};
const isDect = (d) => !!d && d.model in DECT_MAX;
const D = { devices: [], lines: [], users: [], byLineUsers: new Map(), sel: null, scope: null };

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
async function boot() {
  $('conn').textContent = 'Chargement…';
  document.body.classList.remove('idle');
  const scope = `${S.base}|${S.tenant}`;
  if (D.scope !== scope) D.sel = null;
  D.scope = scope;
  try {
    await reload();
    loaded();
    $('conn').textContent = `${new URL(S.base).host}`;
  } catch (e) { loadFailed(e); }
}
async function reload() {
  const [devices, lines, users] = await Promise.all([listAll('/devices'), listAll('/lines'), listAll('/users')]);
  selfCheck(devices, lines);
  D.devices = devices;
  D.lines = lines;
  D.users = users.sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  D.byLineUsers = new Map();
  for (const u of users) for (const l of u.lines || []) {
    if (!D.byLineUsers.has(l.id)) D.byLineUsers.set(l.id, []);
    D.byLineUsers.get(l.id).push(u);
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
const baseName = (d) => d.description || d.ip || d.mac || `Appareil ${d.id}`;
const linesOf = (devId) => D.lines.filter((l) => l.device_id === devId).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
const lineUsers = (l) => D.byLineUsers.get(l.id) || l.users || [];
const lineNumber = (l) => (l.extensions || [])[0]?.exten || '';
const lineLabel = (l) => `${(l.protocol || (l.endpoint_sip ? 'sip' : '')).toUpperCase()} ${l.name || l.endpoint_sip?.name || l.endpoint_sip?.username || `#${l.id}`}`.trim();
const devById = (id) => D.devices.find((d) => d.id === id);
const devLabel = (d) => (d ? `${[d.vendor, d.model].filter(Boolean).join(' ') || 'appareil'} ${d.description || d.mac || d.ip || ''}`.trim() : '');
function usedPositions(devId, exceptLineId) {
  return new Set(linesOf(devId).filter((l) => l.id !== exceptLineId && l.position).map((l) => l.position));
}
function freePositions(dev, exceptLineId) {
  const used = usedPositions(dev.id, exceptLineId);
  const out = [];
  for (let p = 1; p <= DECT_MAX[dev.model]; p++) if (!used.has(p)) out.push(p);
  return out;
}
const ranges = (ps) => {
  const r = [];
  for (const p of ps) { const last = r[r.length - 1]; if (last && p === last[1] + 1) last[1] = p; else r.push([p, p]); }
  return r.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
};
// Alertes d'une base : [{ level: 'bad' | 'warn', text }]
function alertsOf(dev) {
  const max = DECT_MAX[dev.model];
  const ls = linesOf(dev.id);
  const out = [];
  const count = new Map();
  for (const l of ls) if (l.position) count.set(l.position, (count.get(l.position) || 0) + 1);
  const dups = [...count].filter(([, n]) => n > 1).map(([p]) => p);
  if (dups.length) out.push({ level: 'bad', text: `Plusieurs lignes au compte ${dups.join(', ')} : une seule est réellement provisionnée.` });
  const over = ls.filter((l) => l.position > max).map((l) => l.position);
  if (over.length) out.push({ level: 'bad', text: `Compte(s) ${over.join(', ')} au-delà du maximum du ${dev.model} (${max}) : non provisionnés.` });
  if (ls.some((l) => !l.position)) out.push({ level: 'warn', text: 'Ligne sans position.' });
  const orphan = ls.filter((l) => !lineUsers(l).length);
  if (orphan.length) out.push({ level: 'warn', text: `${orphan.length} ligne(s) sans utilisateur.` });
  if (ls.length >= max) out.push({ level: 'warn', text: `Base pleine (${ls.length}/${max}).` });
  if (/yealink/i.test(`${dev.vendor} ${dev.plugin}`) && /v86\b/.test(dev.plugin || '')) out.push({ level: 'bad', text: `Plugin provd ${dev.plugin} : il ne gère pas les bases DECT (utiliser wazo-yealink-v87).` });
  if (!dev.plugin) out.push({ level: 'warn', text: 'Aucun plugin provd associé.' });
  if (dev.status && dev.status !== 'configured') out.push({ level: 'warn', text: `État de provisionnement : ${dev.status}.` });
  if (!ls.length && /^W(75|80|90)B$/.test(dev.model)) out.push({ level: 'warn', text: 'Aucun compte : base secondaire d\'un multicellule ? (seule la base maître porte les comptes).' });
  return out;
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
function render() {
  renderList();
  renderBase();
}
function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const bs = bases();
  const ul = $('baselist');
  ul.innerHTML = '';
  for (const d of bs) {
    const hay = `${baseName(d)} ${d.model} ${d.mac || ''} ${d.ip || ''}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const n = linesOf(d.id).length, max = DECT_MAX[d.model];
    const al = alertsOf(d);
    const li = document.createElement('li');
    li.className = D.sel === d.id ? 'sel' : '';
    li.innerHTML = `<span>${esc(baseName(d))}${al.length ? `<span class="dot${al.some((a) => a.level === 'bad') ? ' bad' : ''}" title="${esc(al.map((a) => a.text).join('\n'))}"></span>` : ''}</span><span class="sub">${esc(d.model)} · <span class="occ${n >= max ? ' full' : ''}">${n}/${max}</span></span>`;
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
  if (!d) return;
  const max = DECT_MAX[d.model];
  const ls = linesOf(d.id);
  $('b-name').textContent = `${[d.vendor, d.model].filter(Boolean).join(' ')} · ${baseName(d)}`;
  $('b-tech').textContent = [d.mac && `MAC ${d.mac}`, d.ip && `IP ${d.ip}`, d.version && `firmware ${d.version}`, d.plugin && `plugin ${d.plugin}`, d.status && `état ${d.status}`].filter(Boolean).join(' · ');
  $('b-warn').innerHTML = alertsOf(d).map((a) => `<div class="warn">${a.level === 'bad' ? `<span class="error">${esc(a.text)}</span>` : esc(a.text)}</div>`).join('');
  $('b-title').textContent = `Comptes · ${ls.length}/${max}`;
  const count = new Map();
  for (const l of ls) count.set(l.position, (count.get(l.position) || 0) + 1);
  $('b-rows').innerHTML = ls.map((l) => {
    const us = lineUsers(l);
    return `<tr${count.get(l.position) > 1 || l.position > max ? ' class="dup"' : ''}><td>${l.position ?? '—'}</td><td>${esc(us.map(fullName).join(', ')) || '<span class="muted">sans utilisateur</span>'}</td><td>${esc(lineNumber(l))}</td><td class="muted small">${esc(lineLabel(l))}</td>
      <td><button data-act="move" data-line="${l.id}">Déplacer</button> <button data-act="remove" data-line="${l.id}" class="danger">Retirer</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">Aucune ligne sur cette base.</td></tr>';
  const free = freePositions(d);
  $('b-free').textContent = free.length ? `Comptes libres : ${ranges(free)}` : 'Aucun compte libre.';
  $('b-assign').disabled = !free.length;
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
  if (!canWrite()) return;
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
// Déplacer : vers une autre base (ou un autre compte de la même base).
function openMove(lineId) {
  if (!canWrite()) return;
  const line = D.lines.find((l) => l.id === lineId);
  const d = devById(line.device_id);
  const targets = bases();
  confirmModal(`<h3>Déplacer ${esc(lineUsers(line).map(fullName).join(', ') || lineLabel(line))}</h3>
    <p class="muted small">Actuellement : ${esc(baseName(d))}, compte ${line.position ?? '?'}.</p>
    <label>Base <select id="m-dev">${targets.map((b) => `<option value="${b.id}"${b.id === d.id ? ' selected' : ''}>${esc(baseName(b))} · ${esc(b.model)} (${linesOf(b.id).length}/${DECT_MAX[b.model]})</option>`).join('')}</select></label>
    <label>Compte (position) <select id="m-pos"></select></label>${syncBox()}`, async () => {
    const dev = $('m-dev').value, pos = Number($('m-pos').value);
    if (!pos) { toast('Aucun compte libre sur cette base.'); return false; }
    const sync = $('m-sync').checked;
    await run(`Ligne déplacée au compte ${pos}`, async () => {
      const old = await placeLine(lineId, dev, pos);
      if (sync) await syncDevices([dev, old]);
    });
  }, 'Déplacer');
  const fill = () => {
    const b = devById($('m-dev').value);
    $('m-pos').innerHTML = freePositions(b, lineId).filter((p) => !(b.id === d.id && p === line.position)).map((p) => `<option value="${p}">${p}</option>`).join('');
  };
  $('m-dev').onchange = fill;
  fill();
}
function openRemove(lineId) {
  if (!canWrite()) return;
  const line = D.lines.find((l) => l.id === lineId);
  const d = devById(line.device_id);
  confirmModal(`<h3>Retirer de la base</h3><p>${esc(lineUsers(line).map(fullName).join(', ') || 'Ligne sans utilisateur')} ${esc(lineNumber(line))} (compte ${line.position ?? '?'}) ne sera plus provisionnée sur ${esc(baseName(d))}. La ligne et l'utilisateur restent dans Wazo.</p>${syncBox()}`, async () => {
    const sync = $('m-sync').checked;
    await run('Ligne retirée de la base', async () => {
      await api('DELETE', `/lines/${lineId}/devices/${d.id}`);
      if (sync) await syncDevices([d.id]);
    });
  }, 'Retirer');
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
$('search').oninput = renderList;
$('found').onclick = (e) => { const h = e.target.closest('.hit'); if (h) { D.sel = h.dataset.dev; render(); } };
$('b-assign').onclick = openAssign;
$('b-sync').onclick = () => { if (canWrite()) syncDevices([D.sel]).then(() => toast('Synchronisation demandée')); };
$('b-rows').onclick = (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'move') openMove(Number(b.dataset.line));
  if (b.dataset.act === 'remove') openRemove(Number(b.dataset.line));
};
connect(boot);
