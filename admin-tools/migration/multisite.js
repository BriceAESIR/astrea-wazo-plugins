// Migration Assistant — lot 2 : bascule monosite → multisite (sans DOM).
// Cadrage et règles lues dans le code : docs/MIGRATION-ASSISTANT.md, « Lot 2 ».
// Résumé :
//  - un seul PUT /extensions/{id} {context} par numéro : la ligne suit (xivo-dao
//    LineFixes), le contexte PJSIP est généré depuis la ligne (confgend) ;
//  - le commun inclut les sites en fin de liste : les références numéro@commun
//    (SDA, destinations, membres de groupe) restent valables sans réécriture ;
//  - live reload coupé pendant toute l'opération, réactivé AVANT le dernier
//    déplacement (une écriture identique ne recharge rien, lu dans le notifier) ;
//  - journal de chaque écriture, annulation depuis le journal.
import { S, api, ApiError } from '../common/core.js?v=0.40.67';
import { I, sameTenant, membersOf, objLabel } from './inventory.js?v=0.40.67';
import { patternMatch, allDests } from './checks.js?v=0.40.67';
import { worldOf, route, siteSlug, clientPatterns, defaultOut, BLOCK_118 } from './3cx-sites.js?v=0.40.67';
import { userContext } from '../callflow/dialsim.js?v=0.40.67';

// ---------------------------------------------------------------------------
// Jeu de contextes par site et cloisonnement (demande de Brice, 06/11/2026)
// ---------------------------------------------------------------------------
// Nommage de l'import 3CX : <ID client>-<site>-internal / to-extern / from-extern.
// Les inclusions sont suivies en cascade par Asterisk (un contexte inclus apporte
// ses propres inclusions) : si le commun inclut les sites et que chaque site
// inclut le commun, tous les sites se joignent par le commun. D'où :
//  - mesh : tous les sites s'appellent ; le commun inclut les sites (références
//    numéro@commun et utilisateurs restés dans le commun : tout reste joignable) ;
//  - pairs / isolated : le commun n'inclut PAS les sites (sinon le cloisonnement
//    fuit par lui) ; chaque site inclut les sites liés, puis le commun (groupes,
//    files, utilisateurs restés). Les références numéro@commun vers un numéro
//    déplacé cassent : relevées avant écriture (réécriture : lot suivant).
export const PARTITIONS = { mesh: 'Tous les sites s\'appellent', pairs: 'Liens choisis entre sites', isolated: 'Sites isolés (aucun appel interne entre sites)' };
export const linkKey = (a, b) => [a, b].sort().join('|');
export const partitionOf = (ms) => (PARTITIONS[ms.partition] ? ms.partition : 'mesh');
export const linked = (ms, a, b) => a !== b && (partitionOf(ms) === 'mesh' || (partitionOf(ms) === 'pairs' && (ms.links || []).includes(linkKey(a, b))));
export const commonIncludesSites = (ms) => partitionOf(ms) === 'mesh';
// ---------------------------------------------------------------------------
// Appels sortants et SDA par site (deuxième temps, 06/11/2026)
// ---------------------------------------------------------------------------
// Sortant : règle de l'assistant France de Call Flow (motifs de 3cx-sites.js, mêmes options que
// l'import 3CX) dans le contexte -to-extern du site, vers le trunk du site ; « interdit-118 »
// reprise ou créée une fois. Sans trunk : pas de règle, le site sort par le commun.
// Entrant : -from-extern reçoit les SDA du site dans ses incall_ranges (une plage par SDA, comme
// le Portal) et inclut les contextes entrants actuels de ces SDA : quand le trunk du site est
// réglé dessus (dans le Portal, l'outil ne touche jamais aux trunks), toutes les SDA restent
// trouvées par l'inclusion (supposé : inclusion entre contextes entrants acceptée par confd et
// suivie par Asterisk, à vérifier en réel). Les SDA du site y sont ensuite déplacées
// (« Déplacer les SDA »), seulement une fois le trunk réglé.
export const outOf = (ms) => ms.out || defaultOut();
// Réécriture des références : par défaut quand le commun n'inclut pas les sites (sinon elles cassent).
export const rewriteOn = (ms) => (typeof ms.rewrite === 'boolean' ? ms.rewrite : partitionOf(ms) !== 'mesh');
// Retrait du sortant du commun : seulement si plus aucun poste n'y reste et que chaque site a sa règle.
export function dropCommonOk(ms, sites, common) {
  const left = movableExtensions(common.name).filter((e) => !sites.some((s) => s.moved.some((m) => m.id === e.id))).length;
  return { ok: !left && sites.length && sites.every((s) => s.trunk), left };
}
export const ruleName = (ms, s) => `${String(ms.clientId || '').trim() || '<ID>'} - ${s.label} - Appels sortants`;
// SDA du tenant : une ligne par numéro entrant (extension de l'incall).
export function tenantDids() {
  return (I.lists.incall || []).flatMap((i) => (i.extensions || []).map((e) => ({ incall: i, extId: e.id, exten: e.exten, context: e.context })));
}
// Site d'une SDA : choix explicite, sinon celui de l'utilisateur visé (numéro déplacé), sinon aucun.
export function didSite(ms, d) {
  if (ms.didAssign && Object.prototype.hasOwnProperty.call(ms.didAssign, d.extId)) return ms.didAssign[d.extId] || null;
  const dest = d.incall.destination;
  if (dest?.type !== 'user') return null;
  const u = (I.lists.user || []).find((x) => x.id === dest.user_id); const e = u?.lines?.[0]?.extensions?.[0];
  const ext = e && (I.lists.extension || []).find((x) => x.exten === e.exten && x.context === e.context);
  return ext ? ms.assign.get(ext.id) || null : null;
}
const didOf = (n) => String(n || '').replace(/\D/g, '');
export function siteNames(ms, s) {
  const id = String(ms.clientId || '').trim() || '<ID>'; const slug = siteSlug(s.label);
  return { ctx: s.ctxLabel || `${id}-${slug}-internal`, out: s.outLabel || `${id}-${slug}-to-extern`, inc: s.incLabel || `${id}-${slug}-from-extern` };
}

