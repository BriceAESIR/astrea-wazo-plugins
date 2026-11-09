// Migration Assistant — lot 5, deuxième conception : migration guidée orientée
// API (cahier des charges : docs/MIGRATION-ASSISTANT.md, « Lot 5, deuxième
// conception »). Retour de Brice sur la 0.40.29 : ne pas recopier sa trame de
// clics du Portal, guider et expliquer, perdre le moins possible et annoncer
// toute perte avant écriture, comme le mode édition de Call Flow.
// Parcours : 1 Préparer (relecture du tenant, prérequis) → 2 Plan (ordonné par
// l'outil, par phases) → 3 Pertes et écarts (à accepter) → 4 Appliquer par
// phase (sauvegarde, journal, annulation) → 5 Contrôle final (à venir).
// Écritures disponibles : phase Fondations (contextes du client selon le site
// choisi, 3cx-sites.js ; plages, pays, conservation, numéros, règle sortante
// de l'assistant France de Call Flow ; lues dans le code, testées sur faux tenant). Les phases
// Personnes, Routage et Finitions sont planifiées (lecture seule) ; leur
// écriture arrive aux lots 5b-5d.
import { S, api, listAll, ApiError, esc, toast, canWrite, confirmModal, helpButton, helpBox, downloadJson } from '../common/core.js?v=0.40.60';
import { I, sameTenant } from './inventory.js?v=0.40.60';
import { buildExport, exportFileName } from './export.js?v=0.40.60';
import { saveDraft, imported, userBy, huntBy, userName, draftIssues, tenantIssues, blfRows, destLabel, LICENCES, linesOf, linesText, didWazo, numWazo, unverified } from './3cx-draft.js?v=0.40.60';
import {
  SITE_MODES, FR_FAMILIES, FR_FORMATS, BLOCK_118, defaultSite, defaultOut, clientPatterns, unitDids, rangeIssues, occupancy, placements, unitLabels, unitCfg, futureOf, siteChecks, routeText, newRanges, multi as multiSites, wazoNum, numberIssues,
} from './3cx-sites.js?v=0.40.60';
import { unitList, unitOf, deptBy, deptLabel, deptObjects } from './3cx-depts.js?v=0.40.60';
import { mohLabel, soundCategory, loaded, uniqueNames, putBinary, CATEGORY_RE } from './3cx-sounds.js?v=0.40.60';
import { phonebookName, companyContacts, sourceColumns, dird } from './3cx-phonebook.js?v=0.40.60';

const W = { d: null, m: null, t: null, busy: false, msg: null, at: null };
export function setWizard(d, m) { W.d = d; W.m = m; W.t = null; W.msg = null; ensureState(); }

function ensureState() {
  const d = W.d;
  // Brouillon de la 0.40.29 (étapes) : on garde l'ID client et les durées, on repart pour les phases.
  const old = d.write || {};
  if (old.version === 2) { old.site ||= defaultSite(); old.out ||= defaultOut(); return; }
  const m = String(d.company || '').match(/^\s*(\d{3,})\s*[-–]\s*(.+)$/);
  d.write = {
    version: 2, clientId: old.clientId ?? (m ? m[1] : ''), clientName: old.clientName ?? (m ? m[2].trim() : (d.company || '')),
    cdrDays: old.cdrDays ?? 90, recordingDays: old.recordingDays ?? 90, trunkId: old.trunkId ?? '', ackLosses: false, keepProfiles: true, phases: {},
    site: defaultSite(), out: defaultOut(),
  };
}
const ph = (id) => (W.d.write.phases[id] ||= { status: 'todo', log: [], undo: [] });
const save = () => saveDraft(W.d);

