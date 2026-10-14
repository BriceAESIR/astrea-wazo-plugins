// Call Flow Manager — modèle du routage (sans DOM). Cadrage :
// astrea-wazo-dev/docs/CALLFLOW-MANAGER.md.
// Vérifié dans le code de wazo-confd master (14/10/2026) :
//  - destination commune (helpers/destination.py) : user (user_id int), group
//    (group_id int, pas l'uuid), queue (queue_id), voicemail, ivr, conference,
//    switchboard (switchboard_uuid), outcall (+exten), extension (exten +
//    context), sound, custom, hangup (cause busy|congestion|normal),
//    application (callback_disa, directory, disa, fax_to_mail, voicemail,
//    custom + application_uuid), none ; aucune destination « schedule » ;
//  - incall : destination, extensions (contexte de type incall), schedules ;
//    aucun lien direct trunk → incall : trunk.context = nom d'un contexte ;
//  - user : fallbacks noanswer|busy|congestion|fail, forwards = numéros en
//    texte libre (pas des destinations), ring_seconds ;
//  - group : fallbacks noanswer|congestion seulement, timeout, user_timeout,
//    retry_delay, ring_strategy ; queue : fallbacks noanswer|busy|congestion|
//    fail + wait_time_destination / wait_ratio_destination ;
//  - ivr : choices[{exten, destination}], timeout|invalid|abort_destination ;
//  - schedule : closed_destination, exceptional_periods[].destination ;
//    associé aux incalls, users, groups, queues, outcalls ;
//  - switchboard : fallbacks noanswer ; outcall : trunks dans l'ordre.
// Supposé, à vérifier en réel : les listes (GET /groups, /queues,
// /switchboards, /schedules) contiennent déjà fallbacks, membres et
// destinations ; sinon on lit le détail de chaque objet (ensureDetails).
import { api, listAll, fullName } from '../common/core.js?v=0.32.0';

export const M = { lists: {}, by: {}, ext: new Map(), extAny: new Map(), rev: null, warns: [] };

// ---------------------------------------------------------------------------
// Catalogue des types de cartes (aide : norme Astrea 3bis)
// ---------------------------------------------------------------------------
export const TYPES = {
  incall: { label: 'SDA', badge: 'SDA', help: 'Numéro entrant (SDA) : appel reçu d\'un opérateur sur un trunk. Il part vers une seule destination ; un horaire associé est vérifié avant (fermé → destination de fermeture).' },
  trunk: { label: 'Trunk', badge: 'TRK', help: 'Liaison opérateur. Les appels entrants arrivent dans le contexte du trunk ; le numéro composé y est cherché parmi les SDA de ce contexte. Wazo n\'a pas de lien direct trunk → SDA : il passe par le contexte.' },
  context: { label: 'Contexte', badge: 'CTX', help: 'Contexte Asterisk : ensemble de numéros joignables. Type incall pour les SDA, internal pour les numéros internes, outcall pour les règles de sortie. Un contexte interne inclut en général le contexte sortant.' },
  user: { label: 'Utilisateur', badge: 'U', help: 'Utilisateur : ses postes sonnent pendant la durée de sonnerie, puis les renvois par défaut (admin) s\'appliquent : pas de réponse, occupé, encombré, indisponible. Les renvois d\'appel (réglés aussi par l\'utilisateur) passent avant : un renvoi inconditionnel actif ne fait pas sonner les postes.' },
  group: { label: 'Groupe', badge: 'GRP', help: 'Groupe d\'appel : fait sonner ses membres selon la stratégie, pendant la durée du groupe, puis part vers le débordement « pas de réponse ». Les renvois par défaut des membres ne s\'appliquent pas dans un groupe (supposé : comportement Wazo habituel, à confirmer).' },
  queue: { label: 'File', badge: 'FILE', help: 'File d\'attente : l\'appelant attend en musique qu\'un membre se libère. Sorties : délai dépassé, seuils d\'attente (temps ou ratio appels/agents) et débordements (occupé, encombré, indisponible).' },
  ivr: { label: 'SVI', badge: 'SVI', help: 'Serveur vocal interactif : joue un message et attend une touche. Chaque touche a sa destination ; sans saisie, saisie invalide et trop d\'essais ont la leur.' },
  schedule: { label: 'Horaire', badge: 'H', help: 'Horaire : vérifié avant l\'objet auquel il est associé (SDA, utilisateur, groupe, file). Hors des plages d\'ouverture, l\'appel part vers la destination de fermeture ; pendant une période exceptionnelle, vers celle de la période.' },
  voicemail: { label: 'Messagerie', badge: 'VM', help: 'Boîte vocale : l\'appelant laisse un message. Fin du parcours.' },
  conference: { label: 'Conférence', badge: 'CONF', help: 'Salle de conférence. Fin du parcours.' },
  switchboard: { label: 'Standard (POPC)', badge: 'POPC', help: 'Standard : l\'appel attend d\'être pris par un standardiste ; sans réponse dans le délai, il part vers le débordement « pas de réponse ».' },
  outcall: { label: 'Sortant', badge: 'OUT', help: 'Règle d\'appel sortant : le numéro part vers l\'extérieur par les trunks, dans l\'ordre (le suivant si le premier échoue).' },
  application: { label: 'Application', badge: 'APP', help: 'Application Wazo (Stasis) : l\'appel est remis à une application externe.' },
  members: { label: 'Membres', badge: '👥', help: 'Membres qui sonnent. Dans un groupe ou une file, ce sont les postes des membres qui sonnent : leurs propres renvois par défaut ne s\'appliquent pas (supposé).' },
  hangup: { label: 'Raccrocher', badge: '✕', help: 'Fin de l\'appel, avec la tonalité choisie : normal, occupé ou encombré.' },
  sound: { label: 'Message', badge: '♪', help: 'Joue un fichier son, puis raccroche (sauf « ne pas décrocher » : le son est joué en pré-décroché).' },
  custom: { label: 'Commande', badge: '{ }', help: 'Commande Asterisk personnalisée (application du dialplan).' },
  extension: { label: 'Numéro', badge: '#', help: 'Numéro composé dans un contexte. Résolu vers l\'objet correspondant quand il est connu ; sinon affiché tel quel.' },
  external: { label: 'Numéro externe', badge: '☎', help: 'Numéro hors de Wazo (renvoi vers un mobile, un autre site…). Le renvoi sort par les règles d\'appel sortant de l\'utilisateur.' },
  app_sub: { label: 'Service', badge: 'SRV', help: 'Service Wazo : annuaire, DISA, rappel DISA, fax vers e-mail, consultation de messagerie.' },
  missing: { label: 'Cible introuvable', badge: '!', help: 'La destination pointe vers un objet introuvable (supprimé, autre tenant, ou droit de lecture manquant).' },
  more: { label: 'Suite', badge: '…', help: 'Branche non dépliée (profondeur maximale). Cliquez pour la déplier.' },
};