export const JOURNAL_FORMAT = 'astrea-multisite-journal';
const JOURNAL_KEY = 'astrea-migration-ms-journal-v1';
const LR_MARK = 'astrea-migration-lr-off';
const MARK = 'Astrea Migration Assistant';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Lecture : contextes sources et numéros déplaçables
// ---------------------------------------------------------------------------
// Contextes internes qui ont des lignes (candidats « commun »).
export function sourceContexts() {
  const n = new Map();
  for (const l of I.lists.line || []) if (I.by.context?.get(String(l.context))?.type === 'internal') n.set(l.context, (n.get(l.context) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([name, lines]) => ({ name, lines, ctx: I.by.context.get(String(name)) }));
}
// Numéros de poste du contexte source : une ligne par extension (une ligne
// partagée par deux utilisateurs = un seul numéro à déplacer).
export function movableExtensions(source) {
  const lineById = new Map((I.lists.line || []).map((l) => [l.id, l]));
  const userById = new Map((I.lists.user || []).map((u) => [u.id, u]));
  const uName = (u) => [u?.firstname, u?.lastname].filter(Boolean).join(' ') || u?.username || '';
  return (I.lists.extension || []).filter((e) => e.context === source && (e.lines || []).length && /^\d+$/.test(e.exten || ''))
    .map((e) => {
      const lines = (e.lines || []).map((x) => lineById.get(x.id)).filter(Boolean);
      const users = lines.flatMap((l) => (l.users || []).map((x) => userById.get(x.id) || I.userByUuid?.get(x.uuid) || x));
      return { id: e.id, exten: e.exten, context: e.context, lines, users, label: users.map(uName).filter(Boolean).join(', ') || lines.map((l) => l.name).join(', ') };
    })
    .sort((a, b) => Number(a.exten) - Number(b.exten) || a.exten.localeCompare(b.exten));
}

// Groupes, files et conférences du commun (troisième temps, 06/11/2026). Lu dans confd :
// déplacés par leur numéro (PUT /extensions/{id} {context}), numéro contrôlé dans les
// group_ranges / queue_ranges / conference_room_ranges du contexte cible (extension/validator.py).
const RANGE_FR = { group_ranges: 'groupes', queue_ranges: 'files', conference_room_ranges: 'conférences' };
const OBJ_KINDS = [['group', 'groupe', 'group_ranges'], ['queue', 'file', 'queue_ranges'], ['conference', 'conférence', 'conference_room_ranges']];
export function movableObjects(source) {
  const out = [];
  for (const e of I.lists.extension || []) {
    if (e.context !== source || !/^\d+$/.test(e.exten || '')) continue;
    const k = OBJ_KINDS.find(([t]) => e[t]); if (!k) continue;
    const o = (I.lists[k[0]] || []).find((x) => String(x.id) === String(e[k[0]].id));
    out.push({ id: e.id, exten: e.exten, context: e.context, kind: k[0], what: k[1], rangeKey: k[2], obj: o, label: o?.label || o?.name || `${k[1]} ${e.exten}` });
  }
  return out.sort((a, b) => Number(a.exten) - Number(b.exten));
}
// Site d'un groupe ou d'une file : choix explicite, sinon celui de la majorité de ses membres utilisateurs déplacés.
export function objSite(ms, x) {
  if (ms.objAssign && Object.prototype.hasOwnProperty.call(ms.objAssign, x.id)) return ms.objAssign[x.id] || null;
  if (!x.obj || x.kind === 'conference') return null;
  const c = {};
  for (const m of membersOf(x.obj).users) {
    const u = (I.lists.user || []).find((y) => y.uuid === m.uuid) || I.userByUuid?.get(m.uuid); const e = u?.lines?.[0]?.extensions?.[0];
    const ext = e && (I.lists.extension || []).find((y) => y.exten === e.exten && y.context === e.context);
    const k = ext && ms.assign.get(ext.id); if (k) c[k] = (c[k] || 0) + 1;
  }
  const n = membersOf(x.obj).users.length; const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] * 2 > n ? best[0] : null; // majorité stricte, sinon reste dans le commun
}

