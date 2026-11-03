// Migration Assistant — lot 5, deuxième conception : migration guidée orientée
// API (cahier des charges : docs/MIGRATION-ASSISTANT.md, « Lot 5, deuxième
// conception »). Retour de Brice sur la 0.40.29 : ne pas recopier sa trame de
// clics du Portal, guider et expliquer, perdre le moins possible et annoncer
// toute perte avant écriture, comme le mode édition de Call Flow.
// Parcours : 1 Préparer (relecture du tenant, prérequis) → 2 Plan (ordonné par
// l'outil, par phases) → 3 Pertes et écarts (à accepter) → 4 Appliquer par
// phase (sauvegarde, journal, annulation) → 5 Contrôle final (à venir).
// Écritures disponibles : phase Fondations (pays, conservation, numéros,
// appels sortants ; lues dans le code, testées sur faux tenant). Les phases
// Personnes, Routage et Finitions sont planifiées (lecture seule) ; leur
// écriture arrive aux lots 5b-5d.
import { S, api, listAll, ApiError, esc, toast, canWrite, confirmModal, helpButton, helpBox, downloadJson } from '../common/core.js?v=0.40.32';
import { I, sameTenant } from './inventory.js?v=0.40.32';
import { buildExport, exportFileName } from './export.js?v=0.40.32';
import { saveDraft, imported, userBy, huntBy, userName, draftIssues, tenantIssues, blfRows, destLabel, LICENCES, linesOf, linesText } from './3cx-draft.js?v=0.40.32';

const W = { d: null, m: null, t: null, busy: false, msg: null, at: null };
export function setWizard(d, m) { W.d = d; W.m = m; W.t = null; W.msg = null; ensureState(); }