// ---------------------------------------------------------------------------
// Accès API (garde de tenant : le portail change de tenant tout de suite)
// ---------------------------------------------------------------------------
const guard = () => { if (!sameTenant(I.tenant)) throw new Error('Le tenant a changé dans le portail : opération arrêtée, rien n\'est envoyé vers le nouveau tenant.'); };
async function tapi(method, path, body) { guard(); return api(method, path, body); }
// call-logd (conservation) : Wazo-Tenant envoyé comme pour confd (Tenant.autodetect, lu) ; CORS supposé.
async function logd(method, path, body) {
  guard();
  if (S.readonly && method !== 'GET') throw new ApiError(0, `Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${S.base}/api/call-logd/1.0${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) { let m = `call-logd ${method} ${path} → ${r.status}`; try { m += ' ' + JSON.stringify(await r.json()).slice(0, 300); } catch { /* */ } throw new ApiError(r.status, m); }
  return r.status === 204 ? null : r.json();
}
const e164 = numWazo; // même normalisation que le brouillon (3cx-draft.js)
const soft = async (fn, fallback) => { try { return await fn(); } catch (e) { return fallback(e); } };

// ---------------------------------------------------------------------------
// 1. Préparer : relecture du tenant (tout ce dont le plan a besoin)
// ---------------------------------------------------------------------------
async function readTenant() {
  const list = (p) => soft(() => listAll(p), (e) => ({ error: e.message, items: [] }));
  const [contexts, extensions, trunks, outcalls, users, voicemails, devices, groups, queues, ivrs, schedules, incalls, phones, perms, moh, sounds] = await Promise.all(
    ['/contexts', '/extensions', '/trunks', '/outcalls', '/users', '/voicemails', '/devices', '/groups', '/queues', '/ivr', '/schedules', '/incalls', '/phone-numbers', '/callpermissions', '/moh', '/sounds'].map(list));
  const unwrap = (x) => (Array.isArray(x) ? x : []);
  const t = {
    at: new Date(), contexts: unwrap(contexts), extensions: unwrap(extensions), trunks: unwrap(trunks), outcalls: unwrap(outcalls), users: unwrap(users), voicemails: unwrap(voicemails),
    devices: unwrap(devices), groups: unwrap(groups), queues: unwrap(queues), ivrs: unwrap(ivrs), schedules: unwrap(schedules), incalls: unwrap(incalls), phones: unwrap(phones), perms: unwrap(perms), moh: unwrap(moh), sounds: unwrap(sounds),
    phonesError: phones?.error || null,
  };
  t.localization = await soft(() => tapi('GET', '/localization'), (e) => ({ error: e.message }));
  t.retention = await soft(() => logd('GET', '/retention'), (e) => ({ error: e.message }));
  // Carnets d'annuaire du tenant (wazo-dird) : un carnet du même nom n'est pas recréé.
  t.phonebooks = await soft(async () => { guard(); return (await dird('GET', '/phonebooks'))?.items || []; }, () => []);
  // Modèles SIP du tenant pour les lignes : l'import de Wazo prend ceux du
  // tenant (creators.py : tenant.global_sip_template, webrtc_sip_template ;
  // GET /tenants/{uuid} les donne, tenant/schema.py, lu le 03/11/2026). À
  // défaut de droit sur /tenants, les modèles libellés « global » / « webrtc »
  // (même repli que User Manager).
  const ten = await soft(() => tapi('GET', `/tenants/${S.tenant}`), () => null);
  const tpls = ten?.global_sip_template_uuid ? [] : unwrap(await list('/endpoints/sip/templates'));
  t.sipTpl = { global: ten?.global_sip_template_uuid || tpls.find((x) => x.label === 'global')?.uuid || null, webrtc: ten?.webrtc_sip_template_uuid || tpls.find((x) => x.label === 'webrtc')?.uuid || null, from: ten ? 'tenant' : 'libellés' };
  return t;
}
// Contextes cibles, selon le site choisi et les départements (3cx-sites.js) :
// une entrée par jeu de contextes (unité), avec son contexte interne existant ou
// à créer (objet virtuel, plages calculées, tant qu'il n'est pas créé) et son
// sortant. `internal` / `outcall` : ceux de la première unité (une seule unité :
// le contexte du client), ou un contexte virtuel couvrant tout le client pour
// les contrôles du brouillon. Entrant : celui choisi dans Exports, sinon le premier.
function contextsOf(t) {
  const pick = (cur, type) => t.contexts.find((c) => c.name === cur && c.type === type) || t.contexts.find((c) => c.type === type) || null;
  const many = multiSites(W.d);
  const units = placements(t, W.d).map((p) => {
    const L = unitLabels(W.d, p);
    const ctx = p.newCtx ? { id: null, name: p.ctx, label: `${L.ctx} (à créer)`, type: 'internal', virtual: true, ...newRanges(W.d, many ? p.key : null) } : t.contexts.find((c) => c.name === p.ctx) || null;
    const out = p.newOut ? { id: null, name: p.out, label: `${L.out} (à créer)`, type: 'outcall', virtual: true } : t.contexts.find((c) => c.name === p.out) || null;
    // Contexte entrant propre au jeu (à créer, ou créé) ; null : celui du trunk.
    const inc = !p.inc ? null : p.newCtx ? { id: null, name: p.inc, label: `${L.inc} (à créer)`, type: 'incall', virtual: true } : t.contexts.find((c) => c.name === p.inc) || null;
    return { ...p, L, ctxObj: ctx, outObj: out, incObj: inc };
  });
  const internal = many ? { id: null, name: '@client', label: 'contextes du client', type: 'internal', virtual: true, ...newRanges(W.d) } : units[0]?.ctxObj || null;
  const incall = pick(W.d.incallCtx, 'incall');
  // Contexte entrant d'une SDA : celui du trunk de son jeu de contextes (champ context du trunk confd),
  // sinon celui choisi dans Exports (demande de Brice, 04/11/2026 : « dans le contexte entrant assigné »).
  const incallOf = (r) => {
    const u = many ? units.find((x) => x.key === unitOf(W.d, r)) : units[0];
    if (u?.incObj) return u.incObj;
    const tc = t.trunks.find((x) => String(x.id) === String(u?.trunkId))?.context;
    return t.contexts.find((x) => x.name === tc && x.type === 'incall') || incall;
  };
  return { internal, incall, outcall: units[0]?.outObj || null, units, many, incallOf };
}
const trunkLabel = (t, id) => { const x = t.trunks.find((y) => String(y.id) === String(id)); return x ? (x.endpoint_sip?.label || x.endpoint_sip?.name || `trunk ${id}`) : `trunk ${id}`; };
// Sons et musiques d'attente à envoyer (onglet Sons) : fichiers chargés et manquants.
function soundPlan(d) {
  const s = d.sounds; if (!s) return { mohs: [], cat: '', files: [], missing: [], def: null };
  const of = (to) => Object.entries(s.files).filter(([, x]) => x.to === to).map(([f]) => f);
  const mohs = s.moh.map((x) => ({ x, label: mohLabel(d, x), files: of(`moh:${x.key}`) }));
  const files = of('sound');
  const missing = [...mohs.flatMap((m) => m.files), ...files].filter((f) => !loaded(f));
  return { mohs, cat: soundCategory(d), files, missing, def: mohs.find((m) => m.x.key === s.defaultMoh) || null };
}
const RANGE_NAMES = { user_ranges: 'postes', group_ranges: 'groupes', queue_ranges: 'files', conference_room_ranges: 'conférences' };
const rangesTxt = (r) => Object.entries(r).map(([k, v]) => `${RANGE_NAMES[k]} ${v.map(rangeTxt).join(', ')}`).join(' ; ');
const ocNameOf = (u, many) => `${W.d.write.clientName || 'Client'}${many ? ` - ${u.label}` : ''} - Appels sortants`;

// ---------------------------------------------------------------------------
// Plages du contexte interne (demande de Brice, 03/11/2026) : les numéros 3CX
// à recréer doivent tomber dans les plages du contexte, sinon confd refuse
// (line_extension/validator.py pour les postes ; même contrôle à
// l'association d'un groupe ou d'une file, extension/validator.py). L'outil
// ajoute les plages manquantes, sans jamais retirer une plage existante.
// Lu dans confd (03/11/2026) : PUT /contexts/{id} partiel (ContextMiddleWare,
// parse_and_update), chaque clé envoyée remplace toute la liste de ce type ;
// début et fin de même longueur (RangeSchema) ; « dialplan reload » à l'écriture.
// ---------------------------------------------------------------------------
const RANGE_TYPES = [
  ['user_ranges', 'postes', (d) => imported(d)],
  ['group_ranges', 'groupes', (d) => d.hunts.filter((h) => h.target === 'group')],
  ['queue_ranges', 'files d\'attente', (d) => d.hunts.filter((h) => h.target === 'queue')],
];
const inR = (n, ranges) => (ranges || []).some((r) => Number(r.start) <= Number(n) && Number(n) <= Number(r.end ?? r.start));
const rangeTxt = (r) => (r.end && r.end !== r.start ? `${r.start}-${r.end}` : r.start);
// Une plage englobante par longueur de numéro (« 001-037 ») : simple à lire
// dans le Portal ; les numéros libres au milieu restent utilisables.
function spanOf(nums) {
  const by = new Map();
  for (const n of nums) { const k = n.length; if (!by.has(k)) by.set(k, []); by.get(k).push(n); }
  return [...by.values()].map((l) => { l.sort((a, b) => Number(a) - Number(b)); return { start: l[0], end: l[l.length - 1] }; });
}
// unit : clé du jeu de contextes (plusieurs jeux) ; seuls ses objets comptent.
function rangeFixes(ctx, unit = null) {
  if (!ctx || ctx.virtual) return [];
  const out = [];
  for (const [key, label, objs] of RANGE_TYPES) {
    const nums = objs(W.d).filter((o) => unit == null || unitOf(W.d, o) === unit).map((o) => wazoNum(W.d, o));
    const missing = [...new Set(nums)].filter((n) => /^\d+$/.test(n) && !inR(n, ctx[key]));
    if (missing.length) out.push({ key, label, missing, add: spanOf(missing), current: ctx[key] || [] });
  }
  return out;
}

// Contextes internes existants à contrôler : celui du client (un seul jeu), ou celui de chaque
// jeu déjà créé (plusieurs jeux, chacun avec ses propres objets).
const rangeTargets = (c) => (c.many ? c.units.filter((u) => u.ctxObj && !u.ctxObj.virtual).map((u) => ({ ctx: u.ctxObj, unit: u.key })) : c.internal && !c.internal.virtual ? [{ ctx: c.internal, unit: null }] : []);

// Messages identiques regroupés en une ligne (« 19 utilisateurs : licence non choisie »).
// La zone « Utilisateur 005 renvoi occupé » est réduite à son objet (« 005 »).
function grouped(list, label) {
  const by = new Map();
  for (const x of list) {
    const k = `${x.sev}|${x.text}`;
    if (!by.has(k)) by.set(k, { ...x, areas: [] });
    by.get(k).areas.push(x.area);
  }
  return [...by.values()].map((g) => (g.areas.length === 1 ? g : { ...g, area: `${g.areas.length} ${label(g.areas[0])}`, text: `${g.text} (${g.areas.map((a) => a.replace(/^(Utilisateur|SDA|Groupe|File|SVI|Appareil|Messagerie) /, '')).join(', ')})` }));
}
const kindOf = (area) => (/^Utilisateur/.test(area) ? 'utilisateurs' : /^SDA/.test(area) ? 'SDA' : /^Appareil/.test(area) ? 'appareils' : 'objets');

// Prérequis : bloquants (empêchent une phase) ou rappels (hors stack).
function prerequisites(t) {
  const c = contextsOf(t); const out = [];
  const add = (sev, title, text, phases = [], src = '') => out.push({ sev, title, text, phases, src });
  if (!c.internal) add('error', 'Contexte interne', 'aucun contexte interne dans le tenant.', ['people', 'routing']);
  if (!c.incall) add('error', 'Contexte entrant', 'aucun contexte entrant : les SDA ne pourront pas être créées.', ['routing']);
  // Site Wazo, contextes et appels simulés (bloquant pour tout : les numéros en dépendent).
  // Trunks jamais modifiés par l'outil (décision de Brice, 04/11/2026). Contexte entrant d'un jeu
  // créé : à régler à la main dans le Portal ; le Routage (SDA) attend que ce soit fait. Si le trunk
  // reçoit déjà d'autres SDA dans son contexte actuel, le changer les couperait : signalé.
  for (const u of c.units.filter((x) => x.inc && x.trunkId)) {
    const tr = t.trunks.find((x) => String(x.id) === String(u.trunkId)); const cur = tr?.context;
    const target = u.incObj?.virtual ? u.L.inc : (u.incObj?.label || u.inc);
    const mine = new Set(unitDids(W.d, c.many ? u.key : null));
    const foreign = cur ? t.incalls.flatMap((x) => x.extensions || []).filter((e) => e.context === cur && !mine.has(e.exten)).map((e) => e.exten) : [];
    const curLabel = t.contexts.find((x) => x.name === cur)?.label || cur || 'aucun';
    if (foreign.length) add('warn', `Trunk ${trunkLabel(t, u.trunkId)}`, `il reçoit déjà ${foreign.length} SDA dans « ${curLabel} » qui ne sont pas à ${c.many ? `« ${u.label} »` : 'ce client'} (${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? '…' : ''}) : changer son contexte entrant les couperait. Prévoir un trunk propre à ${c.many ? 'ce département' : 'ce client'}.`, [], 'site');
    if (cur !== u.inc) add('manual', `Trunk ${trunkLabel(t, u.trunkId)}`, `non modifié par l'outil. ${u.incObj?.virtual ? 'Après la phase Fondations, dans' : 'Dans'} le Portal (Interconnexions > ${trunkLabel(t, u.trunkId)}), régler le contexte entrant sur « ${target} » (actuel : « ${curLabel} »), puis « Relire le tenant ». Le Routage (SDA) attend ce réglage.`, ['routing'], 'site');
  }
  // Plages des contextes à créer (saisies dans l'onglet Départements, ou calculées).
  if (c.units.some((u) => u.newCtx)) for (const x of rangeIssues(W.d)) add(x.sev, x.title, x.text, x.sev === 'error' ? ['found', 'people', 'routing'] : [], 'site');
  for (const x of siteChecks(t, W.d, (id) => trunkLabel(t, id)).issues) add(x.sev === 'info' ? 'remind' : x.sev, x.title, x.text, x.sev === 'error' ? ['found', 'people', 'routing'] : [], 'site');  const tIss = c.internal ? tenantIssues(W.d, { ctx: c.internal.name, incallCtx: c.incall?.name, numOf: (u) => wazoNum(W.d, u) }, { contexts: c.internal.virtual ? [...t.contexts, c.internal] : t.contexts, extensions: t.extensions, users: t.users, voicemails: t.voicemails }) : [];
  // Numéros hors des plages : corrigés par la phase Fondations (ajout des plages), pas une erreur à régler à la main.
  for (const x of tIss.filter((y) => y.sev === 'error' && !/hors des plages/.test(y.text))) add('error', x.area, x.text, ['people']);
  for (const { ctx, unit } of rangeTargets(c)) {
    const fixes = rangeFixes(ctx, unit);
    if (fixes.length) add('fix', `Plages du contexte ${ctx.label || ctx.name}`, `${fixes.map((f) => `${f.missing.length} ${f.label} hors des plages`).join(', ')} : la phase Fondations ajoute ${fixes.map((f) => `${f.label} ${f.add.map(rangeTxt).join(', ')}`).join(' ; ')}. Personnes et Routage attendent cette correction.`, ['people', 'routing']);
  }
  for (const x of grouped([...draftIssues(W.d), ...numberIssues(W.d)].filter((y) => y.sev === 'error'), kindOf)) add('error', x.area, x.text, [/^\d+ (utilisateurs|appareils)|^(Utilisateur|Appareil)/.test(x.area) ? 'people' : 'routing']);
  if (!t.sipTpl?.global) add('error', 'Modèle SIP global', 'modèle SIP « global » du tenant introuvable : aucune ligne ne peut être créée (l\'import de Wazo échoue de même).', ['people']);
  const webrtc = imported(W.d).filter((u) => linesOf(u).includes('webrtc'));
  if (webrtc.length && !t.sipTpl?.webrtc) add('error', 'Modèle SIP WebRTC', `modèle SIP « webrtc » du tenant introuvable : ${webrtc.length} ligne(s) WebRTC impossibles.`, ['people']);
  // Objets pas encore vérifiés, par onglet (case « Vérifié » de chaque ligne) : rappel, pas bloquant.
  const left = unverified(W.d);
  if (left.length) add('warn', 'Vérification du brouillon', `pas encore vérifiés : ${left.map((x) => `${x.n}/${x.total} ${x.label}`).join(', ')} (case « Vérifié » de chaque onglet).`, [...new Set(left.map((x) => (['users', 'vms', 'devices'].includes(x.tab) ? 'people' : 'routing')))]);
  if (!t.trunks.length) add('manual', 'Trunk opérateur', 'aucun trunk dans le tenant. À créer dans le Portal avec le modèle de l\'opérateur (valeurs ci-dessous), puis « Relire le tenant ». Sans trunk : pas d\'appels sortants ni d\'appels entrants.', ['found']);
  add('remind', 'Applications de l\'organisation', 'réglage du Portal (Paramètres > Applications), hors de la stack : à vérifier selon le besoin du client.');
  add('remind', 'IP publique', 'postes fixes : autoriser l\'IP publique du client dans les paramètres globaux de la stack (tenant principal).');
  // Sons : fichiers non déposés = non envoyés (pas bloquant : ils pourront l'être plus tard).
  const sp = soundPlan(W.d);
  if (sp.missing.length) add('warn', 'Fichiers son', `${sp.missing.length} fichier(s) prévus mais non déposés (onglet Sons) : ${sp.missing.slice(0, 5).join(', ')}${sp.missing.length > 5 ? '…' : ''}. Ils ne seront pas envoyés.`);
  if (sp.files.length && !CATEGORY_RE.test(sp.cat)) add('error', 'Catégorie de sons', `« ${sp.cat} » refusée par Wazo (lettres, chiffres, - _ . sans espace) : à corriger dans l'onglet Sons.`, ['found']);
  return out;
}
const blockedPhases = (pre) => new Set(pre.filter((p) => ['error', 'manual', 'fix'].includes(p.sev)).flatMap((p) => p.phases));