// Sorties (ports) : libellé et aide.
export const SLOTS = {
  destination: { label: 'Destination', help: 'Destination de la SDA.' },
  dest_open: { label: 'Si ouvert', help: 'Destination de la SDA pendant les heures d\'ouverture (un horaire est associé).' },
  schedule: { label: 'Horaire', help: 'Horaire vérifié avant de continuer : fermé → destination de fermeture.' },
  fwd_unconditional: { label: 'Renvoi immédiat', help: 'Renvoi inconditionnel (renvoi d\'appel de l\'utilisateur) : actif, les postes ne sonnent pas.' },
  ring: { label: 'Sonne', help: 'Les postes de l\'utilisateur sonnent pendant la durée de sonnerie.' },
  fwd_busy: { label: 'Renvoi si occupé', help: 'Renvoi d\'appel sur occupation (réglé aussi par l\'utilisateur). Passe avant le renvoi par défaut « occupé ».' },
  fwd_noanswer: { label: 'Renvoi si pas de réponse', help: 'Renvoi d\'appel sur non-réponse (réglé aussi par l\'utilisateur). Passe avant le renvoi par défaut « pas de réponse ».' },
  noanswer: { label: 'Pas de réponse', help: 'Débordement après la durée de sonnerie sans réponse.' },
  busy: { label: 'Occupé', help: 'Débordement quand la cible est occupée (appels simultanés atteints, ou file pleine).' },
  congestion: { label: 'Encombré', help: 'Débordement sur encombrement (aucune ressource pour joindre la cible).' },
  fail: { label: 'Indisponible', help: 'Débordement quand la cible ne peut pas être jointe (poste non enregistré, aucun membre…). Stocké « chanunavail » dans Wazo.' },
  vm_assoc: { label: 'Messagerie associée', help: 'Boîte vocale associée à l\'utilisateur. Ce n\'est pas un routage : elle n\'est atteinte que si un renvoi y mène.' },
  members: { label: 'Sonne les membres', help: 'Les membres sonnent selon la stratégie du groupe ou de la file.' },
  wait_time: { label: 'Attente trop longue', help: 'File : l\'appelant part vers cette destination quand le temps d\'attente estimé dépasse le seuil.' },
  wait_ratio: { label: 'Trop d\'appels par agent', help: 'File : l\'appelant part vers cette destination quand le ratio appels en attente / agents dépasse le seuil.' },
  choice: { label: 'Touche', help: 'Touche du SVI composée par l\'appelant.' },
  ivr_timeout: { label: 'Sans saisie', help: 'SVI : aucune touche composée dans le délai.' },
  ivr_invalid: { label: 'Saisie invalide', help: 'SVI : touche qui ne correspond à aucun choix.' },
  ivr_abort: { label: 'Trop d\'essais', help: 'SVI : nombre maximal d\'essais atteint.' },
  closed: { label: 'Fermé', help: 'Horaire : hors des plages d\'ouverture.' },
  exception: { label: 'Exception', help: 'Horaire : période exceptionnelle (jour férié, fermeture…), prioritaire sur les plages d\'ouverture.' },
  context: { label: 'Contexte', help: 'Contexte des appels entrants de ce trunk.' },
  incall: { label: 'SDA', help: 'SDA de ce contexte.' },
  include: { label: 'Inclut', help: 'Contexte inclus : ses numéros sont joignables depuis celui-ci.' },
  trunk: { label: 'Trunk', help: 'Trunk utilisé par la règle sortante, dans l\'ordre.' },
};