function ensureState() {
  const d = W.d;
  // Brouillon de la 0.40.29 (étapes) : on garde l'ID client et les durées, on repart pour les phases.
  const old = d.write || {};
  if (old.version === 2) return;
  const m = String(d.company || '').match(/^\s*(\d{3,})\s*[-–]\s*(.+)$/);
  d.write = {
    version: 2, clientId: old.clientId ?? (m ? m[1] : ''), clientName: old.clientName ?? (m ? m[2].trim() : (d.company || '')),
    cdrDays: old.cdrDays ?? 90, recordingDays: old.recordingDays ?? 90, trunkId: old.trunkId ?? '', ackLosses: false, keepProfiles: true, phases: {},
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
const e164 = (n) => { const s = String(n || '').replace(/[^\d+]/g, ''); return s.startsWith('+') ? s : s.startsWith('00') ? `+${s.slice(2)}` : s.startsWith('0') ? `+33${s.slice(1)}` : s; };
const soft = async (fn, fallback) => { try { return await fn(); } catch (e) { return fallback(e); } };

// ---------------------------------------------------------------------------
// 1. Préparer : relecture du tenant (tout ce dont le plan a besoin)
// ---------------------------------------------------------------------------
async function readTenant() {
  const list = (p) => soft(() => listAll(p), (e) => ({ error: e.message, items: [] }));
  const [contexts, extensions, trunks, outcalls, users, voicemails, devices, groups, queues, ivrs, schedules, incalls, phones] = await Promise.all(
    ['/contexts', '/extensions', '/trunks', '/outcalls', '/users', '/voicemails', '/devices', '/groups', '/queues', '/ivr', '/schedules', '/incalls', '/phone-numbers'].map(list));
  const unwrap = (x) => (Array.isArray(x) ? x : []);
  const t = {
    at: new Date(), contexts: unwrap(contexts), extensions: unwrap(extensions), trunks: unwrap(trunks), outcalls: unwrap(outcalls), users: unwrap(users), voicemails: unwrap(voicemails),
    devices: unwrap(devices), groups: unwrap(groups), queues: unwrap(queues), ivrs: unwrap(ivrs), schedules: unwrap(schedules), incalls: unwrap(incalls), phones: unwrap(phones),
    phonesError: phones?.error || null,
  };
  t.localization = await soft(() => tapi('GET', '/localization'), (e) => ({ error: e.message }));
  t.retention = await soft(() => logd('GET', '/retention'), (e) => ({ error: e.message }));
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
// Contextes cibles : ceux choisis dans Exports (gardés dans le brouillon), sinon le premier du type.
function contextsOf(t) {
  const pick = (cur, type) => t.contexts.find((c) => c.name === cur && c.type === type) || t.contexts.find((c) => c.type === type) || null;
  return { internal: pick(W.d.ctx, 'internal'), incall: pick(W.d.incallCtx, 'incall'), outcall: t.contexts.find((c) => c.type === 'outcall') || null };
}

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
  ['user_ranges', 'postes', (d) => imported(d).map((u) => u.n)],
  ['group_ranges', 'groupes', (d) => d.hunts.filter((h) => h.target === 'group').map((h) => h.n)],
  ['queue_ranges', 'files d\'attente', (d) => d.hunts.filter((h) => h.target === 'queue').map((h) => h.n)],
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
function rangeFixes(ctx) {
  if (!ctx) return [];
  const out = [];
  for (const [key, label, nums] of RANGE_TYPES) {
    const missing = [...new Set(nums(W.d))].filter((n) => /^\d+$/.test(n) && !inR(n, ctx[key]));
    if (missing.length) out.push({ key, label, missing, add: spanOf(missing), current: ctx[key] || [] });
  }
  return out;
}

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
  const add = (sev, title, text, phases = []) => out.push({ sev, title, text, phases });
  if (!c.internal) add('error', 'Contexte interne', 'aucun contexte interne dans le tenant.', ['people', 'routing']);
  if (!c.incall) add('error', 'Contexte entrant', 'aucun contexte entrant : les SDA ne pourront pas être créées.', ['routing']);
  if (!c.outcall) add('error', 'Contexte sortant', 'aucun contexte sortant : pas de règle d\'appels sortants possible.', ['found']);
  const tIss = c.internal ? tenantIssues(W.d, { ctx: c.internal.name, incallCtx: c.incall?.name }, { contexts: t.contexts, extensions: t.extensions, users: t.users, voicemails: t.voicemails }) : [];
  // Numéros hors des plages : corrigés par la phase Fondations (ajout des plages), pas une erreur à régler à la main.
  for (const x of tIss.filter((y) => y.sev === 'error' && !/hors des plages/.test(y.text))) add('error', x.area, x.text, ['people']);
  const fixes = rangeFixes(c.internal);
  if (fixes.length) add('fix', `Plages du contexte ${c.internal.label || c.internal.name}`, `${fixes.map((f) => `${f.missing.length} ${f.label} hors des plages`).join(', ')} : la phase Fondations ajoute ${fixes.map((f) => `${f.label} ${f.add.map(rangeTxt).join(', ')}`).join(' ; ')}. Personnes et Routage attendent cette correction.`, ['people', 'routing']);
  for (const x of grouped(draftIssues(W.d).filter((y) => y.sev === 'error'), kindOf)) add('error', x.area, x.text, [/^\d+ (utilisateurs|appareils)|^(Utilisateur|Appareil)/.test(x.area) ? 'people' : 'routing']);
  if (!t.sipTpl?.global) add('error', 'Modèle SIP global', 'modèle SIP « global » du tenant introuvable : aucune ligne ne peut être créée (l\'import de Wazo échoue de même).', ['people']);
  const webrtc = imported(W.d).filter((u) => linesOf(u).includes('webrtc'));
  if (webrtc.length && !t.sipTpl?.webrtc) add('error', 'Modèle SIP WebRTC', `modèle SIP « webrtc » du tenant introuvable : ${webrtc.length} ligne(s) WebRTC impossibles.`, ['people']);
  const unchecked = imported(W.d).filter((u) => !u.checked).length;
  if (unchecked) add('warn', 'Vérification des utilisateurs', `${unchecked} utilisateur(s) pas encore vérifiés (onglet Utilisateurs, « Vérifier un par un »).`, ['people']);
  if (!t.trunks.length) add('manual', 'Trunk opérateur', 'aucun trunk dans le tenant. À créer dans le Portal avec le modèle de l\'opérateur (valeurs ci-dessous), puis « Relire le tenant ». Sans trunk : pas d\'appels sortants ni d\'appels entrants.', ['found']);
  add('remind', 'Applications de l\'organisation', 'réglage du Portal (Paramètres > Applications), hors de la stack : à vérifier selon le besoin du client.');
  add('remind', 'IP publique', 'postes fixes : autoriser l\'IP publique du client dans les paramètres globaux de la stack (tenant principal).');
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
  { id: 'finish', title: 'Finitions', help: 'Renvois et débordements (deuxième passe, quand toutes les cibles existent), touches de fonction, annuaire.', lot: '5c / 5d' },
];
function buildPlan(t) {
  const d = W.d; const c = contextsOf(t);
  const P = { found: [], people: [], routing: [], finish: [] };
  const add = (k, status, label, detail = '') => P[k].push({ status, label, detail });
  // Fondations : d'abord les plages du contexte interne (les numéros en dépendent).
  for (const f of rangeFixes(c.internal)) add('found', 'update', `Plages ${f.label} du contexte ${c.internal.label || c.internal.name}`, `ajouter ${f.add.map(rangeTxt).join(', ')} (actuelles : ${f.current.map(rangeTxt).join(', ') || 'aucune'} ; ${f.missing.length} numéro(s) hors plages)`);
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
  const ocName = `${d.write.clientName || 'Client'} - Appels sortants`;
  if (t.outcalls.some((o) => o.name === ocName)) add('found', 'exists', `Règle « ${ocName} »`);
  else if (!t.trunks.length) add('found', 'conflict', `Règle « ${ocName} » (_X.)`, 'aucun trunk : à créer d\'abord dans le Portal');
  else if (t.outcalls.some((o) => (o.extensions || []).some((e) => e.exten === '_X.'))) add('found', 'conflict', `Règle « ${ocName} » (_X.)`, `une règle prend déjà tous les numéros : « ${t.outcalls.find((o) => (o.extensions || []).some((e) => e.exten === '_X.')).name} »`);
  else add('found', 'create', `Règle « ${ocName} » (_X.) vers le trunk`);
  // Personnes
  const vmIn = new Set(t.voicemails.filter((v) => v.context === c.internal?.name).map((v) => String(v.number)));
  for (const u of d.users.filter((x) => x.mode === 'voicemail')) add('people', vmIn.has(u.n) ? 'exists' : 'create', `Messagerie commune ${u.n} ${userName(u)}`, vmIn.has(u.n) ? 'déjà présente' : '');
  const extIn = new Set(t.extensions.filter((e) => e.context === c.internal?.name).map((e) => e.exten));
  for (const u of imported(d)) {
    const lic = u.sub == null ? 'licence à choisir' : LICENCES[u.sub];
    add('people', extIn.has(u.n) ? 'conflict' : u.sub == null ? 'conflict' : 'create', `Utilisateur ${u.n} ${userName(u)}`, extIn.has(u.n) ? 'numéro déjà pris dans le contexte' : `${lic}, ligne${linesOf(u).length > 1 ? 's' : ''} ${linesText(u)}${u.vm ? ', messagerie' : ''}${u.checked ? '' : ' · non vérifié'}`);
  }
  const macs = new Set(t.devices.map((x) => String(x.mac || '').toLowerCase()));
  for (const dv of (d.devices || []).filter((x) => x.import)) add('people', macs.has(dv.mac.toLowerCase()) ? 'exists' : 'create', `Appareil ${dv.model} ${dv.mac}`, `${macs.has(dv.mac.toLowerCase()) ? 'déjà présent : sera associé' : 'à créer'}${dv.owner ? ` → ligne de ${dv.owner}` : ' (stock)'}`);
  // Routage
  const schedNames = new Set(t.schedules.map((s) => s.name));
  for (const s of d.schedules.filter((x) => d.dids.some((r) => r.import && r.schedule === x.key))) add('routing', schedNames.has(s.name) ? 'exists' : 'create', `Horaire « ${s.name} »`, s.text);
  for (const h of d.hunts.filter((x) => x.target !== 'skip')) {
    const kind = h.target === 'group' ? 'Groupe' : 'File';
    const taken = extIn.has(h.n);
    const members = h.members.filter((n) => userBy(d, n)?.mode === 'user').length;
    add('routing', taken ? 'conflict' : 'create', `${kind} ${h.n} ${h.name}`, taken ? 'numéro déjà pris' : `${members} membre(s)${h.src === 'Queue' && h.target === 'group' ? ' · file 3CX convertie en groupe' : ''}`);
  }
  for (const v of d.ivrs.filter((x) => x.import)) add('routing', 'create', `SVI ${v.n} ${v.name}`, `${v.choices.length} touche(s) · message ${v.prompt || 'aucun'}`);
  const incIn = new Set(t.extensions.filter((e) => e.context === c.incall?.name).map((e) => e.exten));
  for (const r of d.dids.filter((x) => x.import)) add('routing', incIn.has(r.did) ? 'exists' : r.dest.t === 'none' && r.dest.todo ? 'conflict' : 'create', `SDA ${r.did}`, `${incIn.has(r.did) ? 'déjà présente · ' : ''}${destLabel(d, r.dest)}${r.schedule ? ' · avec horaire' : ''}`);
  // Finitions
  const fbUsers = imported(d).filter((u) => Object.values(u.fb).some((x) => x && x.t !== 'none')).length;
  add('finish', fbUsers ? 'create' : 'skip', `Débordements de ${fbUsers} utilisateur(s)`);
  const prof = imported(d).filter((u) => W.m.extensions.find((e) => e.number === u.n)?.currentProfile !== 'Available');
  if (prof.length) add('finish', d.write.keepProfiles ? 'create' : 'skip', `Profil 3CX actuel de ${prof.length} poste(s) repris en renvoi`, prof.map((u) => u.n).join(', '));
  const blf = blfRows(d, W.m).filter((b) => b.ok);
  add('finish', blf.length ? 'create' : 'skip', `${blf.length} touche(s) de fonction`);
  add('finish', W.m.phonebook.length ? 'create' : 'skip', `Annuaire : ${W.m.phonebook.length} contact(s)`);
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
  const blf = blfRows(d, m).filter((b) => !b.ok);
  if (blf.length) add('info', `${blf.length} touche(s) BLF non reprises`, 'Cibles absentes (anciens postes), postes non repris ou doublons.', 'Liste exacte dans l\'onglet Exports (CSV des touches).');
  if (d.dids.some((r) => r.import && [r.holiday, r.closed].some((x) => x?.t === 'sound'))) add('info', 'Message de fermeture des jours fériés', 'Le son du jour férié doit exister dans Wazo, sinon la fermeture n\'a rien à jouer.', 'Fournir les sons (phase musiques), ou viser la messagerie.');
  if (m.ivrs.some((v) => v.system)) add('info', 'SVI internes de 3CX (code PIN, rappel de file)', 'Sans équivalent : non repris.', '—');
  if (m.others.length) add('info', m.others.map((o) => `${o.kind.replace('Extension', '')} ${o.number}`).join(', '), 'Fax, conférence et menu spécial 3CX : non repris à ce stade.', 'À créer à la main si utilisés.');
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
  if (c.internal && rangeFixes(c.internal).length) {
    const id = c.internal.id;
    ops.push({ label: `Plages du contexte ${c.internal.label || c.internal.name} : ${rangeFixes(c.internal).map((f) => `${f.label} + ${f.add.map(rangeTxt).join(', ')}`).join(' ; ')} (PUT /contexts/${id})`, run: async () => {
      // Relu juste avant : on renvoie les plages actuelles + les nouvelles, par type (PUT partiel, liste remplacée).
      const cur = await tapi('GET', `/contexts/${id}`);
      const body = {}; const prev = {};
      for (const f of rangeFixes(cur)) { prev[f.key] = cur[f.key] || []; body[f.key] = [...(cur[f.key] || []).map((r) => ({ start: r.start, end: r.end ?? r.start })), ...f.add]; }
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
  const ocName = `${d.write.clientName || 'Client'} - Appels sortants`;
  const catchAll = t.outcalls.some((o) => (o.extensions || []).some((e) => e.exten === '_X.'));
  if (t.trunks.length && c.outcall && !catchAll && !t.outcalls.some((o) => o.name === ocName)) {
    const trunkId = Number(d.write.trunkId || t.trunks[0].id);
    // Comme Call Flow Manager (audité le 21/10/2026) : règle, extension _X. dans le contexte sortant, association, trunk ; retour arrière si une écriture échoue.
    ops.push({ label: `Règle « ${ocName} » : _X. vers le trunk ${trunkId}`, run: async () => {
      const o = await tapi('POST', '/outcalls', { name: ocName });
      let ext = null;
      try {
        ext = await tapi('POST', '/extensions', { exten: '_X.', context: c.outcall.name });
        await tapi('PUT', `/outcalls/${o.id}/extensions/${ext.id}`, { strip_digits: 0, external_prefix: null, prefix: null, caller_id: null });
        await tapi('PUT', `/outcalls/${o.id}/trunks`, { trunks: [{ id: trunkId }] });
      } catch (e) {
        try { if (ext) { await tapi('DELETE', `/outcalls/${o.id}/extensions/${ext.id}`).catch(() => {}); await tapi('DELETE', `/extensions/${ext.id}`); } } catch { /* */ }
        try { await tapi('DELETE', `/outcalls/${o.id}`); } catch { /* */ }
        throw e;
      }
      return { created: `règle ${o.id}`, undo: { seq: [{ method: 'DELETE', path: `/outcalls/${o.id}/extensions/${ext.id}` }, { method: 'DELETE', path: `/extensions/${ext.id}` }, { method: 'DELETE', path: `/outcalls/${o.id}` }] } };
    } });
  }
  return ops;
}
async function runUndo(u) {
  if (!u) return;
  if (u.seq) { for (const x of u.seq) { try { await runUndo(x); } catch (e) { if (e.status !== 404) throw e; } } return; }
  if (u.api === 'logd') return logd(u.method, u.path, u.body);
  return tapi(u.method, u.path, u.body);
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
const ST = { create: 'à créer', update: 'à modifier', exists: 'déjà présent', conflict: 'à régler', skip: 'rien à faire' };
const PST = { todo: 'À appliquer', done: 'Appliquée', error: 'Interrompue' };
export function wizardTab() {
  const d = W.d; const w = d.write;
  let html = `<div class="titlerow"><h3>Migration dans Wazo</h3>${helpButton('x3w-h', 'Aide : migration')}</div>
    ${helpBox('x3w-h', 'Comme le mode édition de Call Flow Manager : rien n\'est écrit avant « Appliquer ». 1. Préparer relit le tenant ouvert et liste ce qui manque. 2. Le plan est ordonné par l\'outil (chaque objet après ce dont il dépend). 3. Les pertes et écarts disent tout ce qui ne sera pas reproduit à l\'identique ; il faut en prendre connaissance. 4. Appliquer, phase par phase : sauvegarde du tenant avant la première écriture, journal, annulation de la phase.')}
    <div class="card x3w-step"><div class="ms-tools"><label>ID client <input data-w="clientId" value="${esc(w.clientId)}" class="x3-short" placeholder="44150"></label><label>Nom du client <input data-w="clientName" value="${esc(w.clientName)}" class="x3-mail"></label><label>Journal d'appels (j) <input type="number" min="0" max="3650" data-w="cdrDays" value="${esc(w.cdrDays)}" class="x3-short"></label><label>Enregistrements (j) <input type="number" min="0" max="3650" data-w="recordingDays" value="${esc(w.recordingDays)}" class="x3-short"></label></div>
      <p class="small muted">Tenant visé : ${esc(S.base ? new URL(S.base).host : '?')} · ${esc(I.tenant || 'hors portail')}. Noms produits : « ${esc(w.clientName || '<client>')} - Appels sortants », « ${esc(w.clientId || '<ID>')} - Attente », « ${esc(w.clientId || '<ID>')} - Prédécroché ».</p></div>`;
  // 1. Préparer
  html += `<div class="card x3w-step ${W.t ? 'ok' : 'open'}"><div class="x3w-head"><span class="x3w-n">1</span><strong>Préparer</strong><span class="spacer"></span><button data-wact="read" ${W.busy ? 'disabled' : ''} class="${W.t ? '' : 'primary'}">${W.t ? 'Relire le tenant' : 'Lire le tenant'}</button></div>`;
  if (!W.t) html += '<p class="small muted">Lecture seule : l\'outil lit le tenant ouvert et le confronte au brouillon.</p></div>';
  else {
    const pre = prerequisites(W.t);
    html += `<p class="small muted">Lu à ${esc(W.t.at.toLocaleTimeString('fr-FR'))}.</p>${pre.map((p) => `<div class="${p.sev === 'error' ? 'compat blocking' : ['manual', 'warn', 'fix'].includes(p.sev) ? 'warn' : 'x3w-remind small'}"><strong>${esc(p.title)}</strong> : ${esc(p.text)}</div>`).join('')}`;
    if (!W.t.trunks.length) html += trunkHelp();
    else html += `<label class="small">Trunk des appels sortants <select data-w="trunkId">${W.t.trunks.map((t) => `<option value="${t.id}" ${String(w.trunkId) === String(t.id) ? 'selected' : ''}>${esc(t.endpoint_sip?.label || t.endpoint_sip?.name || `Trunk ${t.id}`)}</option>`).join('')}</select></label>`;
    html += '</div>';
    // 2. Plan
    const plan = buildPlan(W.t); const blocked = blockedPhases(pre);
    html += `<div class="card x3w-step ok"><div class="x3w-head"><span class="x3w-n">2</span><strong>Plan de migration</strong><span class="spacer"></span><span class="muted small">ordre calculé par l'outil</span></div>
      ${PHASES.map((p) => phaseBlock(p, plan[p.id], blocked.has(p.id))).join('')}</div>`;
    // 3. Pertes et écarts
    const L = losses();
    html += `<div class="card x3w-step ${w.ackLosses ? 'ok' : 'open'}"><div class="x3w-head"><span class="x3w-n">3</span><strong>Pertes et écarts avant écriture</strong><span class="spacer"></span><span class="muted small">${L.filter((x) => x.sev === 'warn').length} à surveiller, ${L.filter((x) => x.sev === 'info').length} informations</span></div>
      <label class="inline small"><input type="checkbox" data-w="keepProfiles" ${w.keepProfiles ? 'checked' : ''}> Reprendre le profil 3CX actuel des postes absents en renvoi immédiat Wazo</label>
      <div class="x3-edit-wrap x3w-loss"><table class="diff x3-edit"><thead><tr><th>Quoi</th><th>Conséquence</th><th>Parade</th></tr></thead><tbody>${L.map((x) => `<tr class="x3-${x.sev}"><td>${esc(x.what)}</td><td>${esc(x.effect)}</td><td>${esc(x.fix)}</td></tr>`).join('')}</tbody></table></div>
      <label class="inline"><input type="checkbox" data-w="ackLosses" ${w.ackLosses ? 'checked' : ''}> J'ai pris connaissance de ces pertes et écarts</label></div>`;
    // 4. Appliquer
    html += `<div class="card x3w-step ${w.ackLosses ? 'open' : 'locked'}"><div class="x3w-head"><span class="x3w-n">4</span><strong>Appliquer</strong></div>
      ${!w.ackLosses ? '<p class="small muted">Prendre connaissance des pertes et écarts (étape 3) avant d\'écrire.</p>' : ''}
      ${PHASES.map((p) => applyRow(p, blocked.has(p.id))).join('')}
      ${W.msg ? `<div class="${W.msg.bad ? 'compat blocking' : 'mg-allok'}">${esc(W.msg.text)}</div>` : ''}</div>`;
    html += '<div class="card x3w-step later"><div class="x3w-head"><span class="x3w-n">5</span><strong>Contrôle final</strong><span class="spacer"></span><span class="x3w-badge">À venir</span></div><p class="small muted">Après les phases Routage et Finitions : comparaison du parcours de chaque SDA, 3CX ↔ Wazo (ouvert, fermé, férié), et vérifications du paramétrage.</p></div>';
  }
  return html;
}
function trunkHelp() {
  const t = W.m?.trunks?.[0]; const w = W.d.write;
  return `<ol class="small x3w-todo"><li>Portal : Gestion des appels > Interconnexions > Créer, modèle de l'opérateur (${esc(t?.name || 'Unyc')} ; paramètres sur Atlas).</li><li>Nom affiché : « ${esc(w.clientName || '<client>')} - Trunk ${esc(t ? t.name.charAt(0).toUpperCase() + t.name.slice(1) : 'Unyc')} ».</li><li>Serveur proxy : pbx.eqinoxe.com.</li><li>Identifiant et mot de passe du trunk : ceux d'Atlas. Si 3CX utilise encore ce trunk, fausser son mot de passe d'un côté pour éviter un double enregistrement.</li><li>Numéro principal : ${esc(t?.mainNumber || '?')}. Créer, puis « Relire le tenant ».</li></ol>`;
}
function phaseBlock(p, items, blocked) {
  const n = (s) => items.filter((x) => x.status === s).length;
  const sum = ['create', 'update', 'exists', 'conflict'].filter((s) => n(s)).map((s) => `${n(s)} ${ST[s]}`).join(' · ') || 'rien';
  return `<details class="x3w-phase"${p.id === 'found' ? ' open' : ''}><summary><strong>${esc(p.title)}</strong> <span class="muted small">${esc(sum)}${blocked ? ' · bloquée (voir Préparer)' : ''}${p.lot ? ` · écriture au lot ${esc(p.lot)}` : ''}</span></summary>
    <p class="small muted">${esc(p.help)}</p>
    <table class="diff x3-edit x3w-items"><tbody>${items.map((x) => `<tr class="st-${x.status}"><td class="x3w-st">${esc(ST[x.status])}</td><td>${esc(x.label)}</td><td class="muted small">${esc(x.detail || '')}</td></tr>`).join('')}</tbody></table></details>`;
}
function applyRow(p, blocked) {
  const s = ph(p.id);
  const can = !p.lot && W.d.write.ackLosses && !blocked && s.status !== 'done' && !W.busy;
  return `<div class="x3w-apply"><strong>${esc(p.title)}</strong> <span class="x3w-badge ${s.status === 'done' ? 'ok' : ''}">${esc(p.lot ? `lot ${p.lot}` : PST[s.status])}</span>
    <span class="spacer"></span>
    ${p.lot ? '<span class="muted small">écriture à venir</span>' : `<button data-wact="apply" data-p="${p.id}" class="primary" ${can ? '' : 'disabled'}>Appliquer ${esc(p.title.toLowerCase())}</button>${s.undo.length ? `<button data-wact="undo" data-p="${p.id}" class="danger" ${W.busy ? 'disabled' : ''}>Annuler la phase</button>` : ''}`}
    ${s.log.length ? `<details class="small x3w-log"><summary>Journal (${s.log.length})</summary><ul>${s.log.map((l) => `<li>${esc(new Date(l.at).toLocaleString('fr-FR'))} · ${esc(l.text)}</li>`).join('')}</ul></details>` : ''}</div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export async function wizardChange(t) {
  if (!t.dataset.w) return false;
  const k = t.dataset.w;
  W.d.write[k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value.trim();
  // L'option des profils change la liste des pertes : il faut la relire.
  if (k === 'keepProfiles') W.d.write.ackLosses = false;
  save();
  return true;
}
export async function wizardClick(b, rerender) {
  const act = b.dataset.wact;
  if (act === 'read') {
    W.busy = true; rerender();
    try { W.t = await readTenant(); W.msg = null; } catch (e) { toast(`Lecture du tenant impossible : ${e.message}`, 8000); }
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
    return confirmModal(`<h3>Annuler la phase ${esc(p.title)} ?</h3><p class="small">${s.undo.length} écriture(s) défaite(s), dans l'ordre inverse.</p>`, async () => {
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
