// Migration Assistant — lot 4 : lecture d'une sauvegarde 3CX (XML) et
// correspondance avec Wazo (sans DOM de page, sans réseau : le fichier est lu
// dans le navigateur et n'est envoyé nulle part).
// Format relevé sur une sauvegarde 3CX v20.0.9 réelle (19/10/2026) :
//  PhoneSystem > Tenants > Tenant > DN > Extension | RingGroup | Queue | IVR |
//  ExternalLine | ParkExtension | FaxExtension | ConferencePlaceExtension | SpecialMenu ;
//  Tenant > Groups (heures de bureau / pause par groupe, __DEFAULT__ = société),
//  OfficeHolidays, OutboundRules, PhoneBookEntries ; PhoneSystem > Gateways
//  (VoipProvider = trunk) ; Parameters (musique d'attente).
//  - destination : <To>Extension|VoiceMail|Queue|RingGroup|IVR|External|None…</To>
//    + <Internal DN="…"/> + <External>numéro</External> ;
//    route texte « VoiceMail.001. », « ProceedWithNoExceptions.. » (= continuer) ;
//  - touches BLF : XML échappé dans PhoneDevice/Settings et la propriété
//    SHARED_BLFS : <BLF BLFNo="1" BLFType="BLF|SharedParking">cible</BLF> ;
//  - propriétés : Properties/DNProperty{Name, Value}.
// Supposé (à confirmer sur un poste) : BLFNo n = n-ième touche après la touche de ligne.