// ---------------------------------------------------------------------------
// 2. Plan de migration (ordre de dépendances, calculé par l'outil)
// item = { label, status: create|update|exists|conflict|skip, detail }
// ---------------------------------------------------------------------------
const PHASES = [
  { id: 'found', title: 'Fondations', help: 'Réglages du tenant et ce dont dépendent les appels : pays, conservation des données, numéros publics, appels sortants.', lot: null },
  { id: 'people', title: 'Personnes', help: 'Messageries communes, utilisateurs (licence, ligne, numéro, messagerie, compte des applications) et appareils associés. Création objet par objet comme l\'import de Wazo (décision de Brice).', lot: '5b' },
  { id: 'routing', title: 'Routage', help: 'Horaires, groupes et files, SVI, SDA : dans cet ordre, chaque objet après ses cibles.', lot: '5c' },
  { id: 'finish', title: 'Finitions', help: 'Renvois et débordements (deuxième passe, quand toutes les cibles existent), touches de fonction. L\'annuaire de la société est écrit par les Fondations.', lot: '5c / 5d' },
];
function buildPlan(t) {
  const d = W.d; const c = contextsOf(t);
  const P = { found: [], people: [], routing: [], finish: [] };
  const add = (k, status, label, detail = '') => P[k].push({ status, label, detail });
  // Fondations : d'abord les contextes du client (site partagé, départements).
  for (const u of c.units) {
    if (u.newCtx) {
      add('found', 'create', `Contexte interne « ${u.L.ctx} »`, `plages ${rangesTxt(newRanges(d, c.many ? u.key : null))}`);
      add('found', 'create', `Contexte sortant « ${u.L.out} »`, `inclus par « ${u.L.ctx} » en premier`);
      const dids = unitDids(d, c.many ? u.key : null);
      add('found', 'create', `Contexte entrant « ${u.L.inc} »`, `${dids.length} SDA déclarées dans ses plages (${dids.slice(0, 3).join(', ')}${dids.length > 3 ? '…' : ''})`);
      if (u.trunkId) add('found', 'skip', `Trunk ${trunkLabel(t, u.trunkId)}`, `non modifié par l'outil : son contexte entrant sera à régler dans le Portal sur « ${u.L.inc} », après la phase Fondations`);
      if (c.many && d.write.site.interUnits) add('found', 'create', `Inclusions de « ${u.L.ctx} »`, `les ${c.units.length - 1} autre(s) département(s), pour les appels internes entre eux`);
      for (const peer of u.peers) { const x = t.contexts.find((y) => y.name === peer); add('found', 'update', `Inclusions de « ${x?.label || peer} »`, `« ${u.L.ctx} » ajouté en fin de liste (appels vers lui), et inclus par lui (appels depuis lui)`); }
    } else if (u.newOut && u.ctxObj) add('found', 'create', `Contexte sortant « ${u.L.out} »`, `inclus en tête par « ${u.ctxObj.label || u.ctxObj.name} »`);
  }
  // Fondations : d'abord les plages du contexte interne (les numéros en dépendent).
  for (const { ctx, unit } of rangeTargets(c)) for (const f of rangeFixes(ctx, unit)) add('found', 'update', `Plages ${f.label} du contexte ${ctx.label || ctx.name}`, `ajouter ${f.add.map(rangeTxt).join(', ')} (actuelles : ${f.current.map(rangeTxt).join(', ') || 'aucune'} ; ${f.missing.length} numéro(s) hors plages)`);
  if (t.localization?.error) add('found', 'conflict', 'Pays', `lecture impossible : ${t.localization.error}`);
  else add('found', t.localization?.country === 'FR' ? 'exists' : 'update', 'Pays France', t.localization?.country === 'FR' ? 'déjà réglé' : `${t.localization?.country || 'aucun'} → FR`);
  if (t.retention?.error) add('found', 'conflict', 'Conservation des données', `lecture impossible (call-logd) : ${t.retention.error}`);
  else {
    const same = t.retention.cdr_days === Number(d.write.cdrDays) && t.retention.recording_days === Number(d.write.recordingDays);
    add('found', same ? 'exists' : 'update', `Conservation : journal ${d.write.cdrDays} j, enregistrements ${d.write.recordingDays} j`, same ? 'déjà réglé' : `actuel : ${t.retention.cdr_days ?? `défaut ${t.retention.default_cdr_days ?? '?'}`} / ${t.retention.recording_days ?? `défaut ${t.retention.default_recording_days ?? '?'}`} j`);
  }
  const nums = [...new Set(d.dids.map((r) => e164(r.did)).filter((n) => /^\+\d{6,}$/.test(n)))];
  if (t.phonesError) add('found', 'conflict', 'Numéros de téléphone', `API indisponible : ${t.phonesError}`);
  else {
    const have = new Set(t.phones.map((p) => p.number));
    const todo = nums.filter((n) => !have.has(n));
    add('found', todo.length ? 'create' : 'exists', `${nums.length} numéros publics (+33)`, todo.length ? `${todo.length} à créer, ${nums.length - todo.length} déjà présents` : 'tous déjà présents');
    const main = e164(W.m?.trunks?.[0]?.mainNumber);
    if (main) add('found', t.phones.find((p) => p.number === main)?.main ? 'exists' : 'update', `Numéro principal ${main}`);
  }
  const pats = clientPatterns(d.write.out); const { skipped } = futureOf(t, d);
  for (const u of c.units) {
    const ocName = ocNameOf(u, c.many); const sk = skipped.filter((x) => x.unit === u.key).length;
    const patTxt = `${pats.length - sk} motif(s) de l'assistant France (format ${FR_FORMATS[d.write.out.fmt]})${sk ? `, ${sk} déjà pris par une autre règle` : ''}${d.write.out.block118 ? ', 118 bloqués' : ''}`;
    if (t.outcalls.some((o) => o.name === ocName)) add('found', 'exists', `Règle « ${ocName} »`);
    else if (!u.trunkId) add('found', 'conflict', `Règle « ${ocName} »`, 'aucun trunk choisi : à créer d\'abord dans le Portal');
    else add('found', 'create', `Règle « ${ocName} » vers ${trunkLabel(t, u.trunkId)}`, `${patTxt}, dans ${u.outObj?.label || u.outObj?.name || '?'}`);
  }
  // Sons et musiques d'attente (avant les files et SVI qui s'en servent).
  const sp = soundPlan(d);
  for (const m of sp.mohs.filter((x) => x.files.length)) {
    const ok = m.files.filter((f) => loaded(f)).length; const ex = t.moh.find((x) => x.label === m.label);
    add('found', ok ? (ex ? 'update' : 'create') : 'conflict', `Musique d'attente « ${m.label} »`, `${ok} fichier(s) sur ${m.files.length} déposés${ex ? ' · existe déjà : fichiers ajoutés' : ''}${sp.def === m ? ' · par défaut du site' : ''}`);
  }
  if (sp.files.length) { const ok = sp.files.filter((f) => loaded(f)).length; const ex = t.sounds.some((x) => x.name === sp.cat); add('found', ok ? 'create' : 'conflict', `Sons « ${sp.cat} »`, `${ok} fichier(s) sur ${sp.files.length} déposés${ex ? ' · catégorie déjà présente' : ''}`); }
  const pbn = d.phonebook ? companyContacts(d).length : 0;
  if (pbn && (t.phonebooks || []).some((x) => x.name === phonebookName(d))) add('found', 'exists', `Annuaire « ${phonebookName(d)} »`, 'carnet du même nom déjà présent : rien recréé');
  else if (pbn) add('found', 'create', `Annuaire « ${phonebookName(d)} »`, `${pbn} contact(s)${d.phonebook.includePersonal ? ', contacts personnels compris' : ''} ; carnet, source d'annuaire et profil du site (wazo-dird)`);
  const pers = (d.phonebook?.personal || []).filter((x) => x.import).length;
  if (pers && !d.phonebook.includePersonal) add('finish', 'skip', `${pers} contact(s) personnels des postes`, 'non écrits par l\'outil (wazo-dird n\'accepte que le jeton de l\'utilisateur) : CSV par poste dans l\'onglet Annuaire, à importer par chaque utilisateur');
  if (sp.def) add('found', 'update', `Musique d'attente par défaut : « ${sp.def.label} »`, 'option moh_suggest du modèle SIP global (comme le Wizard de déploiement de Wazo), les autres options du modèle inchangées');
  // Personnes
  const unitCtx = new Set(c.units.map((u) => u.ctx));
  const vmIn = new Set(t.voicemails.filter((v) => unitCtx.has(v.context)).map((v) => String(v.number)));
  for (const u of d.users.filter((x) => x.mode === 'voicemail')) add('people', vmIn.has(u.n) ? 'exists' : 'create', `Messagerie commune ${u.n} ${userName(u)}`, vmIn.has(u.n) ? 'déjà présente' : '');
  const extIn = new Set(t.extensions.filter((e) => unitCtx.has(e.context)).map((e) => e.exten));
  for (const u of imported(d)) {
    const lic = u.sub == null ? 'licence à choisir' : LICENCES[u.sub];
    const wn = wazoNum(d, u);
    add('people', extIn.has(wn) ? 'conflict' : u.sub == null ? 'conflict' : 'create', `Utilisateur ${wn}${wn !== u.n ? ` (${u.n} dans 3CX)` : ''} ${userName(u)}`, extIn.has(wn) ? 'numéro déjà pris dans le contexte' : `${lic}, ligne${linesOf(u).length > 1 ? 's' : ''} ${linesText(u)}${u.vm ? ', messagerie' : ''}${u.checked ? '' : ' · non vérifié'}`);
  }
  const macs = new Set(t.devices.map((x) => String(x.mac || '').toLowerCase()));
  for (const dv of (d.devices || []).filter((x) => x.import)) add('people', macs.has(dv.mac.toLowerCase()) ? 'exists' : 'create', `Appareil ${dv.model} ${dv.mac}`, `${macs.has(dv.mac.toLowerCase()) ? 'déjà présent : sera associé' : 'à créer'}${dv.owner ? ` → ligne de ${dv.owner}` : ' (stock)'}`);
  // Routage
  const schedNames = new Set(t.schedules.map((s) => s.name));
  for (const s of d.schedules.filter((x) => d.dids.some((r) => r.import && r.schedule === x.key))) add('routing', schedNames.has(s.name) ? 'exists' : 'create', `Horaire « ${s.name} »`, s.text);
  for (const h of d.hunts.filter((x) => x.target !== 'skip')) {
    const kind = h.target === 'group' ? 'Groupe' : 'File';
    const taken = extIn.has(wazoNum(d, h));
    const members = h.members.filter((n) => userBy(d, n)?.mode === 'user').length;
    add('routing', taken ? 'conflict' : 'create', `${kind} ${h.n} ${h.name}`, taken ? 'numéro déjà pris' : `${members} membre(s)${h.src === 'Queue' && h.target === 'group' ? ' · file 3CX convertie en groupe' : ''}`);
  }
  for (const v of d.ivrs.filter((x) => x.import)) add('routing', 'create', `SVI ${v.n} ${v.name}`, `${v.choices.length} touche(s) · message ${v.prompt || 'aucun'}`);
  const incIn = new Set(t.extensions.map((e) => `${e.exten}@${e.context}`));
  // SDA déclarées en E.164 français sans « + » dans le contexte entrant (33251712525).
  for (const r of d.dids.filter((x) => x.import)) {
    const n = didWazo(r.did); const ic = c.incallOf(r); const has = ic && (incIn.has(`${n}@${ic.name}`) || incIn.has(`${r.did}@${ic.name}`));
    add('routing', !ic ? 'conflict' : has ? 'exists' : r.dest.t === 'none' && r.dest.todo ? 'conflict' : 'create', `SDA ${n}`, `${ic ? `dans « ${ic.label || ic.name} »` : 'aucun contexte entrant'} · ${has ? 'déjà présente · ' : ''}${n !== r.did ? `${r.did} dans 3CX · ` : ''}${destLabel(d, r.dest)}${r.schedule ? ' · avec horaire' : ''}`);
  }
  // Finitions
  const fbUsers = imported(d).filter((u) => Object.values(u.fb).some((x) => x && x.t !== 'none')).length;
  add('finish', fbUsers ? 'create' : 'skip', `Débordements de ${fbUsers} utilisateur(s)`);
  const prof = imported(d).filter((u) => W.m.extensions.find((e) => e.number === u.n)?.currentProfile !== 'Available');
  if (prof.length) add('finish', d.write.keepProfiles ? 'create' : 'skip', `Profil 3CX actuel de ${prof.length} poste(s) repris en renvoi`, prof.map((u) => u.n).join(', '));
  const blf = blfRows(d, W.m).filter((b) => b.ok);
  add('finish', blf.length ? 'create' : 'skip', `${blf.length} touche(s) de fonction`);
  return P;
}

