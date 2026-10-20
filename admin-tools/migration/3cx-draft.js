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
import { nameOf, schedulesOf, STRATEGY } from './3cx.js?v=0.40.21';

export const DRAFT_FORMAT = 'astrea-3cx-draft';
const KEY = 'astrea-migration-3cx-draft-v1';

// Stratégies Wazo d'un groupe (confd group ring_strategy, lu) et libellés.
export const GROUP_STRATEGIES = { all: 'Tous en même temps', linear: 'Un par un, dans l\'ordre', random: 'Aléatoire', least_recent: 'Le moins récemment appelé', fewest_calls: 'Le moins d\'appels pris', memorized_round_robin: 'Tour de rôle mémorisé', weight_random: 'Aléatoire pondéré' };
// Équivalent file d'attente (option Asterisk « strategy » des files Wazo, supposé).
export const QUEUE_STRATEGY = { all: 'ringall', linear: 'linear', random: 'random', least_recent: 'leastrecent', fewest_calls: 'fewestcalls', memorized_round_robin: 'rrmemory', weight_random: 'wrandom' };
export const MODES = { user: 'Utilisateur', voicemail: 'Messagerie seule', skip: 'Non repris' };
export const HUNT_TARGETS = { group: 'Groupe d\'appel', queue: 'File d\'attente', skip: 'Non repris' };

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
  return { format: DRAFT_FORMAT, version: 1, file, sourceDate: m.date, company: m.company, createdAt: new Date().toISOString(), users, devices: buildDevices(m, users), hunts, ivrs, dids, schedules, holidays, blfOffset: 1 };
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
    for (const [k, l] of [['noanswer', 'pas de réponse'], ['busy', 'occupé'], ['fail', 'indisponible']]) { const p = destProblem(d, u.fb[k]); if (p) add('warn', `${w} renvoi ${l}`, u.fb[k]?.t === 'none' ? `${p}.` : `${destLabel(d, u.fb[k])} : ${p}.`); }
  }
  for (const u of d.users.filter((x) => x.mode === 'voicemail')) if (!u.vm) add('warn', `Messagerie ${u.n}`, 'reprise en « messagerie seule » mais la messagerie est décochée.');
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
// Exports depuis le brouillon
// ---------------------------------------------------------------------------
// CSV d'import utilisateurs de Wazo (colonnes de confd user_import/csvparse.py ;
// ring_seconds en fait partie). Les codes de messagerie ne sont jamais stockés
// dans le brouillon (navigateur, fichier partageable) : `pins` est lu dans la
// sauvegarde 3CX au moment de l'export ({ numéro: code }).
export function usersCsv(d, { ctx, incallCtx, pins = {} }) {
  const cols = ['firstname', 'lastname', 'email', 'mobile_phone_number', 'enabled', 'ring_seconds', 'context', 'line_protocol', 'exten', 'voicemail_name', 'voicemail_number', 'voicemail_context', 'voicemail_password', 'voicemail_email', 'voicemail_attach_audio', 'incall_exten', 'incall_context', 'username'];
  const did = new Map();
  for (const r of d.dids) if (r.import && r.viaCsv && r.dest.t === 'user' && !did.has(r.dest.ref)) did.set(r.dest.ref, r.did);
  const q = (s) => (/[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));
  const rows = imported(d).map((u) => {
    const pin = u.vm && u.vmPin && /^\d+$/.test(pins[u.n] || '') ? pins[u.n] : '';
    const v = {
      firstname: u.first || (u.last ? '' : `Poste ${u.n}`), lastname: u.last, email: u.email, mobile_phone_number: u.mobile, enabled: '1', ring_seconds: u.ring, context: ctx, line_protocol: 'sip', exten: u.n,
      voicemail_name: u.vm ? userName(u) : '', voicemail_number: u.vm ? u.n : '', voicemail_context: u.vm ? ctx : '', voicemail_password: pin,
      voicemail_email: u.vm ? u.email : '', voicemail_attach_audio: u.vm && u.email ? '1' : '', incall_exten: did.get(u.n) || '', incall_context: did.has(u.n) ? incallCtx : '', username: '',
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
