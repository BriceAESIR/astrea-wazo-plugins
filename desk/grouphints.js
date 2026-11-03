// Astrea Desk — membres de groupe inscrits par touche : INDICE tiré du journal
// d'appels (0.8.1, choix de Brice le 02/11/2026). Wazo n'expose la liste réelle
// (Asterisk) qu'au tenant principal : amid @required_master_tenant, et ses
// événements (AMIEvent = ServiceEvent, sans tenant_uuid) ne passent pas le
// filtre tenant de wazo-websocketd. Vérifié dans le code le 02/11/2026.
//
// Codes (vérifié : xivo-manage-db populate.sql, wazo-confgend extensionsconf,
// wazo-agid group_member.py) : *50<groupe> bascule, *51<groupe> entrée,
// *52<groupe> sortie ; la bascule regarde si l'utilisateur est inscrit puis
// entre ou sort. Une touche de poste passe par *735 (phoneprogfunckey) :
// *735<id utilisateur>***2<code sans *>*<groupe>, découpé par
// xivo_helpers.split_extension (ex. réel *7353***250*2 = utilisateur 3,
// *50, groupe 2). Les codes sont relus dans confd /extensions/features s'ils
// ont été changés ; défauts sinon.
//
// Déduction : une entrée ou une sortie fixe l'état ; une bascule l'inverse,
// seulement si l'état d'avant est connu. Supposé, non vérifié : un code
// composé apparaît toujours dans le journal (appel interne non répondu, vu en
// réel), et un échec (groupe d'un autre tenant…) y apparaît aussi.
import { S, api, fullName } from '../admin-tools/common/core.js?v=0.9.5';
import { M } from './cfbridge.js?v=0.9.5';

export const DAYS = 30;
const PAGE = 1000, MAX = 10000;
const DEF = { groupmembertoggle: '*50', groupmemberjoin: '*51', groupmemberleave: '*52', phoneprogfunckey: '*735' };
const ACTION = { groupmembertoggle: 'toggle', groupmemberjoin: 'join', groupmemberleave: 'leave' };

// Port de xivo_helpers.split_extension (xivo-lib-python).
export function splitExtension(exten) {
  let flag = 0, cur = '', i = 1; const ret = [];
  for (const x of exten) {
    if (flag === 2) {
      if (/\d/.test(x)) { if (+x !== i) return null; flag = 0; cur += '*'; }
      else if (x === '*') { ret.push(cur); cur = ''; i++; }
      else return null;
    } else if (x === '*') flag++;
    else if (flag === 1) { flag = 0; ret.push(cur); cur = x; i++; }
    else cur += x;
  }
  ret.push(cur);
  return ret;
}

async function featureCodes() {
  const codes = { ...DEF };
  try {
    const r = await api('GET', '/extensions/features');
    for (const f of r?.items || []) if (f.feature in DEF && f.enabled !== false && f.exten) codes[f.feature] = String(f.exten).replace(/^_/, '').replace(/[.!X]+$/, '');
  } catch { /* droit absent : codes par défaut */ }
  return codes;
}

// Code composé → { action, group, userId? } ou null.
export function parseCode(exten, codes = DEF) {
  if (!exten || exten[0] !== '*') return null;
  const acts = Object.entries(ACTION).map(([f, a]) => [codes[f], a]).filter(([c]) => c).sort((a, b) => b[0].length - a[0].length);
  const prog = codes.phoneprogfunckey;
  if (prog && exten.startsWith(prog)) {
    const p = splitExtension(exten.slice(prog.length));
    if (p && p.length === 3 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[2])) {
      const a = acts.find(([c]) => c === p[1]);
      if (a) return { action: a[1], group: +p[2], userId: +p[0] };
    }
    return null;
  }
  for (const [c, a] of acts) if (exten.startsWith(c) && /^\d+$/.test(exten.slice(c.length))) return { action: a, group: +exten.slice(c.length) };
  return null;
}

async function cdrPage(params) {
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  const r = await fetch(`${S.base}/api/call-logd/1.0/cdr?${new URLSearchParams(params)}`, { headers });
  if (!r.ok) throw new Error(`journal d'appels : erreur ${r.status}`);
  return r.json();
}

// Map group.id → [{ uuid, name, state: true|false|null, last: {action, at}, n, anchorAt }]
let CACHE = null;
export async function loadGroupHints(force = false) {
  if (CACHE && !force && CACHE.tenant === S.tenant && Date.now() - CACHE.at < 60e3) return CACHE;
  if (!S.tenant) throw new Error('Site non reconnu : reconnectez-vous.');
  const tenant = S.tenant;
  const codes = await featureCodes();
  const until = new Date(), from = new Date(until.getTime() - DAYS * 86400e3);
  const rows = []; let truncated = false;
  for (let offset = 0; ; offset += PAGE) {
    const j = await cdrPage({ from: from.toISOString(), until: until.toISOString(), call_direction: 'internal', order: 'start', direction: 'asc', limit: PAGE, offset });
    const items = j?.items || [];
    rows.push(...items);
    if (items.length < PAGE) break;
    if (offset + PAGE >= MAX) { truncated = true; break; }
  }
  const groups = new Map((M.lists.group || []).map((g) => [g.id, g]));
  const users = M.lists.user || [];
  const byId = new Map(users.map((u) => [u.id, u])), byUuid = new Map(users.map((u) => [u.uuid, u]));
  const byExten = new Map(users.flatMap((u) => (u.lines || []).flatMap((l) => (l.extensions || []).map((e) => [e.exten, u]))));
  const hints = new Map();
  for (const c of rows) {
    if (c.tenant_uuid && c.tenant_uuid !== tenant) continue; // toujours le seul tenant du site
    const p = parseCode(c.requested_extension || c.destination_extension, codes);
    if (!p || !groups.has(p.group)) continue;
    const u = (c.source_user_uuid && byUuid.get(c.source_user_uuid)) || (p.userId != null && byId.get(p.userId)) || byExten.get(c.source_extension || c.source_internal_extension);
    if (!u) continue;
    if (!hints.has(p.group)) hints.set(p.group, new Map());
    const g = hints.get(p.group);
    const h = g.get(u.uuid) || { uuid: u.uuid, name: fullName(u) || u.username || u.uuid, state: null, n: 0, anchorAt: null, last: null };
    if (p.action === 'join') { h.state = true; h.anchorAt = c.start; }
    else if (p.action === 'leave') { h.state = false; h.anchorAt = c.start; }
    else if (h.state !== null) h.state = !h.state;
    h.n++; h.last = { action: p.action, at: c.start }; h.first ||= c.start;
    g.set(u.uuid, h);
  }
  const out = new Map([...hints].map(([gid, m]) => [gid, [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'))]));
  if (S.tenant !== tenant) return null;
  CACHE = { tenant, at: Date.now(), hints: out, truncated, codes };
  return CACHE;
}

const pad = (n) => String(n).padStart(2, '0');
const when = (iso) => { const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} à ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// Textes courts pour le client final (demande de Brice, 03/11/2026) : l'état
// probable et la dernière utilisation de la touche, rien de technique. Avec des
// bascules seules, l'état de départ manque : « état incertain », sans
// hypothèse (le détail de la déduction est dans docs/ASTREA-DESK.md § 0.8.1).
export function hintText(h) {
  const state = h.state === true ? 'probablement dans le groupe' : h.state === false ? 'probablement sorti' : 'état incertain';
  return { state, tip: `Touche utilisée pour la dernière fois le ${when(h.last.at)}.` };
}
