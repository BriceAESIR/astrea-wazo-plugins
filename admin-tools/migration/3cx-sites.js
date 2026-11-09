// Migration Assistant — import 3CX : où installer le client sur la stack, et
// contrôle des contextes (demandes de Brice, 03-04/11/2026). Sans DOM.
//
// Organisation de Brice : le Portal découpe en tenant puis sites Wazo. Des
// établissements qui s'appellent en interne, chacun avec son trunk, sont sur
// le même site Wazo, un contexte interne par établissement ; des
// établissements qui ne s'appellent pas (franchise) sont sur des sites Wazo
// distincts.
//
// Jeu de contextes = « unité » : tout le client (un seul département 3CX
// retenu) ou un département 3CX « propre » (3cx-depts.js). Une seule unité :
//  - dedicated : site Wazo dédié au client (contexte interne existant) ;
//  - existing  : site partagé, contexte interne existant choisi ;
//  - new       : site partagé, contexte interne + contexte sortant créés pour
//                le client, inclusions avec les autres établissements en option.
// Plusieurs unités : un nouveau jeu de contextes par unité (contexte interne,
// sortant, trunk), inclusions entre unités et avec les établissements existants
// en option. Réglages par unité dans d.write.units[clé].
//
// Règle sortante : assistant France de Call Flow Manager (mêmes familles de
// motifs, même transformation, blocage des 118). Recherche d'un numéro : même
// moteur que la simulation de Call Flow (dialsim.js, vérifié dans pbx.c) :
// extensions du contexte d'abord (numéro exact avant motif, motif le plus
// précis), puis contextes inclus dans l'ordre, chacun une seule fois.
// Conséquence vérifiée par la simulation, pas supposée : un motif attrape-tout
// (_X.) inclus avant un autre établissement prend aussi ses numéros internes ;
// inclus après, les numéros externes passent par l'établissement inclus, donc
// par son trunk. Les écarts sont montrés avant écriture.
import { matches, comparePatterns, dialedNumber } from '../callflow/dialsim.js?v=0.40.60';
import { FR_FAMILIES, FR_FORMATS, frTransform, BLOCK_118 } from '../callflow/outcall-editor.js?v=0.40.60';
import { imported, didWazo } from './3cx-draft.js?v=0.40.60';
import { unitList, unitOf } from './3cx-depts.js?v=0.40.60';
import { parseRanges, rangesText, inRanges } from './multisite.js?v=0.40.60';

export { FR_FAMILIES, FR_FORMATS, BLOCK_118 };
export const SITE_MODES = {
  dedicated: 'Site Wazo dédié à ce client',
  existing: 'Site Wazo partagé : contexte interne existant',
  new: 'Site Wazo partagé : nouveau contexte pour ce client',
};
export const defaultSite = () => ({ mode: null, newLabel: '', outLabel: '', inter: true, interUnits: true, peers: null, created: null });
// Format « nat » par défaut : la règle _X. de la procédure de Brice envoyait le
// numéro tel que composé.
export const defaultOut = () => ({ fams: FR_FAMILIES.map((f) => f.id), fmt: 'nat', block118: true, catchAll: false });
const NEW_CTX = (k) => `@nouveau-interne:${k}`;
const NEW_OUT = (k) => `@nouveau-sortant:${k}`;
const NEW_INC = (k) => `@nouveau-entrant:${k}`;
export const isVirtual = (name) => String(name || '').startsWith('@');