// ---------------------------------------------------------------------------
// 3. Pertes et écarts (avant toute écriture)
// ---------------------------------------------------------------------------
const PROFILE_FR = { Away: 'Absent', 'Out of office': 'Hors du bureau', 'Custom 1': 'Personnalisé 1', 'Custom 2': 'Personnalisé 2' };
// Dans un profil de renvoi, « None » = pas de renvoi : le poste sonne (supposé,
// même lecture que la route « Disponible » où None marque l'absence de renvoi).
const sideTxt = (s) => (!s?.all || s.all.to === 'None' ? 'pas de renvoi, le poste sonne (supposé)' : destLabel(W.d, convert(s.all)));
// Destination 3CX → destination du brouillon (pour ses libellés). Un numéro du
// client est résolu vers sa destination, comme à la construction du brouillon.
function convert(x, depth = 0) {
  if (!x) return { t: 'none' };
  if (x.to === 'External' && depth < 3) { const r = W.m.inbound.find((y) => y.did && y.did === x.external); if (r) return convert(r.open, depth + 1); }
  if (x.to === 'Extension') return x.dn ? { t: 'user', ref: x.dn } : { t: 'none' };
  if (x.to === 'VoiceMail') return x.dn ? { t: 'vm', ref: x.dn } : { t: 'none' };
  if (x.to === 'Queue' || x.to === 'RingGroup') return { t: 'hunt', ref: x.dn };
  if (x.to === 'IVR') return x.dn ? { t: 'ivr', ref: x.dn } : { t: 'sound', ref: 'holiday' };
  if (x.to === 'External') return { t: 'ext', num: x.external };
  if (x.to === 'None' || x.to === 'EndCall') return { t: 'hangup' };
  return { t: 'none' };
}
function losses() {
  const d = W.d; const m = W.m; const out = [];
  const add = (sev, what, effect, fix) => out.push({ sev, what, effect, fix });
  // Profils de renvoi en cours autres que Disponible.
  for (const u of imported(d)) {
    const e = m.extensions.find((x) => x.number === u.n);
    if (!e || e.currentProfile === 'Available') continue;
    const p = e.profiles?.[e.currentProfile];
    const pname = PROFILE_FR[e.currentProfile] || e.currentProfile;
    add('warn', `Poste ${u.n} ${userName(u)} : profil 3CX actuel « ${pname} »`,
      p ? `Dans 3CX : appels externes → ${sideTxt(p.external)}, internes → ${sideTxt(p.internal)}${p.noRingGroups ? ' ; retiré des groupes' : ''}${p.queueLogout ? ' ; déconnecté des files' : ''}. Wazo n'a qu'un renvoi immédiat, sans distinguer appels internes et externes.` : 'profil illisible dans la sauvegarde.',
      d.write.keepProfiles ? `Repris en renvoi immédiat vers ${p?.external?.all && p.external.all.to !== 'None' ? destLabel(d, convert(p.external.all)) : 'la destination des appels externes'} (option ci-dessous, phase Finitions) : internes et externes seront renvoyés ; à désactiver quand la personne revient.` : 'Non repris : le poste sonnera normalement.');
  }
  // Départements 3CX : fusions avec des horaires différents, numéro principal unique dans Wazo.
  for (const x of (d.depts || []).filter((y) => y.mode === 'merge')) {
    const to = deptBy(d, x.into); const o = deptObjects(d, x.key);
    // Département sans objet repris (ex. __DEFAULT__ qui ne garde que l'administrateur) : rien à perdre.
    if (!o.users.some((u) => u.mode !== 'skip') && !o.hunts.some((h) => h.target !== 'skip') && !o.ivrs.some((v) => v.import) && !o.dids.some((r) => r.import)) continue;
    if (to && x.hours && x.hours !== to.hours) add('warn', `Département ${deptLabel(x.key)} fusionné dans ${deptLabel(to.key)}`, `horaires différents dans 3CX (${x.hours} contre ${to.hours || 'non précisés'}) ; ses SDA gardent l'horaire de leur règle 3CX.`, 'Garder un jeu de contextes propre, ou vérifier les horaires des SDA concernées.');
    if (to && x.holidays) add('info', `Jours fériés du département ${deptLabel(x.key)}`, `${x.holidays} jour(s) férié(s) propres à ce département dans 3CX.`, 'À reprendre dans les horaires Wazo du jeu de contextes (lot Routage).');
  }
  const units = unitList(d);
  if (units.length > 1) {
    const mains = m.trunks.filter((x) => x.mainNumber).map((x) => `${x.mainNumber} (${x.name})`);
    if (mains.length > 1) add('info', 'Numéro principal', `Wazo n'a qu'un numéro principal par site Wazo ; 3CX en avait un par trunk : ${mains.join(', ')}. Le premier est retenu.`, 'Numéro présenté de chaque département : réglé par ses utilisateurs et sa règle sortante, à vérifier après la phase Personnes.');
  }
  const others = m.extensions.reduce((s, e) => s + Object.keys(e.profiles || {}).length, 0);
  if (others) add('info', `${others} profil(s) 3CX Absent / Hors du bureau / Personnalisés configurés`, 'Wazo n\'a pas de profils commutables : seuls le profil « Disponible » (débordements) et le profil courant (option) sont repris.', 'Les personnes régleront leur renvoi dans l\'application Wazo ou avec les codes de service.');
  // Files converties en groupes.
  for (const h of d.hunts.filter((x) => x.src === 'Queue' && x.target === 'group')) add('warn', `File 3CX ${h.n} ${h.name} → groupe Wazo`, 'Plus d\'attente en musique, d\'annonce de position ni de message d\'intro : l\'appelant entend la sonnerie, puis le débordement.', 'Garder en file d\'attente si l\'attente compte.');
  for (const q of m.queues) {
    const h = huntBy(d, q.number); if (!h || h.target !== 'queue') continue;
    const opts = [q.intro && `message d'intro ${q.intro}`, q.announce && `annonce toutes les ${q.announce} s`, q.onHold && `musique ${q.onHold}`].filter(Boolean);
    if (opts.length) add('info', `File ${q.number} ${q.name} : options 3CX`, `${opts.join(', ')}. Reprise à vérifier au lot de création des files (options Wazo à lire dans confd avant de promettre).`, 'Sons à fournir (phase musiques).');
  }
  // Destinations non résolues ou vers des objets non repris (contrôles du brouillon).
  const routeIss = draftIssues(d).filter((y) => y.sev === 'warn' && /^(SDA|Groupe|File|SVI|Utilisateur \S+ renvoi)/.test(y.area)).map((y) => ({ ...y, area: y.area.replace(/ (ouvert|fermé|férié)$/, '') }));
  for (const x of grouped(routeIss, kindOf)) add('warn', x.area, x.text, 'À corriger dans l\'onglet concerné avant d\'écrire, sinon l\'appel sera rejeté à cet endroit.');
  const skipped = d.dids.filter((r) => !r.import).length;
  if (skipped) add('info', `${skipped} SDA non reprises`, 'Appels vers ces numéros rejetés (comme dans 3CX : règle par défaut sans destination).', 'Cocher la reprise dans l\'onglet SDA si besoin.');
  const blfAll = blfRows(d, m); const parkKeys = blfAll.filter((b) => b.type === 'parking' && b.status === 'non (parking non repris)');
  const blf = blfAll.filter((b) => !b.ok && !parkKeys.includes(b));
  if (blf.length) add('info', `${blf.length} touche(s) BLF non reprises`, 'Cibles absentes (anciens postes), postes non repris ou doublons.', 'Liste exacte dans l\'onglet Exports (CSV des touches).');
  if (m.parks.length) add('info', `Parking 3CX non repris${parkKeys.length ? ` (${parkKeys.length} touche(s) de place sur ${new Set(parkKeys.map((b) => b.owner)).size} poste(s))` : ''}`, 'Plusieurs appels en attente : touches ligne du poste Wazo (un appel par touche) ou appli Wazo. Un appel en attente ne se reprend que depuis le poste qui l\'a mis en attente ; pour le passer à un collègue, le transférer.', 'Si un collègue doit reprendre l\'appel depuis son poste, créer un parking Wazo à la main (touches « place de parking »).');
  if (d.schedules.some((s) => d.dids.some((r) => r.import && r.schedule === s.key) && [s.holiday, s.closed].some((x) => x?.t === 'sound'))) add('info', 'Message de fermeture des jours fériés', 'Le son du jour férié doit exister dans Wazo, sinon la fermeture n\'a rien à jouer.', 'Fournir les sons (phase musiques), ou viser la messagerie.');
  if (m.ivrs.some((v) => v.system)) add('info', 'SVI internes de 3CX (code PIN, rappel de file)', 'Sans équivalent : non repris.', '—');
  if (m.others.length) add('info', m.others.map((o) => `${o.kind.replace('Extension', '')} ${o.number}`).join(', '), 'Fax, conférence et menu spécial 3CX : non repris.', 'À créer à la main si utilisés.');
  add('info', 'Messages vocaux, enregistrements et journaux d\'appels 3CX', 'Non migrables par l\'API de Wazo.', 'Les exporter depuis 3CX si le client veut les garder.');
  add('info', 'Postes à reprovisionner', 'Les lignes Wazo sont nouvelles : chaque poste doit récupérer sa configuration Wazo.', 'Appareils créés par MAC et associés aux lignes (phase Personnes) ; redémarrer les postes.');
  const lic = {}; for (const u of imported(d)) if (u.sub != null) lic[u.sub] = (lic[u.sub] || 0) + 1;
  if (Object.keys(lic).length) add('info', `Licences : ${Object.entries(lic).map(([k, n]) => `${LICENCES[k]} ${n}`).join(', ')}`, 'Les quotas de licences sont décomptés par le portail, la stack ne bloque pas un dépassement.', 'Vérifier les souscriptions restantes avant d\'écrire la phase Personnes.');
  return out;
}