// ---------------------------------------------------------------------------
// Références « numéro@commun » vers un numéro déplacé (quatrième temps, 06/11/2026)
// ---------------------------------------------------------------------------
// Lu dans confd : PUT partiel (parse_and_update) pour /incalls, /ivr, /schedules, /queues ;
// /…/fallbacks et /groups/{uuid}/members/extensions remplacent tout (schéma chargé sans partial) :
// l'objet est relu et renvoyé entier. Chaque écriture garde la valeur d'avant pour l'annulation.
// Non réécrit : membres « numéro » des files, touches « numérotation rapide » (sans contexte).
const FALLBACK_KEYS = ['noanswer_destination', 'busy_destination', 'congestion_destination', 'fail_destination'];
export function refTargets(common, movedSet) {
  const hit = (d) => d?.type === 'extension' && d.context === common && movedSet.has(String(d.exten));
  const out = [];
  for (const i of I.lists.incall || []) if (hit(i.destination)) out.push({ kind: 'incall', path: `/incalls/${i.id}`, label: objLabel('incall', i) });
  for (const [t, key] of [['user', 'uuid'], ['group', 'uuid'], ['queue', 'id'], ['switchboard', 'uuid']]) {
    for (const o of I.lists[t] || []) if (FALLBACK_KEYS.some((k) => hit(o.fallbacks?.[k]))) out.push({ kind: 'fallbacks', path: `/${t === 'user' ? 'users' : t === 'group' ? 'groups' : t === 'queue' ? 'queues' : 'switchboards'}/${o[key]}/fallbacks`, label: `débordements de ${objLabel(t, o)}` });
  }
  for (const q of I.lists.queue || []) if (hit(q.wait_time_destination) || hit(q.wait_ratio_destination)) out.push({ kind: 'queue', path: `/queues/${q.id}`, label: `seuils de ${objLabel('queue', q)}` });
  for (const v of I.lists.ivr || []) if ((v.choices || []).some((c) => hit(c.destination)) || ['timeout_destination', 'invalid_destination', 'abort_destination'].some((k) => hit(v[k]))) out.push({ kind: 'ivr', path: `/ivr/${v.id}`, label: objLabel('ivr', v) });
  for (const s of I.lists.schedule || []) if (hit(s.closed_destination) || (s.exceptional_periods || []).some((p) => hit(p.destination))) out.push({ kind: 'schedule', path: `/schedules/${s.id}`, label: objLabel('schedule', s) });
  for (const g of I.lists.group || []) if (membersOf(g).extensions.some((m) => m.context === common && movedSet.has(String(m.exten)))) out.push({ kind: 'gmember', path: `/groups/${g.uuid}`, label: `membres « numéro » de ${objLabel('group', g)}` });
  return out;
}
// Réécrit une cible (relue juste avant) ; renvoie { path, before, after } ou null si rien n'a changé.
async function rewriteTarget(t, mapDest, mapMember) {
  const cur = await tapi('GET', t.path);
  const chg = (d) => { const n = mapDest(d); return n !== d ? n : undefined; };
  if (t.kind === 'incall') { const n = chg(cur.destination); if (!n) return null; await tapi('PUT', t.path, { destination: n }); return { path: t.path, before: { destination: cur.destination }, after: { destination: n } }; }
  if (t.kind === 'fallbacks') {
    const before = Object.fromEntries(FALLBACK_KEYS.map((k) => [k, cur?.[k] ?? null]));
    const after = Object.fromEntries(FALLBACK_KEYS.map((k) => [k, mapDest(before[k])]));
    if (FALLBACK_KEYS.every((k) => after[k] === before[k])) return null;
    await tapi('PUT', t.path, after); return { path: t.path, before, after };
  }
  if (t.kind === 'queue' || t.kind === 'ivr' || t.kind === 'schedule') {
    const keys = { queue: ['wait_time_destination', 'wait_ratio_destination'], ivr: ['timeout_destination', 'invalid_destination', 'abort_destination'], schedule: ['closed_destination'] }[t.kind];
    const before = {}; const after = {};
    for (const k of keys) { const n = chg(cur[k]); if (n) { before[k] = cur[k]; after[k] = n; } }
    if (t.kind === 'ivr' && (cur.choices || []).some((c) => chg(c.destination))) { const strip = (c) => ({ exten: c.exten, destination: c.destination }); before.choices = (cur.choices || []).map(strip); after.choices = (cur.choices || []).map((c) => ({ exten: c.exten, destination: mapDest(c.destination) })); }
    if (t.kind === 'schedule' && (cur.exceptional_periods || []).some((p) => chg(p.destination))) { before.exceptional_periods = cur.exceptional_periods; after.exceptional_periods = cur.exceptional_periods.map((p) => ({ ...p, destination: mapDest(p.destination) })); }
    if (!Object.keys(after).length) return null;
    await tapi('PUT', t.path, after); return { path: t.path, before, after };
  }
  if (t.kind === 'gmember') {
    const list = membersOf(cur).extensions; const body = (l) => ({ extensions: l.map((m) => ({ extension: { exten: m.exten, context: m.context }, priority: m.priority ?? 0 })) });
    const nl = list.map((m) => mapMember(m)); if (nl.every((m, i) => m === list[i])) return null;
    const p = `${t.path}/members/extensions`; await tapi('PUT', p, body(nl)); return { path: p, before: body(list), after: body(nl) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plages
// ---------------------------------------------------------------------------
// « 100-149, 160 » → [{start, end}] ; erreurs en texte.
export function parseRanges(txt) {
  const out = []; const errors = [];
  for (const part of String(txt || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) { errors.push(`« ${part} » n'est pas une plage (ex. 100-149)`); continue; }
    const start = m[1]; const end = m[2] ?? m[1];
    if (start.length !== end.length) { errors.push(`« ${part} » : début et fin doivent avoir le même nombre de chiffres (règle de confd)`); continue; }
    if (Number(start) > Number(end)) { errors.push(`« ${part} » : début après la fin`); continue; }
    out.push({ start, end });
  }
  return { ranges: out, errors };
}
export const rangesText = (r) => (r || []).map((x) => (x.start === x.end ? x.start : `${x.start}-${x.end}`)).join(', ');
// Plages compactes couvrant des numéros (suites consécutives de même longueur).
export function compactRanges(nums) {
  const s = [...new Set(nums)].filter((n) => /^\d+$/.test(n)).sort((a, b) => a.length - b.length || Number(a) - Number(b));
  const out = [];
  for (const n of s) {
    const last = out[out.length - 1];
    if (last && last.end.length === n.length && Number(n) === Number(last.end) + 1) last.end = n; else out.push({ start: n, end: n });
  }
  return out;
}
// Même règle que xivo_dao contextnumbers.in_range (comparaison numérique).
export const inRanges = (exten, ranges) => (ranges || []).some((r) => Number(r.start) <= Number(exten) && Number(exten) <= Number(r.end));

// ---------------------------------------------------------------------------
// Plan (lecture seule) : problèmes, écritures dans l'ordre, rechargements
// ---------------------------------------------------------------------------
// ms = { source, clientId, partition, links: [« a|b »], sites: [{ key, label, rangesText, ctxLabel?, outLabel?, incLabel? }], assign: Map(extId → siteKey) }
const EMERGENCY = ['15', '17', '18', '112', '114'];
// Inclusions d'un site, dans l'ordre : son sortant, les sites liés, le commun.
const siteIncludes = (ms, sites, s, idOf) => [idOf(s, 'out'), ...sites.filter((x) => linked(ms, s.key, x.key)).map((x) => idOf(x, 'ctx')), idOf(null, 'common')];
export function buildPlan(ms) {
  const problems = [];
  const err = (t) => problems.push({ sev: 'error', text: t });
  const warn = (t) => problems.push({ sev: 'warn', text: t });
  const common = I.by.context?.get(String(ms.source));
  if (!common) { err('Contexte commun introuvable : relisez l\'inventaire.'); return { problems, steps: [], sites: [] }; }
  const exts = movableExtensions(ms.source);
  const objsAll = movableObjects(ms.source);
  const extById = new Map(exts.map((e) => [e.id, e]));
  const labels = new Set((I.lists.context || []).map((c) => String(c.label || '').trim().toLowerCase()));
  if (!String(ms.clientId || '').trim()) err('ID client manquant : il sert au nom des contextes (<ID client>-<site>-internal…).');
  const seen = new Set();
  const sites = ms.sites.map((s) => {
    const label = String(s.label || '').trim();
    const { ranges, errors } = parseRanges(s.rangesText);
    const moved = [...ms.assign].filter(([, k]) => k === s.key).map(([id]) => extById.get(id)).filter(Boolean);
    const names = siteNames(ms, { ...s, label });
    if (!label) err('Un site n\'a pas de nom.');
    for (const n of Object.values(names)) {
      if (seen.has(n.toLowerCase())) err(`Deux contextes s'appelleraient « ${n} ».`);
      else if (labels.has(n.toLowerCase())) warn(`Un contexte « ${n} » existe déjà : le nouveau aura le même libellé (Wazo l'accepte, le nom technique diffère), source de confusion.`);
      seen.add(n.toLowerCase());
    }
    for (const e of errors) err(`Site « ${label || '?'} » : ${e}.`);
    if (!ranges.length && !errors.length) err(`Site « ${label || '?'} » : aucune plage de numéros (confd refusera tout numéro).`);
    const out = moved.filter((e) => !inRanges(e.exten, ranges));
    if (out.length) err(`Site « ${label} » : ${out.map((e) => e.exten).join(', ')} hors de ses plages. Ajoutez-les aux plages, ou utilisez « Calculer les plages ».`);
    if (!moved.length) warn(`Site « ${label || '?'} » : aucun numéro affecté ; ses contextes seront créés vides.`);
    // Sortant du site.
    const trunk = (I.lists.trunk || []).find((t) => String(t.id) === String(s.trunkId)) || null;
    const pats = trunk ? clientPatterns(outOf(ms)) : [];
    const rule = trunk ? ruleName(ms, { label }) : null;
    if (!trunk) warn(`Site « ${label || '?'} » : aucun trunk choisi, pas de règle sortante ; il sortira par le commun.`);
    else if ((I.lists.outcall || []).some((o) => (o.label || o.name) === rule)) err(`Une règle sortante « ${rule} » existe déjà.`);
    // SDA du site : contextes entrants actuels (inclus en repli), numéros (plages de l'entrant).
    const dids = tenantDids().filter((d) => didSite(ms, d) === s.key);
    const bad = dids.filter((d) => !/^\d+$/.test(didOf(d.exten)) || didOf(d.exten) !== d.exten);
    if (bad.length) warn(`Site « ${label} » : SDA ${bad.map((d) => d.exten).join(', ')} non numériques (motif ?) : ni plage ni déplacement.`);
    const incFrom = [...new Set([...dids.map((d) => d.context), ...(trunk?.context ? [trunk.context] : [])])].filter((c) => I.by.context?.get(String(c))?.type === 'incall');
    // Groupes, files, conférences du site : plages calculées par type (plus courtes couvrant leurs numéros).
    const objs = objsAll.filter((x) => objSite(ms, x) === s.key);
    const objRanges = {};
    for (const [, , rk] of OBJ_KINDS) { const l = objs.filter((x) => x.rangeKey === rk).map((x) => x.exten); if (l.length) objRanges[rk] = compactRanges(l); }
    // Messageries des utilisateurs déplacés (option) : leur contexte suit celui du poste.
    const vms = ms.moveVm === false ? [] : moved.flatMap((e) => e.users.map((u) => u.voicemail?.id).filter(Boolean)).map((id) => (I.lists.voicemail || []).find((v) => v.id === id)).filter((v) => v && v.context === ms.source);
    return { ...s, label, ranges, moved, names, trunk, pats, rule, dids: dids.filter((d) => !bad.includes(d)), incFrom, objs, objRanges, vms };
  });
  // Autorisation « interdit-118 » existante (reprise), sinon créée à la première règle.
  const perm118 = outOf(ms).block118 ? (I.lists.callpermission || []).find((x) => x.mode === 'deny' && x.enabled !== false && (x.extensions || []).includes(BLOCK_118)) || null : null;
  if (!sites.length) err('Ajoutez au moins un site.');
  // Plages qui se chevauchent entre sites : accepté par Wazo, mais confus.
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    if (sites[i].ranges.some((a) => sites[j].ranges.some((b) => a.start.length === b.start.length && Number(a.start) <= Number(b.end) && Number(b.start) <= Number(a.end)))) warn(`Les plages de « ${sites[i].label} » et « ${sites[j].label} » se chevauchent.`);
  }
  // Numéro présenté de chaque site (règle sortante) : une de ses SDA, au format des numéros Wazo.
  for (const s of sites) if (s.callerId && !s.trunk) warn(`Site « ${s.label} » : numéro présenté sans règle sortante (aucun trunk) : sans effet.`);
  // Références à réécrire, retrait du sortant du commun.
  const movedSet = new Set(sites.flatMap((s) => [...s.moved, ...s.objs].map((m) => String(m.exten))));
  const targets = rewriteOn(ms) ? refTargets(common.name, movedSet) : [];
  const drop = dropCommonOk(ms, sites, common);
  if (ms.dropCommonOut && !drop.ok) err(`Retrait du sortant du commun impossible : ${drop.left ? `${drop.left} poste(s) restent dans le commun` : 'chaque site doit avoir son trunk et sa règle'}.`);
  const dropOut = !!(ms.dropCommonOut && drop.ok);
  const sim = simulate(ms, sites, common, { dropOut });
  problems.push(...sim.issues);
  // Écritures, dans l'ordre d'exécution.
  const steps = [];
  for (const s of sites) steps.push({ phase: 'ctx', site: s.key, text: `Créer les contextes « ${s.names.ctx} » (interne, postes ${rangesText(s.ranges) || 'aucune'}${Object.entries(s.objRanges).map(([k, r]) => `, ${RANGE_FR[k]} ${rangesText(r)}`).join('')}), « ${s.names.out} » (sortant) et « ${s.names.inc} » (entrant, ${s.dids.length} SDA dans ses plages, inclut ${s.incFrom.map((c) => `« ${I.by.context.get(String(c))?.label || c} »`).join(', ') || 'rien'})` });
  for (const s of sites.filter((x) => x.trunk)) steps.push({ phase: 'rule', site: s.key, text: `Règle « ${s.rule} » : ${s.pats.length} motif(s) de l'assistant France dans « ${s.names.out} », vers ${objLabel('trunk', s.trunk)}${s.callerId ? `, numéro présenté ${s.callerId} (utilisateurs réglés sur « défaut »)` : ''}${outOf(ms).block118 ? `, 118 bloqués (« interdit-118 » ${perm118 ? 'reprise' : 'créée'})` : ''}` });
  const lbl = (s, k) => (k === 'common' ? `commun « ${common.label || common.name} »` : k === 'out' ? `« ${s.names.out} »` : `« ${s.names.ctx} »`);
  for (const s of sites) steps.push({ phase: 'inc', site: s.key, text: `Inclusions de « ${s.names.ctx} » : ${siteIncludes(ms, sites, s, lbl).join(', ')}` });
  // Sites en FIN de liste du commun (06/11/2026) : en tête, les appels externes du commun
  // traversaient le premier site et sortaient par son trunk (vu dans la simulation).
  if (commonIncludesSites(ms)) steps.push({ phase: 'common', text: `Inclusions du commun « ${common.label || common.name} » : ${(common.contexts || []).map((c) => `« ${c.label || c.name} »`).join(', ') || 'rien'} (inchangées), puis ${sites.map((s) => `« ${s.names.ctx} »`).join(', ')} en fin de liste` });
  for (const s of sites) for (const e of s.moved) steps.push({ phase: 'move', site: s.key, extId: e.id, exten: e.exten, text: `${e.exten} (${e.label}) → « ${s.names.ctx} »` });
  for (const s of sites) for (const x of s.objs) steps.push({ phase: 'move', site: s.key, extId: x.id, exten: x.exten, text: `${x.what} ${x.exten} (${x.label}) → « ${s.names.ctx} »` });
  for (const t of targets) steps.push({ phase: 'rewrite', target: t, text: `Réécrire ${t.label} : numéro@commun → numéro@site (relu avant, valeur d'avant gardée)` });
  if (dropOut) steps.push({ phase: 'dropout', text: `Retirer du commun « ${common.label || common.name} » ses contextes sortants (${(common.contexts || []).filter((c) => I.by.context?.get(String(c.name))?.type === 'outcall').map((c) => `« ${c.label || c.name} »`).join(', ') || 'aucun'}) : les sites ne sortent plus que par leur règle` });
  for (const s of sites) for (const v of s.vms) steps.push({ phase: 'vm', site: s.key, vmId: v.id, text: `messagerie ${v.number} (${v.name || ''}) → contexte « ${s.names.ctx} » (messages déplacés par Wazo)` });
  const moves = steps.filter((x) => x.phase === 'move').length;
  return { problems, steps, sites, common, moves, sim, perm118, targets, dropOut, drop, ok: !problems.some((p) => p.sev === 'error') && moves > 0 };
}

// ---------------------------------------------------------------------------
// Simulation avant / après (moteur de l'import 3CX : extensions du contexte,
// ses règles sortantes, puis les contextes inclus dans l'ordre, chacun une fois)
// ---------------------------------------------------------------------------
const vname = (s, k) => `@site:${s.key}:${k}`;
function futureWorld(ms, sites, common, dropOut = false) {
  const w = worldOf({ contexts: I.lists.context || [], extensions: I.lists.extension || [], outcalls: I.lists.outcall || [] });
  const f = { ctx: new Map([...w.ctx].map(([k, v]) => [k, { ...v, includes: [...v.includes] }])), exts: new Map(w.exts), outs: new Map([...w.outs].map(([k, v]) => [k, [...v]])) };
  const nm = (s, k) => (k === 'common' ? common.name : vname(s, k));
  for (const s of sites) {
    // Motifs de la règle du site : la simulation montre la sortie par le trunk du site.
    if (s.trunk) f.outs.set(vname(s, 'out'), s.pats.map((p) => ({ exten: p.exten, dp: p, rule: s.rule, trunks: [Number(s.trunk.id)], mine: true })));
    f.ctx.set(vname(s, 'out'), { name: vname(s, 'out'), label: s.names.out, type: 'outcall', includes: [] });
    f.ctx.set(vname(s, 'inc'), { name: vname(s, 'inc'), label: s.names.inc, type: 'incall', includes: [] });
    f.ctx.set(vname(s, 'ctx'), { name: vname(s, 'ctx'), label: s.names.ctx, type: 'internal', includes: siteIncludes(ms, sites, s, nm) });
    for (const e of [...s.moved, ...s.objs]) { const k = `${e.exten}@${common.name}`; const x = f.exts.get(k); f.exts.delete(k); f.exts.set(`${e.exten}@${vname(s, 'ctx')}`, { ...(x || { users: 1 }), ctx: vname(s, 'ctx') }); }
  }
  if (commonIncludesSites(ms)) f.ctx.get(common.name).includes = [...f.ctx.get(common.name).includes.filter((x) => !x.startsWith('@site:')), ...sites.map((s) => vname(s, 'ctx'))];
  if (dropOut) f.ctx.get(common.name).includes = f.ctx.get(common.name).includes.filter((x) => f.ctx.get(x)?.type !== 'outcall');
  return { before: w, after: f };
}
const SIM_EXT = [['15', 'SAMU'], ['112', 'urgences'], ['0240000000', 'fixe'], ['0612345678', 'mobile'], ['0033123456789', 'international']];
// Résultat lisible d'une recherche.
const simText = (w, r) => (r.kind === 'internal' ? `interne · ${w.ctx.get(r.ctx)?.label || r.ctx}` : r.kind === 'out' ? `sortant · règle « ${r.rule} »` : 'non routé');
export function simulate(ms, sites, common, { dropOut = false } = {}) {
  const issues = []; const rows = [];
  if (!sites.length) return { issues, rows, cols: [] };
  const { before, after } = futureWorld(ms, sites, common, dropOut);
  const cName = common.label || common.name;
  // Une cible par site (son premier numéro), une pour le commun (premier numéro resté), puis l'extérieur.
  const stay = (I.lists.extension || []).filter((e) => e.context === common.name && /^\d+$/.test(e.exten || '') && !sites.some((s) => [...s.moved, ...s.objs].some((m) => m.exten === e.exten)));
  const cols = [
    ...sites.filter((s) => s.moved.length).map((s) => ({ n: s.moved[0].exten, what: `site ${s.label}`, site: s })),
    ...(stay.length ? [{ n: stay[0].exten, what: `commun (${stay[0].group ? 'groupe' : stay[0].queue ? 'file' : 'poste'})`, common: true }] : []),
    ...SIM_EXT.map(([n, what]) => ({ n, what, ext: true })),
  ];
  const froms = [...sites.map((s) => ({ ctx: vname(s, 'ctx'), label: s.names.ctx, site: s })), { ctx: common.name, label: `commun ${cName}`, common: true }];
  for (const fr of froms) {
    const cells = cols.map((c) => {
      // Avant : tout le monde compose depuis le commun.
      const b = route(before, common.name, c.n); const a = route(after, fr.ctx, c.n);
      // Attendu : un site joint son propre numéro, les sites liés, le commun ; le commun joint les sites seulement en « mesh ».
      let want = null;
      if (c.site) want = fr.site ? (fr.site === c.site || linked(ms, fr.site.key, c.site.key)) : commonIncludesSites(ms);
      else if (c.common) want = true;
      // Extérieur depuis le commun : rien ne doit changer (même règle qu'avant la bascule).
      const same = simText(before, b) === simText(after, a);
      // Sortant du commun retiré (plus aucun poste n'y compose) : son extérieur change, c'est voulu.
      const ok = want == null ? (fr.common ? same || dropOut : a.kind === 'out' || a.kind === b.kind) : want ? a.kind === 'internal' && (!c.site || a.ctx === vname(c.site, 'ctx')) : a.kind !== 'internal';
      if (fr.common && c.ext && !same && !dropOut) want = 'same';
      return { before: simText(before, b), after: simText(after, a), ok, want };
    });
    rows.push({ from: fr.label, cells });
    cells.forEach((x, i) => {
      if (x.ok) return; const c = cols[i];
      if (x.want === false) issues.push({ sev: 'error', text: `Cloisonnement : depuis « ${fr.label} », ${c.n} (${c.what}) reste joignable (${x.after}).` });
      else if (x.want === true) issues.push({ sev: 'error', text: `Depuis « ${fr.label} », ${c.n} (${c.what}) n'est plus joignable en interne : ${x.after}.` });
      // Appel qui sortait déjà : changer de trunk est une erreur. Appel non routé qui sortirait par un site : avertissement.
      else if (x.want === 'same') issues.push({ sev: x.before === 'non routé' ? 'warn' : 'error', text: `Depuis le commun, ${c.n} (${c.what}) : ${x.before} avant, ${x.after} après${x.before === 'non routé' ? ' (par l\'inclusion du site, en fin de liste)' : ''}.` });
      // Extérieur : visible dans le tableau ; les urgences ont leur propre contrôle ci-dessous.
    });
  }
  // Urgences depuis chaque site.
  for (const s of sites) { const miss = EMERGENCY.filter((n) => route(after, vname(s, 'ctx'), n).kind !== 'out'); if (miss.length) issues.push({ sev: 'warn', text: `Depuis « ${s.names.ctx} », numéros d'urgence non routés : ${miss.join(', ')}.` }); }
  // Références numéro@contexte vers un numéro déplacé, cherchées depuis leur contexte après la bascule.
  const moved = new Map(sites.flatMap((s) => [...s.moved, ...s.objs].map((m) => [m.exten, s])));
  const refs = [];
  // Réécriture active : les destinations et membres de groupe « numéro@commun » visent le site du numéro.
  const fixed = (ctx, n, can) => (can && rewriteOn(ms) && ctx === common.name && moved.has(n) ? vname(moved.get(n), 'ctx') : ctx);
  for (const x of allDests()) if (x.dest?.type === 'extension' && moved.has(x.dest.exten)) refs.push({ from: fixed(x.dest.context, x.dest.exten, true), n: x.dest.exten, what: `${objLabel(x.type, x.obj)}, ${x.slot}` });
  for (const t of ['group', 'queue']) for (const o of I.lists[t] || []) for (const m of membersOf(o).extensions) if (moved.has(m.exten)) refs.push({ from: fixed(m.context, m.exten, t === 'group'), n: m.exten, what: `membre ${m.exten} de ${t === 'group' ? 'groupe' : 'file'} ${o.label || o.name}` });
  const ctxOfUser = (u) => { const c = userContext(u); const e = (u.lines?.[0]?.extensions || [])[0]; const s = e && c === common.name ? moved.get(e.exten) : null; return s ? vname(s, 'ctx') : c; };
  for (const u of I.lists.user || []) for (const [pos, k] of Object.entries(I.funckeys?.[u.uuid] || {})) if (k?.destination?.type === 'custom' && moved.has(k.destination.exten)) refs.push({ from: ctxOfUser(u), n: k.destination.exten, what: `touche ${pos} de ${[u.firstname, u.lastname].filter(Boolean).join(' ')}` });
  const broken = refs.filter((r) => r.from && route(after, r.from, r.n).kind !== 'internal');
  if (broken.length) issues.push({ sev: 'error', text: `${broken.length} référence(s) « numéro » vers un numéro déplacé ne le trouveront plus (${broken.slice(0, 5).map((r) => `${r.what} → ${r.n}`).join(' ; ')}${broken.length > 5 ? '…' : ''}). ${rewriteOn(ms) ? 'Non réécrites par l\'outil (membres « numéro » des files, touches de numérotation rapide) : à corriger à la main, ou choisir « Tous les sites s\'appellent ».' : 'Cocher « Réécrire les références », ou choisir « Tous les sites s\'appellent » (le commun inclut alors les sites).'}` });
  return { issues, rows, cols };
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------
// Refuse tout appel si le portail a changé de tenant (même règle que Call Flow Manager).
async function tapi(method, path, body) {
  if (!sameTenant(I.tenant)) throw Object.assign(new Error('Le tenant a changé dans le portail : opération arrêtée, rien n\'est envoyé vers le nouveau tenant.'), { stale: true });
  return api(method, path, body);
}
// Live reload (règles vérifiées par User Manager, voir users/app.js) : réglage
// commun à tout le serveur, appel sans Wazo-Tenant.
export async function liveReload(method, body) {
  if (S.readonly && method !== 'GET') throw new Error(`Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${S.base}/api/confd/1.1/configuration/live_reload`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new ApiError(r.status, `live reload ${method} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}
export function lrMarkedByUs() { try { return (localStorage.getItem(LR_MARK) || '').startsWith(`${S.base}|`); } catch { return false; } }
function markLr(on) { try { if (on) localStorage.setItem(LR_MARK, `${S.base}|${new Date().toISOString()}`); else localStorage.removeItem(LR_MARK); } catch { /* */ } }
export async function enableLiveReload() {
  let e = null;
  for (let i = 0; i < 3; i++) { try { await liveReload('PUT', { enabled: true }); markLr(false); return true; } catch (x) { e = x; await sleep(1000); } }
  throw e;
}

export function saveJournal(j) { try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(j)); } catch { /* stockage indisponible : le fichier téléchargé fait foi */ } }
export function loadSavedJournal() { try { const j = JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null'); return j?.format === JOURNAL_FORMAT ? j : null; } catch { return null; } }
export function clearSavedJournal() { try { localStorage.removeItem(JOURNAL_KEY); } catch { /* */ } }


// Rechargements regroupés pour toute une opération (lu dans les notifiers de
// confd : contextes et inclusions → dialplan reload ; extension modifiée →
// dialplan + res_pjsip + chan_sccp + app_queue ; écriture identique → rien ;
// live reload coupé → rien, et le réactiver ne recharge rien).
// `body()` fait toutes les écritures sauf la dernière, live reload coupé ;
// `last()` fait la dernière, live reload réactivé : elle déclenche UN rechargement
// complet. Renvoie une note pour le rapport.
async function withGroupedReload(nWrites, body, last) {
  let grouped = false; let note = '';
  if (nWrites > 1) {
    try {
      const st = await liveReload('GET');
      if (st?.enabled) { await liveReload('PUT', { enabled: false }); markLr(true); grouped = true; } else note = 'Live reload déjà désactivé sur le serveur : laissé tel quel, rechargement à faire ensuite.';
    } catch (e) { note = `Regroupement des rechargements impossible (${e.message}) : un rechargement par écriture.`; }
  }
  try { await body(grouped); } catch (e) {
    if (grouped) { try { await enableLiveReload(); } catch { e.message += ' ; ÉCHEC de la réactivation du live reload : bouton du bandeau rouge'; } }
    throw e;
  }
  if (grouped) { await enableLiveReload(); note = 'Rechargements regroupés : un seul rechargement d\'Asterisk, à la dernière écriture.'; }
  await last();
  return note;
}
// Déplace un numéro, relu juste avant (arrêt s'il a changé depuis la lecture).
async function moveOne(m, log, op = 'move') {
  const cur = await tapi('GET', `/extensions/${m.extId}`);
  if (cur?.context === m.to) { log({ op, ...m, skipped: 'déjà dans le contexte cible' }); return; }
  if (cur?.context !== m.from || cur?.exten !== m.exten) throw new Error(`${m.exten} a changé depuis la lecture (maintenant ${cur?.exten}@${cur?.context}) : arrêt.`);
  await tapi('PUT', `/extensions/${m.extId}`, { context: m.to });
  log({ op, ...m });
}

// SDA d'un site : déplacées dans son entrant, seulement si son trunk y arrive déjà (relu juste
// avant ; l'outil ne règle jamais le trunk). Avant ce réglage, les déplacer couperait ces SDA.
export function didsReady(j, key) {
  const s = (j?.sites || []).find((x) => x.site === key); if (!s) return { ok: false, why: 'site inconnu du journal' };
  const left = s.dids.filter((d) => !(j.entries || []).some((e) => e.op === 'move_did' && e.extId === d.extId && !e.undone));
  if (!left.length) return { ok: false, done: true, why: 'SDA déjà déplacées' };
  const tr = (I.lists.trunk || []).find((t) => String(t.id) === String(s.trunkId));
  if (!tr) return { ok: false, why: 'aucun trunk choisi pour ce site' };
  if (tr.context !== s.inc.name) return { ok: false, why: `trunk ${objLabel('trunk', tr)} encore sur « ${I.by.context?.get(String(tr.context))?.label || tr.context || 'aucun'} » : le régler sur « ${s.inc.label} » dans le Portal, puis relire` };
  return { ok: true, s, left, tr };
}
export async function moveDids(j, key, onProgress = () => {}) {
  const r = didsReady(j, key); if (!r.ok) throw new Error(r.why);
  const fresh = await tapi('GET', `/trunks/${r.tr.id}`);
  if (fresh?.context !== r.s.inc.name) throw new Error(`le trunk n'arrive plus sur « ${r.s.inc.label} » (relu à l'instant) : rien n'est déplacé.`);
  const log = (e) => { j.entries.push({ at: new Date().toISOString(), ...e }); saveJournal(j); };
  const ms = r.left.map((d) => ({ extId: d.extId, exten: d.exten, from: d.from, to: r.s.inc.name }));
  return withGroupedReload(ms.length, async (grouped) => {
    for (const [i, m] of ms.slice(0, -1).entries()) { onProgress(`SDA : ${i + 1} / ${ms.length}`); await moveOne(m, log, 'move_did'); if (!grouped) await sleep(300); }
  }, async () => { onProgress(`SDA : ${ms.length} / ${ms.length}`); await moveOne(ms[ms.length - 1], log, 'move_did'); });
}

export async function executePlan(plan, ms, onProgress = () => {}) {
  if (!plan.ok) throw new Error('Plan non valide');
  const j = {
    format: JOURNAL_FORMAT, version: 1, started_at: new Date().toISOString(), host: S.base, tenant: I.tenant,
    source: { name: plan.common.name, id: plan.common.id, label: plan.common.label },
    common_includes_before: null, created: [], entries: [], status: 'en cours', note: '',
  };
  const log = (e) => { j.entries.push({ at: new Date().toISOString(), ...e }); saveJournal(j); };
  saveJournal(j);
  const byKey = new Map(); // clé du site → { ctx, out, inc } (contextes créés)
  let moves = [];
  const withCommon = commonIncludesSites(ms);
  const nWrites = plan.sites.length * 5 + plan.steps.filter((x) => x.phase === 'vm' || x.phase === 'rewrite').length + plan.sites.reduce((a, s) => a + (s.trunk ? s.pats.length * 2 + 3 : 0), 0) + (withCommon ? 1 : 0) + plan.moves;
  j.partition = partitionOf(ms);
  try {
    j.note = await withGroupedReload(nWrites, async (grouped) => {
      // 1. Contextes des sites : sortant et entrant d'abord (vides), puis l'interne avec ses plages.
      const desc = `Site créé par ${MARK} depuis ${plan.common.label || plan.common.name}`;
      for (const s of plan.sites) {
        onProgress(`Création des contextes de « ${s.label} »`);
        const made = {};
        // did_length = longueur du numéro, comme Wazo (confd user/middleware.py) ; 0 affiché sinon dans le Portal.
        const incRanges = s.dids.map((d) => ({ start: d.exten, end: d.exten, did_length: String(d.exten).length }));
        for (const [role, body] of [['out', { label: s.names.out, type: 'outcall' }], ['inc', { label: s.names.inc, type: 'incall', incall_ranges: incRanges }], ['ctx', { label: s.names.ctx, type: 'internal', user_ranges: s.ranges, ...s.objRanges }]]) {
          const c = await tapi('POST', '/contexts', { ...body, description: desc });
          if (!c?.id || !c?.name) throw new Error('POST /contexts : réponse sans id ni nom');
          made[role] = c;
          j.created.push({ site: s.key, role, label: body.label, id: c.id, name: c.name });
          log({ op: 'create_context', role, id: c.id, name: c.name, label: body.label });
        }
        byKey.set(s.key, made);
      }
      // 2. Inclusions de chaque site : son sortant, les sites liés (cloisonnement choisi), le commun.
      const idOf = (s, k) => (k === 'common' ? plan.common.id : byKey.get(s.key)[k].id);
      for (const s of plan.sites) {
        const ids = siteIncludes(ms, plan.sites, s, idOf);
        await tapi('PUT', `/contexts/${byKey.get(s.key).ctx.id}/contexts`, { contexts: ids.map((id) => ({ id })) });
        log({ op: 'site_includes', id: byKey.get(s.key).ctx.id, contexts: ids });
        // Entrant du site : repli sur les contextes entrants actuels de ses SDA (et de son trunk).
        const incIds = s.incFrom.map((n) => I.by.context.get(String(n))?.id).filter(Boolean);
        if (incIds.length) {
          await tapi('PUT', `/contexts/${byKey.get(s.key).inc.id}/contexts`, { contexts: incIds.map((id) => ({ id })) });
          log({ op: 'site_includes', id: byKey.get(s.key).inc.id, contexts: incIds });
        }
      }
      // 2b. Règle sortante de chaque site qui a un trunk (comme Call Flow Manager et l'import 3CX) :
      //     un numéro par motif dans le sortant du site, association avec sa transformation, trunk,
      //     puis l'autorisation « interdit-118 » (reprise si elle existe, créée une fois sinon).
      let perm118 = plan.perm118;
      for (const s of plan.sites.filter((x) => x.trunk)) {
        onProgress(`Règle sortante de « ${s.label} »`);
        const o = await tapi('POST', '/outcalls', { name: s.rule });
        log({ op: 'create_outcall', id: o.id, name: s.rule });
        for (const p of s.pats) {
          const ext = await tapi('POST', '/extensions', { exten: p.exten, context: byKey.get(s.key).out.name });
          log({ op: 'create_extension', id: ext.id, exten: p.exten, outcall: o.id });
          await tapi('PUT', `/outcalls/${o.id}/extensions/${ext.id}`, { strip_digits: p.strip_digits || 0, external_prefix: p.external_prefix || null, prefix: null, caller_id: s.callerId || null });
        }
        await tapi('PUT', `/outcalls/${o.id}/trunks`, { trunks: [{ id: Number(s.trunk.id) }] });
        if (outOf(ms).block118) {
          if (!perm118) {
            perm118 = await tapi('POST', '/callpermissions', { name: 'interdit-118', mode: 'deny', enabled: true, extensions: [BLOCK_118], description: `Renseignements 118 XXX surtaxés (${MARK})` });
            log({ op: 'create_perm', id: perm118.id });
          }
          await tapi('PUT', `/outcalls/${o.id}/callpermissions/${perm118.id}`);
        }
      }
      // SDA à déplacer plus tard (une fois le trunk réglé sur l'entrant du site, dans le Portal).
      j.sites = plan.sites.map((s) => ({ site: s.key, label: s.label, inc: { id: byKey.get(s.key).inc.id, name: byKey.get(s.key).inc.name, label: s.names.inc }, trunkId: s.trunk?.id ?? null, dids: s.dids.map((d) => ({ extId: d.extId, exten: d.exten, from: d.context })) }));
      // 3. Inclusions du commun (relues juste avant), seulement si tous les sites s'appellent :
      //    sinon le commun ouvrirait les sites les uns aux autres.
      //    Sortant du commun retiré si demandé (plus aucun poste n'y compose).
      if (withCommon || plan.dropOut) {
        const fresh = await tapi('GET', `/contexts/${plan.common.id}`);
        const before = (fresh?.contexts || []).map((c) => c.id);
        const siteIds = plan.sites.map((s) => byKey.get(s.key).ctx.id);
        let after = withCommon ? [...before.filter((id) => !siteIds.includes(id)), ...siteIds] : [...before];
        if (plan.dropOut) after = after.filter((id) => (I.lists.context || []).find((c) => c.id === id)?.type !== 'outcall');
        if (after.join() !== before.join()) {
          j.common_includes_before = before;
          await tapi('PUT', `/contexts/${plan.common.id}/contexts`, { contexts: after.map((id) => ({ id })) });
          log({ op: 'common_includes', id: plan.common.id, before, after });
        }
      }
      // 3b. Messageries des utilisateurs déplacés (PUT partiel, lu : parse_and_update ; sysconfd
      //     déplace aussi les messages, voicemail/service.py move_voicemail). Relues juste avant.
      for (const st of plan.steps.filter((x) => x.phase === 'vm')) {
        const to = byKey.get(st.site).ctx.name; const cur = await tapi('GET', `/voicemails/${st.vmId}`);
        if (cur?.context === to) continue;
        if (cur?.context !== plan.common.name) throw new Error(`messagerie ${cur?.number} : contexte changé depuis la lecture (${cur?.context}) : arrêt.`);
        await tapi('PUT', `/voicemails/${st.vmId}`, { context: to });
        log({ op: 'move_vm', vmId: st.vmId, number: cur.number, from: plan.common.name, to });
      }
      saveJournal(j);
      // 4. Numéros (postes, puis groupes, files, conférences), sauf le dernier
      moves = plan.steps.filter((x) => x.phase === 'move').map((x) => ({ extId: x.extId, exten: x.exten, from: plan.common.name, to: byKey.get(x.site).ctx.name }));
      for (const [i, m] of moves.slice(0, -1).entries()) {
        onProgress(`Déplacement des numéros : ${i + 1} / ${moves.length}`);
        await moveOne(m, log);
        if (!grouped) await sleep(300); // laisse Asterisk souffler entre deux rechargements
      }
      // 5. Références « numéro@commun » vers un numéro déplacé : vers le contexte de son site.
      const siteOf = new Map(plan.sites.flatMap((s) => [...s.moved, ...s.objs].map((m) => [String(m.exten), byKey.get(s.key).ctx.name])));
      const mapDest = (d) => (d?.type === 'extension' && d.context === plan.common.name && siteOf.has(String(d.exten)) ? { ...d, context: siteOf.get(String(d.exten)) } : d);
      const mapMember = (m) => (m.context === plan.common.name && siteOf.has(String(m.exten)) ? { ...m, context: siteOf.get(String(m.exten)) } : m);
      for (const st of plan.steps.filter((x) => x.phase === 'rewrite')) {
        onProgress(`Références : ${st.target.label}`);
        const r = await rewriteTarget(st.target, mapDest, mapMember);
        if (r) log({ op: 'rewrite', label: st.target.label, ...r });
      }
    }, async () => {
      onProgress(`Déplacement des numéros : ${moves.length} / ${moves.length}`);
      await moveOne(moves[moves.length - 1], log); // déclenche le rechargement final
    });
    j.status = 'terminé';
  } catch (e) {
    j.status = 'interrompu'; j.error = e.message;
    saveJournal(j);
    throw Object.assign(e, { journal: j });
  }
  j.finished_at = new Date().toISOString();
  saveJournal(j);
  return j;
}

// Annulation depuis le journal : inclusions du commun restaurées, numéros remis
// dans leur contexte d'origine (le dernier déclenche le rechargement), puis
// contextes créés supprimés (refusé par Wazo s'ils contiennent encore un numéro).
export async function undoJournal(j, onProgress = () => {}) {
  if (j?.format !== JOURNAL_FORMAT) throw new Error('Ce fichier n\'est pas un journal de bascule multisite.');
  if (j.host !== S.base || j.tenant !== I.tenant) throw new Error('Ce journal concerne un autre serveur ou un autre tenant.');
  const report = [];
  const log = (e) => report.push(e);
  // Numéros puis SDA, dans l'ordre inverse (les SDA, déplacées en dernier, reviennent d'abord).
  const back = j.entries.filter((e) => (e.op === 'move' || e.op === 'move_did') && !e.skipped && !e.undone).reverse().map((m) => ({ extId: m.extId, exten: m.exten, from: m.to, to: m.from }));
  // Règles sortantes des sites : règles, puis leurs numéros, puis « interdit-118 » si l'outil l'a
  // créée et qu'aucune autre règle ne s'en sert (relu). Avant les contextes, qui doivent être vides.
  const delRules = async () => {
    const ours = new Set(j.entries.filter((e) => e.op === 'create_outcall').map((e) => e.id));
    for (const e of [...j.entries].reverse()) {
      try {
        if (e.op === 'create_outcall') { onProgress(`Suppression de la règle « ${e.name} »`); await tapi('DELETE', `/outcalls/${e.id}`); log({ op: 'delete_outcall', id: e.id }); }
        else if (e.op === 'create_extension') { await tapi('DELETE', `/extensions/${e.id}`); log({ op: 'delete_extension', id: e.id }); }
        else if (e.op === 'create_perm') {
          const p = await tapi('GET', `/callpermissions/${e.id}`);
          const others = (p?.outcalls || []).filter((x) => !ours.has(x.id));
          if (others.length) log({ op: 'keep_perm', id: e.id, error: `« interdit-118 » gardée : utilisée par ${others.length} autre(s) règle(s)` });
          else { await tapi('DELETE', `/callpermissions/${e.id}`); log({ op: 'delete_perm', id: e.id }); }
        }
      } catch (x) { if (x.status !== 404) log({ op: e.op.replace('create', 'delete'), id: e.id, error: x.message }); }
    }
  };
  const restoreIncludes = async () => {
    if (!Array.isArray(j.common_includes_before)) return;
    onProgress('Inclusions du commun');
    await tapi('PUT', `/contexts/${j.source.id}/contexts`, { contexts: j.common_includes_before.map((id) => ({ id })) });
    log({ op: 'common_includes', restored: j.common_includes_before });
  };
  // Contextes créés : interne d'abord (il inclut le sortant), puis sortant et entrant, ordre inverse
  // de la création. Refus de Wazo noté sans arrêter (contexte qui contient encore quelque chose).
  const dels = [...j.created].reverse();
  const del = async (c) => {
    onProgress(`Suppression du contexte « ${c.label} »`);
    try { await tapi('DELETE', `/contexts/${c.id}`); log({ op: 'delete_context', id: c.id }); }
    catch (e) { log({ op: 'delete_context', id: c.id, label: c.label, error: e.message }); }
  };
  // Un seul rechargement : inclusions, numéros sauf le dernier, contextes des autres sites (vides),
  // live reload coupé ; puis le dernier numéro, live reload réactivé (vraie modification : elle
  // recharge à coup sûr, une suppression refusée ne rechargerait rien) ; enfin les contextes de
  // son site, qui ne pouvaient pas être supprimés avant (un rechargement chacun, trois au plus).
  const lastSite = back.length ? j.created.find((c) => c.name === back[back.length - 1].from)?.site : null;
  const early = dels.filter((c) => c.site !== lastSite); const late = dels.filter((c) => c.site === lastSite);
  // Messageries remises dans le commun (avant la suppression des contextes de site).
  const delVms = async () => {
    for (const e of [...j.entries].reverse().filter((x) => x.op === 'move_vm')) {
      try {
        const cur = await tapi('GET', `/voicemails/${e.vmId}`);
        if (cur?.context !== e.to) { log({ op: 'move_vm', vmId: e.vmId, skipped: `contexte actuel ${cur?.context}` }); continue; }
        await tapi('PUT', `/voicemails/${e.vmId}`, { context: e.from }); log({ op: 'move_vm', vmId: e.vmId, restored: e.from });
      } catch (x) { log({ op: 'move_vm', vmId: e.vmId, error: x.message }); }
    }
  };
  // Références réécrites : valeur d'avant renvoyée telle quelle (PUT partiel ou objet entier, selon la cible).
  const restoreRefs = async () => {
    for (const e of [...j.entries].reverse().filter((x) => x.op === 'rewrite')) {
      try { onProgress(`Références : ${e.label}`); await tapi('PUT', e.path, e.before); log({ op: 'rewrite', path: e.path, restored: true }); }
      catch (x) { log({ op: 'rewrite', path: e.path, error: x.message }); }
    }
  };
  const nRules = j.entries.filter((e) => ['create_outcall', 'create_extension', 'create_perm', 'move_vm', 'rewrite'].includes(e.op)).length;
  const nWrites = back.length + (Array.isArray(j.common_includes_before) ? 1 : 0) + early.length + nRules;
  const note = await withGroupedReload(nWrites, async (grouped) => {
    if (back.length) await restoreIncludes();
    for (const [i, m] of back.slice(0, -1).entries()) {
      onProgress(`Retour des numéros : ${i + 1} / ${back.length}`);
      await moveOne(m, log);
      if (!grouped) await sleep(300);
    }
    await restoreRefs();
    await delVms();
    await delRules();
    if (back.length) for (const c of early) await del(c);
  }, async () => {
    if (back.length) { onProgress(`Retour des numéros : ${back.length} / ${back.length}`); await moveOne(back[back.length - 1], log); } else await restoreIncludes();
  });
  const after = back.length ? late : dels;
  for (const c of after) await del(c);
  return { report, note: `${note}${after.length ? ` Puis ${after.length} suppression(s) de contexte, un rechargement chacune.` : ''}` };
}