// Renumérotation multi-site (Brice, 09/11/2026) : le numéro Wazo d'un poste, groupe, file
// ou SVI est le préfixe de son site suivi du numéro 3CX à 3 chiffres (site 1 : 201 → 1201,
// 801 → 1801). Le brouillon garde le numéro 3CX comme clé (BLF, renvois, destinations) ;
// le numéro Wazo est calculé à la sortie (plages, CSV, contrôles, simulation, affichage).
// Case « Renuméroter » par jeu, DÉCOCHÉE par défaut (Brice, 09/11/2026 : les clients gardent
// leurs numéros, leurs annuaires locaux n'ont pas à changer ; la renumérotation est une
// suggestion). Un seul jeu : numéros inchangés.
export const renumbers = (d, unit) => unit != null && multi(d) && unitCfg(d, unit).renumber === true;
// Numéro saisi à la main (o.wn, demande de Brice : « on part sur une nouvelle base ») : prioritaire.
export function wazoNum(d, o) {
  if (o && String(o.wn ?? '').trim()) return String(o.wn).trim();
  if (!o || !/^\d{3}$/.test(String(o.n))) return o?.n;
  const u = unitOf(d, o); return u && renumbers(d, u) ? `${unitPrefix(d, u)}${o.n}` : o.n;
}
// Numéro Wazo d'un numéro 3CX (poste, groupe, file ou SVI du brouillon) ; sinon inchangé.
export function wazoNumOf(d, n) {
  const o = [...(d.users || []), ...(d.hunts || []), ...(d.ivrs || [])].find((x) => x.n === String(n));
  return o ? wazoNum(d, o) : n;
}
// Contrôles des numéros Wazo : chiffres seuls, pas deux objets repris au même numéro dans un
// même jeu de contextes (confd refuserait le second : numéro déjà pris dans le contexte).
export function numberIssues(d) {
  const out = []; const by = new Map();
  const objs = [...imported(d).map((o) => [o, 'Utilisateur']), ...d.users.filter((u) => u.mode === 'voicemail').map((o) => [o, 'Messagerie']), ...d.hunts.filter((h) => h.target !== 'skip').map((o) => [o, o.target === 'queue' ? 'File' : 'Groupe']), ...d.ivrs.filter((v) => v.import).map((o) => [o, 'SVI'])];
  for (const [o, what] of objs) {
    const n = wazoNum(d, o); const area = `${what} ${o.n}`;
    if (!/^\d{1,16}$/.test(String(n || ''))) { out.push({ sev: 'error', area, text: `numéro Wazo « ${n ?? ''} » invalide (chiffres seuls).` }); continue; }
    // Messagerie seule : numéro de boîte, pas d'extension ; comptée à part.
    const k = `${what === 'Messagerie' ? 'vm' : 'ext'}|${unitOf(d, o) || '_'}|${n}`;
    if (by.has(k)) out.push({ sev: 'error', area, text: `numéro Wazo ${n} déjà pris par ${by.get(k)}.` }); else by.set(k, area);
  }
  return out;
}
// Numéros qu'une unité apporte (postes, groupes, files) avec leur type de plage (numéros Wazo).
export function clientNumbers(d, unit = null) {
  const mine = (o) => unit == null || unitOf(d, o) === unit;
  return [
    ...imported(d).filter(mine).map((u) => ({ n: wazoNum(d, u), key: 'user_ranges' })),
    ...d.hunts.filter((h) => h.target === 'group' && mine(h)).map((h) => ({ n: wazoNum(d, h), key: 'group_ranges' })),
    ...d.hunts.filter((h) => h.target === 'queue' && mine(h)).map((h) => ({ n: wazoNum(d, h), key: 'queue_ranges' })),
  ].filter((x) => /^\d+$/.test(x.n));
}
// SDA reprises d'une unité, au format du contexte entrant Wazo (33…).
export const unitDids = (d, unit = null) => [...new Set(d.dids.filter((r) => r.import && (unit == null || unitOf(d, r) === unit)).map((r) => didWazo(r.did)).filter((n) => /^\d+$/.test(n)))];
// Motifs de la règle sortante (assistant France + attrape-tout en option).
export function clientPatterns(out) {
  const o = out || defaultOut(); const pats = [];
  for (const f of FR_FAMILIES.filter((x) => o.fams.includes(x.id))) for (const p of f.pats) pats.push({ exten: p, ...frTransform(f.kind, p, o.fmt) });
  if (o.catchAll) pats.push({ exten: '_X.', strip_digits: 0, external_prefix: '' });
  return pats.sort((a, b) => comparePatterns(a.exten, b.exten));
}
// Plages d'un nouveau contexte, par type et par longueur de numéro : une plage
// par bloc de numéros, coupée aux trous de plus de 20 (site A 200-260 et 321,
// au lieu de 200-321 qui déborderait sur le site B 300-320).
const GAP = 20;
// Plages standard d'un nouveau jeu de contextes (Brice, 09/11/2026) : postes 200-299,
// groupes 800-899, files 900-999, conférences 700-799. Les numéros du client qui n'y
// tombent pas ajoutent leurs propres plages, calculées comme avant.
export const STD_RANGES = { user_ranges: [{ start: '200', end: '299' }], group_ranges: [{ start: '800', end: '899' }], queue_ranges: [{ start: '900', end: '999' }], conference_room_ranges: [{ start: '700', end: '799' }] };
// Plusieurs jeux de contextes (Brice, 09/11/2026) : mêmes plages précédées du préfixe du
// site (site 1 : 1200-1299, 1800-1899, 1900-1999, 1700-1799 ; site 2 : 2200…). Préfixe
// choisi par jeu dans l'onglet Départements, rang du jeu par défaut. Pas de renumérotation :
// les numéros existants qui n'y tombent pas gardent leurs plages calculées en plus.
export const unitPrefix = (d, unit) => {
  const units = unitList(d); const i = units.findIndex((u) => u.key === unit);
  const own = String(unitCfg(d, unit).prefix ?? '').trim();
  return /^\d{1,2}$/.test(own) ? own : String(i < 0 ? 1 : i + 1);
};
// Plages préfixées seulement si le jeu est renuméroté ; sinon plages standard + celles des numéros existants.
export function stdRanges(d, unit = null) {
  if (unit == null || !renumbers(d, unit)) return STD_RANGES;
  const p = unitPrefix(d, unit);
  return Object.fromEntries(Object.entries(STD_RANGES).map(([k, l]) => [k, l.map((r) => ({ start: p + r.start, end: p + r.end }))]));
}
export function autoRanges(d, unit = null) {
  const calc = calcRanges(d, unit); const out = {}; const stds = stdRanges(d, unit);
  for (const [k] of RANGE_KEYS) {
    const std = stds[k] || [];
    const extra = (calc[k] || []).filter((r) => !std.some((s) => s.start.length === r.start.length && Number(s.start) <= Number(r.start) && Number(r.end) <= Number(s.end)));
    out[k] = [...std, ...extra];
  }
  return out;
}
function calcRanges(d, unit = null) {
  const out = {};
  for (const x of clientNumbers(d, unit)) (out[x.key] ||= []).push(x.n);
  for (const k of Object.keys(out)) {
    const by = new Map(); for (const n of new Set(out[k])) { if (!by.has(n.length)) by.set(n.length, []); by.get(n.length).push(n); }
    out[k] = [...by.values()].flatMap((l) => {
      l.sort((a, b) => Number(a) - Number(b)); const r = [];
      for (const n of l) { const last = r[r.length - 1]; if (last && Number(n) - Number(last.end) <= GAP) last.end = n; else r.push({ start: n, end: n }); }
      return r;
    });
  }
  return out;
}
// Plages saisies à la main (demande de Brice, 04/11/2026) : par jeu de contextes et
// par type, texte « 200-260, 321 » ; vide = plages calculées, « - » = aucune.
// Rangées dans d.write.units[clé].ranges (plusieurs jeux) ou d.write.site.ranges.
export const RANGE_KEYS = [['user_ranges', 'postes'], ['group_ranges', 'groupes'], ['queue_ranges', 'files'], ['conference_room_ranges', 'conférences']];
export const rangeCfg = (d, unit) => (unit != null && multi(d) ? unitCfg(d, unit) : d.write.site);
export function newRanges(d, unit = null) {
  const out = autoRanges(d, unit); const own = rangeCfg(d, unit)?.ranges || {};
  for (const [k] of RANGE_KEYS) {
    const txt = String(own[k] ?? '').trim(); if (!txt) continue;
    if (txt === '-') { delete out[k]; continue; }
    const { ranges, errors } = parseRanges(txt); if (!errors.length) out[k] = ranges;
  }
  return out;
}
// Contrôles des plages saisies : forme (règles de confd), numéros du client hors plages
// (confd refuserait le numéro), chevauchement entre jeux de contextes.
export function rangeIssues(d) {
  const out = []; const units = unitList(d); const many = units.length > 1;
  const all = [];
  for (const u of units) {
    const key = many ? u.key : null; const own = rangeCfg(d, key)?.ranges || {}; const r = newRanges(d, key);
    const who = many ? `Plages de « ${u.label} »` : 'Plages du contexte';
    for (const [k, l] of RANGE_KEYS) {
      const txt = String(own[k] ?? '').trim();
      if (txt && txt !== '-') for (const e of parseRanges(txt).errors) out.push({ sev: 'error', title: who, text: `${l} : ${e}.` });
      const outside = clientNumbers(d, key).filter((x) => x.key === k && !inRanges(x.n, r[k])).map((x) => x.n);
      if (outside.length) out.push({ sev: 'error', title: who, text: `${l} : ${outside.join(', ')} hors des plages (${rangesText(r[k]) || 'aucune'}) : Wazo refuserait ces numéros.` });
      for (const x of r[k] || []) all.push({ u: u.label, key, k, l, x });
    }
  }
  // Plages communes à plusieurs jeux (standard 200-299… partout) : sans effet tant qu'un même
  // numéro n'est pas dans deux jeux. Ce cas-là est signalé : depuis un jeu qui inclut l'autre,
  // le premier trouvé répond et l'autre n'est jamais joignable.
  if (many) {
    const by = new Map();
    for (const u of units) for (const x of clientNumbers(d, u.key)) { const k2 = `${x.key === 'user_ranges' ? 'n' : 'h'}|${x.n}`; if (!by.has(k2)) by.set(k2, []); if (!by.get(k2).includes(u.label)) by.get(k2).push(u.label); }
    const dup = [...by].filter(([, l]) => l.length > 1).map(([k2, l]) => `${k2.split('|')[1]} (${l.join(', ')})`);
    if (dup.length) out.push({ sev: 'warn', title: 'Même numéro dans plusieurs jeux', text: `${dup.join(', ')} : si les jeux s'incluent, un seul répondra. Renuméroter un des sites, ou saisir un autre numéro.` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Monde (contextes, numéros, motifs sortants) actuel et futur
// ---------------------------------------------------------------------------
const ctxName = (t, x) => x?.name || t.contexts.find((c) => c.id === x?.id)?.name || null;
export function worldOf(t) {
  const ctx = new Map(t.contexts.map((c) => [c.name, { name: c.name, id: c.id, label: c.label || c.name, type: c.type, includes: (c.contexts || []).map((x) => ctxName(t, x)).filter(Boolean) }]));
  const exts = new Map();
  for (const e of t.extensions) if (!e.outcall && !String(e.exten).startsWith('_')) exts.set(`${e.exten}@${e.context}`, { ctx: e.context, users: (e.lines || []).length });
  const outs = new Map();
  for (const o of t.outcalls) for (const e of o.extensions || []) {
    if (!outs.has(e.context)) outs.set(e.context, []);
    outs.get(e.context).push({ exten: e.exten, dp: e, rule: o.name || o.label || `règle ${o.id}`, trunks: (o.trunks || []).map((x) => Number(x.id)), mine: false });
  }
  return { ctx, exts, outs };
}
// Contextes internes occupés (numéros avec ligne) : établissements déjà sur le site.
export function occupancy(t) {
  const by = new Map();
  for (const e of t.extensions) if ((e.lines || []).length) by.set(e.context, (by.get(e.context) || 0) + 1);
  return t.contexts.filter((c) => c.type === 'internal' && by.get(c.name)).map((c) => ({ name: c.name, label: c.label || c.name, n: by.get(c.name) }));
}
// Premier contexte sortant inclus (directement) par un contexte interne.
export const outOf = (w, name) => (w.ctx.get(name)?.includes || []).find((x) => w.ctx.get(x)?.type === 'outcall') || null;

// Réglages d'une unité : d.write.site / trunkId pour une seule unité, d.write.units[clé] sinon.
export function unitCfg(d, key) {
  if (!d.write.units) d.write.units = {};
  if (!d.write.units[key]) d.write.units[key] = { newLabel: '', incLabel: '', outLabel: '', trunkId: '', created: null };
  return d.write.units[key];
}
// Trunk Wazo proposé pour une unité : celui dont le nom contient le département ou la passerelle 3CX.
export function guessTrunk(t, u) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const keys = [u.label, u.trunk].map(norm).filter((x) => x.length > 2);
  return t.trunks.find((x) => { const n = norm(`${x.endpoint_sip?.label || ''} ${x.endpoint_sip?.name || ''}`); return keys.some((k) => n.includes(k) || k.includes(n)); })?.id || '';
}
export const multi = (d) => unitList(d).length > 1;

// Où chaque unité s'installe : [{ key, label, ctx, out, newCtx, newOut, peers, trunkId }].
// peers = établissements déjà présents sur le site Wazo, inclus avec l'unité.
export function placements(t, d) {
  const s = d.write.site; const w = worldOf(t); const units = unitList(d);
  const existingPeers = s.inter ? (s.peers ?? occupancy(t).map((x) => x.name)) : [];
  if (units.length > 1) {
    return units.map((u) => {
      const c = unitCfg(d, u.key);
      if (c.created) return { key: u.key, label: u.label, ctx: c.created.ctxName, out: c.created.outName, inc: c.created.incName || null, newCtx: false, newOut: false, peers: c.created.peers || [], trunkId: Number(c.trunkId || guessTrunk(t, u) || 0), created: true };
      return { key: u.key, label: u.label, ctx: NEW_CTX(u.key), out: NEW_OUT(u.key), inc: NEW_INC(u.key), newCtx: true, newOut: true, peers: existingPeers, trunkId: Number(c.trunkId || guessTrunk(t, u) || 0) };
    });
  }
  const u = units[0]; const trunkId = Number(d.write.trunkId || t.trunks[0]?.id || 0);
  if (s.mode === 'new') {
    if (s.created) return [{ key: u.key, label: u.label, ctx: s.created.ctxName, out: s.created.outName, inc: s.created.incName || null, newCtx: false, newOut: false, peers: s.created.peers || [], trunkId, created: true }];
    return [{ key: u.key, label: u.label, ctx: NEW_CTX(u.key), out: NEW_OUT(u.key), inc: NEW_INC(u.key), newCtx: true, newOut: true, peers: existingPeers, trunkId }];
  }
  const internal = t.contexts.find((c) => c.name === d.ctx && c.type === 'internal') || t.contexts.find((c) => c.type === 'internal');
  if (!internal) return [{ key: u.key, label: u.label, ctx: null, out: null, peers: [], trunkId }];
  const out = outOf(w, internal.name);
  return [{ key: u.key, label: u.label, ctx: internal.name, out: out || NEW_OUT(u.key), inc: null, newCtx: false, newOut: !out, peers: [], trunkId }];
}
// Libellés des contextes à créer pour une unité. Nommage de Brice (04/11/2026) :
// <ID client>-<site>-<type>, site en minuscules sans accent ni espace, types du
// Portal (internal, from-extern, to-extern) : 44000-nantes-internal.
export const siteSlug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
export function unitLabels(d, p) {
  const w = d.write; const id = w.clientId || '<ID>';
  const c = multi(d) ? unitCfg(d, p.key) : w.site;
  const site = siteSlug(multi(d) || (p.label && p.key !== '__DEFAULT__' && p.key !== '_') ? p.label : w.clientName);
  return { ctx: c.newLabel || `${id}-${site}-internal`, inc: c.incLabel || `${id}-${site}-from-extern`, out: c.outLabel || `${id}-${site}-to-extern` };
}
export function futureOf(t, d) {
  const w = worldOf(t); const ps = placements(t, d); const s = d.write.site;
  const clone = { ctx: new Map([...w.ctx].map(([k, v]) => [k, { ...v, includes: [...v.includes] }])), exts: new Map(w.exts), outs: new Map([...w.outs].map(([k, v]) => [k, [...v]])) };
  const skipped = [];
  const unitNums = (p) => (ps.length > 1 ? clientNumbers(d, p.key) : clientNumbers(d));
  for (const p of ps.filter((x) => x.ctx)) {
    const L = unitLabels(d, p);
    if (p.newCtx) clone.ctx.set(p.ctx, { name: p.ctx, label: L.ctx, type: 'internal', includes: [] });
    if (p.newOut) clone.ctx.set(p.out, { name: p.out, label: L.out, type: 'outcall', includes: [] });
  }
  for (const p of ps.filter((x) => x.ctx)) {
    // Inclusions : le sortant de l'unité d'abord, puis les autres unités, puis les établissements existants.
    const others = ps.length > 1 && s.interUnits ? ps.filter((x) => x !== p && x.ctx).map((x) => x.ctx) : [];
    if (p.newCtx) clone.ctx.get(p.ctx).includes = [p.out, ...others, ...p.peers];
    else if (p.newOut) clone.ctx.get(p.ctx).includes.unshift(p.out);
    // Chez les établissements existants : l'unité en fin de liste, pour ne rien changer à leurs appels actuels.
    if (p.newCtx) for (const peer of p.peers) clone.ctx.get(peer)?.includes.push(p.ctx);
    // Jeu déjà créé : il inclut les nouveaux jeux en fin de liste (comme la phase Fondations).
    if (!p.newCtx && ps.length > 1 && s.interUnits) { const inc = clone.ctx.get(p.ctx)?.includes; if (inc) for (const x of ps.filter((y) => y.newCtx && !inc.includes(y.ctx))) inc.push(x.ctx); }
    for (const x of unitNums(p)) clone.exts.set(`${x.n}@${p.ctx}`, { ctx: p.ctx, users: 1, client: true, unit: p.key });
    // Motifs déjà présents dans le sortant (même exten@contexte) : confd refuserait le doublon, ils restent à leur règle.
    const cur = clone.outs.get(p.out) || [];
    for (const pt of clientPatterns(d.write.out)) {
      const old = cur.find((x) => x.exten === pt.exten);
      if (old) { if (!old.mine) skipped.push({ unit: p.key, exten: pt.exten, rule: old.rule }); continue; }
      cur.push({ exten: pt.exten, dp: pt, rule: ps.length > 1 ? `règle ${p.label}` : 'règle du client', trunks: [Number(p.trunkId)], mine: true, unit: p.key });
    }
    clone.outs.set(p.out, cur);
  }
  return { w: clone, ps, skipped };
}
// Recherche d'un numéro depuis un contexte (même ordre que dialsim.simulate).
export function route(w, from, number) {
  const n = String(number); const seen = new Set(); const path = [];
  const search = (c) => {
    if (!c || seen.has(c)) return null; seen.add(c); path.push(c);
    const ex = w.exts.get(`${n}@${c}`);
    if (ex) return { kind: 'internal', ctx: c, client: !!ex.client };
    const cand = (w.outs.get(c) || []).filter((x) => matches(x.exten, n)).sort((a, b) => comparePatterns(a.exten, b.exten));
    if (cand.length) return { kind: 'out', ctx: c, rule: cand[0].rule, trunks: cand[0].trunks, exten: cand[0].exten, mine: cand[0].mine, sent: dialedNumber(n, cand[0].dp) };
    for (const inc of w.ctx.get(c)?.includes || []) { const r = search(inc); if (r) return r; }
    return null;
  };
  return { ...(search(from) || { kind: 'none' }), path };
}

// ---------------------------------------------------------------------------
// Contrôles (avant écriture)
// ---------------------------------------------------------------------------
export const SAMPLES = [['0240000000', 'fixe'], ['0612345678', 'mobile'], ['0912345678', '09'], ['0800123456', '08'], ['3631', 'court'], ['15', 'SAMU'], ['17', 'police'], ['18', 'pompiers'], ['112', 'urgences'], ['114', 'urgences (SMS)'], ['118712', 'renseignements'], ['0033123456789', 'international 00'], ['+33612345678', 'international +']];
const label = (w, c) => (isVirtual(c) ? `« ${w.ctx.get(c)?.label} » (à créer)` : `« ${w.ctx.get(c)?.label || c} »`);
const sameRoute = (a, b) => a.kind === b.kind && (a.kind !== 'out' || (a.rule === b.rule && String(a.trunks) === String(b.trunks))) && (a.kind !== 'internal' || a.ctx === b.ctx);
export const routeText = (w, r, trunkName) => (r.kind === 'internal' ? `interne, ${label(w, r.ctx)}` : r.kind === 'out' ? `règle « ${r.rule} » (${r.exten}) → ${r.trunks.map(trunkName).join(', ') || 'aucun trunk'}, envoyé ${r.sent}` : 'non routé');
const total = (occ) => occ.reduce((a, x) => a + x.n, 0);

// → { issues: [{ sev, title, text }], tables: [{ p, rows: [{ n, what, r }] }], w, ps }
export function siteChecks(t, d, trunkName = (id) => `trunk ${id}`) {
  const issues = []; const add = (sev, title, text) => issues.push({ sev, title, text });
  const s = d.write.site; const occ = occupancy(t); const many = multi(d);
  const { w, ps, skipped } = futureOf(t, d);
  const now = worldOf(t);
  if (!many && !s.mode) { add('error', 'Site Wazo', occ.length ? `ce site Wazo contient déjà ${total(occ)} poste(s) (${occ.map((x) => `${x.label} : ${x.n}`).join(', ')}) : choisir où installer le client.` : 'choisir où installer le client.'); return { issues, tables: [], w, ps }; }
  if (ps.some((p) => !p.ctx)) { add('error', 'Contexte interne', 'aucun contexte interne dans ce site Wazo.'); return { issues, tables: [], w, ps }; }
  const who = (p) => (many ? `« ${p.label} »` : 'le client');
  if (many && occ.length) add('info', 'Site Wazo partagé', `ce site Wazo contient déjà ${total(occ)} poste(s) (${occ.map((x) => `${x.label} : ${x.n}`).join(', ')}) ; les ${ps.length} départements y auront chacun leur jeu de contextes.`);
  for (const p of ps) if (!p.trunkId) add('error', `Trunk de ${who(p)}`, 'aucun trunk choisi (à créer dans le Portal s\'il manque, puis « Relire le tenant »).');
  if (many) { const by = {}; for (const p of ps) (by[p.trunkId] ||= []).push(p.label); for (const [k, l] of Object.entries(by)) if (k !== '0' && l.length > 1) add('warn', 'Trunks', `${l.join(', ')} partagent le même trunk : est-ce voulu (3CX : un trunk par département) ?`); }
  // Le client n'est pas encore installé : tout poste déjà présent est celui d'un autre établissement.
  if (!many && s.mode === 'dedicated' && occ.length) add('warn', 'Site Wazo dédié', `ce site Wazo contient déjà ${total(occ)} poste(s) (${occ.map((x) => `${x.label} : ${x.n}`).join(', ')}). Pour des établissements qui ne s'appellent pas, un site Wazo par établissement (Portal) ; sinon, choisir un mode « site partagé ».`);
  // Contexte déjà occupé : mêmes règles sortantes pour tous, donc un seul trunk possible.
  for (const p of ps.filter((x) => !x.newCtx && !x.created && occ.some((y) => y.name === x.ctx))) {
    const moved = SAMPLES.map(([n]) => [n, route(now, p.ctx, n), route(w, p.ctx, n)]).filter(([n, a, b]) => !n.startsWith('118') && a.kind === 'out' && b.kind === 'out' && (a.rule !== b.rule || String(a.trunks) !== String(b.trunks)));
    const other = moved.filter(([, a, b]) => String(a.trunks) !== String(b.trunks));
    if (other.length) add('error', `Postes existants de ${label(w, p.ctx)}`, `ils partiraient par le trunk du client : ${other.map(([n, a, b]) => `${n} : ${routeText(now, a, trunkName)} → ${routeText(w, b, trunkName)}`).join(' ; ')}. Un contexte = des règles sortantes communes : pour un trunk propre au client, choisir « nouveau contexte ».`);
    else if (moved.length) add('info', `Postes existants de ${label(w, p.ctx)}`, `${moved.length} type(s) de numéros passeraient par la règle du client (même trunk) : ${moved.map(([n]) => n).join(', ')}.`);
    if (s.mode === 'existing') add('info', 'Contexte partagé', `le contexte ${label(w, p.ctx)} contient déjà ${occ.find((y) => y.name === p.ctx).n} poste(s) : le client partagera leurs appels sortants (${p.newOut ? 'nouveau sortant inclus en tête' : `sortant ${label(w, p.out)}`}).`);
  }
  for (const x of skipped) add('info', 'Règle sortante', `motif ${x.exten} déjà pris dans ${label(w, ps.find((p) => p.key === x.unit)?.out)} par « ${x.rule} » : il reste à cette règle (confd refuse deux fois le même motif dans un contexte).`);
  // Depuis chaque unité : chaque numéro type doit sortir par son trunk.
  const tables = ps.map((p) => ({ p, rows: SAMPLES.map(([n, what]) => ({ n, what, r: route(w, p.ctx, n) })) }));
  for (const { p, rows } of tables) {
    for (const { n, what, r } of rows) {
      const where = `Depuis ${who(p)} : ${n} (${what})`;
      if (n.startsWith('118')) { if (r.kind === 'out' && !r.mine) add('warn', where, `pris par « ${r.rule} » (${r.trunks.map(trunkName).join(', ')}) : le blocage des 118 ne s'y applique pas.`); continue; }
      if (r.kind === 'none') add('warn', where, 'non routé : aucun motif ne prend ce numéro.');
      else if (r.kind === 'internal') add('error', where, `pris comme numéro interne dans ${label(w, r.ctx)}.`);
      else if (!r.trunks.includes(Number(p.trunkId))) add('error', where, `partirait par « ${r.rule} » (${r.trunks.map(trunkName).join(', ') || 'aucun trunk'}), pas par le trunk de ${who(p)} (chemin : ${r.path.map((c) => label(w, c)).join(' → ')}).`);
    }
  }
  // Appels internes entre unités et avec les établissements existants (inclusions cochées).
  const numsAt = (wd, ctx) => [...wd.exts.entries()].filter(([, v]) => v.ctx === ctx && v.users).map(([k]) => k.split('@')[0]);
  const pairs = [];
  for (const p of ps) {
    for (const peer of p.peers) pairs.push([p, { ctx: peer, nums: numsAt(now, peer), name: label(w, peer) }]);
    if (many && s.interUnits) for (const q of ps.filter((x) => x !== p && ps.indexOf(x) > ps.indexOf(p))) pairs.push([p, { ctx: q.ctx, nums: numsAt(w, q.ctx), name: who(q) }]);
  }
  for (const [p, peer] of pairs) {
    const mine = numsAt(w, p.ctx);
    const clash = mine.filter((n) => peer.nums.includes(n));
    if (clash.length) add('warn', `Numéros communs : ${who(p)} et ${peer.name}`, `${clash.join(', ')} : chacun garde son numéro, mais ces numéros ne sont pas joignables de l'un à l'autre.`);
    // Numéro qui part sur un trunk (ou nulle part) : bloquant. Numéro pris par un autre contexte
    // inclus qui a le même numéro : collision, avertissement.
    const check = (from, to, nums, fromName, toName) => {
      const res = nums.filter((n) => !clash.includes(n)).map((n) => [n, route(w, from, n)]).filter(([, r]) => !(r.kind === 'internal' && r.ctx === to));
      const gone = res.filter(([, r]) => r.kind !== 'internal'); const taken = res.filter(([, r]) => r.kind === 'internal');
      if (gone.length) add('error', `Depuis ${fromName} vers ${toName}`, `${gone.length} numéro(s) injoignables (${gone.slice(0, 6).map(([n, r]) => `${n} → ${r.kind === 'out' ? `règle « ${r.rule} » (${r.exten})` : 'non routé'}`).join(' ; ')}${gone.length > 6 ? '…' : ''}). Une règle sortante passe avant l'inclusion : motif trop large (attrape-tout _X.).`);
      if (taken.length) add('warn', `Depuis ${fromName} vers ${toName}`, `${taken.length} numéro(s) pris par un autre contexte qui a le même numéro (${taken.slice(0, 6).map(([n, r]) => `${n} → ${label(w, r.ctx)}`).join(' ; ')}${taken.length > 6 ? '…' : ''}).`);
    };
    check(peer.ctx, p.ctx, mine, peer.name, who(p));
    check(p.ctx, peer.ctx, peer.nums, who(p), peer.name);
  }
  // Rien ne change pour les contextes internes existants (hors ceux des unités).
  const unitCtx = new Set(ps.map((p) => p.ctx));
  for (const c of t.contexts.filter((x) => x.type === 'internal' && !unitCtx.has(x.name))) {
    // Un 118 qui tombe sur une règle du client y est bloqué (autorisation en refus) : pas une fuite.
    const changed = SAMPLES.map(([n]) => n).filter((n) => { const r = route(w, c.name, n); return !sameRoute(route(now, c.name, n), r) && !(n.startsWith('118') && r.mine && d.write.out?.block118); });
    // Appel déjà routé qui change de chemin : bloquant. Appel non routé qui le devient (par
    // l'inclusion du client, donc par son trunk) : avertissement.
    const txt = (l) => l.map((n) => `${n} : ${routeText(now, route(now, c.name, n), trunkName)} → ${routeText(w, route(w, c.name, n), trunkName)}`).join(' ; ');
    const was = changed.filter((n) => route(now, c.name, n).kind !== 'none'); const gained = changed.filter((n) => !was.includes(n));
    if (was.length) add('error', `Effet sur ${label(w, c.name)}`, `appels modifiés : ${txt(was)}.`);
    if (gained.length) add('warn', `Effet sur ${label(w, c.name)}`, `numéros qu'il ne routait pas et qui sortiraient par le trunk du client, via l'inclusion : ${txt(gained)}. Ajouter ces familles à sa propre règle sortante (Call Flow Manager), ou ne pas l'inclure.`);
  }
  return { issues, tables, w, ps };
}
