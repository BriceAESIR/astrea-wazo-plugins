// Migration Assistant — départements 3CX (demande de Brice, 04/11/2026). Sans DOM.
// 3CX v16-v18 : groupes de filtrage ; v20 : départements, plus cloisonnés. Un
// département 3CX devient soit un jeu de contextes Wazo propre (établissement :
// contexte interne + sortant + son trunk), soit il est fusionné dans un autre
// (même jeu de contextes), soit il part sur un site Wazo séparé (non importé ici).
//
// Lu dans une sauvegarde v20.0.9 à 3 départements (pas dans une doc 3CX) :
//  - __DEFAULT__ est le département principal (IsPrimary) de presque tous les
//    postes ; le rattachement réel est l'appartenance à un autre département
//    (postes 2xx et files 800-803 dans un département, 3xx et 804-807 dans l'autre) ;
//  - le trunk d'un département : règle sortante filtrée sur lui (DNGroups) ;
//  - un objet seul dans __DEFAULT__ (ex. SVI de fermeture) est rattaché au
//    département des SDA qui le visent, s'il n'y en a qu'un, sinon à celui
//    dont le nom figure dans le sien (« Fermeture exceptionnelle - Site B »).
// Supposé : un poste dans deux départements réels (le premier est retenu, signalé).
import { imported } from './3cx-draft.js?v=0.40.67';

export const DEFAULT = '__DEFAULT__';
export const DEPT_MODES = { own: 'Jeu de contextes propre', merge: 'Fusionné dans un autre', skip: 'Site Wazo séparé (non importé ici)' };
export const deptLabel = (k) => (k === DEFAULT ? 'Société (__DEFAULT__)' : k);

// Trunk 3CX d'un département : passerelle de la règle sortante la plus prioritaire qui le vise.
export function deptTrunk(m, name) {
  const r = [...(m.outbound || [])].sort((a, b) => a.priority - b.priority).find((x) => x.groups.includes(name) && x.routes.length);
  return r ? r.routes[0].gateway : '';
}
// Destinations d'une SDA : ouvert, puis fermé et férié de son horaire (brouillon v3), ou les siennes (avant).
const destRefs = (r, d) => { const s = d?.schedules?.find((x) => x.key === r.schedule); return [r.dest, s?.closed ?? r.closed, s?.holiday ?? r.holiday].filter((x) => x && ['user', 'hunt', 'ivr', 'vm'].includes(x.t)).map((x) => x.ref); };

// Rattachement des objets et choix par défaut (une seule fois par brouillon).
export function ensureDepts(d, m) {
  if (d.depts) return d;
  const groups = (m.groups || []).filter((g) => !g.favorites);
  const sites = groups.filter((g) => g.name !== DEFAULT);
  const hitsOf = (n) => sites.filter((g) => g.members.includes(n)).map((g) => g.name);
  const of = (x) => { const h = hitsOf(x.n); x.dept = h[0] || DEFAULT; if (h.length > 1) x.deptAlso = h.slice(1); return x.dept; };
  for (const u of d.users) of(u);
  for (const v of d.ivrs) of(v);
  for (const h of d.hunts) {
    of(h);
    // Groupe ou file seul dans __DEFAULT__ : département de la majorité de ses membres.
    if (h.dept === DEFAULT) { const c = {}; for (const n of h.members) { const k = hitsOf(n)[0]; if (k) c[k] = (c[k] || 0) + 1; } const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; if (best) h.dept = best[0]; }
  }
  // SDA : département dont la règle sortante utilise le trunk de la SDA, sinon celui de sa destination.
  const trunkDept = new Map(sites.map((g) => [deptTrunk(m, g.name), g.name]).filter(([t]) => t));
  for (const r of d.dids) {
    const tr = m.inbound.find((x) => x.did === r.did)?.trunk || m.trunks.find((t) => t.dids.includes(r.did))?.name;
    const byDest = destRefs(r, d).map((ref) => [...d.users, ...d.hunts, ...d.ivrs].find((o) => o.n === ref)?.dept).find((k) => k && k !== DEFAULT);
    r.dept = trunkDept.get(tr) || byDest || DEFAULT;
  }
  // Objets seuls dans __DEFAULT__ visés par les SDA d'un seul département.
  for (const o of [...d.users, ...d.hunts, ...d.ivrs].filter((x) => x.dept === DEFAULT)) {
    const ks = [...new Set(d.dids.filter((r) => destRefs(r, d).includes(o.n)).map((r) => r.dept).filter((k) => k !== DEFAULT))];
    if (ks.length === 1) { o.dept = ks[0]; o.deptBy = 'SDA'; continue; }
    // Sinon, un nom qui contient celui d'un seul département (« Fermeture exceptionnelle - Site B »).
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const label = norm(o.name || [o.first, o.last].filter(Boolean).join(' '));
    const byName = sites.filter((g) => norm(g.name).length > 2 && label.includes(norm(g.name)));
    if (byName.length === 1) { o.dept = byName[0].name; o.deptBy = 'nom'; }
  }
  // Choix par défaut : un département réel avec son trunk = jeu propre ; __DEFAULT__
  // fusionné dans le département réel le plus grand s'il y en a, sinon jeu propre.
  const size = (k) => d.users.filter((u) => u.dept === k && u.mode !== 'skip').length + d.hunts.filter((h) => h.dept === k).length;
  const own = sites.filter((g) => deptTrunk(m, g.name) || size(g.name)).sort((a, b) => size(b.name) - size(a.name));
  d.depts = groups.map((g) => ({
    key: g.name, number: g.number, trunk: deptTrunk(m, g.name), visible: g.visible,
    hours: g.hours.periods.map((p) => `${['', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'][p.day] || '?'} ${p.from}-${p.to}`).join(', '),
    holidays: g.holidays.filter((h) => !h.past).length,
    mode: g.name === DEFAULT ? (own.length ? 'merge' : 'own') : 'own', into: g.name === DEFAULT && own.length ? own[0].name : '',
  }));
  return d;
}
export const deptBy = (d, k) => (d.depts || []).find((x) => x.key === k);
// Département effectif (fusions suivies) ; '' si le département part sur un site séparé.
export function unitKey(d, k) {
  if (!d.depts?.length) return '_';
  let x = deptBy(d, k || DEFAULT) || deptBy(d, DEFAULT) || d.depts[0];
  const seen = new Set();
  while (x?.mode === 'merge' && !seen.has(x.key)) { seen.add(x.key); x = deptBy(d, x.into); }
  // Fusion vers un département absent ou en boucle (protégée par setDeptMode, brouillon modifié
  // à la main) : premier département « propre », pour que l'objet garde un jeu de contextes.
  if (!x || x.mode === 'merge') return d.depts.find((y) => y.mode === 'own')?.key || deptBy(d, DEFAULT)?.key || d.depts[0].key;
  return x.mode === 'skip' ? '' : x.key;
}
export const unitOf = (d, o) => unitKey(d, o?.dept);
// Jeux de contextes à créer : départements « propres » qui ont au moins un objet repris.
export function unitList(d) {
  if (!d.depts?.length) return [{ key: '_', label: '' }];
  const used = new Set([...imported(d), ...d.hunts.filter((h) => h.target !== 'skip'), ...d.ivrs.filter((v) => v.import), ...d.dids.filter((r) => r.import), ...d.users.filter((u) => u.mode === 'voicemail')].map((o) => unitOf(d, o)).filter(Boolean));
  const list = d.depts.filter((x) => x.mode === 'own' && used.has(x.key)).map((x) => ({ key: x.key, label: deptLabel(x.key), trunk: x.trunk }));
  return list.length ? list : [{ key: '_', label: '' }];
}
export const multiUnit = (d) => unitList(d).length > 1;
// Objets d'un département (rattachement direct, sans suivre les fusions).
export const deptObjects = (d, k) => ({ users: d.users.filter((u) => u.dept === k), hunts: d.hunts.filter((h) => h.dept === k), ivrs: d.ivrs.filter((v) => v.dept === k), dids: d.dids.filter((r) => r.dept === k) });