export const STRATEGY = { all: 'Tous en même temps', linear: 'Un par un, dans l\'ordre', random: 'Aléatoire', least_recent: 'Le moins récemment appelé', fewest_calls: 'Le moins d\'appels pris', memorized_round_robin: 'Tour de rôle mémorisé', weight_random: 'Aléatoire pondéré', ringall: 'Tous en même temps' };
const HANGUP = { busy: 'occupé', congestion: 'encombré', normal: 'normal' };
const APP_SUB = { callback_disa: 'Rappel DISA', disa: 'DISA', directory: 'Annuaire', fax_to_mail: 'Fax vers e-mail', voicemail: 'Consultation de messagerie', custom: 'Application' };

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
async function lookup(path, what) {
  try { return await listAll(path); } catch (e) { M.warns.push(`${what} indisponibles (${e.status || ''} ${path}) : non affichés.`); console.warn('[astrea]', path, e); return []; }
}
// Utilisateurs par pages de 100 (au-delà, confd charge tout d'un coup).
async function loadUsers() {
  const out = [];
  try {
    for (let off = 0; ; off += 100) {
      const r = await api('GET', `/users?limit=100&offset=${off}&order=firstname&direction=asc`);
      const items = r?.items || [];
      out.push(...items);
      if (items.length < 100 || (Number.isFinite(r?.total) && out.length >= r.total)) return out;
    }
  } catch (e) { M.warns.push(`Utilisateurs indisponibles (${e.status || ''}) : non affichés.`); return out; }
}
// [clé de type, chemin, libellé de l'avertissement, clé d'index]
const SOURCES = [
  ['incall', '/incalls', 'SDA', 'id'], ['group', '/groups', 'Groupes', 'id'], ['queue', '/queues', 'Files', 'id'],
  ['ivr', '/ivr', 'SVI', 'id'], ['schedule', '/schedules', 'Horaires', 'id'], ['voicemail', '/voicemails', 'Messageries', 'id'],
  ['conference', '/conferences', 'Conférences', 'id'], ['switchboard', '/switchboards', 'Standards', 'uuid'], ['context', '/contexts', 'Contextes', 'name'],
  ['trunk', '/trunks', 'Trunks', 'id'], ['outcall', '/outcalls', 'Règles sortantes', 'id'], ['application', '/applications', 'Applications', 'uuid'],
];
export async function loadAll() {
  M.warns = [];
  const [users, ...rest] = await Promise.all([loadUsers(), ...SOURCES.map(([, p, w]) => lookup(p, w))]);
  M.lists = { user: users };
  SOURCES.forEach(([t], i) => (M.lists[t] = rest[i]));
  M.by = {};
  for (const [t, , , k] of [['user', 0, 0, 'id'], ...SOURCES]) M.by[t] = new Map((M.lists[t] || []).map((o) => [String(o[k]), o]));
  // Les groupes sont aussi cherchés par uuid (membres, liens).
  M.groupByUuid = new Map((M.lists.group || []).map((g) => [g.uuid, g]));
  M.userByUuid = new Map(users.map((u) => [u.uuid, u]));
  indexExtensions();
  M.rev = null;
  return M;
}
// Détails absents des listes (supposé) : relus un par un, une seule fois.
const DETAIL = { group: ['fallbacks', (g) => `/groups/${g.uuid}`], queue: ['fallbacks', (q) => `/queues/${q.id}`], switchboard: ['fallbacks', (s) => `/switchboards/${s.uuid}/fallbacks`, true], schedule: ['closed_destination', (s) => `/schedules/${s.id}`], ivr: ['choices', (i) => `/ivr/${i.id}`] };
export async function ensureDetail(type, obj) {
  const d = DETAIL[type];
  if (!d || !obj || obj[d[0]] !== undefined || obj._detail) return;
  obj._detail = true;
  try {
    const r = await api('GET', d[1](obj));
    if (d[2]) obj.fallbacks = r || {}; else Object.assign(obj, r || {});
  } catch (e) { console.warn('[astrea] détail', type, e); }
}
export async function ensureAllDetails() {
  const jobs = [];
  for (const t of Object.keys(DETAIL)) for (const o of M.lists[t] || []) if (o[DETAIL[t][0]] === undefined && !o._detail) jobs.push(() => ensureDetail(t, o));
  if (!jobs.length) return;
  console.info('[astrea] Call Flow : détails lus un par un', jobs.length);
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < jobs.length) await jobs[i++](); }));
}

