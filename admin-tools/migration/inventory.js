// Migration Assistant — inventaire complet d'un tenant (lecture seule, sans DOM).
// Cadrage : astrea-wazo-dev/docs/MIGRATION-ASSISTANT.md.
// Vérifié dans le code de wazo-confd master (19/10/2026) :
//  - GET /users sans « view » renvoie le schéma complet (UserSchema) : lignes,
//    renvois (forwards), débordements (fallbacks), services, horaires, messagerie ;
//  - GET /contexts : plages (user|group|queue|conference_room|incall_ranges) et
//    contextes inclus (contexts) ; le nom (name) est généré par Wazo ;
//  - GET /lines : context, device_id, extensions, users, endpoint_sip|sccp|custom ;
//  - GET /endpoints/sip : auth_section_options contient le mot de passe SIP ;
//  - GET /voicemails : password en clair ;
//  - touches de fonction : GET /users/{uuid}/funckeys (une requête par utilisateur).
// Supposé : les listes /groups, /queues, /switchboards contiennent membres et
// débordements (forme lue par Call Flow Manager, vérifiée en réel sur les groupes).
import { S, api, listAll } from '../common/core.js?v=0.40.10';

export const I = { tenant: undefined, lists: {}, by: {}, funckeys: {}, warns: [], loadedAt: null };

// [clé, chemin, libellé, catégorie, clé d'index, aide]
export const SOURCES = [
  ['context', '/contexts', 'Contextes', 'num', 'name', 'Contextes Asterisk du tenant (internes, entrants, sortants…), avec leurs plages de numéros et les contextes inclus.'],
  ['extension', '/extensions', 'Numéros (extensions)', 'num', 'id', 'Tous les numéros déclarés : postes, groupes, files, conférences, SDA, motifs des règles sortantes.'],
  ['phonenumber', '/phone-numbers', 'Numéros du tenant', 'num', 'uuid', 'Numéros publics déclarés pour le tenant (numéro principal, numéros partagés). API récente de Wazo : absente sur les anciennes stacks.'],
  ['user', null, 'Utilisateurs', 'usr', 'id', 'Utilisateurs avec leurs réglages (renvois, débordements, services, horaires, messagerie).'],
  ['line', '/lines', 'Lignes', 'usr', 'id', 'Lignes téléphoniques (SIP, SCCP, custom) : contexte, numéro, appareil, utilisateurs.'],
  ['endpoint_sip', '/endpoints/sip', 'Comptes SIP', 'usr', 'uuid', 'Comptes SIP des lignes et des trunks, avec identifiants et mots de passe.'],
  ['sip_template', '/endpoints/sip/templates', 'Modèles SIP', 'usr', 'uuid', 'Modèles de configuration SIP hérités par les comptes (ceux du portail et ceux du tenant).'],
  ['endpoint_sccp', '/endpoints/sccp', 'Comptes SCCP', 'usr', 'id', 'Comptes SCCP (anciens postes Cisco).'],
  ['endpoint_custom', '/endpoints/custom', 'Comptes custom', 'usr', 'id', 'Lignes et trunks « custom » (interface Asterisk libre).'],
  ['device', '/devices', 'Appareils', 'usr', 'id', 'Appareils provisionnés (postes, bases DECT, passerelles) : MAC, modèle, état.'],
  ['voicemail', '/voicemails', 'Messageries', 'usr', 'id', 'Boîtes vocales, avec code d\'accès et options.'],
  ['funckeytpl', '/funckeys/templates', 'Modèles de touches', 'usr', 'id', 'Modèles de touches de fonction partagés.'],
  ['agent', '/agents', 'Agents', 'usr', 'id', 'Agents de centre d\'appels (membres des files).'],
  ['skill', '/agents/skills', 'Compétences', 'usr', 'id', 'Compétences des agents (routage par compétence des files).'],
  ['incall', '/incalls', 'SDA', 'rte', 'id', 'Numéros entrants et leur destination.'],
  ['group', '/groups', 'Groupes', 'rte', 'id', 'Groupes d\'appel, membres et débordements.'],
  ['queue', '/queues', 'Files d\'attente', 'rte', 'id', 'Files d\'attente, membres et débordements.'],
  ['ivr', '/ivr', 'SVI', 'rte', 'id', 'Serveurs vocaux interactifs : touches et destinations.'],
  ['schedule', '/schedules', 'Horaires', 'rte', 'id', 'Horaires (plages d\'ouverture, fermetures exceptionnelles) et objets associés.'],
  ['switchboard', '/switchboards', 'Standards', 'rte', 'uuid', 'Standards (POPC) et standardistes.'],
  ['conference', '/conferences', 'Conférences', 'rte', 'id', 'Salles de conférence.'],
  ['application', '/applications', 'Applications', 'rte', 'uuid', 'Applications Stasis (Wazo) qui reçoivent des appels.'],
  ['trunk', '/trunks', 'Trunks', 'out', 'id', 'Liaisons opérateurs : contexte d\'arrivée, compte SIP, règles sortantes.'],
  ['outcall', '/outcalls', 'Règles sortantes', 'out', 'id', 'Règles d\'appel sortant : motifs, trunks, horaires, droits.'],
  ['callpermission', '/callpermissions', 'Droits d\'appel', 'out', 'id', 'Autorisations d\'appels (numéros interdits ou soumis à un code).'],
  ['callfilter', '/callfilters', 'Filtres d\'appel', 'svc', 'id', 'Filtrage patron / secrétaire.'],
  ['callpickup', '/callpickups', 'Interceptions', 'svc', 'id', 'Groupes d\'interception d\'appel.'],
  ['parkinglot', '/parkinglots', 'Parkings', 'svc', 'id', 'Parkings d\'appels.'],
  ['paging', '/pagings', 'Paging', 'svc', 'id', 'Groupes d\'appel général (haut-parleur des postes).'],
  ['meeting', '/meetings', 'Réunions', 'svc', 'uuid', 'Salles de réunion Wazo (meetings).'],
  ['moh', '/moh', 'Musiques d\'attente', 'snd', 'uuid', 'Classes de musique d\'attente et leurs fichiers.'],
  ['sound', '/sounds', 'Catégories de sons', 'snd', 'name', 'Catégories de sons du tenant (accueils, SVI…) et liste des fichiers. Les fichiers eux-mêmes ne sont pas dans l\'export du lot 1.'],
];
export const CATEGORIES = { num: 'Contextes et numéros', usr: 'Utilisateurs et postes', rte: 'Routage des appels', out: 'Trunks et appels sortants', svc: 'Services', snd: 'Sons et musiques' };
// Listes absentes sur certaines stacks ou réservées : pas d'avertissement en tête.
const OPTIONAL = new Set(['phonenumber', 'meeting', 'skill', 'endpoint_sccp', 'endpoint_custom']);