// « Site Wazo séparé » : les objets du département sont retirés de l'import ici
// (état précédent gardé), et retrouvent leur état si on revient en arrière.
export function setDeptMode(d, k, mode, into = '') {
  const x = deptBy(d, k); if (!x) return;
  const was = x.mode; x.mode = mode; x.into = mode === 'merge' ? (into || x.into || d.depts.find((y) => y.key !== k && y.mode === 'own')?.key || '') : '';
  // Fusion en boucle (A dans B, B dans A) : la cible ne peut plus fusionner, elle redevient « propre ».
  if (mode === 'merge') { const seen = new Set([k]); let y = deptBy(d, x.into); while (y?.mode === 'merge' && !seen.has(y.key)) { seen.add(y.key); y = deptBy(d, y.into); } if (y && y.mode === 'merge') { const t = deptBy(d, x.into); if (t) { t.mode = 'own'; t.into = ''; } } }
  const o = deptObjects(d, k);
  const kinds = [['users', o.users], ['hunts', o.hunts], ['ivrs', o.ivrs], ['dids', o.dids]];
  if (mode === 'skip' && was !== 'skip') for (const [kind, l] of kinds) for (const v of l) park(kind, v);
  if (mode !== 'skip' && was === 'skip') for (const [kind, l] of kinds) for (const v of l) unpark(kind, v);
}
// « Site séparé » : objet retiré de l'import, état d'avant gardé (deptPrev) ; et inversement.
function park(kind, v) {
  if ('deptPrev' in v) return;
  if (kind === 'users') { v.deptPrev = v.mode; v.mode = 'skip'; } else if (kind === 'hunts') { v.deptPrev = v.target; v.target = 'skip'; } else { v.deptPrev = v.import; v.import = false; }
}
function unpark(kind, v) {
  if (!('deptPrev' in v)) return;
  if (kind === 'users') v.mode = v.deptPrev || v.mode; else if (kind === 'hunts') v.target = v.deptPrev || v.target; else v.import = v.deptPrev;
  delete v.deptPrev;
}
// Un objet déplacé à la main d'un département à un autre : il suit le mode de sa destination
// (retiré de l'import vers un site séparé, rétabli en en sortant).
export function moveObject(d, kind, n, k) {
  const key = { user: 'users', hunt: 'hunts', ivr: 'ivrs', did: 'dids' }[kind]; const list = d[key] || [];
  const o = list.find((x) => (kind === 'did' ? x.did : x.n) === n); if (!o) return;
  const from = deptBy(d, o.dept)?.mode; const to = deptBy(d, k)?.mode;
  o.dept = k; o.deptBy = 'manuel';
  if (to === 'skip' && from !== 'skip') park(key, o);
  else if (from === 'skip' && to !== 'skip') unpark(key, o);
}
