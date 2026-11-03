// Migration Assistant — brouillon d'import 3CX → Wazo (sans DOM).
// Construit depuis la sauvegarde lue par 3cx.js, puis modifié dans les tableaux
// (3cx-edit.js). Il est la source unique des exports (CSV d'import, touches) et,
// plus tard, de l'écriture dans Wazo. Demande de Brice (19/10/2026) : contrôler
// et modifier chaque partie avant import (utilisateurs, renvois, contacts,
// groupes / files, conversion d'une file 3CX en groupe Wazo…).
//
// Destination unique du brouillon : { t, ref, num } avec t =
//   user (ref = numéro du poste) | vm (messagerie du poste ref) |
//   hunt (groupe ou file 3CX ref : suit le type Wazo choisi pour cet objet) |
//   ivr (ref) | ext (numéro externe num) | sound (ref = fichier ou « holiday ») |
//   hangup | none.
// Les objets Wazo correspondants (destinations confd user_id, group_id…) ne
// sont résolus qu'à l'écriture : convertir une file en groupe ne demande donc
// aucune reprise des destinations qui la visent.
import { nameOf, schedulesOf, STRATEGY } from './3cx.js?v=0.40.32';

export const DRAFT_FORMAT = 'astrea-3cx-draft';
const KEY = 'astrea-migration-3cx-draft-v1';