// ---------------------------------------------------------------------------
// 4. Écritures de la phase Fondations (lues dans le code, cf. cadrage 5a)
// op = { label, run: async () => ({ created?, undo? }) }
// ---------------------------------------------------------------------------
async function foundationOps(t) {
  const d = W.d; const c = contextsOf(t); const ops = [];
  const s = d.write.site;
  const incl = (ids) => ({ contexts: ids.map((id) => ({ id })) });
  const includesOf = async (id) => ((await tapi('GET', `/contexts/${id}`)).contexts || []).map((x) => x.id);
  // Sortant de chaque unité, connu après sa création (op suivante).
  const outName = Object.fromEntries(c.units.map((u) => [u.key, u.outObj?.virtual ? null : u.outObj?.name]));
  // Lu dans confd (19/10/2026, bascule multisite) : POST /contexts {label, type, plages}, nom technique
  // généré ; PUT /contexts/{id}/contexts remplace la liste des inclusions, dans l'ordre.
  const fresh = c.units.filter((u) => u.newCtx);
  if (fresh.length) {
    ops.push({ label: `Contextes ${fresh.map((u) => `« ${u.L.ctx} », « ${u.L.inc} » et « ${u.L.out} »`).join(', ')}, inclusions${c.many && s.interUnits ? ' entre départements' : ''}${fresh[0].peers.length ? ` et avec ${fresh[0].peers.length} établissement(s)` : ''} (POST /contexts, PUT /contexts/…/contexts ; trunks non modifiés)`, run: async () => {
      const undo = []; const made = {};
      try {
        // 1. Tous les contextes d'abord (les unités s'incluent entre elles). Entrant : ses SDA dans
        //    incall_ranges, une plage par SDA, comme le Portal (IncallRangeSchema, context/schema.py, lu).
        for (const u of fresh) {
          const oc = await tapi('POST', '/contexts', { label: u.L.out, type: 'outcall' });
          undo.unshift({ method: 'DELETE', path: `/contexts/${oc.id}` });
          const ic = await tapi('POST', '/contexts', { label: u.L.ctx, type: 'internal', ...newRanges(d, c.many ? u.key : null) });
          undo.unshift({ method: 'DELETE', path: `/contexts/${ic.id}` });
          const inc = await tapi('POST', '/contexts', { label: u.L.inc, type: 'incall', incall_ranges: unitDids(d, c.many ? u.key : null).map((n) => ({ start: n, end: n })) });
          undo.unshift({ method: 'DELETE', path: `/contexts/${inc.id}` });
          made[u.key] = { oc, ic, inc };
        }
        // 2. Inclusions de chaque unité : son sortant, les autres unités, les établissements existants.
        const peers = fresh[0].peers.map((n) => t.contexts.find((x) => x.name === n)).filter(Boolean);
        // Jeux déjà créés lors d'un passage précédent (département ajouté ensuite) : inclus par les
        // nouveaux, et ils incluent les nouveaux en fin de liste (relus juste avant).
        const older = c.many && s.interUnits ? c.units.filter((x) => !x.newCtx && x.ctxObj?.id) : [];
        for (const u of fresh) {
          const others = c.many && s.interUnits ? [...fresh.filter((x) => x !== u).map((x) => made[x.key].ic.id), ...older.map((x) => x.ctxObj.id)] : [];
          await tapi('PUT', `/contexts/${made[u.key].ic.id}/contexts`, incl([made[u.key].oc.id, ...others, ...peers.map((x) => x.id)]));
        }
        for (const x of older) {
          const cur = await includesOf(x.ctxObj.id); const add = fresh.map((u) => made[u.key].ic.id);
          await tapi('PUT', `/contexts/${x.ctxObj.id}/contexts`, incl([...cur.filter((id) => !add.includes(id)), ...add]));
          undo.unshift({ method: 'PUT', path: `/contexts/${x.ctxObj.id}/contexts`, body: incl(cur) });
        }
        // 3. Chez les établissements existants : relu juste avant, les unités ajoutées en fin de liste.
        for (const x of peers) {
          const cur = await includesOf(x.id); const add = fresh.map((u) => made[u.key].ic.id);
          await tapi('PUT', `/contexts/${x.id}/contexts`, incl([...cur.filter((id) => !add.includes(id)), ...add]));
          undo.unshift({ method: 'PUT', path: `/contexts/${x.id}/contexts`, body: incl(cur) });
        }
        // Trunks : jamais modifiés par l'outil (décision de Brice, 04/11/2026 : en cas de souci, il
        // repart de zéro sur le trunk, mots de passe compris). Leur contexte entrant se règle dans le
        // Portal ; Préparer le demande tant que ce n'est pas fait.
      } catch (e) { for (const u of undo) { try { await runUndo(u); } catch { /* signalé par l'erreur d'origine */ } } throw e; }
      for (const u of fresh) {
        const cr = { ctxId: made[u.key].ic.id, ctxName: made[u.key].ic.name, outId: made[u.key].oc.id, outName: made[u.key].oc.name, incId: made[u.key].inc.id, incName: made[u.key].inc.name, peers: u.peers };
        // Trunk proposé gardé : il ne change plus si les trunks du tenant changent ensuite.
        if (c.many) { const cfg = unitCfg(d, u.key); cfg.created = cr; if (!cfg.trunkId) cfg.trunkId = u.trunkId; } else { s.created = { ...cr, prevCtx: d.ctx || '' }; d.ctx = cr.ctxName; }
        outName[u.key] = cr.outName;
      }
      return { created: fresh.map((u) => `${made[u.key].ic.name}, ${made[u.key].inc.name}, ${made[u.key].oc.name}`).join(' ; '), undo: { seq: [...undo, { local: 'site', units: c.many ? fresh.map((u) => u.key) : null }] } };
    } });
  }
  for (const u of c.units.filter((x) => !x.newCtx && x.newOut && x.ctxObj)) {
    const id = u.ctxObj.id;
    ops.push({ label: `Contexte sortant « ${u.L.out} », inclus en tête par « ${u.ctxObj.label || u.ctxObj.name} »`, run: async () => {
      const oc = await tapi('POST', '/contexts', { label: u.L.out, type: 'outcall' });
      const cur = await includesOf(id);
      try { await tapi('PUT', `/contexts/${id}/contexts`, incl([oc.id, ...cur])); } catch (e) { await tapi('DELETE', `/contexts/${oc.id}`).catch(() => {}); throw e; }
      outName[u.key] = oc.name;
      return { created: oc.name, undo: { seq: [{ method: 'PUT', path: `/contexts/${id}/contexts`, body: incl(cur) }, { method: 'DELETE', path: `/contexts/${oc.id}` }] } };
    } });
  }
  for (const { ctx, unit } of rangeTargets(c)) {
    const fx = rangeFixes(ctx, unit); if (!fx.length) continue;
    const id = ctx.id;
    ops.push({ label: `Plages du contexte ${ctx.label || ctx.name} : ${fx.map((f) => `${f.label} + ${f.add.map(rangeTxt).join(', ')}`).join(' ; ')} (PUT /contexts/${id})`, run: async () => {
      // Relu juste avant : on renvoie les plages actuelles + les nouvelles, par type (PUT partiel, liste remplacée).
      const cur = await tapi('GET', `/contexts/${id}`);
      const body = {}; const prev = {};
      for (const f of rangeFixes(cur, unit)) { prev[f.key] = cur[f.key] || []; body[f.key] = [...(cur[f.key] || []).map((r) => ({ start: r.start, end: r.end ?? r.start })), ...f.add]; }
      if (!Object.keys(body).length) return { created: 'plages déjà suffisantes' };
      await tapi('PUT', `/contexts/${id}`, body);
      return { created: Object.entries(body).map(([k, v]) => `${k} : ${v.map(rangeTxt).join(', ')}`).join(' ; '), undo: { method: 'PUT', path: `/contexts/${id}`, body: Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, v.map((r) => ({ start: r.start, end: r.end ?? r.start }))])) } };
    } });
  }
  if (!t.localization?.error && t.localization?.country !== 'FR') {
    const prev = t.localization?.country ?? null;
    ops.push({ label: 'Pays : FR (PUT /localization)', run: async () => { await tapi('PUT', '/localization', { country: 'FR' }); return { undo: { method: 'PUT', path: '/localization', body: { country: prev } } }; } });
  }
  if (!t.retention?.error) {
    const cur = t.retention;
    const want = { cdr_days: Number(d.write.cdrDays), recording_days: Number(d.write.recordingDays), export_days: cur.export_days ?? null };
    if (cur.cdr_days !== want.cdr_days || cur.recording_days !== want.recording_days) {
      // PUT non partiel (call-logd retention, lu) : les trois durées sont renvoyées.
      ops.push({ label: `Conservation : ${want.cdr_days} / ${want.recording_days} j (PUT /retention)`, run: async () => { await logd('PUT', '/retention', want); return { undo: { api: 'logd', method: 'PUT', path: '/retention', body: { cdr_days: cur.cdr_days ?? null, recording_days: cur.recording_days ?? null, export_days: cur.export_days ?? null } } }; } });
    }
  }
  if (!t.phonesError) {
    const have = new Set(t.phones.map((p) => p.number));
    for (const n of [...new Set(d.dids.map((r) => e164(r.did)).filter((x) => /^\+\d{6,}$/.test(x)))].filter((x) => !have.has(x))) {
      ops.push({ label: `Numéro ${n} (POST /phone-numbers)`, run: async () => { const p = await tapi('POST', '/phone-numbers', { number: n }); return { created: p.uuid, undo: { method: 'DELETE', path: `/phone-numbers/${p.uuid}` } }; } });
    }
    const main = e164(W.m?.trunks?.[0]?.mainNumber);
    if (main && !t.phones.find((p) => p.number === main)?.main) {
      const before = t.phones.find((p) => p.main)?.uuid || null;
      ops.push({ label: `Numéro principal ${main} (PUT /phone-numbers/main)`, run: async () => {
        const p = (await listAll('/phone-numbers')).find((x) => x.number === main);
        if (!p) throw new Error(`numéro principal ${main} introuvable`);
        await tapi('PUT', '/phone-numbers/main', { phone_number_uuid: p.uuid });
        return { undo: before ? { method: 'PUT', path: '/phone-numbers/main', body: { phone_number_uuid: before } } : null };
      } });
    }
  }
  // Une règle par unité ; l'autorisation « interdit-118 » est partagée (créée une seule fois).
  const perm118 = { p: t.perms.find((x) => x.mode === 'deny' && x.enabled !== false && (x.extensions || []).includes(BLOCK_118)) || null };
  const { skipped } = futureOf(t, d);
  for (const u of c.units.filter((x) => x.trunkId && x.outObj)) {
    const ocName = ocNameOf(u, c.many); const trunkId = u.trunkId;
    if (t.outcalls.some((o) => o.name === ocName)) continue;
    // Motifs de l'assistant France de Call Flow, sauf ceux déjà pris dans ce contexte sortant (confd refuse le doublon).
    const pats = clientPatterns(d.write.out).filter((p) => !skipped.some((x) => x.unit === u.key && x.exten === p.exten));
    // Comme Call Flow Manager (audité le 21/10/2026) : règle, un numéro par motif dans le contexte
    // sortant, association avec sa transformation, trunk ; autorisation « interdit-118 » (refus de
    // _118XXX) reprise si elle existe, sinon créée, puis associée (PUT /outcalls/{id}/callpermissions/{id}).
    // Retour arrière si une écriture échoue.
    ops.push({ label: `Règle « ${ocName} » : ${pats.length} motif(s) vers ${trunkLabel(t, trunkId)}${d.write.out.block118 ? ', 118 bloqués' : ''}`, run: async () => {
      const ctxOut = outName[u.key];
      if (!ctxOut) throw new Error(`contexte sortant de « ${u.L.ctx} » introuvable`);
      const undo = [];
      const o = await tapi('POST', '/outcalls', { name: ocName });
      undo.unshift({ method: 'DELETE', path: `/outcalls/${o.id}` });
      try {
        for (const p of pats) {
          const ext = await tapi('POST', '/extensions', { exten: p.exten, context: ctxOut });
          undo.unshift({ method: 'DELETE', path: `/extensions/${ext.id}` });
          await tapi('PUT', `/outcalls/${o.id}/extensions/${ext.id}`, { strip_digits: p.strip_digits || 0, external_prefix: p.external_prefix || null, prefix: null, caller_id: null });
          undo.unshift({ method: 'DELETE', path: `/outcalls/${o.id}/extensions/${ext.id}` });
        }
        await tapi('PUT', `/outcalls/${o.id}/trunks`, { trunks: [{ id: trunkId }] });
        if (d.write.out.block118) {
          if (!perm118.p) {
            perm118.p = await tapi('POST', '/callpermissions', { name: 'interdit-118', mode: 'deny', enabled: true, extensions: [BLOCK_118], description: 'Renseignements 118 XXX surtaxés (Migration Assistant)' });
            undo.push({ method: 'DELETE', path: `/callpermissions/${perm118.p.id}` });
          }
          await tapi('PUT', `/outcalls/${o.id}/callpermissions/${perm118.p.id}`);
        }
      } catch (e) { for (const x of undo) { try { await runUndo(x); } catch { /* signalé par l'erreur d'origine */ } } throw e; }
      return { created: `règle ${o.id}`, undo: { seq: undo } };
    } });
  }
  // Sons et musiques d'attente (onglet Sons ; API lues dans confd, voir 3cx-sounds.js).
  // Musique existante du même nom : fichiers ajoutés (annulation : ces fichiers seulement).
  const sp = soundPlan(d); const mohName = {};
  for (const m of sp.mohs) { const ex = t.moh.find((x) => x.label === m.label); if (ex) mohName[m.x.key] = ex.name; }
  // Un fichier déjà présent dans Wazo sous le même nom n'est jamais remplacé : l'annulation ne
  // pourrait pas le rendre (elle ne garde que des appels d'API, pas le son d'avant). Il est
  // signalé dans le journal ; seuls les fichiers envoyés par l'outil sont annulables.
  for (const m of sp.mohs) {
    const files = m.files.filter((f) => loaded(f)); if (!files.length) continue;
    const names = uniqueNames(m.files);
    ops.push({ label: `Musique d'attente « ${m.label} » : ${files.length} fichier(s) WAV 8 kHz (POST /moh, PUT /moh/…/files/…)`, run: async () => {
      const undo = []; const cur = (await listAll('/moh')).find((x) => x.label === m.label);
      const moh = cur || await tapi('POST', '/moh', { label: m.label, mode: 'files', sort: m.x.sort || 'alphabetical' });
      if (!cur) undo.unshift({ method: 'DELETE', path: `/moh/${moh.uuid}` });
      const have = new Set(cur ? ((await tapi('GET', `/moh/${moh.uuid}`)).files || []).map((x) => String(x.name).toLowerCase()) : []);
      const kept = [];
      try {
        for (const f of files) {
          const fn = `${names.get(f)}.wav`; if (have.has(fn.toLowerCase())) { kept.push(fn); continue; }
          guard();
          await putBinary(`/moh/${moh.uuid}/files/${encodeURIComponent(fn)}`, loaded(f).blob);
          if (cur) undo.unshift({ method: 'DELETE', path: `/moh/${moh.uuid}/files/${encodeURIComponent(fn)}` });
        }
      } catch (e) { for (const x of undo) { try { await runUndo(x); } catch { /* signalé par l'erreur d'origine */ } } throw e; }
      mohName[m.x.key] = moh.name;
      return { created: `${moh.name}${kept.length ? ` · déjà présents, non remplacés : ${kept.join(', ')}` : ''}`, undo: { seq: undo } };
    } });
  }
  const sfiles = sp.files.filter((f) => loaded(f));
  if (sfiles.length && CATEGORY_RE.test(sp.cat)) {
    const names = uniqueNames(sp.files);
    ops.push({ label: `Sons « ${sp.cat} » : ${sfiles.length} fichier(s) WAV 8 kHz, langue fr_FR (POST /sounds, PUT /sounds/…/files/…)`, run: async () => {
      const undo = []; const ex = (await listAll('/sounds')).some((x) => x.name === sp.cat);
      if (!ex) { await tapi('POST', '/sounds', { name: sp.cat }); undo.unshift({ method: 'DELETE', path: `/sounds/${sp.cat}` }); }
      // Fichiers de la catégorie (SoundFileSchema : name, formats [{format, language}]) : présent = même nom en fr_FR.
      const have = new Set(ex ? ((await tapi('GET', `/sounds/${sp.cat}`)).files || []).filter((x) => (x.formats || []).some((y) => !y.language || y.language === 'fr_FR')).map((x) => String(x.name).toLowerCase()) : []);
      const kept = []; let sent = 0;
      try {
        for (const f of sfiles) {
          const n = names.get(f); if (have.has(n.toLowerCase())) { kept.push(n); continue; }
          const fn = encodeURIComponent(n); guard();
          await putBinary(`/sounds/${sp.cat}/files/${fn}?format=wav&language=fr_FR`, loaded(f).blob); sent++;
          if (ex) undo.unshift({ method: 'DELETE', path: `/sounds/${sp.cat}/files/${fn}?format=wav&language=fr_FR` });
        }
      } catch (e) { for (const x of undo) { try { await runUndo(x); } catch { /* signalé par l'erreur d'origine */ } } throw e; }
      return { created: `${sent} fichier(s) dans ${sp.cat}${kept.length ? ` · déjà présents, non remplacés : ${kept.join(', ')}` : ''}`, undo: { seq: undo } };
    } });
  }
  // Annuaire (wazo-dird, lu le 04/11/2026, voir 3cx-phonebook.js) : carnet, contacts, source de
  // type carnet (colonnes reprises d'une source carnet existante du site, sinon par défaut), ajout
  // de la source aux services du profil du site. Annulation : profil d'avant, source, carnet.
  const contacts = d.phonebook ? companyContacts(d) : [];
  // Carnet du même nom déjà présent (phase relancée après une erreur, ou annuaire fait à la main) :
  // rien n'est recréé ; relu aussi juste avant l'écriture.
  if (contacts.length && !(t.phonebooks || []).some((x) => x.name === phonebookName(d))) {
    const name = phonebookName(d);
    ops.push({ label: `Annuaire « ${name} » : ${contacts.length} contact(s), source d'annuaire et profil du site (wazo-dird)`, run: async () => {
      const undo = [];
      try {
        guard();
        if (((await dird('GET', '/phonebooks'))?.items || []).some((x) => x.name === name)) return { created: `carnet « ${name} » déjà présent : rien recréé` };
        const pb = await dird('POST', '/phonebooks', { name, description: 'Import 3CX (Migration Assistant)' });
        undo.unshift({ api: 'dird', method: 'DELETE', path: `/phonebooks/${pb.uuid}` });
        for (const c of contacts) { guard(); await dird('POST', `/phonebooks/${pb.uuid}/contacts`, c); }
        const model = ((await dird('GET', '/backends/phonebook/sources'))?.items || [])[0];
        const cols = sourceColumns(model);
        const src = await dird('POST', '/backends/phonebook/sources', { name, phonebook_uuid: pb.uuid, ...cols });
        undo.unshift({ api: 'dird', method: 'DELETE', path: `/backends/phonebook/sources/${src.uuid}` });
        const profs = (await dird('GET', '/profiles'))?.items || [];
        const prof = profs.find((x) => x.name === 'default') || profs[0];
        let note = 'aucun profil d\'annuaire : source à ajouter à la main (Portal > Annuaire > Profils)';
        if (prof) {
          const full = await dird('GET', `/profiles/${prof.uuid}`);
          const prev = JSON.parse(JSON.stringify(full));
          const services = { ...(full.services || {}) };
          for (const s of Object.keys(services).length ? Object.keys(services).filter((k) => ['lookup', 'reverse', 'favorites'].includes(k)) : ['lookup', 'reverse']) {
            const cur = services[s] || { sources: [], options: {} };
            if (!(cur.sources || []).some((x) => x.uuid === src.uuid)) services[s] = { ...cur, sources: [...(cur.sources || []), { uuid: src.uuid }] };
          }
          await dird('PUT', `/profiles/${prof.uuid}`, { name: full.name, display: full.display, services });
          undo.unshift({ api: 'dird', method: 'PUT', path: `/profiles/${prof.uuid}`, body: { name: prev.name, display: prev.display, services: prev.services } });
          note = `profil « ${full.name} »`;
        }
        return { created: `${pb.uuid} · ${contacts.length} contact(s) · ${note}`, undo: { seq: undo } };
      } catch (e) { for (const x of undo) { try { await runUndo(x); } catch { /* signalé par l'erreur d'origine */ } } throw e; }
    } });
  }
  // Musique par défaut : moh_suggest du modèle SIP global (comme le Wizard de Wazo). PUT partiel
  // (endpoint_sip/resource.py, lu) : la liste des options est relue puis renvoyée entière, seule
  // moh_suggest change ; annulation = liste d'avant.
  if (sp.def && t.sipTpl?.global) {
    ops.push({ label: `Musique d'attente par défaut « ${sp.def.label} » (modèle SIP global, moh_suggest)`, run: async () => {
      const name = mohName[sp.def.x.key] || (await listAll('/moh')).find((x) => x.label === sp.def.label)?.name;
      if (!name) return { created: 'musique d\'attente absente : rien changé (déposer ses fichiers)' };
      const tpl = await tapi('GET', `/endpoints/sip/templates/${t.sipTpl.global}`);
      const prev = tpl.endpoint_section_options || [];
      if (prev.some(([k, v]) => k === 'moh_suggest' && v === name)) return { created: 'déjà réglée' };
      await tapi('PUT', `/endpoints/sip/templates/${t.sipTpl.global}`, { endpoint_section_options: [...prev.filter(([k]) => k !== 'moh_suggest'), ['moh_suggest', name]] });
      return { created: name, undo: { method: 'PUT', path: `/endpoints/sip/templates/${t.sipTpl.global}`, body: { endpoint_section_options: prev } } };
    } });
  }
  return ops;
}
async function runUndo(u) {
  if (!u) return;
  if (u.seq) { for (const x of u.seq) { try { await runUndo(x); } catch (e) { if (e.status !== 404) throw e; } } return; }
  // Contextes du client supprimés : le brouillon revient au contexte d'avant.
  if (u.local === 'site') {
    if (u.units) { for (const k of u.units) unitCfg(W.d, k).created = null; return; }
    const s = W.d.write.site; if (s.created) { W.d.ctx = s.created.prevCtx; s.created = null; } return;
  }
  if (u.api === 'logd') return logd(u.method, u.path, u.body);
  if (u.api === 'dird') { guard(); return dird(u.method, u.path, u.body); }
  return tapi(u.method, u.path, u.body);
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
const ST = { create: 'à créer', update: 'à modifier', exists: 'déjà présent', conflict: 'à régler', skip: 'rien à faire' };
const PST = { todo: 'À appliquer', done: 'Appliquée', error: 'Interrompue' };
// Parcours guidé (retour de Brice, 09/11/2026 : « franchement la zone ») : une étape affichée à
// la fois, « Suivant » seulement quand l'étape est remplie, raison affichée sinon.
const STEPS = [
  { id: 'client', title: 'Client', help: 'Identité du client : elle sert à nommer ce qui est créé dans Wazo.' },
  { id: 'tenant', title: 'Tenant Wazo', help: 'Lecture seule : l\'outil lit le tenant ouvert dans le portail et liste ce qui manque avant d\'écrire.' },
  { id: 'site', title: 'Site et appels sortants', help: 'Où le client s\'installe (contextes), par quel trunk il sort, et simulation des appels avant toute écriture.' },
  { id: 'losses', title: 'Pertes et écarts', help: 'Ce qui ne sera pas reproduit à l\'identique de 3CX. À lire et à accepter avant d\'écrire.' },
  { id: 'write', title: 'Écriture', help: 'Phase par phase, dans l\'ordre. Sauvegarde du tenant avant la première écriture, journal, annulation possible de chaque phase.' },
  { id: 'final', title: 'Contrôle final', help: 'Après Routage et Finitions : comparaison du parcours de chaque SDA, 3CX et Wazo (ouvert, fermé, férié).' },
];
// Ce qui manque pour finir l'étape i (null = finie).
function stepTodo(i, pre) {
  const w = W.d.write;
  switch (STEPS[i].id) {
    case 'client': return !w.clientId ? 'saisir l\'ID client' : !w.clientName ? 'saisir le nom du client' : null;
    case 'tenant': return !W.t ? 'lire le tenant' : !W.t.trunks.length ? 'créer le trunk dans le Portal, puis relire le tenant' : null;
    case 'site': {
      const c = contextsOf(W.t);
      if (!c.many && !w.site.created && !w.site.mode) return 'choisir l\'installation du client';
      const n = pre.filter((p) => p.src === 'site' && p.sev === 'error').length;
      return n ? `corriger ${n} erreur(s) signalée(s) ci-dessus` : null;
    }
    case 'losses': return w.ackLosses ? null : 'cocher « J\'ai pris connaissance de ces pertes et écarts »';
    case 'write': return PHASES.filter((p) => !p.lot).every((p) => ph(p.id).status === 'done') ? null : 'appliquer les phases disponibles';
    default: return 'à venir';
  }
}
const PRE_GROUPS = [
  ['error', 'Bloquant', 'compat blocking'], ['manual', 'À faire dans le Portal', 'warn'], ['fix', 'Corrigé par l\'outil à l\'écriture', 'x3w-remind small'],
  ['warn', 'À surveiller', 'warn'], ['remind', 'Rappels', 'x3w-remind small'],
];
const phaseTitles = (ids) => ids.map((id) => PHASES.find((p) => p.id === id)?.title).filter(Boolean).join(', ');
function preList(list) {
  return PRE_GROUPS.map(([sev, label, cls]) => {
    const l = list.filter((p) => (PRE_GROUPS.some((g) => g[0] === p.sev) ? p.sev : 'warn') === sev);
    return l.length ? `<h4 class="x3w-gh">${esc(label)} (${l.length})</h4>${l.map((p) => `<div class="${cls}"><strong>${esc(p.title)}</strong> : ${esc(p.text)}${p.phases.length && ['error', 'manual', 'fix'].includes(sev) ? ` <span class="muted small">Bloque : ${esc(phaseTitles(p.phases))}.</span>` : ''}</div>`).join('')}` : '';
  }).join('');
}
export function wizardTab() {
  const w = W.d.write;
  const pre = W.t ? prerequisites(W.t) : [];
  const todo = STEPS.map((_, i) => (i > 1 && !W.t ? 'lire le tenant' : stepTodo(i, pre)));
  // Étape la plus loin atteignable : toutes les précédentes finies (Contrôle final : après Écriture).
  let reach = 0; while (reach < STEPS.length - 1 && !todo[reach]) reach++;
  // w.view gardé tel quel : après rechargement (tenant à relire), on revient où on en était.
  const i = Math.min(w.view ?? reach, reach); const st = STEPS[i];
  let html = `<div class="titlerow"><h3>Migration dans Wazo</h3>${helpButton('x3w-h', 'Aide : migration')}</div>
    ${helpBox('x3w-h', 'Comme le mode édition de Call Flow Manager : rien n\'est écrit avant « Appliquer ». Les étapes se suivent ; « Suivant » se débloque quand l\'étape est remplie, et dit ce qui manque sinon. Une étape finie reste consultable en cliquant sur son nom.')}
    <ol class="x3w-bar">${STEPS.map((s, k) => `<li><button type="button" data-wact="goto" data-s="${k}" class="${k === i ? 'cur' : !todo[k] ? 'done' : ''}" ${k > reach ? 'disabled' : ''}><span class="x3w-n">${k + 1}</span>${esc(s.title)}</button></li>`).join('')}</ol>
    <div class="card x3w-step open"><div class="x3w-head"><span class="x3w-n">${i + 1}</span><strong>${esc(st.title)}</strong><span class="spacer"></span>${todo[i] ? '' : '<span class="x3w-badge ok">Fait</span>'}</div>
    <p class="small muted">${esc(st.help)}</p>`;
  html += { client: stepClient, tenant: stepTenant, site: stepSite, losses: stepLosses, write: stepWrite, final: () => '' }[st.id](pre);
  html += `<div class="x3w-nav">${i ? `<button type="button" data-wact="goto" data-s="${i - 1}">Précédent</button>` : ''}<span class="spacer"></span>
    ${i < STEPS.length - 1 ? `${todo[i] ? `<span class="small x3w-why">Pour continuer : ${esc(todo[i])}.</span>` : ''}<button type="button" class="primary" data-wact="goto" data-s="${i + 1}" ${todo[i] ? 'disabled' : ''}>Suivant : ${esc(STEPS[i + 1].title)}</button>` : ''}</div></div>`;
  return html;
}
function stepClient() {
  const w = W.d.write;
  return `<div class="ms-tools"><label>ID client <input data-w="clientId" value="${esc(w.clientId)}" class="x3-short" placeholder="44150"></label><label>Nom du client <input data-w="clientName" value="${esc(w.clientName)}" class="x3-mail"></label><label>Journal d'appels (j) <input type="number" min="0" max="3650" data-w="cdrDays" value="${esc(w.cdrDays)}" class="x3-short"></label><label>Enregistrements (j) <input type="number" min="0" max="3650" data-w="recordingDays" value="${esc(w.recordingDays)}" class="x3-short"></label></div>
    <p class="small muted">Tenant visé : ${esc(S.base ? new URL(S.base).host : '?')} · ${esc(I.tenant || 'hors portail')}. Noms produits : « ${esc(w.clientName || '<client>')} - Appels sortants », « ${esc(w.clientId || '<ID>')} - Attente », « ${esc(w.clientId || '<ID>')} - Prédécroché ».</p>`;
}
function stepTenant(pre) {
  let h = `<div class="btnrow"><button data-wact="read" ${W.busy ? 'disabled' : ''} class="${W.t ? '' : 'primary'}">${W.t ? 'Relire le tenant' : 'Lire le tenant'}</button>${W.t ? `<span class="small muted">Lu à ${esc(W.t.at.toLocaleTimeString('fr-FR'))}. Relire après chaque changement fait dans le Portal.</span>` : ''}</div>`;
  if (!W.t) return h;
  if (!W.t.trunks.length) h += trunkHelp();
  const l = pre.filter((p) => p.src !== 'site');
  return h + (l.length ? preList(l) : '<div class="mg-allok">Rien ne manque dans le tenant.</div>');
}
function stepSite(pre) {
  const w = W.d.write; let h = '';
  const l = pre.filter((p) => p.src === 'site');
  if (l.length) h += preList(l);
  if (!multiSites(W.d)) h += `<label class="small">Trunk du client <select data-w="trunkId">${W.t.trunks.map((t) => `<option value="${t.id}" ${String(w.trunkId || W.t.trunks[0]?.id) === String(t.id) ? 'selected' : ''}>${esc(trunkLabel(W.t, t.id))}</option>`).join('')}</select></label>`;
  return h + siteBlock(W.t);
}
function stepLosses() {
  const w = W.d.write; const L = losses();
  return `<p class="small"><strong>${L.filter((x) => x.sev === 'warn').length} à surveiller</strong> (en orange), ${L.filter((x) => x.sev === 'info').length} pour information.</p>
    <label class="inline small"><input type="checkbox" data-w="keepProfiles" ${w.keepProfiles ? 'checked' : ''}> Reprendre le profil 3CX actuel des postes absents en renvoi immédiat Wazo</label>
    <div class="x3-edit-wrap x3w-loss"><table class="diff x3-edit"><thead><tr><th>Quoi</th><th>Conséquence</th><th>Parade</th></tr></thead><tbody>${L.map((x) => `<tr class="x3-${x.sev}"><td>${esc(x.what)}</td><td>${esc(x.effect)}</td><td>${esc(x.fix)}</td></tr>`).join('')}</tbody></table></div>
    <label class="inline x3w-ack"><input type="checkbox" data-w="ackLosses" ${w.ackLosses ? 'checked' : ''}> J'ai pris connaissance de ces pertes et écarts</label>`;
}
function stepWrite(pre) {
  const plan = buildPlan(W.t); const blocked = blockedPhases(pre);
  const next = PHASES.find((p) => !p.lot && ph(p.id).status !== 'done');
  return `${W.msg ? `<div class="${W.msg.bad ? 'compat blocking' : 'mg-allok'}">${esc(W.msg.text)}</div>` : ''}
    ${PHASES.map((p, k) => phaseCard(p, k, plan[p.id], pre, blocked.has(p.id), p === next)).join('')}`;
}
// Où installer le client, règle sortante (assistant France de Call Flow) et
// simulation des appels depuis son contexte, avant toute écriture.
const SITE_HELP = 'Le Portal découpe en tenant puis sites Wazo. Établissements qui s\'appellent en interne, chacun avec son trunk : même site Wazo, un contexte interne par établissement. Établissements qui ne s\'appellent pas (franchise) : un site Wazo chacun, créé dans le Portal. « Nouveau contexte » crée le contexte interne du client (plages calculées) et son contexte sortant, inclus en premier ; les autres établissements cochés sont inclus après, et incluent le client en fin de liste, pour ne rien changer à leurs appels actuels. La simulation cherche chaque numéro comme Asterisk (moteur de Call Flow Manager) : extensions du contexte, puis contextes inclus dans l\'ordre. Elle montre où partiraient les appels, pour le client et pour chaque autre contexte interne, avant / après.';
function siteBlock(t) {
  const w = W.d.write; const s = w.site; const o = w.out; const c = contextsOf(t);
  const occ = occupancy(t); const internals = t.contexts.filter((x) => x.type === 'internal');
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  const lbl = (n) => t.contexts.find((x) => x.name === n)?.label || n;
  const peersBox = () => (s.inter ? `<div class="small">${occ.map((x) => `<label class="inline"><input type="checkbox" data-w="site.peer" data-id="${esc(x.name)}" ${(s.peers ?? occ.map((y) => y.name)).includes(x.name) ? 'checked' : ''}> ${esc(x.label)}</label>`).join(' ') || '<span class="muted">aucun autre établissement</span>'}</div>` : '');
  let h = `<div class="x3w-site"><div class="titlerow"><strong>Site Wazo et contextes</strong>${helpButton('x3w-site-h', 'Aide : site et contextes')}</div>${helpBox('x3w-site-h', SITE_HELP)}
    <p class="small muted">${occ.length ? `Ce site Wazo contient déjà des postes : ${occ.map((x) => `${esc(x.label)} (${x.n})`).join(', ')}.` : 'Ce site Wazo ne contient encore aucun poste.'}</p>`;
  if (c.many) {
    // Départements 3CX en jeux de contextes propres (onglet Départements) : un nouveau jeu chacun.
    h += `<p class="small">${c.units.length} jeux de contextes, un par département 3CX (onglet Départements) : chacun son contexte interne, son contexte entrant (son trunk y est pointé), son contexte sortant et son trunk. Noms : &lt;ID client&gt;-&lt;site&gt;-&lt;type&gt;.</p>
      <table class="diff x3-edit"><thead><tr><th>Département</th><th>Contexte interne</th><th>Contexte entrant</th><th>Contexte sortant</th><th>Trunk Wazo</th></tr></thead><tbody>${c.units.map((u) => {
      const cfg = unitCfg(W.d, u.key);
      if (u.created) return `<tr><td>${esc(u.label)}</td><td>${esc(lbl(u.ctx))}</td><td>${esc(lbl(u.inc || ''))}</td><td>${esc(lbl(u.out))}</td><td>${esc(trunkLabel(t, u.trunkId))} <span class="muted small">(créés)</span></td></tr>`;
      return `<tr><td>${esc(u.label)}${u.trunk ? `<div class="muted small">3CX : ${esc(u.trunk)}</div>` : ''}</td><td><input data-w="unit.newLabel" data-id="${esc(u.key)}" value="${esc(cfg.newLabel)}" placeholder="${esc(u.L.ctx)}" class="x3-mail"></td><td><input data-w="unit.incLabel" data-id="${esc(u.key)}" value="${esc(cfg.incLabel || '')}" placeholder="${esc(u.L.inc)}" class="x3-mail"></td><td><input data-w="unit.outLabel" data-id="${esc(u.key)}" value="${esc(cfg.outLabel)}" placeholder="${esc(u.L.out)}" class="x3-mail"></td>
        <td><select data-w="unit.trunkId" data-id="${esc(u.key)}">${u.trunkId ? '' : opt('', 'À choisir', '')}${t.trunks.map((x) => opt(x.id, trunkLabel(t, x.id), u.trunkId)).join('')}</select></td></tr>`;
    }).join('')}</tbody></table>
      <label class="inline small"><input type="checkbox" data-w="site.interUnits" ${s.interUnits ? 'checked' : ''}> Appels internes entre départements</label>
      <label class="inline small"><input type="checkbox" data-w="site.inter" ${s.inter ? 'checked' : ''}> Appels internes avec les établissements déjà présents</label>${peersBox()}`;
  } else if (s.created) h += `<p class="small">Contextes du client créés : « ${esc(lbl(s.created.ctxName))} »${s.created.incName ? `, « ${esc(lbl(s.created.incName))} »` : ''}, « ${esc(lbl(s.created.outName))} » (annulables avec la phase Fondations).</p>`;
  else {
    const u = c.units[0]; const L = u.L;
    h += `<label class="small">Installation <select data-w="site.mode">${s.mode ? '' : opt('', 'À choisir', '')}${Object.entries(SITE_MODES).map(([k, l]) => opt(k, l, s.mode)).join('')}</select></label>`;
    if (s.mode === 'dedicated' || s.mode === 'existing') h += ` <label class="small">Contexte interne <select data-w="draft.ctx">${internals.map((x) => opt(x.name, `${x.label || x.name}${occ.find((y) => y.name === x.name) ? ` (${occ.find((y) => y.name === x.name).n} postes)` : ''}`, u.ctx)).join('')}</select></label>`;
    if (s.mode === 'new') {
      h += `<div class="ms-tools"><label class="small">Contexte interne <input data-w="site.newLabel" value="${esc(s.newLabel)}" placeholder="${esc(L.ctx)}" class="x3-mail"></label><label class="small">Contexte entrant <input data-w="site.incLabel" value="${esc(s.incLabel || '')}" placeholder="${esc(L.inc)}" class="x3-mail" title="Le trunk choisi y sera pointé ; les SDA du client y sont déclarées"></label><label class="small">Contexte sortant <input data-w="site.outLabel" value="${esc(s.outLabel)}" placeholder="${esc(L.out)}" class="x3-mail"></label></div>
        <label class="inline small"><input type="checkbox" data-w="site.inter" ${s.inter ? 'checked' : ''}> Appels internes avec les autres établissements</label>${peersBox()}`;
    }
  }
  // Règle sortante du client : assistant France de Call Flow Manager.
  h += `<div class="x3w-out"><strong class="small">Règle sortante du client</strong> <span class="small muted">assistant France de Call Flow Manager ; l'ordre d'essai est celui d'Asterisk (le plus précis d'abord)</span>
    <div class="small">${FR_FAMILIES.map((f) => `<label class="inline"><input type="checkbox" data-w="out.fam" data-id="${f.id}" ${o.fams.includes(f.id) ? 'checked' : ''}> ${esc(f.label)} <code>${esc(f.note || f.pats.join(', '))}</code></label>`).join(' ')}</div>
    <div class="ms-tools small"><label>Format attendu par l'opérateur <select data-w="out.fmt">${Object.entries(FR_FORMATS).map(([k, l]) => opt(k, l, o.fmt)).join('')}</select></label>
      <label class="inline"><input type="checkbox" data-w="out.block118" ${o.block118 ? 'checked' : ''}> Bloquer les 118 XXX (autorisation « interdit-118 »)</label>
      <label class="inline" title="Prend tout numéro qu'aucun autre motif ne prend. Incompatible avec les appels internes entre établissements : la simulation le montre."><input type="checkbox" data-w="out.catchAll" ${o.catchAll ? 'checked' : ''}> Attrape-tout _X.</label></div></div>`;
  // Simulation depuis chaque jeu de contextes.
  const chk = siteChecks(t, W.d, (id) => trunkLabel(t, id));
  for (const { p, rows } of chk.tables) h += `<details class="small x3w-sim"${chk.issues.some((x) => x.sev === 'error') ? ' open' : ''}><summary>Simulation : appels depuis ${esc(c.many ? `« ${p.label} »` : 'le client')}</summary><table class="diff x3-edit"><thead><tr><th>Numéro</th><th>Type</th><th>Résultat</th></tr></thead><tbody>${rows.map((x) => `<tr class="${(x.r.kind === 'out' && x.r.trunks.includes(Number(p.trunkId))) || x.n.startsWith('118') ? '' : 'x3-warn'}"><td>${esc(x.n)}</td><td>${esc(x.what)}</td><td>${esc(routeText(chk.w, x.r, (id) => trunkLabel(t, id)))}${x.n.startsWith('118') && x.r.mine && o.block118 ? ' · bloqué par « interdit-118 »' : ''}</td></tr>`).join('')}</tbody></table></details>`;
  return `${h}</div>`;
}
function trunkHelp() {
  const t = W.m?.trunks?.[0]; const w = W.d.write;
  return `<ol class="small x3w-todo"><li>Portal : Gestion des appels > Interconnexions > Créer, modèle de l'opérateur (${esc(t?.name || 'Unyc')} ; paramètres sur Atlas).</li><li>Nom affiché : « ${esc(w.clientName || '<client>')} - Trunk ${esc(t ? t.name.charAt(0).toUpperCase() + t.name.slice(1) : 'Unyc')} ».</li><li>Serveur proxy : pbx.eqinoxe.com.</li><li>Identifiant et mot de passe du trunk : ceux d'Atlas. Si 3CX utilise encore ce trunk, fausser son mot de passe d'un côté pour éviter un double enregistrement.</li><li>Numéro principal : ${esc(t?.mainNumber || '?')}. Créer, puis « Relire le tenant ».</li></ol>`;
}
// Une phase = ce qu'elle écrira (plan), ce qui la bloque, son bouton et son journal, au même endroit.
function phaseCard(p, k, items, pre, blocked, isNext) {
  const s = ph(p.id);
  const n = (x) => items.filter((y) => y.status === x).length;
  const sum = ['create', 'update', 'exists', 'conflict'].filter((x) => n(x)).map((x) => `${n(x)} ${ST[x]}`).join(' · ') || 'rien à écrire';
  const why = pre.filter((x) => ['error', 'manual', 'fix'].includes(x.sev) && x.phases.includes(p.id));
  const can = !p.lot && W.d.write.ackLosses && !blocked && s.status !== 'done' && !W.busy;
  const state = p.lot ? `écriture au lot ${p.lot}` : PST[s.status];
  return `<div class="x3w-phasebox ${isNext ? 'next' : ''} ${s.status === 'done' ? 'done' : ''} ${p.lot ? 'later' : ''}">
    <div class="x3w-head"><span class="x3w-n">${String.fromCharCode(65 + k)}</span><strong>${esc(p.title)}</strong><span class="x3w-badge ${s.status === 'done' ? 'ok' : isNext ? 'open' : ''}">${esc(state)}</span><span class="spacer"></span>
      ${p.lot ? '' : `${s.undo.length ? `<button data-wact="undo" data-p="${p.id}" class="danger" ${W.busy ? 'disabled' : ''}>Annuler la phase</button>` : ''}${s.status === 'done' ? '' : `<button data-wact="apply" data-p="${p.id}" class="${isNext ? 'primary' : ''}" ${can ? '' : 'disabled'}>Appliquer ${esc(p.title.toLowerCase())}</button>`}`}</div>
    <p class="small muted">${esc(p.help)}</p>
    ${!p.lot && blocked && s.status !== 'done' ? `<div class="compat blocking small"><strong>Bloquée par :</strong> ${why.map((x) => esc(x.title)).join(', ')} (étapes Tenant Wazo ou Site et appels sortants).</div>` : ''}
    <details class="small"${!p.lot && n('conflict') && s.status !== 'done' ? ' open' : ''}><summary>${s.status === 'done' ? 'État du tenant relu' : 'Ce qui sera écrit'} : ${esc(sum)}</summary><table class="diff x3-edit x3w-items"><tbody>${items.map((x) => `<tr class="st-${x.status}"><td class="x3w-st">${esc(ST[x.status])}</td><td>${esc(x.label)}</td><td class="muted small">${esc(x.detail || '')}</td></tr>`).join('')}</tbody></table></details>
    ${s.log.length ? `<details class="small x3w-log"><summary>Journal (${s.log.length})</summary><ul>${s.log.map((l) => `<li>${esc(new Date(l.at).toLocaleString('fr-FR'))} · ${esc(l.text)}</li>`).join('')}</ul></details>` : ''}</div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export async function wizardChange(t) {
  if (!t.dataset.w) return false;
  const k = t.dataset.w; const w = W.d.write;
  const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value.trim();
  if (k === 'out.fam') { const f = new Set(w.out.fams); v ? f.add(t.dataset.id) : f.delete(t.dataset.id); w.out.fams = FR_FAMILIES.map((x) => x.id).filter((x) => f.has(x)); }
  else if (k === 'site.peer') { const occ = W.t ? occupancy(W.t).map((x) => x.name) : []; const f = new Set(w.site.peers ?? occ); v ? f.add(t.dataset.id) : f.delete(t.dataset.id); w.site.peers = [...f]; }
  else if (k === 'draft.ctx') W.d.ctx = v;
  else if (k.startsWith('unit.')) unitCfg(W.d, t.dataset.id)[k.slice(5)] = v;
  else if (k.includes('.')) { const [a, b] = k.split('.'); w[a][b] = v; }
  else w[k] = v;
  // L'option des profils change la liste des pertes : il faut la relire.
  if (k === 'keepProfiles') W.d.write.ackLosses = false;
  save();
  return true;
}
export async function wizardClick(b, rerender) {
  const act = b.dataset.wact;
  if (act === 'goto') { W.d.write.view = Number(b.dataset.s); W.msg = null; save(); rerender(); document.querySelector('.x3w-bar')?.scrollIntoView({ block: 'nearest' }); return; }
  if (act === 'read') {
    W.busy = true; rerender();
    try {
      W.t = await readTenant(); W.msg = null;
      // Site Wazo vide : dédié au client par défaut ; sinon le choix est demandé.
      if (!W.d.write.site.mode && !occupancy(W.t).length) { W.d.write.site.mode = 'dedicated'; save(); }
    } catch (e) { toast(`Lecture du tenant impossible : ${e.message}`, 8000); }
    W.busy = false; return rerender();
  }
  const id = b.dataset.p; const p = PHASES.find((x) => x.id === id); if (!p) return;
  const s = ph(id);
  const log = (text) => s.log.push({ at: new Date().toISOString(), text });
  if (act === 'apply') {
    if (!canWrite()) return;
    let ops;
    try { W.t = await readTenant(); ops = id === 'found' ? await foundationOps(W.t) : []; } catch (e) { W.msg = { bad: true, text: `Relecture impossible : ${e.message}` }; return rerender(); }
    if (!ops.length) { s.status = 'done'; log('rien à écrire : déjà conforme'); save(); W.msg = { text: `${p.title} : déjà conforme, rien à écrire.` }; return rerender(); }
    return confirmModal(`<h3>Appliquer : ${esc(p.title)}</h3><ol class="small">${ops.map((o) => `<li>${esc(o.label)}</li>`).join('')}</ol><p class="small">Tenant ${esc(I.tenant || '?')}. ${W.d.write.backupAt ? '' : 'Un export JSON du tenant est d\'abord téléchargé (sauvegarde). '}Chaque écriture est notée dans le journal de la phase et peut être annulée.</p>`, async () => {
      W.busy = true; rerender();
      if (!W.d.write.backupAt) { downloadJson(exportFileName().replace('astrea-export', 'astrea-export-avant-migration-3cx'), buildExport({ secrets: false })); W.d.write.backupAt = new Date().toISOString(); }
      let n = 0;
      try {
        for (const o of ops) { const r = await o.run(); n++; if (r?.undo) s.undo.push(r.undo); log(`${o.label}${r?.created ? ` → ${r.created}` : ''}`); save(); }
        s.status = 'done'; W.msg = { text: `${p.title} : ${n} écriture(s) faite(s).` };
      } catch (e) {
        s.status = 'error'; log(`ERREUR après ${n} écriture(s) : ${e.message}`);
        W.msg = { bad: true, text: `${p.title} interrompue après ${n} écriture(s) sur ${ops.length} : ${e.message}. Ce qui a été écrit est dans le journal et annulable.` };
      }
      try { W.t = await readTenant(); } catch { /* le plan se relira au prochain clic */ }
      W.busy = false; save(); rerender();
    }, 'Appliquer');
  }
  if (act === 'undo') {
    if (!canWrite()) return;
    // Contextes entrants créés : un trunk réglé dessus à la main (l'outil ne touche pas aux trunks) doit
    // d'abord être remis ailleurs dans le Portal ; effet de la suppression sur le trunk non vérifié.
    const incs = id === 'found' && W.t ? W.t.trunks.filter((tr) => [W.d.write.site.created?.incName, ...Object.values(W.d.write.units || {}).map((u) => u.created?.incName)].filter(Boolean).includes(tr.context)) : [];
    return confirmModal(`<h3>Annuler la phase ${esc(p.title)} ?</h3><p class="small">${s.undo.length} écriture(s) défaite(s), dans l'ordre inverse.</p>${incs.length ? `<p class="compat blocking small">${incs.map((tr) => esc(trunkLabel(W.t, tr.id))).join(', ')} : contexte entrant réglé sur un contexte que l'annulation va supprimer. Le remettre d'abord sur un autre contexte dans le Portal (l'outil ne modifie pas les trunks), puis « Relire le tenant ».</p>` : ''}`, async () => {
      W.busy = true; rerender();
      try { for (const u of [...s.undo].reverse()) { await runUndo(u); s.undo.pop(); save(); } s.status = 'todo'; log('phase annulée'); W.msg = { text: `${p.title} annulée.` }; }
      catch (e) { log(`ERREUR à l'annulation : ${e.message}`); W.msg = { bad: true, text: `Annulation interrompue : ${e.message}` }; }
      try { W.t = await readTenant(); } catch { /* */ }
      W.busy = false; save(); rerender();
    }, 'Annuler la phase');
  }
}
export const wizardDone = () => PHASES.filter((p) => ph(p.id).status === 'done').length;
export const wizardTotal = () => PHASES.length;