// Numéros → clé de carte (résolution des destinations « extension » et des renvois).
function indexExtensions() {
  M.ext = new Map(); M.extAny = new Map();
  const ctxType = (name) => M.by.context?.get(name)?.type;
  const add = (exten, context, key) => {
    if (!exten) return;
    M.ext.set(`${exten}@${context || ''}`, key);
    if (ctxType(context) !== 'incall' && !M.extAny.has(exten)) M.extAny.set(exten, key);
  };
  for (const u of M.lists.user || []) for (const l of u.lines || []) for (const e of l.extensions || []) add(e.exten, e.context, `user:${u.id}`);
  for (const t of ['group', 'queue', 'conference', 'incall', 'switchboard']) for (const o of M.lists[t] || []) for (const e of o.extensions || []) add(e.exten, e.context, key(t, o));
}

// ---------------------------------------------------------------------------
// Clés et cartes
// ---------------------------------------------------------------------------
const IDKEY = { switchboard: 'uuid', context: 'name', application: 'uuid' };
export const key = (type, o) => `${type}:${o[IDKEY[type] || 'id']}`;
export function entity(k) {
  const i = k.indexOf(':'); const t = k.slice(0, i), id = k.slice(i + 1);
  return { type: t, id, obj: M.by[t]?.get(id) || null };
}
const firstExten = (o) => o?.extensions?.[0]?.exten || '';
const userExten = (u) => { for (const l of u.lines || []) for (const e of l.extensions || []) if (e.exten) return e.exten; return ''; };
const ctxLabel = (name) => { const c = M.by.context?.get(name); return c ? (c.label || c.name) : (name || ''); };
const sec = (n) => (n || n === 0 ? `${n} s` : '');

// Titre / sous-titre d'une entité (liste de gauche, cartes).
export function describe(type, o) {
  if (!o) return { title: '?', sub: '' };
  switch (type) {
    case 'incall': return { title: firstExten(o) || `SDA #${o.id}`, sub: [o.description, ctxLabel(o.extensions?.[0]?.context)].filter(Boolean).join(' · ') };
    case 'user': return { title: fullName(o) || `#${o.id}`, sub: [userExten(o), o.ring_seconds != null ? `sonne ${o.ring_seconds} s` : '', o.services?.dnd?.enabled ? 'ne pas déranger' : ''].filter(Boolean).join(' · ') };
    case 'group': return { title: o.label || o.name, sub: [firstExten(o), STRATEGY[o.ring_strategy] || o.ring_strategy, o.timeout ? `${o.timeout} s` : ''].filter(Boolean).join(' · ') };
    case 'queue': return { title: o.label || o.name, sub: [firstExten(o), o.timeout ? `délai ${o.timeout} s` : ''].filter(Boolean).join(' · ') };
    case 'ivr': return { title: o.name, sub: [o.description, `${(o.choices || []).length} choix`].filter(Boolean).join(' · ') };
    case 'schedule': return { title: o.name || `Horaire #${o.id}`, sub: [o.enabled === false ? 'désactivé' : '', o.timezone].filter(Boolean).join(' · ') };
    case 'voicemail': return { title: o.name, sub: [o.number, ctxLabel(o.context)].filter(Boolean).join(' · ') };
    case 'conference': return { title: o.name || `#${o.id}`, sub: firstExten(o) };
    case 'switchboard': return { title: o.name, sub: firstExten(o) };
    case 'context': return { title: o.label || o.name, sub: o.type };
    case 'trunk': { const ep = o.endpoint_sip || o.endpoint_iax || o.endpoint_custom || {}; return { title: ep.label || ep.name || ep.interface || `Trunk #${o.id}`, sub: ctxLabel(o.context) }; }
    case 'outcall': return { title: o.name || o.label || `#${o.id}`, sub: (o.extensions || []).map((e) => e.exten).slice(0, 3).join(', ') };
    case 'application': return { title: o.name || o.uuid, sub: '' };
    default: return { title: String(o.name || o.id || ''), sub: '' };
  }
}
export function nodeInfo(k, leaf) {
  if (leaf) return leaf;
  const { type, obj } = entity(k);
  return { type, ...describe(type, obj), obj };
}