// Le portail change de tenant tout de suite (S.tenant) : un chargement terminé
// après un changement de tenant est abandonné (même règle que Call Flow Manager).
export const sameTenant = (t) => S.tenant === t;
const stale = () => Object.assign(new Error('tenant changé pendant le chargement'), { stale: true });
// listAll lit en recurse=true : on ne garde que les objets du tenant courant.
const ownTenant = (t, l) => (l || []).filter((o) => !t || !o?.tenant_uuid || o.tenant_uuid === t);

async function loadUsers() {
  const out = [];
  for (let off = 0; ; off += 100) {
    const r = await api('GET', `/users?limit=100&offset=${off}&order=id&direction=asc`);
    const items = r?.items || [];
    out.push(...items);
    if (items.length < 100 || (Number.isFinite(r?.total) && out.length >= r.total)) return out;
  }
}
// N requêtes en parallèle au plus (le serveur héberge 20-30 tenants).
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

export async function loadInventory(progress = () => {}) {
  const tenant = S.tenant;
  const warns = [];
  const lists = {};
  let done = 0;
  const total = SOURCES.length;
  await pool(SOURCES, 6, async ([key, path, label]) => {
    try { lists[key] = key === 'user' ? await loadUsers() : await listAll(path); }
    catch (e) {
      lists[key] = [];
      if (!OPTIONAL.has(key)) warns.push(`${label} illisibles (${e.status || ''} ${path || '/users'}) : absents de l'inventaire et de l'export.`);
      console.warn('[astrea]', path, e);
    }
    progress(`Lecture : ${++done} / ${total} listes`);
  });
  if (!sameTenant(tenant)) throw stale();
  for (const [key] of SOURCES) lists[key] = ownTenant(tenant, lists[key]);
  // /sounds ajoute la catégorie « system » (sons d'Asterisk, sans tenant : lu
  // dans sound/service.py) : elle n'appartient pas au tenant.
  lists.sound = (lists.sound || []).filter((c) => c.name !== 'system');

  // Touches de fonction : une requête par utilisateur.
  const funckeys = {};
  let n = 0;
  await pool(lists.user, 8, async (u) => {
    try { funckeys[u.uuid] = (await api('GET', `/users/${u.uuid}/funckeys`))?.keys || {}; }
    catch (e) { funckeys[u.uuid] = null; console.warn('[astrea] funckeys', u.uuid, e); }
    if (++n % 10 === 0 || n === lists.user.length) progress(`Touches de fonction : ${n} / ${lists.user.length} utilisateurs`);
  });
  const fkErr = Object.values(funckeys).filter((v) => v === null).length;
  if (fkErr) warns.push(`Touches de fonction illisibles pour ${fkErr} utilisateur${fkErr > 1 ? 's' : ''} : absentes de l'export.`);
  if (!sameTenant(tenant)) throw stale();

  I.tenant = tenant; I.lists = lists; I.funckeys = funckeys; I.warns = warns; I.loadedAt = new Date();
  I.by = {};
  for (const [key, , , , k] of SOURCES) I.by[key] = new Map((lists[key] || []).map((o) => [String(o?.[k]), o]));
  I.userByUuid = new Map(lists.user.map((u) => [u.uuid, u]));
  I.groupByUuid = new Map((lists.group || []).map((g) => [g.uuid, g]));
  return I;
}