// Stratégies Wazo d'un groupe (confd group ring_strategy, lu) et libellés.
export const GROUP_STRATEGIES = { all: 'Tous en même temps', linear: 'Un par un, dans l\'ordre', random: 'Aléatoire', least_recent: 'Le moins récemment appelé', fewest_calls: 'Le moins d\'appels pris', memorized_round_robin: 'Tour de rôle mémorisé', weight_random: 'Aléatoire pondéré' };
// Équivalent file d'attente (option Asterisk « strategy » des files Wazo, supposé).
export const QUEUE_STRATEGY = { all: 'ringall', linear: 'linear', random: 'random', least_recent: 'leastrecent', fewest_calls: 'fewestcalls', memorized_round_robin: 'rrmemory', weight_random: 'wrandom' };
export const MODES = { user: 'Utilisateur', voicemail: 'Messagerie seule', skip: 'Non repris' };
// Licence = subscription_type (confd : 0 à 10). Libellés relevés en réel par
// User Manager (13/10/2026) ; 2 jamais vu. Retour terrain du 20/10 : le CSV ne
// portait aucune licence → choix obligatoire, sans valeur par défaut.
export const LICENCES = { 0: 'Voix', 1: 'Communication unifiée', 3: 'Relation client' };
// Méthode de connexion du compte des applications (wazo-auth, validée contre
// les fournisseurs configurés ; lu par User Manager). Pas de colonne dans le CSV.
export const AUTH_METHODS = { default: 'Défaut de l\'organisation', native: 'Native', saml: 'SAML', ldap: 'LDAP' };
// confd user/schema.py (lu) : identifiant 2-254 caractères de ce jeu.
const USERNAME_RE = /^[a-zA-Z0-9\-._~!$&'()*+,;=%@]{2,254}$/;
export const HUNT_TARGETS = { group: 'Groupe d\'appel', queue: 'File d\'attente', skip: 'Non repris' };
// Lignes créées pour un utilisateur (même numéro). L'import CSV de Wazo n'en
// crée qu'une (line_protocol sip OU webrtc, csvparse.py) ; l'écriture guidée
// crée les deux. WebRTC = endpoint SIP avec les modèles global + webrtc du
// tenant (user_import/creators.py, WebRTCCreator) ; refusée en licence Voix
// par le portail (vérifié par User Manager).
export const LINE_MODES = { auto: 'Auto : SIP, + WebRTC si applications', sip: 'SIP seule', webrtc: 'WebRTC seule', both: 'SIP + WebRTC' };
export function linesOf(u) {
  const m = u.lines || 'auto';
  if (m === 'sip') return ['sip'];
  if (m === 'webrtc') return ['webrtc'];
  if (m === 'both') return ['sip', 'webrtc'];
  return u.appAccess && u.sub !== 0 ? ['sip', 'webrtc'] : ['sip'];
}
export const linesText = (u) => linesOf(u).map((t) => (t === 'sip' ? 'SIP' : 'WebRTC')).join(' + ');
// Réglages d'une messagerie (confd voicemail/schema.py, lu le 03/11/2026) :
// email ≤ 80 caractères, password chiffres seuls, max_messages ≥ 0,
// language xx_XX ; delete_messages exige email ET attach_audio (validates_schema).
// Valeurs envoyées explicitement à l'écriture (pas de défaut caché du serveur).
// email null = celui de l'utilisateur ; notify false = aucune notification.
export const VM_LANGS = { fr_FR: 'Français', en_US: 'Anglais (US)', fr_CA: 'Français (Canada)', de_DE: 'Allemand', es_ES: 'Espagnol', it_IT: 'Italien' };
export const defaultVmo = () => ({ notify: true, email: null, attach: true, del: false, ask: true, max: null, lang: 'fr_FR' });
export const vmEmail = (u) => (u.vmo?.notify === false ? '' : (u.vmo?.email ?? u.email ?? ''));
// NOM en majuscules (demande de Brice, 03/11/2026) : « Tessier » → « TESSIER ».
export const upperName = (s) => String(s || '').toLocaleUpperCase('fr-FR');

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------
function convertDest(m, d, depth = 0) {
  if (!d) return { t: 'none' };
  switch (d.to) {
    case 'Extension': return d.dn ? { t: 'user', ref: d.dn } : { t: 'none', todo: 'poste non précisé dans 3CX' };
    case 'VoiceMail': return d.dn ? { t: 'vm', ref: d.dn } : { t: 'none', todo: 'messagerie non précisée dans 3CX' };
    case 'Queue': case 'RingGroup': return { t: 'hunt', ref: d.dn };
    case 'IVR': return d.dn ? { t: 'ivr', ref: d.dn } : { t: 'sound', ref: 'holiday' };
    case 'External': {
      // Renvoi vers un numéro du client : on vise directement sa destination
      // (pas de sortie puis retour par le trunk). Le brouillon le note.
      const rule = depth < 3 && m.inbound.find((r) => r.did && r.did === d.external);
      if (rule) return { ...convertDest(m, rule.open, depth + 1), fixed: `renvoi vers ${d.external} (numéro du client) remplacé par sa destination` };
      return { t: 'ext', num: d.external };
    }
    case 'None': case 'EndCall': return { t: 'hangup' };
    default: return { t: 'none', todo: `type 3CX ${d.to} non repris` };
  }
}
const FWD = { NoAnswer: 'noanswer', Busy: 'busy', NotRegistered: 'fail' };

export function buildDraft(m, file) {
  const scheds = schedulesOf(m); // pose aussi r.scheduleKey sur chaque règle
  const keyOf = (p) => p.map((x) => `${x.day}:${x.from}-${x.to}`).join('|');
  const users = m.extensions.map((e) => {
    const n = nameOf(e);
    const mode = !e.enabled ? 'skip' : e.devices.length ? 'user' : e.vm.enabled ? 'voicemail' : 'skip';
    const fb = { noanswer: { t: 'none' }, busy: { t: 'none' }, fail: { t: 'none' } };
    for (const [k, w] of Object.entries(FWD)) if (e.fwd[k]) fb[w] = convertDest(m, e.fwd[k]);
    return {
      n: e.number, mode, first: n.first || (n.last ? '' : (e.devices.length ? `Poste ${e.number}` : '')), last: n.last, guessed: n.guessed,
      email: e.email, mobile: e.mobile, vm: e.vm.enabled, vmPin: false, ring: e.fwd.timeout || 30, fb, blf: true,
      sub: null, username: '', authMethod: 'default', appAccess: true, checked: false, lines: 'auto', vmo: defaultVmo(),
      devices: e.devices, src: { first: e.first, last: e.last, enabled: e.enabled },
    };
  });
  const hunts = [
    ...m.ringGroups.map((g) => ({ n: g.number, src: 'RingGroup', name: g.name, target: 'group', strategy: STRATEGY[g.strategy] || 'all', timeout: g.ringTime || 30, userTimeout: g.ringTime || 30, members: [...g.members], noanswer: convertDest(m, g.dest), music: '' })),
    ...m.queues.map((q) => ({ n: q.number, src: 'Queue', name: q.name, target: 'queue', strategy: STRATEGY[q.strategy] || 'all', timeout: q.masterTimeout || 300, userTimeout: q.ringTimeout || 15, members: [...q.members], noanswer: convertDest(m, q.dest), music: q.onHold || '' })),
  ];
  const ivrs = m.ivrs.filter((v) => !v.system).map((v) => ({
    n: v.number, import: true, name: v.name, prompt: v.prompt, timeout: v.timeout,
    choices: v.choices.map((c) => ({ key: c.key, dest: convertDest(m, c) })),
    timeoutDest: v.timeoutDest.to === 'EndCall' ? { t: 'hangup' } : convertDest(m, v.timeoutDest),
  }));
  const schedules = scheds.map((s) => ({ key: keyOf(s.periods), name: s.name, text: s.text, periods: s.periods }));
  const dids = m.inbound.filter((r) => r.did).map((r) => {
    const open = convertDest(m, r.open);
    return { did: r.did, import: true, name: r.name, dest: open, schedule: r.scheduleKey || '', closed: convertDest(m, r.closed), holiday: convertDest(m, r.holiday), viaCsv: open.t === 'user' };
  });
  // SDA du trunk sans règle propre : rejet par défaut dans 3CX, reprises « non affectées ».
  const ruled = new Set(dids.map((d) => d.did));
  for (const t of m.trunks) for (const did of t.dids) if (!ruled.has(did)) dids.push({ did, import: false, name: '(sans règle 3CX)', dest: { t: 'none' }, schedule: '', closed: { t: 'none' }, holiday: { t: 'none' }, viaCsv: false });
  const holidays = m.holidays.filter((h) => !h.past).map((h) => ({ ...h, include: true }));
  return { format: DRAFT_FORMAT, version: 1, file, sourceDate: m.date, company: m.company, createdAt: new Date().toISOString(), users, devices: buildDevices(m, users), hunts, ivrs, dids, schedules, holidays, blfOffset: 1, upperLast: false };
}
// Appareils (demande de Brice, 19/10/2026) : MAC, modèle, utilisateur associé et
// description « Prénom Nom ». confd (device/schema.py, lu) : mac au format
// xx:xx:xx:xx:xx:xx, description texte libre. descAuto : la description suit
// le nom de l'utilisateur tant qu'elle n'est pas modifiée à la main.
export function buildDevices(m, users) {
  const out = [];
  for (const e of m.extensions) for (const dv of e.devices) {
    const u = users.find((x) => x.n === e.number);
    out.push({ mac: macWazo(dv.mac), model: dv.model, vendor: /^yealink/i.test(dv.model) ? 'Yealink' : (dv.model.split(' ')[0] || ''), owner: e.number, import: u?.mode === 'user', desc: '', descAuto: true });
  }
  return out;
}
// « 001565A1B2C3 » ou « 00-15-65-… » → « 00:15:65:a1:b2:c3 » ; vide si invalide.
export function macWazo(s) {
  const h = String(s || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return h.length === 12 ? h.match(/../g).join(':') : String(s || '');
}
export const macValid = (s) => /^([0-9a-f]{2})(:[0-9a-f]{2}){5}$/i.test(s || '');
// Description de l'appareil : « Prénom Nom » de l'utilisateur associé.
export function deviceDesc(d, dv) {
  if (!dv.descAuto) return dv.desc || '';
  const u = userBy(d, dv.owner);
  return u ? userName(u) : '';
}

// Brouillon d'une version précédente : champs ajoutés depuis (licence, compte
// des applications, vérification), sans toucher à ce qui a été saisi.
export function upgradeDraft(d) {
  for (const u of d.users) {
    if (!('sub' in u)) u.sub = null;
    if (!('username' in u)) u.username = '';
    if (!('authMethod' in u)) u.authMethod = 'default';
    if (!('appAccess' in u)) u.appAccess = true;
    if (!('checked' in u)) u.checked = false;
    if (!('lines' in u)) u.lines = 'auto';
    if (!u.vmo) u.vmo = defaultVmo();
  }
  if (!('upperLast' in d)) d.upperLast = false;
  return d;
}
// Identifiant effectif : celui saisi, sinon l'e-mail (comme l'import Wazo :
// wazo_user_service.py, username or email_address or uuid).
export const effectiveUsername = (u) => u.username || u.email || '';

// ---------------------------------------------------------------------------
// Sauvegarde dans le navigateur (confort) et fichier JSON (partage, reprise)
// ---------------------------------------------------------------------------
const storeKey = (d) => `${KEY}|${d.file}|${d.sourceDate}`;
export function saveDraft(d) { try { d.savedAt = new Date().toISOString(); localStorage.setItem(storeKey(d), JSON.stringify(d)); return true; } catch { return false; } }
export function loadDraft(file, sourceDate) { try { const d = JSON.parse(localStorage.getItem(storeKey({ file, sourceDate })) || 'null'); return d?.format === DRAFT_FORMAT ? d : null; } catch { return null; } }
export function clearDraft(d) { try { localStorage.removeItem(storeKey(d)); } catch { /* */ } }
// Brouillon chargé depuis un fichier : il doit venir de la même sauvegarde.
export function acceptDraft(json, file, sourceDate) {
  if (json?.format !== DRAFT_FORMAT) throw new Error('ce fichier n\'est pas un brouillon d\'import 3CX');
  if (json.sourceDate !== sourceDate) throw new Error(`brouillon fait sur une autre sauvegarde (${json.sourceDate})`);
  return { ...json, file };
}

// ---------------------------------------------------------------------------
// Lecture du brouillon
// ---------------------------------------------------------------------------
export const userBy = (d, n) => d.users.find((u) => u.n === n);
export const huntBy = (d, n) => d.hunts.find((h) => h.n === n);
export const ivrBy = (d, n) => d.ivrs.find((v) => v.n === n);
export const userName = (u) => [u.first, u.last].filter(Boolean).join(' ') || `Poste ${u.n}`;
export const imported = (d) => d.users.filter((u) => u.mode === 'user');

// Texte d'une destination du brouillon, avec son état (objet non repris…).
export function destLabel(d, x) {
  if (!x) return 'aucune';
  switch (x.t) {
    case 'user': { const u = userBy(d, x.ref); return u ? `Utilisateur ${x.ref} ${userName(u)}${u.mode !== 'user' ? ' (non repris)' : ''}` : `Utilisateur ${x.ref} (absent)`; }
    case 'vm': { const u = userBy(d, x.ref); return u ? `Messagerie ${x.ref} ${userName(u)}${u.mode === 'skip' || !u.vm ? ' (désactivée)' : ''}` : `Messagerie ${x.ref} (absente)`; }
    case 'hunt': { const h = huntBy(d, x.ref); return h ? `${h.target === 'skip' ? 'Groupe / file' : HUNT_TARGETS[h.target]} ${x.ref} ${h.name}${h.target === 'skip' ? ' (non repris)' : ''}` : `Groupe / file ${x.ref} (absent)`; }
    case 'ivr': { const v = ivrBy(d, x.ref); return v ? `SVI ${x.ref} ${v.name}${v.import ? '' : ' (non repris)'}` : `SVI ${x.ref} (absent)`; }
    case 'ext': return `Numéro externe ${x.num || '?'}`;
    case 'sound': return x.ref === 'holiday' ? 'Message du jour férié' : `Son ${x.ref}`;
    case 'hangup': return 'Raccrocher';
    default: return x.todo ? `À définir (${x.todo})` : 'Aucune';
  }
}
// Destination valide après import ? (sinon raison)
export function destProblem(d, x) {
  if (!x) return null;
  switch (x.t) {
    case 'user': { const u = userBy(d, x.ref); return !u ? 'utilisateur absent' : u.mode !== 'user' ? 'utilisateur non repris' : null; }
    case 'vm': { const u = userBy(d, x.ref); return !u ? 'messagerie absente' : (u.mode === 'skip' || !u.vm) ? 'messagerie désactivée ou non reprise' : null; }
    case 'hunt': { const h = huntBy(d, x.ref); return !h ? 'groupe / file absent' : h.target === 'skip' ? 'groupe / file non repris' : null; }
    case 'ivr': { const v = ivrBy(d, x.ref); return !v ? 'SVI absent' : !v.import ? 'SVI non repris' : null; }
    case 'ext': return /^\+?\d{2,}$/.test(x.num || '') ? null : 'numéro externe invalide';
    case 'none': return x.todo ? `à définir (${x.todo})` : null;
    default: return null;
  }
}

// Contrôles du brouillon : ce qui empêcherait ou fausserait l'import.
export function draftIssues(d) {
  const out = [];
  const add = (sev, area, text) => out.push({ sev, area, text });
  const exts = new Map();
  for (const u of d.users.filter((x) => x.mode === 'user')) {
    const w = `Utilisateur ${u.n}`;
    if (!/^\d+$/.test(u.n)) add('error', w, 'numéro non numérique.');
    if (exts.has(u.n)) add('error', w, 'numéro en double.');
    exts.set(u.n, u);
    if (!u.first && !u.last) add('error', w, 'sans nom.');
    if (u.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) add('warn', w, `e-mail invalide (${u.email}).`);
    if (u.mobile && !/^\+?\d{6,}$/.test(u.mobile)) add('warn', w, `mobile invalide (${u.mobile}).`);
    if (!(u.ring >= 5 && u.ring <= 300)) add('warn', w, `durée de sonnerie ${u.ring} s inhabituelle.`);
    if (u.sub == null) add('error', w, 'licence non choisie (Voix, Communication unifiée ou Relation client).');
    if ((u.sub === 1 || u.sub === 3) && !u.email) add('error', w, `e-mail obligatoire pour la licence ${LICENCES[u.sub]} (règle du portail).`);
    if (u.sub === 0 && u.appAccess) add('info', w, 'licence Voix : les applications Wazo refuseront la connexion, même avec l\'accès autorisé (vérifié par User Manager) ; pas de ligne WebRTC en mode Auto.');
    if (u.sub === 0 && linesOf(u).includes('webrtc')) add('error', w, 'ligne WebRTC demandée en licence Voix : refusée par le portail (choisir SIP seule ou une autre licence).');
    if (linesOf(u).includes('webrtc') && !u.appAccess) add('warn', w, 'ligne WebRTC sans accès aux applications : elle ne servira pas.');
    if (!linesOf(u).includes('sip') && (d.devices || []).some((x) => x.import && x.owner === u.n)) add('error', w, 'appareil associé mais pas de ligne SIP (une ligne WebRTC ne se met pas sur un téléphone).');
    if (u.username && !USERNAME_RE.test(u.username)) add('error', w, `identifiant « ${u.username} » refusé par Wazo (2 à 254 caractères : lettres, chiffres, - . _ ~ ! $ & ' ( ) * + , ; = % @).`);
    if (!effectiveUsername(u)) add('warn', w, 'ni identifiant ni e-mail : Wazo prendra l\'identifiant interne (uuid) comme identifiant de connexion.');
    for (const [k, l] of [['noanswer', 'pas de réponse'], ['busy', 'occupé'], ['fail', 'indisponible']]) { const p = destProblem(d, u.fb[k]); if (p) add('warn', `${w} renvoi ${l}`, u.fb[k]?.t === 'none' ? `${p}.` : `${destLabel(d, u.fb[k])} : ${p}.`); }
  }
  // Identifiants de connexion uniques sur tout le serveur : au moins entre eux.
  const logins = new Map();
  for (const u of d.users.filter((x) => x.mode === 'user')) {
    const k = effectiveUsername(u).toLowerCase(); if (!k) continue;
    if (logins.has(k)) add('error', `Utilisateur ${u.n}`, `identifiant de connexion « ${effectiveUsername(u)} » identique à celui de ${logins.get(k)} (unique sur le serveur).`);
    logins.set(k, u.n);
  }
  const unchecked = imported(d).filter((u) => !u.checked).map((u) => u.n);
  if (unchecked.length) add('warn', 'Vérification', `${unchecked.length} utilisateur(s) pas encore vérifiés : ${unchecked.join(', ')} (onglet Utilisateurs, « Vérifier un par un »).`);
  for (const u of d.users.filter((x) => x.mode === 'voicemail')) if (!u.vm) add('warn', `Messagerie ${u.n}`, 'reprise en « messagerie seule » mais la messagerie est décochée.');
  // Réglages des messageries (règles de confd voicemail/schema.py).
  for (const u of d.users.filter((x) => x.mode !== 'skip' && x.vm)) {
    const w = `Messagerie ${u.n}`; const o = u.vmo || defaultVmo(); const mail = vmEmail(u);
    if (o.notify && !mail) add('warn', w, 'notification par e-mail sans adresse (ni e-mail de l\'utilisateur) : aucune notification.');
    if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) add('error', w, `adresse de notification invalide (${mail}).`);
    if (mail.length > 80) add('error', w, 'adresse de notification de plus de 80 caractères (refusée par Wazo).');
    if (o.del && !(mail && o.attach)) add('error', w, '« supprimer après envoi » exige une adresse de notification et « joindre l\'audio » (règle de Wazo) : les messages seraient perdus.');
    if (o.max != null && !(o.max >= 0)) add('error', w, 'nombre maximal de messages invalide.');
  }
  const macs = new Map();
  for (const dv of (d.devices || []).filter((x) => x.import)) {
    const w = `Appareil ${dv.mac}`;
    if (!macValid(dv.mac)) add('error', w, 'adresse MAC invalide (format attendu 00:15:65:a1:b2:c3).');
    if (macs.has(dv.mac.toLowerCase())) add('error', w, 'adresse MAC en double.');
    macs.set(dv.mac.toLowerCase(), dv);
    const u = dv.owner ? userBy(d, dv.owner) : null;
    if (!dv.owner) add('info', w, 'sans utilisateur associé : appareil créé seul (en stock).');
    else if (u?.mode !== 'user') add('warn', w, `associé au poste ${dv.owner}, non repris comme utilisateur.`);
  }
  const multi = imported(d).filter((u) => (d.devices || []).filter((x) => x.import && x.owner === u.n).length > 1);
  if (multi.length) add('info', 'Appareils', `utilisateurs à plusieurs appareils (une ligne par appareil à prévoir) : ${multi.map((u) => u.n).join(', ')}.`);
  for (const h of d.hunts.filter((x) => x.target !== 'skip')) {
    const w = `${HUNT_TARGETS[h.target]} ${h.n}`;
    const live = h.members.filter((n) => userBy(d, n)?.mode === 'user');
    if (!live.length) add('error', w, 'aucun membre repris.');
    if (live.length !== h.members.length) add('warn', w, `membres non repris retirés : ${h.members.filter((n) => !live.includes(n)).join(', ')}.`);
    if (!/^\d+$/.test(h.n)) add('error', w, 'numéro non numérique.');
    if (exts.has(h.n)) add('error', w, 'numéro déjà pris par un utilisateur.');
    const p = destProblem(d, h.noanswer); if (p) add('warn', `${w} sans réponse`, `${destLabel(d, h.noanswer)} : ${p}.`);
  }
  for (const v of d.ivrs.filter((x) => x.import)) {
    for (const c of v.choices) { const p = destProblem(d, c.dest); if (p) add('warn', `SVI ${v.n} touche ${c.key}`, `${destLabel(d, c.dest)} : ${p}.`); }
    const p = destProblem(d, v.timeoutDest); if (p) add('warn', `SVI ${v.n} sans saisie`, `${destLabel(d, v.timeoutDest)} : ${p}.`);
  }
  // SDA : une ligne par problème ; les cas répétitifs sont regroupés en une ligne.
  const csvNoSched = []; const noDest = [];
  for (const r of d.dids.filter((x) => x.import)) {
    for (const [k, l] of [['dest', 'ouvert'], ['closed', 'fermé'], ['holiday', 'férié']]) {
      if (k !== 'dest' && !r.schedule) continue;
      const p = destProblem(d, r[k]);
      if (p) add('warn', `SDA ${r.did} ${l}`, r[k]?.t === 'none' ? `${p}.` : `${destLabel(d, r[k])} : ${p}.`);
    }
    if (r.dest.t === 'none' && !r.dest.todo) noDest.push(r.did);
    if (r.viaCsv && r.dest.t === 'user' && r.schedule) csvNoSched.push(r.did);
  }
  if (noDest.length) add('info', 'SDA', `${noDest.length} SDA sans destination (appel rejeté) : ${noDest.join(', ')}.`);
  if (csvNoSched.length) add('info', 'SDA', `${csvNoSched.length} SDA directes créées par le CSV sans leur horaire (à associer ensuite) : ${csvNoSched.join(', ')}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Contrôles contre le tenant Wazo ouvert (avant l'import CSV)
// Lu dans wazo-confd (user_import, 03/11/2026) : l'import est tout ou rien
// (rollback à la première erreur).
//  - poste : line_extension/validator.py exige le numéro dans les user_ranges
//    du contexte (« outside of range ») ; EXTEN_REGEX accepte les zéros en tête ;
//  - numéro existant : ExtensionCreator.find le réutilise, puis l'association
//    à la nouvelle ligne échoue (extension déjà associée) ;
//  - SDA : aucune plage exigée (incall_extension/validator.py), mais une SDA
//    existante est réutilisée et déjà associée → refus ;
//  - messagerie existante (numéro@contexte) : VoicemailCreator.find la rattache
//    au nouvel utilisateur au lieu d'en créer une ;
//  - e-mail : compte wazo-auth ; unicité supposée (non lue), vérifiable ici
//    seulement dans le tenant ouvert.
// `t` = { contexts, extensions, users, voicemails } (listes du tenant).
// ---------------------------------------------------------------------------
const inUserRanges = (exten, ctx) => (ctx?.user_ranges || []).some((r) => Number(r.start) <= Number(exten) && Number(exten) <= Number(r.end ?? r.start));
export function tenantIssues(d, { ctx, incallCtx }, t) {
  const out = [];
  const add = (sev, area, text) => out.push({ sev, area, text, tenant: true });
  const c = (t.contexts || []).find((x) => x.name === ctx);
  if (!c) { add('error', 'Contexte interne', 'aucun contexte interne choisi ou lu dans le tenant.'); return out; }
  const users = imported(d);
  const outRange = users.filter((u) => !inUserRanges(u.n, c)).map((u) => u.n);
  if (outRange.length) add('error', `Contexte ${c.label || c.name}`, `${outRange.length} numéro(s) hors des plages utilisateurs du contexte (${(c.user_ranges || []).map((r) => (r.end && r.end !== r.start ? `${r.start}-${r.end}` : r.start)).join(', ') || 'aucune plage'}) : ${outRange.join(', ')}. Wazo refusera tout l'import : élargir les plages du contexte (Portal) ou changer les numéros.`);
  const ext = new Map((t.extensions || []).filter((e) => e.context === ctx).map((e) => [e.exten, e]));
  const taken = users.filter((u) => ext.has(u.n)).map((u) => u.n);
  if (taken.length) add('error', `Contexte ${c.label || c.name}`, `numéro(s) déjà utilisés dans ce contexte : ${taken.join(', ')}.`);
  if (incallCtx) {
    const inc = new Set((t.extensions || []).filter((e) => e.context === incallCtx).map((e) => e.exten));
    const dids = d.dids.filter((r) => r.import && r.viaCsv && r.dest.t === 'user' && inc.has(r.did)).map((r) => r.did);
    if (dids.length) add('error', 'SDA', `SDA déjà présentes dans le contexte entrant : ${dids.join(', ')}. Décochez « CSV » dans l'onglet SDA pour celles-ci.`);
  }
  const vms = new Set((t.voicemails || []).filter((v) => v.context === ctx).map((v) => v.number));
  const vmTaken = users.filter((u) => u.vm && vms.has(u.n)).map((u) => u.n);
  if (vmTaken.length) add('warn', 'Messageries', `messagerie(s) déjà présentes (${vmTaken.join(', ')}) : l'import les rattache aux nouveaux utilisateurs au lieu d'en créer.`);
  const mails = new Map((t.users || []).filter((u) => u.email).map((u) => [u.email.toLowerCase(), u]));
  const seen = new Map();
  for (const u of users.filter((x) => x.email)) {
    const k = u.email.toLowerCase();
    if (mails.has(k)) add('warn', `Utilisateur ${u.n}`, `e-mail ${u.email} déjà utilisé dans le tenant (${[mails.get(k).firstname, mails.get(k).lastname].filter(Boolean).join(' ')}).`);
    if (seen.has(k)) add('warn', `Utilisateur ${u.n}`, `même e-mail que ${seen.get(k)} dans le brouillon.`);
    seen.set(k, u.n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exports depuis le brouillon
// ---------------------------------------------------------------------------
// CSV d'import utilisateurs de Wazo (colonnes de confd user_import/csvparse.py ;
// ring_seconds en fait partie). Les codes de messagerie ne sont jamais stockés
// dans le brouillon (navigateur, fichier partageable) : `pins` est lu dans la
// sauvegarde 3CX au moment de l'export ({ numéro: code }).
export function usersCsv(d, { ctx, incallCtx, pins = {} }) {
  // subscription_type : IntRule de USER_RULES ; username : WAZO_USER_RULES (vide
  // → Wazo prend l'e-mail). Ni méthode de connexion ni accès aux applications
  // dans le CSV (WazoUserSchema) : à poser après l'import.
  // Une seule ligne par utilisateur dans le CSV (SIP, ou WebRTC si c'est la
  // seule demandée) : la seconde ligne d'un « SIP + WebRTC » n'est créée que
  // par l'écriture guidée.
  const cols = ['firstname', 'lastname', 'email', 'mobile_phone_number', 'enabled', 'subscription_type', 'ring_seconds', 'context', 'line_protocol', 'exten', 'voicemail_name', 'voicemail_number', 'voicemail_context', 'voicemail_password', 'voicemail_email', 'voicemail_attach_audio', 'voicemail_delete_messages', 'voicemail_ask_password', 'incall_exten', 'incall_context', 'username'];
  const did = new Map();
  for (const r of d.dids) if (r.import && r.viaCsv && r.dest.t === 'user' && !did.has(r.dest.ref)) did.set(r.dest.ref, r.did);
  const q = (s) => (/[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));
  const rows = imported(d).map((u) => {
    const pin = u.vm && u.vmPin && /^\d+$/.test(pins[u.n] || '') ? pins[u.n] : '';
    const o = u.vmo || defaultVmo(); const mail = u.vm ? vmEmail(u) : '';
    const v = {
      firstname: u.first || (u.last ? '' : `Poste ${u.n}`), lastname: u.last, email: u.email, mobile_phone_number: u.mobile, enabled: '1', subscription_type: u.sub ?? '', ring_seconds: u.ring, context: ctx, line_protocol: linesOf(u)[0], exten: u.n,
      voicemail_name: u.vm ? userName(u) : '', voicemail_number: u.vm ? u.n : '', voicemail_context: u.vm ? ctx : '', voicemail_password: pin,
      voicemail_email: mail, voicemail_attach_audio: mail ? (o.attach ? '1' : '0') : '', voicemail_delete_messages: u.vm ? (o.del && mail && o.attach ? '1' : '0') : '', voicemail_ask_password: u.vm ? (o.ask ? '1' : '0') : '', incall_exten: did.get(u.n) || '', incall_context: did.has(u.n) ? incallCtx : '', username: u.username || '',
    };
    return cols.map((c) => q(v[c])).join(',');
  });
  return [cols.join(','), ...rows].join('\r\n');
}
// Appareils : MAC (format Wazo), modèle, description, utilisateur associé.
export function devicesCsv(d) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = (d.devices || []).filter((x) => x.import).map((dv) => { const u = dv.owner ? userBy(d, dv.owner) : null; return [dv.mac, dv.vendor, dv.model, deviceDesc(d, dv), dv.owner || '', u ? userName(u) : ''].map(q).join(';'); });
  return '﻿' + [['mac', 'marque', 'modele', 'description', 'numero', 'utilisateur'].join(';'), ...rows].join('\r\n');
}
// Touches : reprise alignée sur le brouillon (poste et cible repris, doublons).
export function blfRows(d, m) {
  const out = [];
  for (const e of m.extensions) {
    const u = userBy(d, e.number);
    const seen = new Set();
    for (const b of e.blfs) {
      const t = userBy(d, b.target);
      let status = 'oui';
      if (!u || u.mode !== 'user') status = 'non (poste non repris)';
      else if (!u.blf) status = 'non (touches non reprises pour ce poste)';
      else if (b.type === 'SharedParking') status = 'oui';
      else if (!m.dn.has(b.target)) status = 'non (cible absente)';
      else if (m.dn.get(b.target).kind === 'Extension' && t?.mode !== 'user') status = 'non (cible non reprise)';
      else if (seen.has(b.target)) status = 'non (doublon)';
      if (b.type !== 'SharedParking') seen.add(b.target);
      out.push({ owner: e.number, ownerName: u ? userName(u) : '', pos: b.pos, wpos: b.pos + (d.blfOffset ?? 1), type: b.type === 'SharedParking' ? 'parking' : 'supervision', target: b.target, targetName: t ? userName(t) : (m.dn.get(b.target)?.name || ''), status, ok: status === 'oui' });
    }
  }
  return out;
}