// ---------------------------------------------------------------------------
// Destinations → cartes
// ---------------------------------------------------------------------------
// Feuille (fin de parcours, pas d'objet confd) : sa clé est donnée par buildTree.
const leaf = (type, title, sub = '', extra = {}) => ({ key: null, leaf: { type, title, sub, ...extra } });
const target = (t, id) => (M.by[t]?.has(String(id)) ? { key: `${t}:${id}` } : leaf('missing', `${TYPES[t]?.label || t} #${id}`, 'introuvable'));
// Renvoi (numéro libre) : objet interne si le numéro est connu, sinon numéro externe (supposé : même résolution qu'Asterisk).
function numberTarget(num) {
  const k = M.extAny.get(String(num));
  return k ? { key: k, note: 'numéro interne' } : leaf('external', String(num || '?'));
}
export function destTarget(d) {
  if (!d || !d.type || d.type === 'none') return null;
  switch (d.type) {
    case 'user': return target('user', d.user_id);
    case 'group': return target('group', d.group_id);
    case 'queue': return target('queue', d.queue_id);
    case 'voicemail': return target('voicemail', d.voicemail_id);
    case 'ivr': return target('ivr', d.ivr_id);
    case 'conference': return target('conference', d.conference_id);
    case 'switchboard': return target('switchboard', d.switchboard_uuid);
    case 'outcall': return { ...target('outcall', d.outcall_id), note: d.exten ? `compose ${d.exten}` : '' };
    case 'extension': { const k = M.ext.get(`${d.exten}@${d.context}`); return k ? { key: k, note: `via ${d.exten}` } : leaf('extension', d.exten, ctxLabel(d.context)); }
    case 'sound': return leaf('sound', d.filename || '?', [d.skip ? 'interruptible' : '', d.no_answer ? 'sans décrocher' : ''].filter(Boolean).join(' · '));
    case 'custom': return leaf('custom', d.command || '');
    case 'hangup': return leaf('hangup', 'Raccrocher', [HANGUP[d.cause] || d.cause, d.timeout ? `${d.timeout} s` : ''].filter(Boolean).join(' · '));
    case 'application':
      if (d.application === 'custom' && d.application_uuid) return M.by.application?.has(d.application_uuid) ? { key: `application:${d.application_uuid}` } : leaf('application', d.application_name || d.application_uuid);
      return leaf('app_sub', APP_SUB[d.application] || d.application, d.email || ctxLabel(d.context) || '');
    default: return leaf('custom', d.type);
  }
}
// Durée de sonnerie portée par la destination (user, group, queue, switchboard).
const ringNote = (d) => (d?.ring_time ? `sonne ${d.ring_time} s` : '');

// ---------------------------------------------------------------------------
// Sorties d'une carte : [{slot, label, help, dest (confd, pour le lot 2), to:{key, leaf?, note}}]
// to = null : sortie non réglée (affichée avec « Sorties vides »).
// ---------------------------------------------------------------------------
function out(slot, d, extraLabel = '') {
  const t = destTarget(d);
  const note = [extraLabel, t?.note, ringNote(d)].filter(Boolean).join(' · ');
  return { slot, label: SLOTS[slot]?.label || slot, note, help: SLOTS[slot]?.help || '', dest: d || null, to: t };
}
const link = (slot, k, note = '') => ({ slot, label: SLOTS[slot]?.label || slot, note, help: SLOTS[slot]?.help || '', to: { key: k } });
const schedOuts = (o) => (o?.schedules || []).filter((s) => M.by.schedule?.has(String(s.id))).map((s) => link('schedule', `schedule:${s.id}`));
const fb = (o, k) => o?.fallbacks?.[`${k}_destination`];