// ---------------------------------------------------------------------------
// Aides de lecture communes aux contrôles et à l'affichage
// ---------------------------------------------------------------------------
export const ctxLabel = (name) => { const c = I.by.context?.get(String(name)); return c ? `${c.label || c.name} (${c.name})` : String(name ?? ''); };
const nameOf = (u) => [u?.firstname, u?.lastname].filter(Boolean).join(' ') || u?.username || u?.uuid || '';
// Libellé d'un objet de l'inventaire, pour les rapports.
export function objLabel(type, o) {
  if (!o) return '';
  const ext = (o.extensions || [])[0];
  const num = ext ? ` ${ext.exten}` : '';
  switch (type) {
    case 'user': return `${nameOf(o)}${o.lines?.[0]?.extensions?.[0] ? ` (${o.lines[0].extensions[0].exten})` : ''}`;
    case 'incall': return `SDA${num || ` #${o.id}`}`;
    case 'group': return `${o.label || o.name}${num}`;
    case 'queue': return `${o.label || o.name}${num}`;
    case 'ivr': return o.name || o.description || `SVI #${o.id}`;
    case 'schedule': return o.name || `Horaire #${o.id}`;
    case 'switchboard': return o.name || o.uuid;
    case 'conference': return `${o.name || `Conférence #${o.id}`}${num}`;
    case 'outcall': return o.label || o.name || `Règle #${o.id}`;
    case 'trunk': return o.endpoint_sip?.label || o.endpoint_sip?.name || o.endpoint_custom?.interface || `Trunk #${o.id}`;
    case 'line': return `Ligne ${o.name || o.id}${o.extensions?.[0] ? ` (${o.extensions[0].exten})` : ''}`;
    case 'device': return `${[o.vendor, o.model].filter(Boolean).join(' ') || 'Appareil'} ${o.mac || o.id}`;
    case 'voicemail': return `${o.name || ''} (${o.number || ''}@${o.context || ''})`;
    case 'context': return `${o.label || o.name} (${o.name})`;
    case 'extension': return `${o.exten}@${o.context}`;
    default: return o.label || o.name || String(o.id ?? o.uuid ?? '');
  }
}
// Membres d'un groupe ou d'une file, quelle que soit la forme renvoyée.
export function membersOf(o) {
  const m = o?.members || {};
  return {
    users: m.users || o?.user_queue_members || [],
    extensions: m.extensions || o?.extension_queue_members || [],
    agents: m.agents || o?.agent_queue_members || [],
  };
}
