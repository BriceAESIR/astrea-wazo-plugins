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
import { S, api, listAll, fullName } from '../common/core.js?v=0.40.5';
import { comparePatterns, describePattern, userContext, rightsList, simulate, famLabel } from './dialsim.js?v=0.40.5';

export const M = { lists: {}, by: {}, ext: new Map(), extAny: new Map(), rev: null, warns: [] };

// ---------------------------------------------------------------------------
// Catalogue des types de cartes (aide : norme Astrea 3bis)
// ---------------------------------------------------------------------------
export const TYPES = {
  caller: { label: 'Appelant', badge: 'APP', help: 'Numéro de la personne qui appelle (« Simulation d\'appel »). Wazo route un appel entrant selon le numéro appelé (SDA) et l\'heure ; le numéro de l\'appelant ne compte que pour la liste de blocage des utilisateurs.' },
  incall: { label: 'SDA', badge: 'SDA', help: 'Numéro entrant (SDA) : appel reçu d\'un opérateur sur un trunk. Il part vers une seule destination ; un horaire associé est vérifié avant (fermé → destination de fermeture).' },
  trunk: { label: 'Trunk', badge: 'TRK', help: 'Liaison opérateur. Les appels entrants arrivent dans le contexte du trunk ; le numéro composé y est cherché parmi les SDA de ce contexte. Wazo n\'a pas de lien direct trunk → SDA : il passe par le contexte.' },
  context: { label: 'Contexte', badge: 'CTX', help: 'Contexte Asterisk : ensemble de numéros joignables. Type incall pour les SDA, internal pour les numéros internes, outcall pour les règles de sortie. Un contexte interne inclut en général le contexte sortant.' },
  user: { label: 'Utilisateur', badge: 'U', help: 'Utilisateur : ses postes sonnent pendant la durée de sonnerie, puis les renvois par défaut (admin) s\'appliquent : pas de réponse, occupé, encombré, indisponible. Les renvois d\'appel (réglés aussi par l\'utilisateur) passent avant : un renvoi inconditionnel actif ne fait pas sonner les postes.' },
  group: { label: 'Groupe', badge: 'GRP', help: 'Groupe d\'appel : fait sonner ses membres selon la stratégie, pendant la durée du groupe, puis part vers le débordement « pas de réponse ». Les renvois par défaut des membres ne s\'appliquent pas dans un groupe (supposé : comportement Wazo habituel, à confirmer).' },
  queue: { label: 'File d\'attente', badge: 'FA', help: 'File d\'attente : l\'appelant attend en musique qu\'un membre se libère. Sorties : délai dépassé, seuils d\'attente (temps ou ratio appels/agents) et débordements (occupé, encombré, indisponible).' },
  ivr: { label: 'SVI', badge: 'SVI', help: 'Serveur vocal interactif : joue un message et attend une touche. Chaque touche a sa destination ; sans saisie, saisie invalide et trop d\'essais ont la leur.' },
  schedule: { label: 'Horaire', badge: 'H', help: 'Horaire : condition vérifiée avant l\'objet auquel il est associé (SDA, utilisateur, groupe, file) ; la carte est donc placée devant lui. Ouvert : l\'appel continue vers l\'objet (pour une SDA, vers sa destination). Fermé : destination de fermeture. Fermeture exceptionnelle (prioritaire sur les heures d\'ouverture) : destination propre à cette fermeture.' },
  voicemail: { label: 'Messagerie', badge: 'VM', help: 'Boîte vocale : l\'appelant laisse un message. Fin du parcours.' },
  conference: { label: 'Conférence', badge: 'CONF', help: 'Salle de conférence. Fin du parcours.' },
  switchboard: { label: 'Standard (POPC)', badge: 'POPC', help: 'Standard : l\'appel attend d\'être pris par un standardiste ; sans réponse dans le délai, il part vers le débordement « pas de réponse ».' },
  outcall: { label: 'Sortant', badge: 'OUT', help: 'Règle d\'appel sortant : le numéro part vers l\'extérieur par les trunks, dans l\'ordre (le suivant si le premier échoue).' },
  application: { label: 'Application', badge: 'APP', help: 'Application Wazo (Stasis) : l\'appel est remis à une application externe.' },
  dial: { label: 'Envoi', badge: 'ENV', help: 'Ce qui part vers l\'opérateur pour ce motif : le numéro après transformation (chiffres retirés, préfixe ajouté ; vérifié dans wazo-agid), le numéro présenté, puis les trunks dans l\'ordre (le suivant si le premier échoue).' },
  member: { label: 'Membre', badge: 'M', help: 'Membre du groupe. En NPD, il ne sonne pas et l\'appel n\'est pas renvoyé (vérifié dans le code de Wazo). Les renvois d\'appel, renvois par défaut et le filtrage de l\'utilisateur ne s\'appliquent pas quand il est appelé par un groupe (déduit du dialplan, non testé). Un membre « numéro » qui pointe vers un utilisateur passe en revanche par le traitement normal de l\'utilisateur.' },
  members: { label: 'Membres', badge: 'MBR', help: 'Membres qui sonnent : membres fixes (réglés dans Wazo) et, pour un groupe, utilisateurs inscrits par la touche « bascule groupe » (*50) — ceux-là ne sont connus que d\'Asterisk, lus si le serveur l\'autorise. Ce sont les postes des membres qui sonnent : leurs propres renvois par défaut ne s\'appliquent pas (supposé).' },
  hangup: { label: 'Raccrocher', badge: 'FIN', help: 'Fin de l\'appel, avec la tonalité choisie : normal, occupé ou encombré.' },
  sound: { label: 'Fichier son', badge: 'SON', help: 'Joue un fichier son (sons du tenant ou sons système), puis raccroche (sauf « ne pas décrocher » : le son est joué en pré-décroché).' },
  custom: { label: 'Commande', badge: '{ }', help: 'Commande Asterisk personnalisée (application du dialplan).' },
  extension: { label: 'Numéro', badge: '#', help: 'Numéro composé dans un contexte. Résolu vers l\'objet correspondant quand il est connu ; sinon affiché tel quel.' },
  external: { label: 'Numéro externe', badge: 'EXT', help: 'Numéro hors de Wazo (renvoi vers un mobile, un autre site…). Le renvoi sort par les règles d\'appel sortant de l\'utilisateur.' },
  app_sub: { label: 'Service', badge: 'SRV', help: 'Service Wazo : annuaire, DISA, rappel DISA, fax vers e-mail, consultation de messagerie.' },
  missing: { label: 'Cible introuvable', badge: '!', help: 'La destination pointe vers un objet introuvable (supprimé, autre tenant, ou droit de lecture manquant).' },
  more: { label: 'Suite', badge: '…', help: 'Branche non dépliée (profondeur maximale). Cliquez pour la déplier.' },
};

// Sorties (ports) : libellé et aide.
export const SLOTS = {
  destination: { label: 'Destination', help: 'Destination de la SDA.' },
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
  wait_time: { label: 'Attente trop longue', help: 'File d\'attente : l\'appelant part vers cette destination quand le temps d\'attente estimé dépasse le seuil.' },
  wait_ratio: { label: 'Trop d\'appels par agent', help: 'File d\'attente : l\'appelant part vers cette destination quand le ratio appels en attente / agents dépasse le seuil.' },
  choice: { label: 'Touche', help: 'Touche du SVI composée par l\'appelant.' },
  ivr_timeout: { label: 'Sans saisie', help: 'SVI : aucune touche composée dans le délai.' },
  ivr_invalid: { label: 'Saisie invalide', help: 'SVI : touche qui ne correspond à aucun choix.' },
  ivr_abort: { label: 'Trop d\'essais', help: 'SVI : nombre maximal d\'essais atteint.' },
  open: { label: 'Ouvert', help: 'Horaire : pendant les plages d\'ouverture (et hors fermeture exceptionnelle), l\'appel continue vers l\'objet suivant.' },
  closed: { label: 'Fermé', help: 'Horaire : hors des plages d\'ouverture.' },
  exception: { label: 'Fermeture exceptionnelle', help: 'Horaire : fermeture exceptionnelle (jour férié, congés…), avec sa propre destination ; prioritaire sur les plages d\'ouverture. Tous ses critères doivent être vrais en même temps (jours de la semaine ET jours du mois ET mois ET heures).' },
  context: { label: 'Contexte', help: 'Contexte des appels entrants de ce trunk.' },
  incall: { label: 'SDA', help: 'SDA de ce contexte.' },
  include: { label: 'Inclut', help: 'Contexte inclus : ses numéros sont joignables depuis celui-ci.' },
  trunk: { label: 'Trunk', help: 'Trunk utilisé par la règle sortante, dans l\'ordre.' },
  dial_from: { label: 'Compose depuis', help: 'Contexte de la ligne de l\'utilisateur : c\'est là qu\'Asterisk cherche le numéro composé, puis dans les contextes inclus, dans l\'ordre.' },
  outcall: { label: 'Règle sortante', help: 'Règle sortante dont au moins un motif est déclaré dans ce contexte. Asterisk cherche dans le contexte lui-même (numéro exact d\'abord, puis le motif le plus précis) avant les contextes inclus.' },
  internal: { label: 'Numéro interne', help: 'Le numéro composé existe dans ce contexte (poste, groupe, file…) : l\'appel reste dans Wazo.' },
  internals: { label: 'Numéros internes', help: 'Postes, groupes, files… joignables dans ce contexte. Un numéro exact passe avant tout motif de règle sortante.' },
};