export function edgesOf(k) {
  const { type, obj: o } = entity(k);
  if (!o) return [];
  switch (type) {
    case 'incall': {
      const sch = schedOuts(o);
      return [...sch, out(sch.length ? 'dest_open' : 'destination', o.destination)];
    }
    case 'user': {
      const f = o.forwards || {};
      const e = [...schedOuts(o)];
      if (f.unconditional?.enabled) e.push({ ...link('fwd_unconditional', ''), to: numberTarget(f.unconditional.destination), note: f.unconditional.destination });
      if (f.busy?.enabled) e.push({ ...link('fwd_busy', ''), to: numberTarget(f.busy.destination), note: f.busy.destination });
      if (f.noanswer?.enabled) e.push({ ...link('fwd_noanswer', ''), to: numberTarget(f.noanswer.destination), note: f.noanswer.destination });
      e.push(out('noanswer', fb(o, 'noanswer'), sec(o.ring_seconds)), out('busy', fb(o, 'busy')), out('congestion', fb(o, 'congestion')), out('fail', fb(o, 'fail')));
      const vmTargeted = e.some((x) => x.to?.key === `voicemail:${o.voicemail?.id}`);
      if (o.voicemail?.id && !vmTargeted && M.by.voicemail?.has(String(o.voicemail.id))) e.push({ ...link('vm_assoc', `voicemail:${o.voicemail.id}`), assoc: true });
      return e;
    }
    case 'group': {
      const mem = members(o.members);
      return [...schedOuts(o),
        { slot: 'members', label: SLOTS.members.label, help: SLOTS.members.help, note: [STRATEGY[o.ring_strategy] || o.ring_strategy, o.user_timeout ? `${o.user_timeout} s chacun` : ''].filter(Boolean).join(' · '), to: leaf('members', `${mem.length} membre${mem.length > 1 ? 's' : ''}`, mem.slice(0, 6).join(', ') + (mem.length > 6 ? ` +${mem.length - 6}` : ''), { names: mem }) },
        out('noanswer', fb(o, 'noanswer'), sec(o.timeout)), out('congestion', fb(o, 'congestion'))];
    }
    case 'queue': {
      const mem = members(o.members);
      return [...schedOuts(o),
        { slot: 'members', label: SLOTS.members.label, help: SLOTS.members.help, note: '', to: leaf('members', `${mem.length} membre${mem.length > 1 ? 's' : ''}`, mem.slice(0, 6).join(', ') + (mem.length > 6 ? ` +${mem.length - 6}` : ''), { names: mem }) },
        out('wait_time', o.wait_time_destination, o.wait_time_threshold != null ? `> ${o.wait_time_threshold} s` : ''),
        out('wait_ratio', o.wait_ratio_destination, o.wait_ratio_threshold != null ? `> ${o.wait_ratio_threshold}` : ''),
        out('noanswer', fb(o, 'noanswer'), sec(o.timeout)), out('busy', fb(o, 'busy')), out('congestion', fb(o, 'congestion')), out('fail', fb(o, 'fail'))];
    }
    case 'ivr':
      return [...(o.choices || []).map((c) => ({ ...out('choice', c.destination), label: `Touche ${c.exten}`, choice: c.exten })),
        out('ivr_timeout', o.timeout_destination, sec(o.timeout)), out('ivr_invalid', o.invalid_destination), out('ivr_abort', o.abort_destination, o.max_tries ? `${o.max_tries} essais` : '')];
    case 'schedule':
      return [out('closed', o.closed_destination), ...(o.exceptional_periods || []).map((p, i) => ({ ...out('exception', p.destination, periodText(p)), label: `Exception ${i + 1}` }))];
    case 'switchboard': return [out('noanswer', fb(o, 'noanswer'), sec(o.timeout))];
    case 'trunk': return o.context && M.by.context?.has(o.context) ? [link('context', `context:${o.context}`)] : [];
    case 'context': {
      const e = [];
      if (o.type === 'incall') for (const ic of M.lists.incall || []) for (const x of ic.extensions || []) if (x.context === o.name) e.push({ ...link('incall', key('incall', ic)), label: x.exten });
      for (const c of o.contexts || []) { const cc = (M.lists.context || []).find((y) => y.id === c.id || y.name === c.name); if (cc) e.push(link('include', key('context', cc))); }
      return e;
    }
    case 'outcall': return (o.trunks || []).map((t, i) => ({ ...link('trunk', `trunk:${t.id}`), label: `Trunk ${i + 1}` })).filter((x) => M.by.trunk?.has(x.to.key.slice(6)));
    default: return [];
  }
}
// Membres (users et extensions ; agents pour les files) → noms.
function members(m) {
  if (!m) return [];
  const users = (m.users || []).map((x) => fullName(x) || fullName(M.userByUuid.get(x.uuid)) || x.uuid);
  const ext = (m.extensions || []).map((x) => x.exten);
  const agents = (m.agents || []).map((a) => `agent ${a.number || a.id}`);
  return [...users, ...ext, ...agents];
}

// ---------------------------------------------------------------------------
// Sens inverse : qui envoie des appels vers une carte
// ---------------------------------------------------------------------------
export function reverseIndex() {
  if (M.rev) return M.rev;
  M.rev = new Map();
  for (const t of ['incall', 'user', 'group', 'queue', 'ivr', 'schedule', 'switchboard', 'trunk', 'context', 'outcall']) {
    for (const o of M.lists[t] || []) {
      const from = key(t, o);
      for (const e of edgesOf(from)) {
        const k = e.to?.key;
        // Règle sortante → trunk et inclusion de contexte : pas des arrivées d'appels entrants.
        if (!k || e.to.leaf || e.assoc || e.slot === 'trunk' || e.slot === 'include') continue;
        if (!M.rev.has(k)) M.rev.set(k, []);
        M.rev.get(k).push({ from, slot: e.slot, label: e.label, note: e.note, help: e.help });
      }
    }
  }
  return M.rev;
}