const T = (n, sel) => n?.querySelector(`:scope > ${sel}`) || null;
const txt = (n, sel) => (T(n, sel)?.textContent ?? '').trim();
const all = (n, sel) => [...(n?.querySelectorAll(`:scope > ${sel}`) || [])];
const prop = (n, name) => { const p = all(T(n, 'Properties'), 'DNProperty').find((x) => txt(x, 'Name') === name); return p ? txt(p, 'Value') : ''; };
const DAYS = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
const DAYS_FR = ['', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
const SECRET = '***';

// Destination d'un nœud <…Destination> ou d'une route texte.
function destOf(node) {
  if (!node) return null;
  const to = txt(node, 'To');
  if (!to) return null;
  return { to, dn: T(node, 'Internal')?.getAttribute('DN') || '', external: txt(node, 'External') };
}
function routeOf(s) {
  const [to, dn] = String(s || '').split('.');
  if (!to || to === 'ProceedWithNoExceptions') return null;
  return { to, dn: dn || '', external: '' };
}
// Heures : [{ day (1-7), from, to }] ; type AllHours / OfficeHours / Specific…
function hoursOf(node) {
  if (!node) return { type: 'AllHours', periods: [] };
  const periods = [];
  for (const d of all(node, 'PeriodsOfDay')) for (const p of all(d, 'PeriodOfDay')) periods.push({ day: DAYS[d.getAttribute('DayOfWeek')] || 0, from: p.getAttribute('begin'), to: p.getAttribute('end') });
  return { type: node.getAttribute('HoursType') || node.getAttribute('Type') || 'AllHours', periods };
}
export function periodsText(periods) {
  const byDay = new Map();
  for (const p of periods) byDay.set(p.day, [...(byDay.get(p.day) || []), `${p.from}-${p.to}`]);
  // Jours consécutifs aux mêmes heures regroupés : « lun.-ven. 09:00-12:00 ».
  const out = []; let run = null;
  for (const d of [1, 2, 3, 4, 5, 6, 7]) {
    const h = (byDay.get(d) || []).join(', ');
    if (run && h && run.h === h && run.to === d - 1) run.to = d;
    else { if (run) out.push(run); run = h ? { from: d, to: d, h } : null; }
  }
  if (run) out.push(run);
  return out.map((r) => `${DAYS_FR[r.from]}${r.to !== r.from ? `-${DAYS_FR[r.to]}` : ''} ${r.h}`).join(' ; ') || 'aucune plage';
}
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };
const toHm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// Heures d'ouverture d'un groupe 3CX = heures de bureau moins la pause.
function openMinusBreak(open, brk) {
  const out = [];
  for (const p of open) {
    let segs = [[toMin(p.from), toMin(p.to)]];
    for (const b of brk.filter((x) => x.day === p.day)) {
      const [bs, be] = [toMin(b.from), toMin(b.to)];
      segs = segs.flatMap(([s, e]) => (be <= s || bs >= e ? [[s, e]] : [[s, Math.min(bs, e)], [Math.max(be, s), e]].filter(([a, z]) => z > a)));
    }
    for (const [s, e] of segs) out.push({ day: p.day, from: toHm(s), to: toHm(e) });
  }
  return out.sort((a, b) => a.day - b.day || a.from.localeCompare(b.from));
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------
export function parse3cx(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('fichier XML illisible');
  const root = doc.documentElement;
  if (root?.nodeName !== 'PhoneSystem') throw new Error('ce n\'est pas une sauvegarde 3CX (racine PhoneSystem attendue)');
  const tenant = root.querySelector(':scope > Tenants > Tenant');
  if (!tenant) throw new Error('aucun Tenant dans le fichier');
  const dn = T(tenant, 'DN');
  const m = {
    version: txt(T(root, 'header'), 'version'), date: txt(T(root, 'header'), 'Date'),
    company: txt(T(root, 'license'), 'company'), fqdn: txt(T(root, 'fqdn'), 'externalFqdn'),
    dn: new Map(), extensions: [], ringGroups: [], queues: [], ivrs: [], inbound: [], trunks: [], outbound: [],
    groups: [], holidays: [], parks: [], others: [], prompts: new Set(), phonebook: [],
  };
  const addPrompt = (f) => { if (f && /\.(wav|mp3)$/i.test(f)) m.prompts.add(f.split('/').pop()); };
  const reg = (kind, number, name, obj) => { if (number) m.dn.set(number, { kind, name, obj }); };

  // Postes
  for (const e of all(dn, 'Extension')) {
    const number = txt(e, 'Number');
    const blfs = [];
    const devices = all(T(e, 'PhoneDevices'), 'PhoneDevice').map((d) => ({ mac: txt(d, 'MAC'), model: txt(d, 'ProvisioningFilename2'), template: txt(d, 'TemplateFilename') }));
    const settingsXml = [...all(T(e, 'PhoneDevices'), 'PhoneDevice').map((d) => txt(d, 'Settings')), prop(e, 'SHARED_BLFS')];
    const seen = new Set();
    for (const sx of settingsXml) {
      if (!sx) continue;
      const sd = new DOMParser().parseFromString(sx, 'text/xml');
      if (sd.querySelector('parsererror')) continue;
      for (const b of sd.querySelectorAll('BLF')) {
        const k = `${b.getAttribute('BLFNo')}|${b.getAttribute('BLFType')}|${b.textContent.trim()}`;
        if (seen.has(k)) continue; seen.add(k);
        blfs.push({ pos: Number(b.getAttribute('BLFNo')), type: b.getAttribute('BLFType'), target: b.textContent.trim() });
      }
    }
    blfs.sort((a, b) => a.pos - b.pos);
    const fwd = {};
    const avail = all(T(e, 'FwdProfiles'), 'FwdProfile').find((p) => txt(p, 'Name') === 'Available');
    if (avail) {
      const route = T(avail, 'AvailableRoute');
      for (const k of ['NoAnswer', 'Busy', 'NotRegistered']) { const n = T(route, k); const d = destOf(T(n, 'AllCalls')); if (d && d.to !== 'None') fwd[k] = d; }
      fwd.timeout = Number(txt(avail, 'NoAnswerTimeout')) || 0;
      fwd.ringMobile = txt(avail, 'RingMyMobile') === 'True';
    }
    const mobile = prop(e, 'MOBILENUMBER');
    const x = {
      number, first: txt(e, 'FirstName'), last: txt(e, 'LastName'), email: txt(e, 'EmailAddress'),
      enabled: txt(e, 'Enabled') !== 'False', mobile: /^\+?\d{6,}$/.test(mobile) ? mobile : '',
      vm: { enabled: txt(e, 'VMEnabled') === 'True', pin: txt(e, 'VMPIN') }, recordCalls: txt(e, 'RecordCalls') === 'True',
      authId: txt(e, 'AuthID'), devices, blfs, fwd,
    };
    m.extensions.push(x); reg('Extension', number, [x.first, x.last].filter(Boolean).join(' '), x);
  }
  for (const g of all(dn, 'RingGroup')) {
    const x = { number: txt(g, 'Number'), name: txt(g, 'Name'), strategy: txt(g, 'RingStrategy'), ringTime: Number(txt(g, 'RingTime')) || 0, members: all(T(g, 'Members'), 'Member').map((y) => y.getAttribute('DN')), dest: destOf(T(g, 'Destination')), routes: routesOf(g) };
    m.ringGroups.push(x); reg('RingGroup', x.number, x.name, x);
  }
  for (const q of all(dn, 'Queue')) {
    const x = {
      number: txt(q, 'Number'), name: txt(q, 'Name'), strategy: txt(q, 'PollingStrategy'), ringTimeout: Number(txt(q, 'RingTimeout')) || 0, masterTimeout: Number(txt(q, 'MasterTimeout')) || 0,
      members: all(T(q, 'Members'), 'Member').map((y) => y.getAttribute('DN')), dest: destOf(T(q, 'Destination')),
      intro: txt(q, 'EnableIntro') === 'True' ? txt(q, 'IntroFile') : '', onHold: txt(q, 'OnHoldFile'), announce: Number(txt(q, 'AnnouncementInterval')) || 0, routes: routesOf(q),
    };
    addPrompt(x.intro); addPrompt(x.onHold);
    m.queues.push(x); reg('Queue', x.number, x.name, x);
  }
  for (const v of all(dn, 'IVR')) {
    const x = {
      number: txt(v, 'Number'), name: txt(v, 'Name'), prompt: txt(v, 'PromptFilename'), timeout: Number(txt(v, 'Timeout')) || 0,
      timeoutDest: { to: txt(v, 'TimeoutForwardType'), dn: txt(v, 'TimeoutForwardDN'), external: '' },
      choices: all(T(v, 'Forwards'), 'IVRForward').map((f) => ({ key: txt(f, 'Number'), to: txt(f, 'ForwardType'), dn: txt(f, 'ForwardDN'), external: txt(f, 'CustomData') })),
      routes: routesOf(v),
    };
    // SVI internes de 3CX (code PIN, rappel de file) : sans équivalent, ignorés.
    x.system = x.name === 'PIN Protect IVR' || x.name === 'QueueCallback' || !/^\d+$/.test(x.number);
    addPrompt(x.prompt);
    m.ivrs.push(x); reg('IVR', x.number, x.name, x);
  }
  for (const k of ['ParkExtension', 'FaxExtension', 'ConferencePlaceExtension', 'SpecialMenu']) for (const o of all(dn, k)) { const x = { kind: k, number: txt(o, 'Number'), name: txt(o, 'Name') }; (k === 'ParkExtension' ? m.parks : m.others).push(x); reg(k, x.number, x.name, x); }

  // Trunks : passerelles (VoipProvider) + lignes externes (SDA, routage)
  const gws = new Map([...(root.querySelectorAll(':scope > Gateways > *'))].map((g) => [txt(g, 'Name'), { name: txt(g, 'Name'), type: g.nodeName, host: txt(g, 'Host'), proxy: txt(g, 'ProxyHost'), codecs: [...g.querySelectorAll('Codecs > codec')].map((c) => c.getAttribute('RFCName')) }]));
  for (const l of all(dn, 'ExternalLine')) {
    const gw = gws.get(txt(l, 'Gateway'));
    if (!gw || gw.type !== 'VoipProvider') continue; // pont WebMeeting et passerelles internes de 3CX
    const dids = txt(l, 'DIDNumbers').split(',').map((s) => s.trim()).filter(Boolean);
    m.trunks.push({ name: gw.name, host: gw.host, proxy: gw.proxy, codecs: gw.codecs, authId: txt(l, 'AuthID'), mainNumber: txt(l, 'ExternalNumber'), callerId: txt(l, 'OutboundCallerID'), channels: Number(txt(l, 'SimultaneousCalls')) || 0, dids, number: txt(l, 'Number') });
    for (const r of all(T(l, 'RoutingRules'), 'ExternalLineRule')) {
      const fd = T(r, 'ForwardDestinations');
      const cond = T(r, 'Conditions');
      const altOut = txt(fd, 'AlterDestinationDuringOutOfOfficeHours') === 'True';
      const altHol = txt(fd, 'AlterDestinationDuringHolidays') === 'True';
      const open = destOf(T(fd, 'OfficeHoursDestination'));
      m.inbound.push({
        did: txt(r, 'Data'), name: txt(r, 'RuleName'), trunk: gw.name, condition: T(cond, 'Condition')?.getAttribute('Type') || '',
        hours: hoursOf(T(r, 'Hours')), open, closed: altOut ? destOf(T(fd, 'OutOfOfficeHoursDestination')) : open, holiday: altHol ? destOf(T(fd, 'HolidaysDestination')) : (altOut ? destOf(T(fd, 'OutOfOfficeHoursDestination')) : open),
      });
    }
  }
  // Groupes 3CX : heures de bureau et pause (le groupe __DEFAULT__ porte celles de la société).
  for (const g of all(T(tenant, 'Groups'), 'Group')) {
    const open = hoursOf(T(g, 'Hours')); const brk = hoursOf(T(g, 'BreakTime'));
    m.groups.push({ name: txt(g, 'Name'), members: all(T(g, 'Members'), 'Member').map((y) => y.getAttribute('DN')), hours: open, breakTime: brk, effective: open.type === 'AllHours' ? [] : openMinusBreak(open.periods, brk.periods) });
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const h of all(T(tenant, 'OfficeHolidays'), 'OfficeHoliday')) {
    const rec = txt(h, 'IsRecurrent') === 'True';
    const y = Number(txt(h, 'Year')); const ye = Number(txt(h, 'YearEnd')) || y;
    const end = new Date(ye || today.getFullYear(), Number(txt(h, 'MonthEnd')) - 1, Number(txt(h, 'DayEnd')));
    const x = { name: txt(h, 'Name'), recurrent: rec, day: Number(txt(h, 'Day')), month: Number(txt(h, 'Month')), year: y, dayEnd: Number(txt(h, 'DayEnd')), monthEnd: Number(txt(h, 'MonthEnd')), yearEnd: ye, from: txt(h, 'TimeOfStartDate').slice(0, 5), to: txt(h, 'TimeOfEndDate').slice(0, 5), prompt: txt(h, 'HolidayPrompt') };
    x.past = !rec && end < today;
    if (!x.past) addPrompt(x.prompt);
    m.holidays.push(x);
  }
  for (const r of all(T(tenant, 'OutboundRules'), 'OutboundRule')) {
    m.outbound.push({ name: txt(r, 'Name'), prefix: txt(r, 'Prefix'), priority: Number(txt(r, 'Priority')) || 0, routes: all(T(r, 'OutboundRoutes'), 'OutboundRoute').map((o) => ({ gateway: txt(o, 'Gateway'), strip: Number(txt(o, 'StripDigits')) || 0, prepend: txt(o, 'Prepend') })).filter((o) => o.gateway), groups: all(T(r, 'DNGroups'), 'Group').map((g) => g.textContent.trim()) });
  }
  for (const p of all(T(tenant, 'PhoneBookEntries'), 'PhoneBookEntry')) m.phonebook.push({ first: txt(p, 'FirstName'), last: txt(p, 'LastName'), company: txt(p, 'CompanyName'), number: txt(p, 'PhoneNumber') || txt(p, 'Mobile') });
  const param = (n) => { const p = [...root.querySelectorAll(':scope > Parameters > Parameter')].find((x) => txt(x, 'Name') === n); return p ? txt(p, 'Value') : ''; };
  m.moh = param('MUSICONHOLDFILE').split('/').pop();
  addPrompt(m.moh);
  for (const o of [...m.ringGroups, ...m.queues, ...m.ivrs]) for (const r of Object.values(o.routes)) addPrompt(r.prompt);
  m.prompts = [...m.prompts].sort();
  m.defaultGroup = m.groups.find((g) => g.name === '__DEFAULT__') || null;
  return m;
}
// Routes horaires d'un objet (fermé, férié, pause) avec leur message.
function routesOf(n) {
  const r = {};
  for (const [k, l] of [['OutOfOfficeHours', 'closed'], ['Holidays', 'holiday'], ['BreakTime', 'break']]) {
    const d = routeOf(txt(n, `${k}Route`));
    if (d) r[l] = { ...d, prompt: txt(n, `${k}RoutePromptEnabled`) === 'True' ? txt(n, `${k}RoutePrompt`) : '' };
  }
  r.hours = hoursOf(T(n, 'Hours'));
  return r;
}

// ---------------------------------------------------------------------------
// Correspondance avec Wazo
// ---------------------------------------------------------------------------
// Nom à reprendre : celui de 3CX, sauf s'il ne contient que des initiales
// (« JM ») et que l'e-mail est de la forme prenom.nom@ : on propose alors le
// nom déduit de l'e-mail (« Jeanne Martin »), marqué « déduit ».
const cap = (s) => s.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
export function nameOf(e) {
  const first = e.first || ''; const last = e.last || '';
  const initials = !last && /^[A-ZÀ-Ý]{1,4}$/.test(first);
  const m = String(e.email || '').toLowerCase().match(/^([a-zà-ÿ-]+)\.([a-zà-ÿ-]+)@/);
  if ((initials || (!first && !last)) && m) return { first: cap(m[1]), last: cap(m[2]), guessed: true };
  return { first, last, guessed: false };
}
export const KIND_FR = { Extension: 'Utilisateur', RingGroup: 'Groupe', Queue: 'File d\'attente', IVR: 'SVI', ParkExtension: 'Parking', FaxExtension: 'Fax', ConferencePlaceExtension: 'Conférence', SpecialMenu: 'Menu spécial' };
export const STRATEGY = { RingAll: 'all', Hunt: 'linear', HuntRandomStart: 'random', LongestWaiting: 'least_recent', LeastTalkTime: 'fewest_calls', FewestAnswered: 'fewest_calls', RoundRobin: 'memorized_round_robin', Paging: 'all' };
export const STRATEGY_FR = { all: 'tous en même temps', linear: 'un par un, dans l\'ordre', random: 'aléatoire', least_recent: 'le moins récemment appelé', fewest_calls: 'le moins d\'appels', memorized_round_robin: 'tour de rôle mémorisé' };
// Texte d'une destination 3CX, avec sa cible Wazo.
export function destText(m, d) {
  if (!d) return 'continuer';
  const t = m.dn.get(d.dn);
  const name = t ? ` ${d.dn} (${t.name || '?'})` : d.dn ? ` ${d.dn} (introuvable)` : '';
  switch (d.to) {
    case 'Extension': return d.dn ? `Utilisateur${name}` : 'Poste non précisé';
    case 'VoiceMail': return d.dn ? `Messagerie de${name}` : 'Messagerie non précisée';
    case 'Queue': return `File d'attente${name}`;
    case 'RingGroup': return `Groupe${name}`;
    case 'IVR': return d.dn ? `SVI${name}` : 'Message de fermeture du jour férié';
    case 'External': return `Numéro externe ${d.external}`;
    case 'None': case 'EndCall': return 'Raccrocher';
    default: return `${d.to}${name}`;
  }
}
// Points à vérifier avant ou pendant la reprise.
export function issuesOf(m) {
  const out = [];
  const seen = new Set();
  const add = (sev, area, text) => { const k = `${area}|${text}`; if (!seen.has(k)) { seen.add(k); out.push({ sev, area, text }); } };
  const known = (n) => m.dn.has(n);
  const dids = new Set(m.trunks.flatMap((t) => t.dids));
  const selfFwd = new Map(); // numéro du client visé par un renvoi → qui
  const checkDest = (where, d, who = where) => {
    if (!d) return;
    if (['Extension', 'VoiceMail'].includes(d.to) && !d.dn) add('warn', where, `destination « ${d.to} » sans poste dans 3CX : à préciser.`);
    else if (d.dn && !known(d.dn)) add('error', where, `destination vers ${d.dn}, absent de la sauvegarde.`);
    if (d.to === 'VoiceMail' && d.dn && m.dn.get(d.dn)?.kind === 'Extension' && !m.dn.get(d.dn).obj.vm.enabled) add('warn', `Messagerie ${d.dn}`, `visée par le routage mais désactivée sur ce poste dans 3CX : à créer quand même dans Wazo.`);
    if (d.to === 'External' && dids.has(d.external)) { if (!selfFwd.has(d.external)) selfFwd.set(d.external, new Set()); selfFwd.get(d.external).add(who); }
  };
  for (const r of m.inbound) {
    const w = `SDA ${r.did || '(règle par défaut)'}`;
    checkDest(w, r.open); checkDest(w, r.closed); checkDest(w, r.holiday);
    if (r.open?.to === 'None') add('info', w, 'en heures d\'ouverture : aucune destination (appel rejeté) ; numéro réservé ?');
  }
  const ruled = new Set(m.inbound.map((r) => r.did));
  const free = [...dids].filter((d) => !ruled.has(d));
  if (free.length) add('info', 'SDA', `${free.length} SDA sans règle propre (règle par défaut de 3CX) : ${free.join(', ')}.`);
  for (const g of m.ringGroups) { checkDest(`Groupe ${g.number}`, g.dest, `groupe ${g.number}`); for (const x of g.members) if (!known(x)) add('error', `Groupe ${g.number}`, `membre ${x} absent.`); if (g.members.length === 1) add('info', `Groupe ${g.number}`, `un seul membre (${g.members[0]}) : un groupe est-il utile ?`); }
  for (const q of m.queues) { checkDest(`File ${q.number}`, q.dest); }
  for (const v of m.ivrs.filter((x) => !x.system)) { checkDest(`SVI ${v.number}`, v.timeoutDest.to === 'EndCall' ? null : v.timeoutDest); for (const c of v.choices) checkDest(`SVI ${v.number} touche ${c.key}`, c); }
  for (const e of m.extensions) {
    const w = `Poste ${e.number}`;
    if (!e.first && !e.last && !nameOf(e).guessed) add('warn', w, e.devices.length ? `sans nom : repris sous « Poste ${e.number} », à renommer.` : 'sans nom.');
    if (!e.enabled) add('info', w, 'désactivé dans 3CX : à reprendre ?');
    if (e.enabled && !e.devices.length) add('info', w, e.vm.enabled ? `sans appareil, messagerie active (« ${[e.first, e.last].filter(Boolean).join(' ')} ») : dans Wazo, une messagerie seule suffit sans doute (sans utilisateur).` : 'sans appareil : compte à reprendre (softphone, application) ou non ?');
    if (e.devices.length > 1) add('info', w, `${e.devices.length} appareils.`);
    const bad = e.blfs.filter((b) => b.type === 'BLF' && !known(b.target)).map((b) => b.target);
    if (bad.length) add('warn', w, `${bad.length} touche(s) BLF vers des numéros absents (anciens postes ?) : ${[...new Set(bad)].join(', ')}. Elles ne seront pas reprises.`);
    for (const [k, d] of Object.entries(e.fwd)) if (d && typeof d === 'object') checkDest(`${w} renvoi ${k === 'NoAnswer' ? 'pas de réponse' : k === 'Busy' ? 'occupé' : 'non enregistré'}`, d, `poste ${e.number}`);
  }
  // Renvois vers un numéro du client : une ligne par numéro, avec la cible Wazo conseillée.
  for (const [num, who] of selfFwd) {
    const rule = m.inbound.find((r) => r.did === num);
    const list = [...who];
    add('info', `Renvois vers ${num}`, `${list.length} renvoi(s) vers ce numéro du client (${list.slice(0, 8).join(', ')}${list.length > 8 ? '…' : ''}) : l'appel ressort par le trunk puis revient. Dans Wazo, viser directement ${rule ? destText(m, rule.open) : 'sa destination'} (débordements de l'utilisateur ou du groupe).`);
  }
  const past = m.holidays.filter((h) => h.past).length;
  if (past) add('info', 'Jours fériés', `${past} fermeture(s) passée(s), non reprises.`);
  if (m.ivrs.some((v) => v.system)) add('info', 'SVI', `SVI internes de 3CX ignorés : ${m.ivrs.filter((v) => v.system).map((v) => `${v.name} (${v.number})`).join(', ')}.`);
  return out;
}

// Horaires Wazo à créer : un par jeu de plages distinct (dédoublonné).
// Une règle « OfficeHours » prend les heures du groupe __DEFAULT__ (heures de
// bureau moins la pause) ; « Specific… » ses propres plages ; AllHours : aucun horaire.
export function schedulesOf(m) {
  const map = new Map();
  const key = (p) => p.map((x) => `${x.day}:${x.from}-${x.to}`).join('|');
  const use = (periods, who) => {
    if (!periods.length) return null;
    const k = key(periods);
    if (!map.has(k)) map.set(k, { periods, users: [] });
    map.get(k).users.push(who);
    return k;
  };
  for (const r of m.inbound) {
    const t = r.hours.type;
    const p = t === 'OfficeHours' ? (m.defaultGroup?.effective || []) : t === 'AllHours' ? [] : r.hours.periods;
    r.scheduleKey = use(p, `SDA ${r.did || 'par défaut'}`);
  }
  const holidays = m.holidays.filter((h) => !h.past);
  return [...map.values()].map((s, i) => ({ ...s, name: i === 0 ? 'Heures de bureau' : `Horaire ${i + 1}`, text: periodsText(s.periods), holidays }));
}

// CSV d'import utilisateurs de Wazo (colonnes de confd user_import/csvparse.py,
// séparateur virgule, booléens 1/0). `ctx` = nom technique du contexte interne,
// `incallCtx` = contexte entrant (SDA directes), `opt.vmPin` = reprendre le code
// de messagerie.
// Postes repris dans Wazo (même règle pour le CSV d'import et la reprise des
// touches) : actifs, avec un appareil ou un nom ; sans appareil exclus sur option.
// Un poste sans nom mais avec appareil est repris sous « Poste NNN » (cas réel :
// poste 030, un T46S qui reçoit une SDA).
export function importedExtensions(m, { skipNoDevice = false } = {}) {
  return m.extensions.filter((e) => e.enabled && (e.devices.length || e.first || e.last || nameOf(e).guessed) && (!skipNoDevice || e.devices.length));
}
// Reprise de chaque touche, alignée sur le CSV d'import : poste non repris,
// cible absente de la sauvegarde, cible non reprise (poste exclu), doublon
// (même cible déjà sur une touche précédente du poste). Map numéro → touches.
export function blfStatus(m, { skipNoDevice = false } = {}) {
  const kept = new Set(importedExtensions(m, { skipNoDevice }).map((e) => e.number));
  const out = new Map();
  for (const e of m.extensions) {
    const seen = new Set();
    out.set(e.number, e.blfs.map((b) => {
      let status = 'oui';
      const t = m.dn.get(b.target);
      if (!kept.has(e.number)) status = 'non (poste non repris)';
      else if (b.type === 'SharedParking') status = 'oui';
      else if (!t) status = 'non (cible absente)';
      else if (t.kind === 'Extension' && !kept.has(b.target)) status = 'non (cible non reprise)';
      else if (seen.has(b.target)) status = 'non (doublon)';
      if (b.type !== 'SharedParking') seen.add(b.target);
      return { ...b, status, ok: status === 'oui' };
    }));
  }
  return out;
}
export function wazoUsersCsv(m, { ctx, incallCtx, vmPin = false, withDids = true, guessNames = true, skipNoDevice = false } = {}) {
  const cols = ['firstname', 'lastname', 'email', 'mobile_phone_number', 'enabled', 'context', 'line_protocol', 'exten', 'voicemail_name', 'voicemail_number', 'voicemail_context', 'voicemail_password', 'voicemail_email', 'voicemail_attach_audio', 'incall_exten', 'incall_context', 'username'];
  const directDid = new Map();
  if (withDids) for (const r of m.inbound) if (r.did && r.open?.to === 'Extension' && r.open.dn && !directDid.has(r.open.dn)) directDid.set(r.open.dn, r.did);
  const q = (s) => (/[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));
  const rows = importedExtensions(m, { skipNoDevice }).map((e) => {
    const vm = e.vm.enabled;
    const n = guessNames ? nameOf(e) : { first: e.first, last: e.last };
    const v = {
      firstname: n.first || (n.last ? '' : `Poste ${e.number}`), lastname: n.last, email: e.email, mobile_phone_number: e.mobile, enabled: '1', context: ctx, line_protocol: 'sip', exten: e.number,
      voicemail_name: vm ? [n.first, n.last].filter(Boolean).join(' ') : '', voicemail_number: vm ? e.number : '', voicemail_context: vm ? ctx : '',
      voicemail_password: vm && vmPin && /^\d+$/.test(e.vm.pin) ? e.vm.pin : '', voicemail_email: vm ? e.email : '', voicemail_attach_audio: vm && e.email ? '1' : '',
      incall_exten: directDid.get(e.number) || '', incall_context: directDid.has(e.number) ? incallCtx : '', username: '',
    };
    return cols.map((c) => q(v[c])).join(',');
  });
  return [cols.join(','), ...rows].join('\r\n');
}
// Version sans secrets du modèle (pour un export JSON de la fiche).
export function redacted(m) {
  return JSON.parse(JSON.stringify({ ...m, dn: undefined }, (k, v) => (['authId', 'pin'].includes(k) && v ? SECRET : v)));
}