export const STRATEGY = { all: 'Tous en même temps', linear: 'Un par un, dans l\'ordre', random: 'Aléatoire', least_recent: 'Le moins récemment appelé', fewest_calls: 'Le moins d\'appels pris', memorized_round_robin: 'Tour de rôle mémorisé', weight_random: 'Aléatoire pondéré', ringall: 'Tous en même temps' };
const HANGUP = { busy: 'occupé', congestion: 'encombré', normal: 'normal' };
const APP_SUB = { callback_disa: 'Rappel DISA', disa: 'DISA', directory: 'Annuaire', fax_to_mail: 'Fax vers e-mail', voicemail: 'Consultation de messagerie', custom: 'Application' };

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
// Listes qui ne servent qu'aux formulaires de réglage : pas d'avertissement en tête (console seulement).
const QUIET = new Set(['/moh', '/callpermissions', '/agents']);
async function lookup(path, what) {
  try { return await listAll(path); } catch (e) { if (!QUIET.has(path)) M.warns.push(`${what} indisponibles (${e.status || ''} ${path}) : non affichés.`); console.warn('[astrea]', path, e); return []; }
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
  ['incall', '/incalls', 'SDA', 'id'], ['group', '/groups', 'Groupes', 'id'], ['queue', '/queues', 'Files d\'attente', 'id'],
  ['ivr', '/ivr', 'SVI', 'id'], ['schedule', '/schedules', 'Horaires', 'id'], ['voicemail', '/voicemails', 'Messageries', 'id'],
  ['conference', '/conferences', 'Conférences', 'id'], ['switchboard', '/switchboards', 'Standards', 'uuid'], ['context', '/contexts', 'Contextes', 'name'],
  ['trunk', '/trunks', 'Trunks', 'id'], ['outcall', '/outcalls', 'Règles sortantes', 'id'], ['application', '/applications', 'Applications', 'uuid'],
  // Pour le réglage des groupes (lot 2c) : musiques d'attente (clé = name, valeur
  // attendue par confd) et autorisations d'appels.
  ['moh', '/moh', 'Musiques d\'attente', 'name'], ['callpermission', '/callpermissions', 'Autorisations d\'appels', 'id'],
  // Pour le réglage des files (16/10/2026) : agents (noms, ajout de membres).
  ['agent', '/agents', 'Agents', 'id'],
];
// ---------------------------------------------------------------------------
// Tenant (audit du 16/10/2026). Le portail change de tenant tout de suite
// (S.tenant, en-tête Wazo-Tenant) : un appel encore en cours partirait vers le
// nouveau tenant avec les identifiants de l'ancien.
//  - M.tenant = tenant des données chargées ; tapi() refuse tout appel du module
//    (lectures de préparation comprises) si le portail a changé de tenant :
//    l'écriture s'arrête au lieu de viser le nouveau tenant.
//  - un chargement terminé après un changement de tenant est abandonné (stale).
//  - les listes ne gardent que les objets du tenant (listAll lit en recurse=true :
//    un tenant parent verrait sinon les objets de ses sous-tenants).
// ---------------------------------------------------------------------------
export const sameTenant = (t) => S.tenant === t;
export async function tapi(method, path, body) {
  if (M.tenant !== undefined && !sameTenant(M.tenant)) throw Object.assign(new Error('Le tenant a changé dans le portail : opération arrêtée (rien n\'est envoyé vers le nouveau tenant). Rechargez puis recommencez.'), { stale: true });
  return api(method, path, body);
}
const stale = () => Object.assign(new Error('tenant changé pendant le chargement'), { stale: true });
const ownTenant = (t, l) => (l || []).filter((o) => !t || !o?.tenant_uuid || o.tenant_uuid === t);
export async function loadAll() {
  const tenant = S.tenant;
  M.warns = [];
  const [users, ...rest] = await Promise.all([loadUsers(), ...SOURCES.map(([, p, w]) => lookup(p, w))]);
  if (!sameTenant(tenant)) throw stale();
  M.tenant = tenant;
  M.lists = { user: ownTenant(tenant, users) };
  SOURCES.forEach(([t], i) => (M.lists[t] = ownTenant(tenant, rest[i])));
  M.by = {};
  for (const [t, , , k] of [['user', 0, 0, 'id'], ...SOURCES]) M.by[t] = new Map((M.lists[t] || []).map((o) => [String(o[k]), o]));
  // Les groupes sont aussi cherchés par uuid (membres, liens).
  M.groupByUuid = new Map((M.lists.group || []).map((g) => [g.uuid, g]));
  M.userByUuid = new Map(M.lists.user.map((u) => [u.uuid, u]));
  indexExtensions();
  // Caches liés au tenant : remis à zéro (la liste de blocage restait celle du tenant précédent).
  M.rev = null; M.keys = null; M.live = null; M.liveState = ''; M.sounds = null; M.blocklist = undefined;
  return M;
}
// ---------------------------------------------------------------------------
// Opérateur d'un trunk (demande de Brice, 16/10/2026 : « regarde le champ
// template »). Vérifié dans wazo-confd (endpoint_sip/schema.py) : GET
// /endpoints/sip/{uuid} donne `templates` [{uuid, label}] (modèles hérités, ceux
// que pose l'assistant d'interconnexion du portail, supposé) et
// `aor_section_options` (contact sip:hôte). La fiche contient aussi les
// identifiants SIP : seuls les libellés de modèles et l'hôte sont gardés.
// ---------------------------------------------------------------------------
const OPERATORS = [
  ['Phenix Partner', ['phenix']], ['Rubix Telecom', ['rubix']], ['Sewan', ['sewan']], ['SFR Business', ['sfr']], ['SignalWire', ['signalwire']],
  ['Telecom Object', ['telecomobject', 'telecom-object']], ['Telnyx', ['telnyx']], ['Twilio', ['twilio']], ['Unyc', ['unyc']], ['Voice Me Up', ['voicemeup']],
  ['VoIP.ms', ['voipms', 'voip.ms']], ['Waycom', ['waycom']], ['OVHcloud', ['ovh']], ['Keyyo', ['keyyo']], ['Orange', ['orange']], ['Bouygues Telecom', ['bouygues']],
  ['Alphalink', ['alphalink']], ['Axialys', ['axialys']], ['Colt', ['colt']], ['Ipline', ['ipline']], ['Kiwi', ['kiwi']],
];
const GENERIC_TPL = /^(global|default|trunk|webrtc|registration|wazo|template)/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
// Modèles d'opérateurs du portail Wazo (indication de Brice, 16/10/2026) :
// dépôt public wazo-communication/portal-plugins, plugins/sip/list.json
// ({ items: [{ name, slug, logo, mainColor… }] }) — la même liste et les mêmes
// logos que la page « Interconnexions › Créer ». Lue une fois ; sans réseau,
// repli sur la liste OPERATORS (sans logo).
const PROVIDERS_URL = 'https://raw.githubusercontent.com/wazo-communication/portal-plugins/master/plugins/sip/list.json';
export async function loadProviders() {
  if (M.providers) return M.providers;
  try { const r = await fetch(PROVIDERS_URL); M.providers = r.ok ? ((await r.json())?.items || []) : []; } catch (e) { M.providers = []; console.warn('[astrea] modèles d\'opérateurs illisibles', e); }
  return M.providers;
}
// Serveurs déclarés par chaque modèle du portail (indication de Brice,
// 16/10/2026) : plugins/sip/<slug>/endpoint/variables.json, valeurs par défaut
// et choix des variables. Ex. Unyc : domain pbx.vcore.eqinoxe.com ou
// pbx.eqinoxe.com, authentification sippbx.eqinoxe.com. Lus une seule fois, et
// seulement si un trunk n'est pas reconnu autrement.
const PLUGINS_BASE = 'https://raw.githubusercontent.com/wazo-communication/portal-plugins/master/plugins/sip';
async function loadProviderHosts() {
  if (M.providerHosts) return M.providerHosts;
  M.providerHosts = new Map();
  await Promise.all((M.providers || []).filter((p) => /^[a-z0-9_-]+$/i.test(p.slug || '')).map(async (p) => {
    try {
      const r = await fetch(`${PLUGINS_BASE}/${p.slug}/endpoint/variables.json`); if (!r.ok) return;
      for (const x of (await r.json())?.variables || []) for (const v of [x.default, ...(Array.isArray(x.choices) ? x.choices : [])]) {
        if (typeof v === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) M.providerHosts.set(v.toLowerCase(), p);
      }
    } catch { /* modèle illisible : ignoré */ }
  }));
  return M.providerHosts;
}
// Hôte du trunk → modèle du portail : serveur identique, sinon même domaine (eqinoxe.com).
function providerByHost(host) {
  const h = String(host || '').toLowerCase(); if (!h || !M.providerHosts) return null;
  if (M.providerHosts.has(h)) return M.providerHosts.get(h);
  const dom = h.split('.').slice(-2).join('.');
  for (const [k, p] of M.providerHosts) if (k.split('.').slice(-2).join('.') === dom) return p;
  return null;
}
const provOp = (p) => ({ name: p.name, known: true, logo: /^https:\/\/raw\.githubusercontent\.com\/wazo-communication\/portal-plugins\/[A-Za-z0-9_/.-]+\.(png|svg|jpg|jpeg|webp)$/.test(p.logo || '') ? p.logo : null, color: p.mainColor || null });
// Recherche, dans l'ordre : modèles hérités, serveur déclaré par un modèle du
// portail, nom du trunk (trunk créé avec des modèles génériques, retour de
// Brice 16/10/2026), puis nom contenu dans l'hôte.
export function trunkOperator(tplLabels, host, names = []) {
  const h = norm(host);
  const srcs = [tplLabels.map(norm), names.map(norm), [h]];
  const hit = (keys) => srcs.some((src) => src.some((s) => keys.some((k) => s.includes(k))));
  const byHost = providerByHost(host);
  // Liste du portail d'abord : nom ou slug (sans « v1 »).
  for (const [i, src] of srcs.entries()) {
    if (i === 1 && byHost) return provOp(byHost);
    for (const p of M.providers || []) {
      const keys = [norm(p.name), norm(String(p.slug || '').replace(/v\d+$/, ''))].filter((k) => k.length >= 3);
      if (src.some((s) => keys.some((k) => s.includes(k)))) return provOp(p);
    }
  }
  for (const [name, keys] of OPERATORS) if (hit(keys)) return { name, known: true };
  const other = tplLabels.find((l) => l && !GENERIC_TPL.test(l));
  return other ? { name: other, known: false } : host ? { name: host, known: false } : null;
}
export async function loadTrunkOperators() {
  if (!(M.lists.trunk || []).length) return;
  await loadProviders();
  await Promise.all((M.lists.trunk || []).map(async (t) => {
    const uuid = t.endpoint_sip?.uuid; if (!uuid || t.operator !== undefined) return;
    try {
      const ep = await api('GET', `/endpoints/sip/${uuid}`);
      const tpl = (ep?.templates || []).map((x) => x.label).filter(Boolean);
      const contact = (ep?.aor_section_options || []).find(([k]) => k === 'contact')?.[1] || '';
      const host = (contact.match(/^sips?:(?:[^@]*@)?([^:;>]+)/) || [])[1] || '';
      t.sipNames = [t.endpoint_sip?.label, ep?.label].filter(Boolean);
      t.operator = trunkOperator(tpl, host, t.sipNames); t.sipTemplates = tpl; t.sipHost = host;
    } catch (e) { t.operator = null; console.warn('[astrea] trunk', t.id, e); }
  }));
  // Trunk non reconnu (ou reconnu par son seul nom) : serveurs des modèles du portail, puis nouvel essai.
  const redo = (M.lists.trunk || []).filter((t) => t.sipHost && (!t.operator?.known || !t.operator.logo));
  if (!redo.length) return;
  await loadProviderHosts();
  for (const t of redo) t.operator = trunkOperator(t.sipTemplates || [], t.sipHost, t.sipNames || []);
}
// Listes de blocage des utilisateurs (vérifié : wazo-confd user_blocklist,
// GET /users/blocklist/numbers, droit confd.users.blocklist.read ; numéros
// « idéalement » en E.164). Lues une fois, à la première saisie d'un appelant.
// null = illisible (droit refusé ou stack plus ancienne).
export async function loadBlocklist() {
  if (M.blocklist !== undefined) return M.blocklist;
  const tenant = M.tenant;
  let l; try { l = await listAll('/users/blocklist/numbers'); } catch (e) { l = null; console.warn('[astrea] listes de blocage illisibles', e); }
  if (!sameTenant(tenant)) return M.blocklist; // tenant changé pendant la lecture : ignorée
  M.blocklist = l ? ownTenant(tenant, l) : null;
  return M.blocklist;
}
// Numéro français (demande de Brice, 16/10/2026) : les SDA sont souvent saisies en
// E.164 sans « + » (33…), avec (+33…) ou au format national (0…) ; elles sont
// affichées au format national, et la fiche donne aussi l'international et
// l'E.164. Tout le reste (numéros courts de routines, étrangers) : tel quel.
export function frNumber(n) {
  const m = String(n || '').replace(/[\s.-]/g, '').match(/^(?:\+33|0033|33|0)([1-9]\d{8})$/);
  if (!m) return null;
  const d = m[1]; const rest = d.slice(1).match(/.{2}/g).join(' ');
  return { national: `0${d[0]} ${rest}`, international: `+33 ${d[0]} ${rest}`, e164: `+33${d}` };
}
export const showNum = (n) => frNumber(n)?.national || String(n ?? '');
// Forme comparable d'un numéro : chiffres, +33 / 0033 → 0 (France ; supposé pour les autres pays).
export const numKey = (n) => String(n || '').replace(/[^\d+]/g, '').replace(/^(\+|00)33/, '0').replace(/^\+/, '00');
// Jokers dans les champs Appelant / Appelé (demande de Brice, 16/10/2026 : « *7652
// plus pratique que de retrouver la SDA exacte ») : * = n'importe quelle suite,
// ? = un caractère ; comparé au numéro tel quel et à sa forme nationale (+33 / 0033 → 0).
// Pas pour le numéro composé en sortant : là, * est un vrai code de service Wazo.
export const isGlob = (s) => /[*?]/.test(String(s || ''));
export function numMatch(pattern, number) {
  const p = String(pattern || '').replace(/[\s.()-]/g, ''); const n = String(number || '');
  if (!p) return false;
  const forms = [n, numKey(n)];
  if (!isGlob(p)) return forms.includes(p) || forms.includes(numKey(p));
  // Saisie libre : métacaractères échappés, jokers limités (audit : *[ ou *{ faisaient planter le graphe).
  if ((p.match(/\*/g) || []).length > 6) return false;
  let re; try { re = new RegExp(`^${p.replace(/[.^$|()[\]{}\\+]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`); } catch { return false; }
  return forms.some((x) => re.test(x));
}
// Utilisateurs (uuid) qui bloquent cet appelant (jokers acceptés).
export function blockedBy(caller) {
  if (!String(caller || '').trim() || !M.blocklist) return new Map();
  return new Map(M.blocklist.filter((b) => numMatch(caller, b.number)).map((b) => [b.user_uuid, b.label || '']));
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
// Carte horaire « condition » : clé schedule:<id>@<clé de l'objet gardé>.
// Carte répétée (même objet atteint par une autre route) : clé « <clé>~N ».
export const baseKey = (k) => (k || '').replace(/~\d+$/, '');
export function entity(k) {
  k = baseKey(k);
  const i = k.indexOf(':'); const t = k.slice(0, i); let id = k.slice(i + 1), owner = null;
  if (t === 'schedule' && id.includes('@')) { owner = id.slice(id.indexOf('@') + 1); id = id.slice(0, id.indexOf('@')); }
  return { type: t, id, owner, obj: M.by[t]?.get(id) || null };
}
// L'horaire associé à un objet (SDA, utilisateur, groupe, file) est vérifié
// avant lui : la carte horaire s'intercale devant l'objet, avec ses
// embranchements Ouvert (→ l'objet) / Fermé / Exceptions. Supposé : avec
// plusieurs horaires sur un objet, seul le premier compte.
export function gateOf(k) {
  const { type, obj } = entity(k);
  // Règle sortante comprise (retour de Brice, 16/10/2026 : horaire d'outcall invisible, donc non modifiable).
  if (!obj || !['user', 'group', 'queue', 'incall', 'outcall'].includes(type)) return null;
  const s = (obj.schedules || []).find((x) => M.by.schedule?.has(String(x.id)));
  return s ? `schedule:${s.id}@${k}` : null;
}
const gated = (k) => gateOf(k) || k;
const firstExten = (o) => o?.extensions?.[0]?.exten || '';
const userExten = (u) => { for (const l of u.lines || []) for (const e of l.extensions || []) if (e.exten) return e.exten; return ''; };
const ctxLabel = (name) => { const c = M.by.context?.get(name); return c ? (c.label || c.name) : (name || ''); };
const sec = (n) => (n || n === 0 ? `${n} s` : '');
// Délai avant le débordement (distinct de « sonne N s », durée portée par la destination).
const after = (n) => (n ? `après ${n} s` : '');

// Titre / sous-titre d'une entité (liste de gauche, cartes).
export function describe(type, o) {
  if (!o) return { title: '?', sub: '' };
  switch (type) {
    // SDA française affichée au format national ; raw = numéro saisi (recherche).
    case 'incall': return { title: showNum(firstExten(o)) || `SDA #${o.id}`, raw: firstExten(o), sub: [o.description, ctxLabel(o.extensions?.[0]?.context)].filter(Boolean).join(' · ') };
    case 'user': return { title: fullName(o) || `#${o.id}`, sub: [userExten(o), o.ring_seconds != null ? `sonne ${o.ring_seconds} s` : '', o.services?.dnd?.enabled ? 'ne pas déranger' : ''].filter(Boolean).join(' · ') };
    case 'group': return { title: o.label || o.name, sub: [o.enabled === false ? 'désactivé : l\'appel échoue' : '', firstExten(o), STRATEGY[o.ring_strategy] || o.ring_strategy, o.timeout ? `${o.timeout} s` : 'sans limite'].filter(Boolean).join(' · ') };
    case 'queue': return { title: o.label || o.name, sub: [firstExten(o), o.timeout ? `délai ${o.timeout} s` : ''].filter(Boolean).join(' · ') };
    case 'ivr': return { title: o.name, sub: [o.description, `${(o.choices || []).length} choix`].filter(Boolean).join(' · ') };
    case 'schedule': return { title: o.name || `Horaire #${o.id}`, sub: [o.enabled === false ? 'désactivé' : '', o.timezone].filter(Boolean).join(' · ') };
    case 'voicemail': return { title: o.name, sub: [o.number, ctxLabel(o.context)].filter(Boolean).join(' · ') };
    case 'conference': return { title: o.name || `#${o.id}`, sub: firstExten(o) };
    case 'switchboard': return { title: o.name, sub: firstExten(o) };
    case 'context': return { title: o.label || o.name, sub: o.type };
    case 'trunk': { const ep = o.endpoint_sip || o.endpoint_iax || o.endpoint_custom || {}; return { title: ep.label || ep.name || ep.interface || `Trunk #${o.id}`, sub: [o.operator ? `opérateur ${o.operator.name}` : '', ctxLabel(o.context)].filter(Boolean).join(' · ') }; }
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
const target = (t, id) => (M.by[t]?.has(String(id)) ? { key: gated(`${t}:${id}`) } : leaf('missing', `${TYPES[t]?.label || t} #${id}`, 'introuvable'));
// Renvoi (numéro libre) : objet interne si le numéro est connu, sinon numéro externe (supposé : même résolution qu'Asterisk).
// ctx : contexte où le numéro est composé (renvoi : contexte de l'utilisateur renvoyé,
// vérifié dans wazo-agid userfeatures.py, main_extension.context) ; sert à suivre la sortie.
function numberTarget(num, ctx = '') {
  const k = M.extAny.get(String(num));
  return k ? { key: gated(k), note: 'numéro interne' } : leaf('external', num ? showNum(num) : '?', '', { num: String(num || ''), ctx });
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
    case 'schedule': return target('schedule', d.schedule_id); // brouillon d'association (lot 2b), pas une destination confd
    case 'outcall': return { ...target('outcall', d.outcall_id), note: d.exten ? `compose ${d.exten}` : '' };
    case 'extension': { const k = M.ext.get(`${d.exten}@${d.context}`); return k ? { key: k.startsWith('incall:') ? k : gated(k), note: `via ${d.exten}` } : leaf('extension', showNum(d.exten), ctxLabel(d.context), { num: String(d.exten || ''), ctx: d.context }); }
    case 'sound': return leaf('sound', soundName(d.filename) || '?', [d.skip ? 'interruptible' : '', d.no_answer ? 'sans décrocher' : ''].filter(Boolean).join(' · '));
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
// Libellé lisible d'une destination (aperçu avant / après du brouillon).
export function destLabel(d) {
  const t = destTarget(d);
  if (!t) return 'aucune';
  let txt;
  if (t.leaf) txt = t.leaf.type === 'hangup' ? `${t.leaf.title} (${t.leaf.sub})` : `${TYPES[t.leaf.type]?.label || ''} ${t.leaf.title}${t.leaf.sub && t.leaf.type !== 'missing' ? ` (${t.leaf.sub})` : ''}`;
  else { const e = entity(t.key); const k = e.owner || t.key; const i = nodeInfo(k); txt = `${TYPES[i.type]?.label || ''} ${i.title}`; }
  return [txt.trim(), ringNote(d)].filter(Boolean).join(' · ');
}

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
const fb = (o, k) => o?.fallbacks?.[`${k}_destination`];
// Sortie modifiable (lot 2a) : w = adresse d'écriture, voir write.js.
const W = (e, k, id, f) => ({ ...e, w: { k, id, f, key: `${k}:${id}:${f}` } });
const fbOut = (k, id, o, slot, extra) => W(out(slot, fb(o, slot), extra), k, id, slot);

// when (simulation horaire) : sorties d'une carte horaire seulement —
// 'open' (ouvert), 'closed' (fermé, hors exception), 'exc:i' (exception i).
export function edgesOf(k) {
  k = baseKey(k);
  const { type, obj: o, owner } = entity(k);
  if (!o) return [];
  switch (type) {
    case 'incall': {
      // SDA avec horaire : la carte horaire se place entre la SDA et sa destination.
      const g = gateOf(k);
      return [g ? { ...link('destination', g), dest: o.destination } : W(out('destination', o.destination), 'incall', o.id, 'destination')];
    }
    case 'user': {
      const f = o.forwards || {};
      const e = [];
      if (f.unconditional?.enabled) e.push({ ...link('fwd_unconditional', ''), to: numberTarget(f.unconditional.destination, userContext(o)), note: f.unconditional.destination });
      if (f.busy?.enabled) e.push({ ...link('fwd_busy', ''), to: numberTarget(f.busy.destination, userContext(o)), note: f.busy.destination });
      if (f.noanswer?.enabled) e.push({ ...link('fwd_noanswer', ''), to: numberTarget(f.noanswer.destination, userContext(o)), note: f.noanswer.destination });
      e.push(fbOut('user_fb', o.uuid, o, 'noanswer', after(o.ring_seconds)), fbOut('user_fb', o.uuid, o, 'busy'), fbOut('user_fb', o.uuid, o, 'congestion'), fbOut('user_fb', o.uuid, o, 'fail'));
      const vmTargeted = e.some((x) => x.to?.key === `voicemail:${o.voicemail?.id}`);
      if (o.voicemail?.id && !vmTargeted && M.by.voicemail?.has(String(o.voicemail.id))) e.push({ ...link('vm_assoc', `voicemail:${o.voicemail.id}`), assoc: true });
      return e;
    }
    case 'group':
      // Membres affichés selon la stratégie (demande de Brice, 15/10/2026) :
      // éventail de mini-cartes (sonnent ensemble ou une à la fois selon la
      // stratégie) ou chaîne « un par un ». Durée totale vide ou 0 = le groupe
      // sonne indéfiniment (vérifié : Queue() sans timeout, api.yml confd).
      return [
        { slot: 'members', label: SLOTS.members.label, help: SLOTS.members.help, note: [STRATEGY[o.ring_strategy] || o.ring_strategy, o.user_timeout ? `${o.user_timeout} s chacun` : ''].filter(Boolean).join(' · '), to: groupFlow(o), cfg: { k: 'group', id: o.uuid } },
        fbOut('group_fb', o.uuid, o, 'noanswer', o.timeout ? after(o.timeout) : 'jamais : sonne indéfiniment (durée totale vide)'),
        fbOut('group_fb', o.uuid, o, 'congestion', o.max_calls ? `plus de ${o.max_calls} appel${o.max_calls > 1 ? 's' : ''} en cours` : '')];
    case 'queue': {
      return [
        { slot: 'members', label: SLOTS.members.label, help: SLOTS.members.help, note: [QSTRAT[qopt(o, 'strategy') || 'ringall'], `${qopt(o, 'timeout') || 15} s par agent`].join(' · '), to: queueFlow(o), cfg: { k: 'queue', id: o.id } },
        W(out('wait_time', o.wait_time_destination, o.wait_time_threshold != null ? `> ${o.wait_time_threshold} s` : ''), 'queue', o.id, 'wait_time_destination'),
        W(out('wait_ratio', o.wait_ratio_destination, o.wait_ratio_threshold != null ? `> ${o.wait_ratio_threshold}` : ''), 'queue', o.id, 'wait_ratio_destination'),
        fbOut('queue_fb', o.id, o, 'noanswer', after(o.timeout)), fbOut('queue_fb', o.id, o, 'busy'), fbOut('queue_fb', o.id, o, 'congestion'), fbOut('queue_fb', o.id, o, 'fail')];
    }
    case 'ivr':
      return [...(o.choices || []).map((c) => W({ ...out('choice', c.destination), label: `Touche ${c.exten}`, choice: c.exten }, 'ivr_choice', o.id, c.exten)),
        W(out('ivr_timeout', o.timeout_destination, after(o.timeout)), 'ivr', o.id, 'timeout_destination'), W(out('ivr_invalid', o.invalid_destination), 'ivr', o.id, 'invalid_destination'),
        W(out('ivr_abort', o.abort_destination, o.max_tries ? `${o.max_tries} essais` : ''), 'ivr', o.id, 'abort_destination')];
    case 'schedule': {
      // Carte condition (devant un objet) : Ouvert → l'objet (pour une SDA :
      // sa destination). Carte seule (choisie dans la liste) : pas de sortie Ouvert.
      const e = [];
      if (owner) e.push(owner.startsWith('incall:') ? { ...W(out('open', M.by.incall?.get(owner.slice(7))?.destination, periodsText(o)), 'incall', owner.slice(7), 'destination'), when: 'open' } : { ...link('open', owner, periodsText(o)), when: 'open' });
      // Lot 2b : fermé et fermetures exceptionnelles modifiables (PUT /schedules/{id}).
      e.push({ ...W(out('closed', o.closed_destination), 'sched', o.id, 'closed'), when: 'closed' });
      (o.exceptional_periods || []).forEach((p, i) => e.push({ ...W({ ...out('exception', p.destination, periodText(p)), label: `Fermeture exceptionnelle ${i + 1}` }, 'sched_exc', o.id, i), when: `exc:${i}` }));
      // Toutes les sorties d'un horaire ouvrent aussi l'éditeur de ses plages (clic, mode Modifier).
      for (const x of e) x.periods = o.id;
      return e;
    }
    case 'switchboard': return [fbOut('sb_fb', o.uuid, o, 'noanswer', after(o.timeout))];
    case 'trunk': return o.context && M.by.context?.has(o.context) ? [link('context', `context:${o.context}`)] : [];
    case 'context': {
      const e = [];
      if (o.type === 'incall') for (const ic of M.lists.incall || []) for (const x of ic.extensions || []) if (x.context === o.name) e.push({ ...link('incall', key('incall', ic)), label: showNum(x.exten) });
      for (const c of o.contexts || []) { const cc = (M.lists.context || []).find((y) => y.id === c.id || y.name === c.name); if (cc) e.push(link('include', key('context', cc))); }
      return e;
    }
    case 'outcall': {
      // Motifs regroupés par transformation (retour de Brice, 16/10/2026 : une
      // sortie par motif devenait illisible) : une sortie par combinaison
      // chiffres retirés / préfixe ajouté / numéro présenté, qui liste ses
      // familles, ses motifs et sa transformation (numéro envoyé : strip_digits,
      // external_prefix, vérifié dans wazo-agid). Plus de carte « Envoi » (retour
      // de Brice : elle répétait la sortie) : toutes les sorties convergent vers
      // UNE carte du 1er trunk (merge), qui porte « si échec » vers le suivant.
      // L'ordre d'essai entre motifs reste celui d'Asterisk (le plus précis d'abord).
      const trunks = (o.trunks || []).filter((t) => M.by.trunk?.has(String(t.id)));
      const pats = [...(o.extensions || [])].sort((a, b) => comparePatterns(a.exten, b.exten));
      const groups = new Map();
      for (const dp of pats) {
        const k = `${dp.strip_digits || 0}|${dp.external_prefix || ''}|${dp.caller_id || ''}`;
        if (!groups.has(k)) groups.set(k, { dp, list: [] });
        groups.get(k).list.push(dp.exten);
      }
      return [...groups.values()].map(({ dp, list }) => {
        const tr = [dp.strip_digits ? `retire ${dp.strip_digits} chiffre${dp.strip_digits > 1 ? 's' : ''}` : '', dp.external_prefix ? `ajoute ${dp.external_prefix} devant` : ''].filter(Boolean).join(', ');
        const fams = [...new Set(list.map(famLabel))];
        const shown = list.length > 6 ? `${list.slice(0, 6).join(', ')} +${list.length - 6}` : list.join(', ');
        const to = trunks.length ? { key: `trunk:${trunks[0].id}` } : null;
        return { slot: 'pattern', pats: list, merge: true, outTrunks: trunks.slice(1).map((t) => t.id), label: `${fams.join(', ')}`.replace(/^./, (c) => c.toUpperCase()), note: [shown, tr || 'tel quel', dp.caller_id ? `présenté ${dp.caller_id}` : '', trunks.length ? '' : 'aucun trunk : ne sort pas'].filter(Boolean).join(' · '), help: `Motifs qui partent avec la même transformation : ${list.join(', ')}. Règles d'Asterisk : _ = motif, X = 0-9, Z = 1-9, N = 2-9, [1-5] = un chiffre parmi, « . » = un ou plusieurs caractères ; le plus précis est essayé d'abord.`, to, info: !to };
      });
    }
    default: return [];
  }
}
// Sens « Numéros composés » (dir 'dial', demande de Brice 16/10/2026) : depuis
// un utilisateur (contexte de sa ligne) ou un contexte, tout ce par où un
// numéro composé peut passer : numéros internes et règles sortantes du
// contexte, puis contextes inclus, dans l'ordre de recherche d'Asterisk.
// hit = résultat de simulate() : son numéro interne trouvé devient une sortie.
// Qui compose, pour une carte de départ : l'utilisateur lui-même ; pour un
// groupe, son premier membre utilisateur qui a une ligne (les autorisations du
// groupe valent pour ses membres : vérifié, wazo-agid user_set_call_rights).
export function dialUser(k) {
  const { type, obj } = entity(k || '');
  if (type === 'user') return obj;
  if (type === 'group') return groupMemberList(obj).filter((m) => m.kind === 'user').map((m) => M.userByUuid.get(m.uuid)).find((u) => u && userContext(u)) || null;
  return null;
}
// scope : 'int' (interne : sans les règles sortantes) | 'out' (sortant : sans le décompte des numéros internes) | '' (tout).
function dialEdgesOf(k, hit, scope = '') {
  const { type, obj: o } = entity(k);
  if (!o) return [];
  if (type === 'user' || type === 'group') {
    const u = dialUser(k); const c = userContext(u);
    const label = type === 'group' ? `Un membre compose${u ? ` (ex. ${fullName(u)})` : ''}` : 'Compose depuis';
    return c && M.by.context?.has(c) ? [{ ...link('dial_from', `context:${c}`), label, note: ctxLabel(c) }] : [{ slot: 'dial_from', label, note: type === 'group' ? 'aucun membre avec une ligne' : 'aucune ligne : ne peut pas appeler', info: true, to: null }];
  }
  if (type !== 'context') return edgesOf(k);
  const e = [];
  if (hit?.ctx === o.name && hit.key) e.push({ ...link('internal', hit.key.startsWith('incall:') ? hit.key : gated(hit.key)), label: `${hit.number} : numéro interne`, note: 'l\'appel reste dans Wazo' });
  const n = [...M.ext.keys()].filter((x) => x.endsWith(`@${o.name}`) && !M.ext.get(x).startsWith('incall:')).length;
  if (n && scope !== 'out') e.push({ ...link('internals', ''), to: null, info: true, note: `${n} dans ce contexte` });
  if (scope !== 'int') for (const oc of M.lists.outcall || []) {
    const pats = (oc.extensions || []).filter((x) => x.context === o.name).map((x) => x.exten);
    if (pats.length) e.push({ ...link('outcall', gated(key('outcall', oc))), label: `Règle ${oc.name || oc.label || oc.id}`, note: pats.join(', ') });
  }
  for (const c of o.contexts || []) { const cc = (M.lists.context || []).find((y) => y.id === c.id || y.name === c.name); if (cc) e.push({ ...link('include', key('context', cc)), note: cc.label || cc.name }); }
  return e;
}

// Membres (users et extensions ; agents pour les files) → noms.
function members(m) {
  if (!m) return [];
  const users = (m.users || []).map((x) => fullName(x) || fullName(M.userByUuid.get(x.uuid)) || x.uuid);
  const ext = (m.extensions || []).map((x) => x.exten);
  const agents = (m.agents || []).map((a) => `agent ${a.number || a.id}`);
  return [...users, ...ext, ...agents];
}
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
// Membres d'un groupe, dans l'ordre de sonnerie : utilisateurs fixes (par
// priorité), puis numéros (vérifié : en linéaire l'agid fait les utilisateurs
// puis les extensions), puis inscrits par touche (Asterisk, si lisibles).
// NPD : le membre ne sonne pas et l'appel n'est pas renvoyé (vérifié :
// linear_group_get_interfaces le saute ; avec Queue(), wazo-calld le met en
// pause). Les renvois et débordements de l'utilisateur ne s'appliquent pas
// dans un groupe (déduit du dialplan usersharedlines, non testé).
export function groupMemberList(o) {
  const out = [];
  const users = [...(o.members?.users || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const m of users) {
    const u = M.userByUuid.get(m.uuid);
    out.push({ kind: 'user', uuid: m.uuid, name: fullName(m) || fullName(u) || m.uuid, exten: u ? userExten(u) : '', dnd: !!u?.services?.dnd?.enabled });
  }
  for (const m of [...(o.members?.extensions || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) {
    out.push({ kind: 'ext', exten: m.exten, context: m.context, name: `Numéro ${m.exten}` });
  }
  const fixedUuids = new Set(users.map((m) => m.uuid));
  for (const x of (M.live?.get(o.name) || []).filter((y) => y.dynamic && !fixedUuids.has(y.uuid))) {
    const u = x.uuid && M.userByUuid.get(x.uuid);
    out.push({ kind: 'live', uuid: x.uuid, name: x.name, unknown: x.unknown, state: x.state, dnd: !!u?.services?.dnd?.enabled });
  }
  return out;
}
const ORDER = { random: 'un à la fois, au hasard', least_recent: 'un à la fois, le moins récemment appelé d\'abord', fewest_calls: 'un à la fois, celui qui a pris le moins d\'appels', memorized_round_robin: 'un à la fois, à tour de rôle', weight_random: 'un à la fois, au hasard pondéré' };
// Durée d'un tour complet en stratégie « un par un » : chaque membre sonne
// user_timeout puis la pause retry_delay (dialplan group-linear). Au-delà, le
// premier membre resonne. NPD exclus du calcul par l'appelant s'il le souhaite.
export const linearRound = (n, ut, rd) => (n > 0 ? n * ((ut ?? 15) + (rd ?? 0)) : 0);
const STRAT_HELP_SHORT = {
  random: 'Asterisk choisit un membre au hasard, le fait sonner, puis un autre s\'il ne répond pas.',
  least_recent: 'Asterisk fait sonner d\'abord le membre qui a raccroché depuis le plus longtemps.',
  fewest_calls: 'Asterisk fait sonner d\'abord le membre qui a pris le moins d\'appels de ce groupe.',
  memorized_round_robin: 'À tour de rôle : Asterisk reprend après le dernier membre qui a répondu.',
  weight_random: 'Au hasard, pondéré par les pénalités des membres.',
};
// Carte « membres » : « un par un » = chaîne de mini-cartes ; « tous » =
// éventail de mini-cartes ; autres stratégies = un bloc qui liste les membres.
function groupFlow(o) {
  const hub = membersLeaf('group', o);
  const list = groupMemberList(o);
  const ut = o.user_timeout, rd = o.retry_delay;
  const gk = `group:${o.id}`;
  const badge = (m) => [m.kind === 'live' ? 'inscrit par touche' : '', m.kind === 'ext' ? 'numéro' : '', m.dnd ? 'NPD : ne sonne pas' : '', m.unknown ? 'utilisateur inconnu' : '', m.exten && m.kind === 'user' ? m.exten : ''].filter(Boolean).join(' · ');
  const card = (m, extra = {}) => leaf('member', m.name.replace(/^Numéro /, ''), badge(m), { dnd: m.dnd, live: m.kind === 'live', group: gk, member: m, ...extra });
  if (!list.length) return hub;
  if (o.ring_strategy === 'linear') {
    // Chaîne : membre 1 → (sonnerie, puis pause) membre 2 → … → nouveau tour.
    // Vérifié (dialplan extensions_lib_group.conf, group-linear) : Wait(retry)
    // après CHAQUE membre, pas seulement entre deux tours ; un membre en NPD
    // est retiré de la liste (ni sonnerie ni pause).
    let next = null;
    const step = `sinon, après ${ut ?? '?'} s${rd ? ` + pause ${rd} s` : ''}`;
    // Inscrits par touche : absents de la chaîne. linear_group_get_interfaces lit
    // les membres dans la base (user_queue_members, extension_queue_members),
    // or ces inscriptions n'existent que dans Asterisk (déduit, non testé).
    const chain = list.filter((m) => m.kind !== 'live');
    const liveN = list.length - chain.length;
    for (let i = chain.length - 1; i >= 0; i--) {
      const m = chain[i]; const last = i === chain.length - 1;
      const c = card(m, { last, order: i + 1 });
      c.leaf.title = `${i + 1} · ${c.leaf.title}`;
      c.leaf.edges = last
        ? [{ slot: 'retry', label: `↺ ${rd ? `pause ${rd} s, puis ` : ''}nouveau tour`, note: o.timeout ? `jusqu'à ${o.timeout} s au total` : 'sans fin (durée totale vide)', help: 'Après le dernier membre (et sa pause), le groupe recommence au premier, jusqu\'à la durée totale du groupe.', to: null, info: true }]
        : [{ slot: 'next', label: m.dnd ? 'NPD : sauté' : step, help: 'Si ce membre ne répond pas pendant sa durée de sonnerie, le groupe attend la pause de réessai puis fait sonner le membre suivant.', to: next }];
      next = c;
    }
    const tour = linearRound(chain.length, ut, rd);
    hub.leaf.edges = [{ slot: 'first', label: 'Un par un, dans l\'ordre', note: `${ut ?? '?'} s chacun${rd ? ` + ${rd} s de pause` : ''}${tour ? ` · un tour ≈ ${tour} s` : ''}`, help: 'Stratégie linéaire : les membres sonnent l\'un après l\'autre, dans l\'ordre (utilisateurs puis numéros), avec la pause de réessai après chacun.', to: next },
      ...(liveN ? [{ slot: 'live', label: `${liveN} inscrit${liveN > 1 ? 's' : ''} par touche : non appelé${liveN > 1 ? 's' : ''}`, note: 'en « un par un »', help: 'La stratégie « un par un » de Wazo lit les membres dans sa base ; les inscriptions par touche de bascule n\'existent que dans Asterisk, elles ne sont donc pas appelées (déduit du code de wazo-agid, non testé).', to: null, info: true }] : [])];
  } else if (o.ring_strategy === 'all' || !o.ring_strategy) {
    // Éventail : tous sonnent ensemble, une mini-carte par membre.
    const how = 'sonnent ensemble';
    hub.leaf.edges = list.map((m) => ({ slot: 'member', label: m.name, note: m.dnd ? 'NPD : ne sonne pas' : `${ut ?? '?'} s`, help: `Membre du groupe (${how}).`, to: card(m, { fan: true }) }));
    hub.leaf.how = how;
  } else {
    // Autres stratégies (un à la fois, ordre choisi par Asterisk) : un seul
    // bloc qui contient les membres, sans mini-cartes (demande de Brice).
    const how = ORDER[o.ring_strategy] || o.ring_strategy;
    hub.leaf.edges = [
      { slot: 'pick', label: `${how[0].toUpperCase()}${how.slice(1)}`, note: `${ut ?? '?'} s chacun, puis un autre${rd ? ` · pause ${rd} s entre deux tours` : ''}`, help: STRAT_HELP_SHORT[o.ring_strategy] || '', to: null, info: true },
      ...list.map((m) => ({ slot: 'member', label: m.name, note: badge(m) || (m.kind === 'user' ? 'membre' : ''), help: m.dnd ? 'En NPD : ce membre ne sonne pas, l\'appel n\'est pas renvoyé.' : `Membre du groupe (${how}).`, to: null, info: true, npd: m.dnd })),
    ];
    hub.leaf.how = how;
  }
  hub.leaf.sub = [o.ring_strategy === 'linear' ? 'un par un' : hub.leaf.how, hub.leaf.sub].filter(Boolean).join(' — ');
  return hub;
}
// ---------------------------------------------------------------------------
// Files d'attente (16/10/2026). Stratégie et durées = options Asterisk de la
// file (`options`, paires [clé, valeur] ; vérifié dans xivo-dao : défauts
// strategy ringall, timeout 15, retry 5). Affichage : un bloc qui liste les
// membres (agents avec leur pénalité, puis utilisateurs), avec la règle en tête.
// ---------------------------------------------------------------------------
export const QSTRAT = {
  ringall: 'Tous en même temps', linear: 'Un par un, dans l\'ordre', rrordered: 'Tour de rôle, dans l\'ordre', rrmemory: 'Tour de rôle mémorisé',
  leastrecent: 'Le moins récemment appelé', fewestcalls: 'Le moins d\'appels pris', random: 'Aléatoire', wrandom: 'Aléatoire pondéré (pénalités)',
};
export const qopt = (o, k) => (o?.options || []).find(([x]) => x === k)?.[1] ?? null;
function queueFlow(o) {
  const hub = membersLeaf('queue', o);
  const strat = qopt(o, 'strategy') || 'ringall';
  const ut = Number(qopt(o, 'timeout') ?? 15), rd = Number(qopt(o, 'retry') ?? 5);
  const agents = [...(o.members?.agents || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const users = [...(o.members?.users || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const rows = [
    ...agents.map((a) => ({ slot: 'member', label: [fullName(a), a.number ? `agent ${a.number}` : ''].filter(Boolean).join(' · ') || `agent #${a.id}`, note: `pénalité ${a.penalty ?? 0}`, help: 'Agent membre de la file : il ne reçoit les appels que s\'il est connecté (logué).', to: null, info: true })),
    ...users.map((m) => { const u = M.userByUuid.get(m.uuid); const dnd = !!u?.services?.dnd?.enabled; return { slot: 'member', label: fullName(m) || fullName(u) || m.uuid, note: dnd ? 'NPD : en pause' : 'utilisateur', help: dnd ? 'En NPD : wazo-calld met ce membre en pause dans la file.' : 'Utilisateur membre direct de la file.', to: null, info: true, npd: dnd }; }),
  ];
  hub.leaf.edges = [{ slot: 'pick', label: QSTRAT[strat] || strat, note: `${ut} s par agent${rd ? `, pause ${rd} s` : ''}${o.timeout ? ` · ${o.timeout} s au total` : ' · sans limite'}`, help: 'Règle de distribution de la file (option Asterisk strategy) ; sonnerie par agent = option timeout ; pause = option retry.', to: null, info: true }, ...rows];
  hub.leaf.how = QSTRAT[strat] || strat;
  hub.leaf.sub = [hub.leaf.how, hub.leaf.sub].filter(Boolean).join(' — ');
  return hub;
}
// Carte « membres » : fixes (confd), inscrits en ce moment (Asterisk, si
// lisible) et, pour un groupe, utilisateurs qui ont une touche de bascule.
function membersLeaf(type, o) {
  const fixed = members(o.members);
  const live = M.live?.get(o.name);
  const dyn = (live || []).filter((x) => x.dynamic);
  const keys = type === 'group' ? M.keys?.get(o.id) : null;
  const parts = [plural(fixed.length, 'fixe')];
  if (live) parts.push(`${dyn.length} ${type === 'queue' ? 'connecté' : 'inscrit'}${dyn.length > 1 ? 's' : ''}`);
  else if (keys) parts.push(`${keys.length} par touche`);
  const few = (arr) => arr.slice(0, 4).join(', ') + (arr.length > 4 ? ` +${arr.length - 4}` : '');
  const sub = [few(fixed)];
  const ghosts = dyn.filter((x) => x.unknown);
  if (dyn.length > ghosts.length) sub.push(`inscrits : ${few(dyn.filter((x) => !x.unknown).map((x) => x.name))}`);
  if (ghosts.length) sub.push(`Attention : ${plural(ghosts.length, 'inscrit')} inconnu${ghosts.length > 1 ? 's' : ''} (utilisateur supprimé ?)`);
  // Inscrits non lisibles (amid refusé) : on montre les membres possibles
  // (touche de bascule), sans savoir s'ils sont inscrits en ce moment.
  if (!live && keys?.length) sub.push(`bascule : ${few([...new Set(keys.map((k) => k.name))])} (inscrits ou non)`);
  else if (!live && keys) sub.push('aucune touche de bascule');
  else if (!live && type === 'group') sub.push('inscrits par touche : non lisibles');
  return leaf('members', parts.join(' · '), sub.filter(Boolean).join(' — '), { names: fixed, live: live || null, keys: keys || null, ownerType: type });
}

// ---------------------------------------------------------------------------
// Membres inscrits en ce moment (touche « bascule groupe » *50/*51/*52, agents
// connectés). Vérifié dans wazo-agid (modules/group_member.py) : la touche
// fait AddQueueMember(group.name, Local/<uuid>@usersharedlines) dans
// Asterisk, sans rien écrire en base : confd ne les voit pas. Lecture REST :
// wazo-amid POST /1.0/action/QueueStatus {"Queue": <group.name>} (ACL
// amid.action.QueueStatus.create). Le code exige un token du tenant master
// (@required_master_tenant), mais le token du portail de Brice est accepté
// (200, testé en réel le 14/10/2026) quand on n'envoie PAS Wazo-Tenant (CORS).
// Sans "Queue", amid renvoie les files de tous les tenants : une requête par file.
// Réponse vérifiée en réel : messages AMI en JSON, QueueMember avec Name,
// Location (Local/<uuid>@usersharedlines), StateInterface, Membership
// (dynamic | static), Status (1 = libre…), Paused, LoginTime, CallsTaken.
// ---------------------------------------------------------------------------
const DEVSTATE = { 1: 'libre', 2: 'en ligne', 3: 'occupé', 4: 'invalide', 5: 'indisponible', 6: 'sonne', 7: 'sonne', 8: 'en attente' };
const since = (t) => { const d = new Date(Number(t) * 1000); return Number(t) > 0 ? `inscrit le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : ''; };
async function queueStatus(name) {
  // Pas de Wazo-Tenant : amid ne l'autorise pas en CORS (Access-Control-Allow-Headers),
  // le navigateur bloque alors la requête (« Failed to fetch », vérifié en réel le 14/10/2026).
  const r = await fetch(`${S.base}/api/amid/1.0/action/QueueStatus`, { method: 'POST', headers: { 'X-Auth-Token': S.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ Queue: name }) });
  if (!r.ok) { const e = new Error(r.status === 401 || r.status === 403 ? `refusé par le serveur (${r.status}) : l'API Asterisk (amid) exige un token du tenant principal` : `erreur ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
export async function loadLiveMembers() {
  const tenant = M.tenant; // résultat ignoré si le tenant change pendant la lecture
  M.live = null; M.liveState = '';
  const names = [...(M.lists.group || []), ...(M.lists.queue || [])].map((x) => x.name).filter(Boolean);
  if (!names.length) return;
  const live = new Map();
  try {
    // Une requête par groupe / file du tenant (4 à la fois) : jamais les queues des autres tenants.
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < names.length) {
        const q = names[i++];
        const msgs = await queueStatus(q);
        const list = [];
        for (const m of Array.isArray(msgs) ? msgs : []) {
          if (m?.Event !== 'QueueMember' || m.Queue !== q) continue;
          const itf = m.Location || m.Interface || m.Name || m.StateInterface || '';
          const u = itf.match(/([0-9a-f]{8}-[0-9a-f-]{27})@usersharedlines/i);
          const a = itf.match(/Local\/id-(\d+)@agentcallback/i);
          const user = u ? M.userByUuid.get(u[1]) : null;
          const name = user ? fullName(user) : a ? `agent ${a[1]}` : (m.MemberName || itf);
          const st = [DEVSTATE[m.Status] || '', m.Paused === '1' || m.Paused === true ? 'en pause' : '', String(m.Membership).toLowerCase() === 'dynamic' ? since(m.LoginTime) : ''].filter(Boolean).join(', ');
          list.push({ name, uuid: u?.[1] || null, itf, queue: q, unknown: !!u && !user, dynamic: String(m.Membership || '').toLowerCase() === 'dynamic', state: st, calls: Number(m.CallsTaken) || 0 });
        }
        live.set(q, list);
      }
    }));
    // Inscrit dont l'uuid n'est pas un utilisateur du tenant : relu dans confd.
    // 404 = utilisateur supprimé (membre fantôme gardé par l'astdb d'Asterisk,
    // persistentmembers = yes) ou utilisateur d'un autre tenant (constaté sur
    // g_chaumes le 14/10/2026, cause à confirmer).
    for (const x of [...live.values()].flat().filter((y) => y.unknown)) {
      try { const usr = await api('GET', `/users/${x.uuid}`); if (usr) { x.name = fullName(usr); x.unknown = false; } } catch { /* introuvable */ }
      if (x.unknown) x.name = `inscrit inconnu (${x.uuid.slice(0, 8)}…)`;
    }
    if (!sameTenant(tenant)) return;
    M.live = live; M.liveState = 'ok';
    console.info('[astrea] Call Flow : membres en direct (amid QueueStatus)', M.live);
  } catch (e) { M.liveState = e.status ? e.message : `indisponible (${e.message})`; console.info('[astrea] amid QueueStatus :', M.liveState, e); }
}

// Fichiers son (menu des destinations « Fichier son »). Vérifié dans
// wazo-confd plugins/sound (service.py, storage.py, master) : GET /sounds
// liste les catégories du tenant + « system » (sons Asterisk, via ARI) ;
// GET /sounds/{catégorie} donne files[].formats[].path, SANS extension
// (/var/lib/wazo/sounds/tenants/<tenant>/<catégorie>/<fichier>) : c'est la
// valeur à mettre dans destination.filename ; un son système se désigne par
// son nom (ex. agent-alreadylogged, vu en réel). Chargé une fois, à la demande.
// Renvoie [{ category, system, files: [{ label, value }] }].
export async function loadSounds() {
  if (M.sounds) return M.sounds;
  const out = [];
  try {
    const cats = await listAll('/sounds');
    const tenant = cats.filter((c) => c.name !== 'system'), sys = cats.find((c) => c.name === 'system');
    for (const c of [...tenant, ...(sys ? [sys] : [])]) {
      try {
        const d = await api('GET', `/sounds/${encodeURIComponent(c.name)}`);
        const files = (d?.files || []).map((f) => ({ label: f.name, value: c.name === 'system' ? f.name : (f.formats || []).find((x) => x.path)?.path || f.name }));
        if (files.length) out.push({ category: c.name, system: c.name === 'system', files: files.sort((a, b) => a.label.localeCompare(b.label, 'fr')) });
      } catch (e) { console.warn('[astrea] sons', c.name, e); }
    }
  } catch (e) { console.warn('[astrea] sons', e); }
  M.sounds = out;
  return out;
}
// Libellé lisible d'un fichier son (destination) : nom du fichier, sans le chemin du tenant.
export const soundName = (filename) => String(filename || '').split('/').pop();

// Utilisateurs qui ont une touche « membre de groupe » (funckey confd type
// groupmember, group_id entier, action join|leave|toggle ; vérifié dans
// wazo-confd func_key/schema.py). Une lecture par utilisateur : à la demande.
export async function scanGroupKeys(onProgress) {
  const tenant = M.tenant;
  const users = M.lists.user || [];
  const keys = new Map();
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < users.length) {
      const u = users[i++];
      try {
        const r = await api('GET', `/users/${u.uuid}/funckeys`);
        for (const [pos, k] of Object.entries(r?.keys || {})) {
          const d = k?.destination;
          if (d?.type !== 'groupmember') continue;
          if (!keys.has(d.group_id)) keys.set(d.group_id, []);
          keys.get(d.group_id).push({ uuid: u.uuid, name: fullName(u), action: d.action, pos });
        }
      } catch (e) { console.warn('[astrea] touches', u.uuid, e); }
      onProgress?.(++done, users.length);
    }
  }));
  if (sameTenant(tenant)) M.keys = keys;
}

// ---------------------------------------------------------------------------
// Sens inverse : qui envoie des appels vers une carte
// ---------------------------------------------------------------------------
export function reverseIndex() {
  if (M.rev) return M.rev;
  M.rev = new Map();
  const froms = [];
  for (const t of ['incall', 'user', 'group', 'queue', 'ivr', 'switchboard', 'trunk', 'context', 'outcall']) {
    for (const o of M.lists[t] || []) { const k = key(t, o); froms.push(k); const g = gateOf(k); if (g) froms.push(g); }
  }
  for (const from of froms) {
    for (const e of edgesOf(from)) {
      const k = e.to?.key;
      // Règle sortante → trunk et inclusion de contexte : pas des arrivées d'appels entrants.
      if (!k || e.to.leaf || e.assoc || e.slot === 'trunk' || e.slot === 'include') continue;
      if (!M.rev.has(k)) M.rev.set(k, []);
      M.rev.get(k).push({ from, slot: e.slot, label: e.label, note: e.note, help: e.help });
    }
  }
  return M.rev;
}

// ---------------------------------------------------------------------------
// Arbre affiché, en largeur. Un objet atteint par une autre route est répété
// (clé « ~N ») ; seul un retour vers un objet déjà sur le chemin (boucle) est
// un lien croisé en pointillé.
// dir 'out' : où vont les appels ; 'in' : qui arrive ici.
// ---------------------------------------------------------------------------
// Comment un appel extérieur arrive jusqu'à un objet (simulation, départ
// utilisateur, groupe, SVI… ; demande de Brice, 16/10/2026) : pour chaque SDA,
// le plus court chemin par les sorties réelles (toutes heures confondues :
// l'horaire est vérifié ensuite par la simulation) jusqu'à la carte de départ
// (son horaire compris). Un utilisateur est aussi atteint comme membre d'un
// groupe ou d'une file. → [{ sda, exten, steps: [{ key, edge }] }], plus court d'abord.
export function entryChains(target) {
  const T = gated(baseKey(target)); const tObj = entity(baseKey(target));
  const isMember = (k) => {
    if (tObj.type !== 'user' || !tObj.obj) return false;
    const { type, obj } = entity(k);
    if (type === 'group') return groupMemberList(obj).some((m) => m.uuid === tObj.obj.uuid);
    if (type === 'queue') return (obj.members?.users || []).some((m) => m.uuid === tObj.obj.uuid);
    return false;
  };
  const out = [];
  for (const ic of M.lists.incall || []) {
    const start = key('incall', ic);
    const prev = new Map([[start, null]]); const q = [start]; let end = null;
    while (q.length && !end && prev.size < 600) {
      const k = q.shift();
      if (isMember(k) && T === baseKey(target)) { end = { k, edge: { slot: 'members', label: SLOTS.members.label, note: `dont ${nodeInfo(T).title}`, help: SLOTS.members.help, to: { key: T } } }; break; }
      for (const e of edgesOf(k)) {
        const to = e.to?.key; if (!to || e.assoc) continue;
        const b = baseKey(to);
        if (b === T) { end = { k, edge: e }; break; }
        if (!prev.has(b) && !b.startsWith('leaf:')) { prev.set(b, { from: k, edge: e }); q.push(b); }
      }
    }
    if (!end) continue;
    const steps = [{ key: end.k, edge: end.edge }];
    for (let k = end.k; prev.get(k); k = prev.get(k).from) steps.unshift({ key: prev.get(k).from, edge: prev.get(k).edge });
    out.push({ sda: start, exten: ic.extensions?.[0]?.exten || '', steps });
  }
  return out.sort((a, b) => a.steps.length - b.steps.length);
}

// Numéro externe (renvoi, destination Numéro) en simulation entrante (demande de
// Brice, 16/10/2026) : la sortie qu'il prend, depuis le contexte où il est composé
// (renvoi : contexte de l'utilisateur renvoyé, vérifié dans wazo-agid). Un appel
// renvoyé vers l'extérieur occupe 2 canaux : l'entrant reste ouvert pendant le sortant.
function outEdges(l) {
  const s = simulate(l.num, l.ctx); const r = s.result;
  if (r?.kind === 'outcall') return [{ slot: 'dial_out', label: `Ressort par la règle ${r.outcall.name || r.outcall.id}`, note: `motif ${r.dp.exten} · 2 canaux sur le trunk`, help: 'Le numéro est composé dans le contexte de l\'utilisateur renvoyé (vérifié, wazo-agid) : l\'appel repart vers l\'opérateur. L\'appel entrant reste ouvert pendant ce temps : 2 canaux sont occupés (l\'entrant et le sortant).', to: { key: gated(key('outcall', r.outcall)) }, outMatch: s }];
  if (r?.kind === 'internal' || r?.kind === 'incall') return [{ slot: 'dial_out', label: 'Numéro interne', note: 'l\'appel reste dans Wazo', to: { key: r.key.startsWith('incall:') ? r.key : gated(r.key) }, outMatch: s }];
  return [{ slot: 'dial_none', label: 'Aucune règle sortante ne prend ce numéro', note: 'le renvoi échoue (supposé)', help: 'Ni numéro interne ni motif de règle sortante dans le contexte où il est composé.', to: null, info: true, npd: true }];
}

const MAX_NODES = 400; // garde-fou : au-delà, les répétitions deviennent des liens
export function buildTree(rootKey, dir, { maxDepth = 8, collapsed = new Set(), expanded = new Set(), showEmpty = false, hit = null, caller = '', dialScope = '', chain = null, trunkPref = '', viaTrunk = false, followOut = false } = {}) {
  // Objet gardé par un horaire : en sens « où vont les appels », le parcours
  // commence par la carte horaire (une SDA garde sa carte, l'horaire suit).
  if (dir === 'out' && !rootKey.startsWith('incall:')) rootKey = gated(rootKey);
  const nodes = new Map(); const cross = [];
  const first = { key: rootKey, depth: 0, kids: [], info: nodeInfo(rootKey), ports: [] };
  let root = first;
  nodes.set(rootKey, first);
  // Arrivée de l'appel simulé (demande de Brice, 16/10/2026), cartes de passage
  // en tête, une seule sortie chacune, puis l'objet choisi à gauche :
  //  Appelant (si saisi) → Trunk (contexte de la SDA) → SDA → [chain : cartes
  //  entre la SDA et l'objet, voir entryChains] → objet.
  // chain = { sda, steps: [{ key, edge }] } (départ autre qu'un trunk ou une SDA).
  // viaTrunk : simulation entrante depuis une SDA, le trunk s'affiche même sans appelant.
  if (dir === 'out' && (caller || chain || viaTrunk)) {
    const seq = [];
    const sda = rootKey.startsWith('incall:') ? rootKey : chain?.sda || null;
    if (sda) {
      // Trunk dont le contexte est celui de la SDA : celui choisi dans la simulation (trunkPref), sinon le premier ; les autres cités.
      const ctxs = (entity(sda).obj?.extensions || []).map((x) => x.context);
      const all = (M.lists.trunk || []).filter((t) => ctxs.includes(t.context));
      const trs = [...all.filter((t) => `trunk:${t.id}` === trunkPref), ...all.filter((t) => `trunk:${t.id}` !== trunkPref)];
      if (trs.length) seq.push({ key: `trunk:${trs[0].id}`, port: { slot: 'via', label: 'Contexte entrant → SDA', note: [ctxLabel(trs[0].context), trs.length > 1 ? `ou par ${trs.slice(1).map((t) => nodeInfo(`trunk:${t.id}`).title).join(', ')}` : ''].filter(Boolean).join(' · '), help: 'Le numéro appelé est cherché parmi les SDA du contexte entrant du trunk.' } });
    }
    for (const s of chain?.steps || []) seq.push({ key: s.key, pass: true, port: { ...s.edge } });
    if (caller) {
      const info = { type: 'caller', title: isGlob(caller) ? caller : showNum(caller), sub: 'appelant extérieur' };
      seq.unshift({ key: 'leaf:caller', leaf: info, port: { slot: 'calls', label: seq[0]?.key.startsWith('trunk:') || rootKey.startsWith('trunk:') ? 'Appelle, arrive par ce trunk' : 'Appelle ce numéro', note: '', help: 'L\'opérateur présente l\'appel à Wazo.' } });
    }
    let parent = null;
    seq.forEach((s, i) => {
      const nextKey = seq[i + 1]?.key || rootKey;
      const port = { ...s.port, id: `${s.port.slot}#pass`, to: { key: nextKey } };
      const n = { key: s.key, depth: i, kids: [], ports: [port], pass: !!s.pass, entry: true, leaf: s.leaf || null, info: s.leaf ? { ...s.leaf, leafType: true } : nodeInfo(s.key) };
      if (parent) { Object.assign(n, { parent: parent.key, port: parent.ports[0].id, edge: parent.ports[0] }); parent.kids.push(n); } else root = n;
      nodes.set(s.key, n); parent = n;
    });
    if (parent) { Object.assign(first, { depth: seq.length, parent: parent.key, port: parent.ports[0].id, edge: parent.ports[0] }); parent.kids.push(first); maxDepth += seq.length; }
  }
  const queue = [first];
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
    // Une feuille peut porter ses propres sorties (membres d'un groupe).
    // Sens « Numéros composés » : l'utilisateur de départ et les contextes de la chaîne de recherche ;
    // au-delà (règle sortante, objet interne trouvé), les sorties habituelles.
    const dialNode = dir === 'dial' && (n.depth === 0 || n.viaDial);
    let edges = n.leaf ? (n.leaf.edges || []) : dialNode ? dialEdgesOf(n.key, hit, dialScope) : edgesOf(n.key);
    // Simulation entrante : un numéro externe (renvoi, destination Numéro) continue jusqu'à sa sortie.
    if (followOut && n.leaf?.num && n.leaf.ctx && (n.leaf.type === 'external' || n.leaf.type === 'extension')) edges = outEdges(n.leaf);
    // Règle sortante en appel passé : ce qui peut bloquer, sur la carte (autorisations
    // de l'appelant, de ses groupes, de la règle ; horaire ; règle désactivée).
    if (dir === 'dial' && !n.leaf && baseKey(n.key).startsWith('outcall:')) {
      const oc = entity(n.key).obj; const u = dialUser(rootKey);
      const LV = { user: 'utilisateur', group: 'groupe', outcall: 'règle' };
      const blocks = rightsList(u, oc).map(({ level, p, via }) => ({ slot: 'right', label: `Autorisation « ${p.name} »`, note: [p.mode === 'allow' ? 'autorise' : 'refuse', (p.extensions || []).join(', '), p.password ? 'code' : '', `${LV[level]}${via ? ` ${via}` : ''}`, p.enabled === false ? 'désactivée' : ''].filter(Boolean).join(' · '), help: 'Autorisation d\'appel qui s\'applique à ce chemin (vérifié, wazo-agid : utilisateur, puis ses groupes, puis la règle ; au premier niveau concerné, une « autorise » suffit, sinon refus).', to: null, info: true, npd: p.mode !== 'allow' }));
      // L'horaire de la règle est une carte à part, devant elle (gateOf), modifiable comme les autres.
      if (oc?.enabled === false) blocks.push({ slot: 'right', label: 'Règle désactivée', note: 'aucun appel ne sort par elle', to: null, info: true, npd: true });
      edges = [...blocks, ...edges];
    }
    // Trunk atteint par une règle sortante : l'appel sort vers l'opérateur, fin
    // du parcours dans Wazo. Sans ça, le graphe enchaînait sur le contexte
    // entrant du trunk (mêmes trunks dans les deux sens) : boucle juste pour
    // Asterisk, déroutante à lire (retour de Brice, 16/10/2026). Trunk choisi
    // comme point de départ : ses appels entrants restent affichés.
    if (!n.leaf && baseKey(n.key).startsWith('trunk:') && n.parent && (n.edge?.merge || n.edge?.outTrunk || baseKey(n.parent).startsWith('outcall:') || nodes.get(n.parent)?.leaf?.type === 'dial')) {
      const op = entity(n.key).obj?.operator;
      edges = [{ slot: 'pstn', label: op ? `Vers l'opérateur ${op.name}` : 'Vers l\'opérateur (réseau public)', note: 'appel sortant : fin du parcours dans Wazo', op: op?.name || null, help: 'L\'appel quitte Wazo par ce trunk. Ses appels entrants (contexte, SDA) se voient en partant du trunk lui-même.', to: null, info: true }];
      // Trunks suivants de la règle : utilisés si celui-ci échoue (ordre de la règle).
      const rest = n.edge?.outTrunks || [];
      if (rest.length) edges.push({ ...link('trunk', `trunk:${rest[0]}`), label: 'Si échec : trunk suivant', note: '', outTrunk: true, outTrunks: rest.slice(1), help: 'La règle sortante essaie ses trunks dans l\'ordre : celui-ci est utilisé si le précédent échoue.' });
    }
    n.ports = edges.filter((e) => e.to || showEmpty || e.info).map((e, i) => ({ ...e, id: `${e.slot}#${i}` }));
    edges = n.ports;
    if (stop) { n.folded = edges.some((e) => e.to); continue; }
    for (const e of edges) {
      if (!e.to) continue;
      // Feuille : clé stable (parent + sortie), pour garder sa position.
      const k = e.to.leaf ? `leaf:${n.key}/${e.id}` : e.to.key;
      // Retour sur la carte elle-même (SVI « touche 9 : réécouter ») : pas de lien, une mention.
      if (baseKey(k) === baseKey(n.key)) { e.self = true; continue; }
      // Objet déjà affiché : vraie boucle (il est sur le chemin qui mène ici)
      // → lien en pointillé vers lui ; sinon c'est une autre route → carte
      // répétée (demande de Brice : chaque fin possible visible, quitte à se
      // répéter). Au-delà de MAX_NODES cartes, lien en pointillé.
      let key = k;
      // Sorties qui convergent (motifs d'une règle → son trunk) : la 2e sortie et les
      // suivantes rejoignent la carte créée par la 1re (lien plein, pas de carte répétée).
      if (e.merge && n.mergeTo?.[k]) { cross.push({ from: n.key, port: e.id, to: n.mergeTo[k], edge: e, merge: true }); continue; }
      if (nodes.has(k)) {
        // Cartes d'arrivée (appelant, trunk, chaîne vers la carte choisie) : pas des boucles (ex. renvoi qui ressort par le trunk d'arrivée).
        let a = n; while (a && (a.entry || baseKey(a.key) !== k)) a = a.parent ? nodes.get(a.parent) : null;
        if (a || nodes.size >= MAX_NODES) { cross.push({ from: n.key, port: e.id, to: a ? a.key : k, edge: e, loop: !!a }); continue; }
        let i = 1; while (nodes.has(`${k}~${i}`)) i++;
        key = `${k}~${i}`;
      }
      const child = { key, copy: key !== k, depth: n.depth + 1, kids: [], parent: n.key, port: e.id, edge: e, leaf: e.to.leaf || null, viaDial: dialNode && (e.slot === 'dial_from' || e.slot === 'include') };
      child.info = e.to.leaf ? { ...e.to.leaf, leafType: true } : nodeInfo(k);
      nodes.set(key, child);
      n.kids.push(child);
      queue.push(child);
      if (e.merge) (n.mergeTo ||= {})[k] = key;
    }
  }
  // (0.36.1) Plus de liens « membres → pas de réponse » : la durée du groupe
  // est globale, ce n'est pas un membre qui déborde (retour de Brice).
  // Lien visible horaire → objet gardé (demande de Brice) : la carte horaire
  // dit de quel objet elle est la condition, l'objet affiche son horaire, et
  // la sortie « Ouvert » est marquée « guard » (lien épais).
  for (const n of nodes.values()) {
    const { owner, obj } = n.key.startsWith('schedule:') ? entity(n.key) : {};
    if (!owner) continue;
    const oi = nodeInfo(owner);
    n.guardOf = owner.startsWith('incall:') ? `la SDA ${oi.title}` : `${TYPES[oi.type]?.label || ''} ${oi.title}`.trim();
    // L'attache relie l'horaire à SON objet : SDA → horaire (la SDA est avant),
    // horaire → objet (Ouvert) pour un utilisateur, un groupe ou une file.
    if (owner.startsWith('incall:')) { for (const p of nodes.get(owner)?.ports || []) if (p.to?.key === baseKey(n.key)) p.guard = true; }
    else for (const p of n.ports || []) if (p.slot === 'open') p.guard = true;
    // Objet gardé : la carte au bout de « Ouvert » (peut être une carte répétée).
    const op = (n.ports || []).find((p) => p.slot === 'open');
    const target = (op && n.kids.find((c) => c.port === op.id)) || nodes.get(owner);
    if (target) target.guardedBy = obj?.name || 'Horaire';
  }
  return { root, nodes, cross };
}

// ---------------------------------------------------------------------------
// Simulation date / heure. Vérifié dans wazo-agid (schedule.py, master) :
// périodes exceptionnelles (fermées) testées d'abord, puis ouvertes, sinon
// fermé (closed_destination) ; heures comparées en (heure, minute), bornes
// incluses ; jours ISO 1 = lundi … 7 = dimanche ; champ vide = sans
// restriction. L'heure du curseur est l'heure locale du site (fuseau de
// l'horaire) : pas de conversion. Supposé : un horaire désactivé
// (enabled = false) laisse toujours passer (ouvert).
// ---------------------------------------------------------------------------
const hm = (s) => { const [h, m] = String(s || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
function periodMatch(p, w) {
  if (p.week_days?.length && !p.week_days.includes(w.wd)) return false;
  if (p.month_days?.length && !p.month_days.includes(w.day)) return false;
  if (p.months?.length && !p.months.includes(w.month)) return false;
  const a = hm(p.hours_start), b = hm(p.hours_end);
  if (a != null && b != null && (w.min < a || w.min > b)) return false;
  return true;
}
// when = { wd, day, month, min } → { open, exc (index ou -1), label }
export function scheduleState(s, w) {
  if (!s || s.enabled === false) return { open: true, exc: -1, label: s ? 'Désactivé (ouvert)' : '' };
  const i = (s.exceptional_periods || []).findIndex((p) => periodMatch(p, w));
  if (i >= 0) return { open: false, exc: i, label: `Fermeture exceptionnelle ${i + 1}`, short: `Fermeture exc. ${i + 1}` };
  if ((s.open_periods || []).some((p) => periodMatch(p, w))) return { open: true, exc: -1, label: 'Ouvert' };
  return { open: false, exc: -1, label: 'Fermé' };
}
export const whenOf = (date, min) => ({ wd: ((date.getDay() + 6) % 7) + 1, day: date.getDate(), month: date.getMonth() + 1, min });
// Marque les sorties inactives (p.inactive) et les cartes atteintes seulement
// par des sorties inactives (n.dim). w = null : tout est actif.
export function applyTime(tree, w) {
  for (const n of tree.nodes.values()) {
    n.dim = false; n.timeLabel = '';
    const s = w && n.key.startsWith('schedule:') ? scheduleState(entity(n.key).obj, w) : null;
    if (s) { n.timeLabel = s.short || s.label; n.timeOpen = s.open; } // pastille de la carte : libellé court
    for (const p of n.ports || []) {
      p.inactive = false;
      if (!s || !p.when) continue;
      p.inactive = p.when === 'open' ? !s.open : p.when === 'closed' ? (s.open || s.exc >= 0) : s.exc !== Number(p.when.slice(4));
    }
  }
  if (!w) return;
  // Cartes atteignables par des sorties actives, depuis la carte de départ.
  const reach = new Set([tree.root.key]);
  const out = new Map();
  const add = (from, port, to) => { if (!out.has(from)) out.set(from, []); out.get(from).push([port, to]); };
  for (const n of tree.nodes.values()) if (n.parent) add(n.parent, n.port, n.key);
  for (const c of tree.cross) add(c.from, c.port, c.to);
  const queue = [tree.root.key];
  while (queue.length) {
    const k = queue.shift(); const n = tree.nodes.get(k);
    for (const [port, to] of out.get(k) || []) {
      if (reach.has(to) || n.ports?.find((p) => p.id === port)?.inactive) continue;
      reach.add(to); queue.push(to);
    }
  }
  for (const n of tree.nodes.values()) n.dim = !reach.has(n.key);
}
// État d'un horaire sur une journée, minute par minute (bandeau du curseur) ;
// end = première minute hors de la tranche.
export function dayBands(s, date) {
  const out2 = [];
  for (let m = 0; m < 1440; m++) {
    const x = scheduleState(s, whenOf(date, m));
    const k = x.exc >= 0 ? `exc${x.exc}` : x.open ? 'open' : 'closed';
    const last = out2[out2.length - 1];
    if (last && last.id === k) last.end = m + 1; else out2.push({ id: k, k: x.exc >= 0 ? 'exc' : k, start: m, end: m + 1, label: x.label });
  }
  return out2;
}

// Horaires distincts présents dans l'arbre (ordre de parcours depuis la carte de départ).
export function schedulesIn(tree) {
  const seen = new Map();
  for (const k of tree?.nodes.keys() || []) if (k.startsWith('schedule:')) { const { id, obj } = entity(k); if (obj && !seen.has(id)) seen.set(id, obj); }
  return [...seen.values()];
}
// Cible d'une sortie dans l'arbre affiché (enfant ou lien croisé).
function targetOf(tree, k, portId) {
  for (const n of tree.nodes.get(k)?.kids || []) if (n.port === portId) return n.key;
  return tree.cross.find((c) => c.from === k && c.port === portId)?.to || null;
}
// Où arrive l'appel au moment w : on part de la carte de départ (une SDA passe
// à sa destination), puis on traverse les cartes horaire par leur sortie
// active, jusqu'au premier objet qui n'est pas un horaire.
export function landingAt(tree, w) {
  // Appelant et trunk de passage (simulation) : on part de la carte choisie.
  let n0 = tree.root; while (n0 && (n0.info?.type === 'caller' || n0.pass || n0.ports?.some((p) => p.slot === 'via'))) n0 = n0.kids[0];
  let k = n0?.key;
  if (k.startsWith('incall:')) k = targetOf(tree, k, tree.root.ports?.[0]?.id);
  for (let i = 0; k && k.startsWith('schedule:') && i < 12; i++) {
    const n = tree.nodes.get(k); const s = scheduleState(entity(k).obj, w);
    const p = (n.ports || []).find((x) => (x.when === 'open' && s.open) || (x.when === 'closed' && !s.open && s.exc < 0) || (x.when === `exc:${s.exc}`));
    if (!p) return { key: null, why: n.folded ? 'branche repliée' : 'sortie non réglée' };
    k = targetOf(tree, k, p.id);
    if (!k) return { key: null, why: n.folded ? 'branche repliée' : 'sortie non réglée' };
  }
  return { key: k };
}
// Résultat sur une journée, minute par minute : tranches [{start, end, key, type, title}].
export function landingSegments(tree, date) {
  const out2 = [];
  for (let m = 0; m < 1440; m++) {
    const r = landingAt(tree, whenOf(date, m));
    const id = r.key || `none:${r.why}`;
    const last = out2[out2.length - 1];
    if (last && last.id === id) { last.end = m + 1; continue; }
    const n = r.key ? tree.nodes.get(r.key) : null;
    const lbl = TYPES[n?.info?.type]?.label || '';
    const title = !n ? (r.why || 'aucune destination') : String(n.info.title).toLowerCase().startsWith(lbl.toLowerCase()) ? n.info.title : `${lbl} ${n.info.title}`.trim();
    out2.push({ id, start: m, end: m + 1, key: r.key, type: n?.info?.type || 'none', title });
  }
  return out2;
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
function periodsText(s) { return (s?.open_periods || []).map(periodText).join(' ; '); }
export function periodText(p) {
  if (!p) return '';
  const days = p.week_days?.length && p.week_days.length < 7 ? ranges(p.week_days, DAYS) : '';
  const md = p.month_days?.length && p.month_days.length < 31 ? `le ${ranges(p.month_days)}` : '';
  const mo = p.months?.length && p.months.length < 12 ? ranges(p.months, MONTHS) : '';
  return [days, md, mo, p.hours_start && p.hours_end ? `${p.hours_start}–${p.hours_end}` : ''].filter(Boolean).join(' ');
}
export function facts(k, leafInfo) {
  if (leafInfo?.names) {
    const ACT = { join: 'rejoindre', leave: 'quitter', toggle: 'bascule' };
    const g = leafInfo.ownerType === 'group';
    const dyn = (leafInfo.live || []).filter((x) => x.dynamic);
    const ghosts = dyn.filter((x) => x.unknown);
    return [['Membres fixes', leafInfo.names.join(', ') || 'aucun', 'Membres réglés dans Wazo (confd). Ils sonnent toujours.'],
      ...(ghosts.length ? [['Inscrits inconnus', ghosts.map((x) => `${x.uuid} — pour le retirer (CLI Asterisk) : queue remove member ${x.itf} from ${x.queue}`).join(' ; '),
        'Inscription par touche dont l\'utilisateur n\'existe pas dans ce tenant : utilisateur supprimé alors qu\'il était inscrit (Asterisk garde l\'inscription, persistentmembers = yes), ou utilisateur d\'un autre tenant. Le groupe continue d\'appeler ce canal. Supposé : la commande queue remove member retire aussi l\'inscription persistante.']] : []),
      [g ? 'Inscrits en ce moment' : 'Connectés en ce moment', leafInfo.live ? (dyn.filter((x) => !x.unknown).map((x) => `${x.name}${x.state ? ` (${x.state})` : ''}`).join(', ') || 'aucun') : `non lisible : ${M.liveState || 'non lu'}`,
        g ? 'Utilisateurs inscrits par la touche « bascule groupe » (*50, *51, *52). Wazo ne les enregistre pas dans sa configuration : seul Asterisk les connaît (lecture par l\'API amid).' : 'Agents connectés à la file, lus dans Asterisk (API amid).'],
      ...(g && leafInfo.keys ? [['Touches de bascule', leafInfo.keys.map((k) => `${k.name} (${ACT[k.action] || k.action}, touche ${k.pos})`).join(', ') || 'aucune', 'Utilisateurs qui ont une touche pour rejoindre ou quitter ce groupe : membres possibles, pas forcément inscrits.']] : [])];
  }
  if (leafInfo?.type === 'member') {
    const m = leafInfo.member || {};
    return [['Membre', m.name], ['Type', m.kind === 'ext' ? `numéro ${m.exten} (${ctxLabel(m.context)})` : m.kind === 'live' ? 'inscrit par la touche de bascule' : 'membre fixe'],
      ...(m.exten && m.kind === 'user' ? [['Numéro', m.exten]] : []),
      ['Ne pas déranger', m.dnd ? 'oui : ne sonne pas, appel non renvoyé' : 'non', 'État lu dans Wazo (confd, services.dnd) au chargement de la page : « Recharger » après un changement. NPD activé par la touche du poste Yealink : le poste prévient Wazo (action URL vers wazo-phoned, vérifié dans les plugins provd) seulement si cette URL est dans sa configuration et si le poste joint le serveur ; sinon le NPD reste local au poste, inconnu de Wazo et donc absent ici.'],
      ['Renvois de l\'utilisateur', m.kind === 'ext' ? 'appliqués (le numéro passe par le traitement de l\'utilisateur)' : 'non appliqués dans un groupe (supposé)', 'Déduit du dialplan Wazo (contexte usersharedlines), non testé en réel.']];
  }
  if (leafInfo) return [[TYPES[leafInfo.type]?.label || 'Valeur', [leafInfo.title, leafInfo.sub].filter(Boolean).join(' · ')]];
  k = baseKey(k);
  const { type, obj: o } = entity(k);
  if (!o) return [];
  const f = [];
  const exts = (o.extensions || []).map((e) => `${e.exten}${e.context ? ` (${ctxLabel(e.context)})` : ''}`).join(', ');
  const scheds = (o.schedules || []).map((s) => M.by.schedule?.get(String(s.id))?.name || s.name || `#${s.id}`).join(', ');
  switch (type) {
    case 'incall': {
      // Aperçu du numéro (demande de Brice, 16/10/2026), comme le portail : national, international, E.164.
      const fr = frNumber(firstExten(o));
      if (fr) f.push(['National', `FR ${fr.national}`], ['International', fr.international], ['E.164', fr.e164], ['Saisi dans Wazo', firstExten(o), 'Numéro tel qu\'enregistré dans la SDA (c\'est lui qui est comparé au numéro reçu de l\'opérateur).']);
    }
      f.push(['Numéro', exts || '—'], ['Description', o.description], ['Horaire', scheds], ['Message d\'accueil', o.greeting_sound], ['Nom appelant', o.caller_id_mode ? `${o.caller_id_mode} « ${o.caller_id_name || ''} »` : ''], ['Sous-routine', o.preprocess_subroutine]);
      break;
    case 'user': {
      const f2 = o.forwards || {};
      const fw = (x) => (x?.enabled ? `→ ${x.destination || '?'}` : 'non');
      f.push(['Numéros', (o.lines || []).flatMap((l) => (l.extensions || []).map((e) => `${e.exten} (${ctxLabel(e.context)})`)).join(', ') || '—'],
        ['Durée de sonnerie', sec(o.ring_seconds)], ['Appels simultanés', o.simultaneous_calls], ['Messagerie', o.voicemail ? (M.by.voicemail?.get(String(o.voicemail.id))?.number || '') + ' ' + (o.voicemail.name || '') : 'aucune'],
        ['Renvoi immédiat', fw(f2.unconditional)], ['Renvoi si occupé', fw(f2.busy)], ['Renvoi si pas de réponse', fw(f2.noanswer)],
        ['Ne pas déranger', o.services?.dnd?.enabled ? 'oui (les appels ne sonnent pas)' : 'non', 'État lu dans Wazo (confd, services.dnd) au chargement de la page : « Recharger » après un changement. NPD activé par la touche du poste Yealink : le poste prévient Wazo (action URL vers wazo-phoned, vérifié dans les plugins provd) seulement si cette URL est dans sa configuration et si le poste joint le serveur ; sinon le NPD reste local au poste, inconnu de Wazo et donc absent ici.'], ['Horaire', scheds], ['Sous-routine', o.preprocess_subroutine]);
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
        ['Fermetures exceptionnelles', (o.exceptional_periods || []).map(periodText).join(' ; ') || '—'],
        ['Utilisé par', ['incalls', 'users', 'groups', 'queues', 'outcalls'].map((x) => (o[x] || []).length).reduce((a, b) => a + b, 0) || '—']);
      break;
    case 'voicemail': f.push(['Numéro', o.number], ['Contexte', ctxLabel(o.context)], ['E-mail', o.email], ['Type', o.accesstype]); break;
    case 'conference': f.push(['Numéro', exts], ['Participants max', o.max_users || '—'], ['Code PIN', o.pin ? 'oui' : 'non']); break;
    case 'switchboard': f.push(['Numéro', exts], ['Délai', sec(o.timeout)]); break;
    case 'context': f.push(['Nom technique', o.name], ['Type', o.type], ['SDA (plages)', (o.incall_ranges || []).map((r) => `${r.start}–${r.end}`).join(', ')], ['Utilisateurs (plages)', (o.user_ranges || []).map((r) => `${r.start}–${r.end}`).join(', ')], ['Inclut', (o.contexts || []).map((c) => c.label || c.name).join(', ')]); break;
    case 'trunk': { const ep = o.endpoint_sip ? 'SIP' : o.endpoint_iax ? 'IAX' : o.endpoint_custom ? 'personnalisé' : '—'; f.push(['Type', ep], ['Opérateur', o.operator ? `${o.operator.name}${o.operator.known ? '' : ' (non reconnu : modèle ou hôte affiché tel quel)'}` : o.operator === null ? 'non reconnu' : 'non lu', 'Lu sur la fiche SIP du trunk : modèles hérités (posés par l\'assistant d\'interconnexion du portail) puis hôte de l\'opérateur.'], ['Modèles SIP', (o.sipTemplates || []).join(', ') || '—'], ['Hôte', o.sipHost || '—'], ['Contexte', ctxLabel(o.context)], ['Format du numéro présenté', o.outgoing_caller_id_format], ['Règles sortantes', (o.outcalls || []).map((x) => x.name).join(', ')]); break; }
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