// ---------------------------------------------------------------------------
// Arbre affiché : chaque carte une seule fois (première rencontre, en largeur) ;
// les autres liens vers elle sont des liens croisés.
// dir 'out' : où vont les appels ; 'in' : qui arrive ici.
// ---------------------------------------------------------------------------
export function buildTree(rootKey, dir, { maxDepth = 8, collapsed = new Set(), expanded = new Set(), showEmpty = false } = {}) {
  const nodes = new Map(); const cross = [];
  const root = { key: rootKey, depth: 0, kids: [], info: nodeInfo(rootKey), ports: [] };
  nodes.set(rootKey, root);
  const queue = [root];
  const rev = dir === 'in' ? reverseIndex() : null;
  while (queue.length) {
    const n = queue.shift();
    const stop = collapsed.has(n.key) || (n.depth >= maxDepth && !expanded.has(n.key));
    if (dir === 'in') {
      // Sens inverse : la sortie est portée par la carte d'origine (à gauche),
      // une par cas (un SVI peut arriver par « Touche 1 » et « Sans saisie »).
      const from = rev.get(n.key) || [];
      if (stop) { n.folded = from.some((r) => r.from !== n.key); continue; }
      from.forEach((r, i) => {
        if (r.from === n.key) return;
        const port = { ...r, id: `${n.key}#${i}`, to: { key: n.key } };
        const p = nodes.get(r.from);
        if (p) { p.ports.push(port); cross.push({ from: n.key, port: port.id, to: r.from, edge: port }); return; }
        const child = { key: r.from, depth: n.depth + 1, kids: [], parent: n.key, port: port.id, edge: port, leaf: null, info: nodeInfo(r.from), ports: [port] };
        nodes.set(r.from, child); n.kids.push(child); queue.push(child);
      });
      continue;
    }
    let edges = n.leaf ? [] : edgesOf(n.key);
    n.ports = edges.filter((e) => e.to || showEmpty).map((e, i) => ({ ...e, id: `${e.slot}#${i}` }));
    edges = n.ports;
    if (stop) { n.folded = edges.some((e) => e.to); continue; }
    for (const e of edges) {
      if (!e.to) continue;
      // Feuille : clé stable (parent + sortie), pour garder sa position.
      const k = e.to.leaf ? `leaf:${n.key}/${e.id}` : e.to.key;
      // Retour sur la carte elle-même (SVI « touche 9 : réécouter ») : pas de lien, une mention.
      if (k === n.key) { e.self = true; continue; }
      if (nodes.has(k)) { cross.push({ from: n.key, port: e.id, to: k, edge: e }); continue; }
      const child = { key: k, depth: n.depth + 1, kids: [], parent: n.key, port: e.id, edge: e, leaf: e.to.leaf || null };
      child.info = e.to.leaf ? { ...e.to.leaf, leafType: true } : nodeInfo(k);
      nodes.set(k, child);
      n.kids.push(child);
      queue.push(child);
    }
  }
  return { root, nodes, cross };
}

// ---------------------------------------------------------------------------
// Fiche (panneau de droite) : [[libellé, valeur, aide?]]
// ---------------------------------------------------------------------------
const DAYS = ['', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
const MONTHS = ['', 'janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
function ranges(arr, names) {
  const v = [...new Set(arr || [])].sort((a, b) => a - b); const out2 = [];
  for (let i = 0; i < v.length; i++) { let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++; out2.push(j > i + 1 ? `${names ? names[v[i]] : v[i]}–${names ? names[v[j]] : v[j]}` : j === i + 1 ? `${names ? names[v[i]] : v[i]}, ${names ? names[v[j]] : v[j]}` : `${names ? names[v[i]] : v[i]}`); i = j; }
  return out2.join(', ');
}
export function periodText(p) {
  if (!p) return '';
  const days = p.week_days?.length && p.week_days.length < 7 ? ranges(p.week_days, DAYS) : '';
  const md = p.month_days?.length && p.month_days.length < 31 ? `le ${ranges(p.month_days)}` : '';
  const mo = p.months?.length && p.months.length < 12 ? ranges(p.months, MONTHS) : '';
  return [days, md, mo, p.hours_start && p.hours_end ? `${p.hours_start}–${p.hours_end}` : ''].filter(Boolean).join(' ');
}
export function facts(k, leafInfo) {
  if (leafInfo) return leafInfo.names ? [['Membres', leafInfo.names.join(', ') || '—']] : [[TYPES[leafInfo.type]?.label || 'Valeur', [leafInfo.title, leafInfo.sub].filter(Boolean).join(' · ')]];
  const { type, obj: o } = entity(k);
  if (!o) return [];
  const f = [];
  const exts = (o.extensions || []).map((e) => `${e.exten}${e.context ? ` (${ctxLabel(e.context)})` : ''}`).join(', ');
  const scheds = (o.schedules || []).map((s) => M.by.schedule?.get(String(s.id))?.name || s.name || `#${s.id}`).join(', ');
  switch (type) {
    case 'incall':
      f.push(['Numéro', exts || '—'], ['Description', o.description], ['Horaire', scheds], ['Message d\'accueil', o.greeting_sound], ['Nom appelant', o.caller_id_mode ? `${o.caller_id_mode} « ${o.caller_id_name || ''} »` : ''], ['Sous-routine', o.preprocess_subroutine]);
      break;
    case 'user': {
      const f2 = o.forwards || {};
      const fw = (x) => (x?.enabled ? `→ ${x.destination || '?'}` : 'non');
      f.push(['Numéros', (o.lines || []).flatMap((l) => (l.extensions || []).map((e) => `${e.exten} (${ctxLabel(e.context)})`)).join(', ') || '—'],
        ['Durée de sonnerie', sec(o.ring_seconds)], ['Appels simultanés', o.simultaneous_calls], ['Messagerie', o.voicemail ? (M.by.voicemail?.get(String(o.voicemail.id))?.number || '') + ' ' + (o.voicemail.name || '') : 'aucune'],
        ['Renvoi immédiat', fw(f2.unconditional)], ['Renvoi si occupé', fw(f2.busy)], ['Renvoi si pas de réponse', fw(f2.noanswer)],
        ['Ne pas déranger', o.services?.dnd?.enabled ? 'oui (les appels ne sonnent pas)' : 'non'], ['Horaire', scheds], ['Sous-routine', o.preprocess_subroutine]);
      break;
    }
    case 'group':
      f.push(['Numéro', exts], ['Nom technique', o.name], ['Stratégie', STRATEGY[o.ring_strategy] || o.ring_strategy], ['Durée du groupe', sec(o.timeout), 'Durée totale de sonnerie du groupe avant le débordement « pas de réponse ».'],
        ['Sonnerie par membre', sec(o.user_timeout), 'Durée de sonnerie de chaque membre (stratégies un par un).'], ['Pause entre tours', sec(o.retry_delay)], ['Appels max', o.max_calls || 'illimité'],
        ['Musique d\'attente', o.music_on_hold], ['Horaire', scheds], ['Membres', members(o.members).join(', ') || '—']);
      break;
    case 'queue':
      f.push(['Numéro', exts], ['Nom technique', o.name], ['Délai', sec(o.timeout)], ['Seuil d\'attente', sec(o.wait_time_threshold)], ['Seuil ratio', o.wait_ratio_threshold],
        ['Musique d\'attente', o.music_on_hold], ['Horaire', scheds], ['Membres', members(o.members).join(', ') || '—']);
      break;
    case 'ivr':
      f.push(['Accueil', o.greeting_sound], ['Menu', o.menu_sound], ['Saisie invalide (son)', o.invalid_sound], ['Abandon (son)', o.abort_sound], ['Délai de saisie', sec(o.timeout)], ['Essais max', o.max_tries],
        ['Choix', (o.choices || []).map((c) => c.exten).join(', ')]);
      break;
    case 'schedule':
      f.push(['Fuseau', o.timezone], ['Actif', o.enabled === false ? 'non' : 'oui'], ['Ouvert', (o.open_periods || []).map(periodText).join(' ; ') || '—'],
        ['Exceptions', (o.exceptional_periods || []).map(periodText).join(' ; ') || '—'],
        ['Utilisé par', ['incalls', 'users', 'groups', 'queues', 'outcalls'].map((x) => (o[x] || []).length).reduce((a, b) => a + b, 0) || '—']);
      break;
    case 'voicemail': f.push(['Numéro', o.number], ['Contexte', ctxLabel(o.context)], ['E-mail', o.email], ['Type', o.accesstype]); break;
    case 'conference': f.push(['Numéro', exts], ['Participants max', o.max_users || '—'], ['Code PIN', o.pin ? 'oui' : 'non']); break;
    case 'switchboard': f.push(['Numéro', exts], ['Délai', sec(o.timeout)]); break;
    case 'context': f.push(['Nom technique', o.name], ['Type', o.type], ['SDA (plages)', (o.incall_ranges || []).map((r) => `${r.start}–${r.end}`).join(', ')], ['Utilisateurs (plages)', (o.user_ranges || []).map((r) => `${r.start}–${r.end}`).join(', ')], ['Inclut', (o.contexts || []).map((c) => c.label || c.name).join(', ')]); break;
    case 'trunk': { const ep = o.endpoint_sip ? 'SIP' : o.endpoint_iax ? 'IAX' : o.endpoint_custom ? 'personnalisé' : '—'; f.push(['Type', ep], ['Contexte', ctxLabel(o.context)], ['Format du numéro présenté', o.outgoing_caller_id_format], ['Règles sortantes', (o.outcalls || []).map((x) => x.name).join(', ')]); break; }
    case 'outcall': f.push(['Motifs', (o.extensions || []).map((e) => `${e.exten}${e.strip_digits ? ` (−${e.strip_digits})` : ''}${e.prefix ? ` (+${e.prefix})` : ''}`).join(', ')], ['Nom appelant interne', o.internal_caller_id ? 'oui' : 'non'], ['Sonnerie', sec(o.ring_time)], ['Actif', o.enabled === false ? 'non' : 'oui']); break;
    default: break;
  }
  return f.filter(([, v]) => v !== undefined && v !== null && v !== '');
}

// Entités listées à gauche, par type.
export function listOf(type) {
  return (M.lists[type] || []).map((o) => ({ key: key(type, o), ...describe(type, o) }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'fr', { numeric: true }));
}
