// User Manager — réglages modifiables en masse (lots 2a et 2b). Chaque réglage :
//  read(u)            valeur actuelle, lue sur un utilisateur (GET /users/{uuid})
//  form(ctx)          champs du dialogue (ids m-*), parse(ctx) → { target(cur), desc }
//                     (lève une Error si la saisie est invalide)
//  text(v, ctx)       valeur lisible (aperçu, sauvegarde)
//  check(u, v)        message si l'écriture est impossible pour cet utilisateur
//  write(u, v, cur)   écriture (seulement si v diffère de cur)
//  prefill(v, u)      valeurs des champs (id → valeur) pour la fiche ; sans prefill,
//                     la fiche met v dans #m-v s'il existe
//  single             true = fiche seulement (champ propre à chaque utilisateur)
//  showIf(u)          fiche : réglage affiché seulement si vrai pour cet utilisateur
//  heavy              true = l'écriture recharge Asterisk (écritures espacées, ou
//                     regroupées en coupant le live reload) ; reload = type de
//                     rechargement à redéclencher à la fin ('user')
// Routes et sémantique vérifiées dans le code de wazo-confd (13/10/2026),
// voir docs/USER-MANAGER.md. Écritures non encore testées en réel.
import { api, esc, fullName } from '../common/core.js?v=0.27.2';

// Comparaison indépendante de l'ordre des clés (objets relus vs construits).
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v ?? null);
export const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const $v = (id) => document.getElementById(id)?.value ?? '';
const onOff = (label) => `<label>${esc(label)} <select id="m-v"><option value="1">Activé</option><option value="0">Désactivé</option></select></label>`;
const sortedIds = (arr, key) => (arr || []).map((x) => x[key]).filter((x) => x != null).sort();
const options = (items, sel) => items.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(t)}</option>`).join('');
export const LANG = { fr_FR: 'Français', fr_CA: 'Français (CA)', en_US: 'Anglais', de_DE: 'Allemand', es_ES: 'Espagnol', it_IT: 'Italien', nl_NL: 'Néerlandais' };
const TZ = ['Europe/Paris', 'Europe/Brussels', 'Europe/Luxembourg', 'Europe/Zurich', 'Europe/Monaco', 'America/Montreal', 'America/Guadeloupe', 'America/Martinique', 'America/Cayenne', 'Indian/Reunion', 'Indian/Mayotte', 'Pacific/Noumea', 'Pacific/Tahiti'];

// Champ scalaire de l'utilisateur : PUT /users/{uuid} partiel, seul le champ
// modifié est envoyé (les autres restent tels quels, vérifié dans le code).
const userField = (field) => ({
  read: (u) => u[field] ?? null,
  write: (u, v) => api('PUT', `/users/${u.uuid}`, { [field]: v }),
  heavy: true, reload: 'user',
});
const service = (key, label) => ({
  id: key, label, grp: 'Services', form: () => onOff(label),
  parse: () => { const v = $v('m-v') === '1'; return { target: () => v, desc: `${label} : ${v ? 'activé' : 'désactivé'}` }; },
  prefill: (v) => ({ 'm-v': v ? '1' : '0' }),
  read: (u) => u.services?.[key]?.enabled === true,
  text: (v) => (v ? 'activé' : 'désactivé'),
  write: (u, v) => api('PUT', `/users/${u.uuid}/services/${key}`, { enabled: v }),
});
// Renvoi d'appel : désactiver garde la destination enregistrée (comme le portail).
const forward = (key, label) => ({
  id: `fwd_${key}`, label: `Renvoi ${label}`, grp: 'Renvois d\'appel (utilisateur)',
  form: () => `<label>Action <select id="m-mode"><option value="on">Activer vers un numéro</option><option value="off">Désactiver</option></select></label>
    <label id="m-numl">Numéro de destination <input id="m-v" inputmode="tel" placeholder="0612345678 ou 1001"></label>`,
  wire: () => { const f = () => { document.getElementById('m-numl').hidden = $v('m-mode') !== 'on'; }; document.getElementById('m-mode').addEventListener('change', f); f(); },
  parse: () => {
    if ($v('m-mode') === 'off') return { target: (cur) => ({ enabled: false, destination: cur?.destination ?? null }), desc: `Renvoi ${label} : désactivé` };
    const n = $v('m-v').trim();
    if (!/^\+?[0-9*#]{1,40}$/.test(n)) throw new Error('Numéro de destination invalide (chiffres, *, #, + en tête).');
    return { target: () => ({ enabled: true, destination: n }), desc: `Renvoi ${label} : activé vers ${n}` };
  },
  prefill: (v) => ({ 'm-mode': v?.enabled ? 'on' : 'off', 'm-v': v?.destination || '' }),
  read: (u) => ({ enabled: u.forwards?.[key]?.enabled === true, destination: u.forwards?.[key]?.destination ?? null }),
  text: (v) => (v?.enabled ? `→ ${v.destination}` : `désactivé${v?.destination ? ` (${v.destination})` : ''}`),
  write: (u, v) => api('PUT', `/users/${u.uuid}/forwards/${key}`, v),
});
const number = (field, label, min, max, unit = '') => ({
  id: field, label, grp: 'Sonnerie', ...userField(field),
  form: () => `<label>${esc(label)}${unit ? ` (${unit})` : ''} <input id="m-v" type="number" min="${min}" max="${max}"></label>`,
  parse: () => {
    const n = Number($v('m-v'));
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} : entier de ${min} à ${max}.`);
    return { target: () => n, desc: `${label} : ${n}${unit ? ` ${unit}` : ''}` };
  },
  text: (v) => (v == null ? '—' : `${v}${unit ? ` ${unit}` : ''}`),
});
// Ajout / retrait d'un élément dans une liste (groupes, droits d'appel).
const addRemove = (label, items) => `<label>Action <select id="m-mode"><option value="add">Ajouter</option><option value="remove">Retirer</option></select></label>
  <label>${esc(label)} <select id="m-v">${options(items)}</select></label>`;

// ---------------------------------------------------------------------------
// Lot 2b
// ---------------------------------------------------------------------------
// Destination confd réduite aux champs écrivables : sans libellés ajoutés à la
// lecture (user_firstname, group_label…) ni valeurs nulles. null = aucune.
export function normDest(d) {
  if (!d || !d.type || d.type === 'none') return null;
  const o = {};
  for (const [k, v] of Object.entries(d)) if (v != null && k !== 'links' && !/(_name|_label|_firstname|_lastname)$/.test(k)) o[k] = v;
  return o;
}
const lineContext = (u) => { for (const l of u.lines || []) for (const e of l.extensions || []) if (e.context) return e.context; return null; };
const FB_KEYS = ['busy', 'congestion', 'fail', 'noanswer'];
const showSub = (sel, attr) => { const f = () => document.querySelectorAll(`[${attr}]`).forEach((x) => (x.hidden = x.getAttribute(attr) !== $v(sel))); document.getElementById(sel).addEventListener('change', f); f(); };
// Renvoi par défaut (fallback) : PUT /users/{uuid}/fallbacks REMPLACE les 4
// destinations (vérifié dans le code, « delete all fields that are not
// defined ») : on renvoie les 3 autres telles que relues juste avant.
const fallback = (k, label) => ({
  id: `fb_${k}`, label: `Défaut ${label}`, grp: 'Renvois par défaut (admin)',
  form: (c) => `<label>Destination <select id="m-dt">${options([['none', 'Aucune'], ['selfvm', 'Sa propre messagerie'], ['user', 'Un utilisateur'], ['group', 'Un groupe d\'appel'], ['queue', 'Une file d\'attente'], ['switchboard', 'Un standard (POPC)'], ['extension', 'Un numéro'], ['hangup', 'Raccrocher']])}</select></label>
    <div data-dt="user"><label>Utilisateur <select id="m-du">${options(c.users.map((u) => [u.id, fullName(u)]))}</select></label></div>
    <div data-dt="group"><label>Groupe <select id="m-dg">${options([...c.groups.values()].map((g) => [g.id, g.label || g.name]).sort((a, b) => a[1].localeCompare(b[1], 'fr')))}</select></label></div>
    <div data-dt="queue"><label>File d'attente <select id="m-dq">${options([...c.queues.values()].map((q) => [q.id, q.label || q.name]).sort((a, b) => a[1].localeCompare(b[1], 'fr')))}</select></label></div>
    <div data-dt="switchboard"><label>Standard <select id="m-ds">${options([...c.sbs.values()].map((s) => [s.uuid, s.name]).sort((a, b) => a[1].localeCompare(b[1], 'fr')))}</select></label></div>
    <div data-dt="extension"><label>Numéro <input id="m-dn" inputmode="tel" placeholder="0612345678"></label>
      <label>Contexte <select id="m-dc">${options([['@line', 'Celui de la ligne de chaque utilisateur'], ...c.contexts.map((x) => [x.name, `${x.label || x.name}${x.type ? ` (${x.type})` : ''}`])])}</select></label></div>
    <div data-dt="hangup"><label>Cause <select id="m-dh">${options([['normal', 'Normale'], ['busy', 'Occupé'], ['congestion', 'Encombré']])}</select></label></div>`,
  wire: () => showSub('m-dt', 'data-dt'),
  parse: (c) => {
    const t = $v('m-dt');
    const fixed = (d) => ({ target: () => d, desc: `Renvoi par défaut ${label} : ${c.destText(d) || 'aucun'}` });
    if (t === 'none') return fixed(null);
    if (t === 'selfvm') return {
      // Déjà sur sa propre messagerie : on garde tel quel (message d'accueil inclus).
      target: (cur, u) => (cur?.type === 'voicemail' && u.voicemail && cur.voicemail_id === u.voicemail.id ? cur : { type: 'voicemail', voicemail_id: u.voicemail?.id ?? null, skip_instructions: false }),
      desc: `Renvoi par défaut ${label} : sa propre messagerie`,
    };
    const need = (v, what) => { if (!v) throw new Error(`Aucun(e) ${what} disponible.`); return v; };
    if (t === 'user') return fixed({ type: 'user', user_id: Number(need($v('m-du'), 'utilisateur')) });
    if (t === 'group') return fixed({ type: 'group', group_id: Number(need($v('m-dg'), 'groupe')) });
    if (t === 'queue') return fixed({ type: 'queue', queue_id: Number(need($v('m-dq'), 'file d\'attente')) });
    if (t === 'switchboard') return fixed({ type: 'switchboard', switchboard_uuid: need($v('m-ds'), 'standard') });
    if (t === 'hangup') return fixed({ type: 'hangup', cause: $v('m-dh') });
    const n = $v('m-dn').trim(), cx = $v('m-dc');
    if (!/^[0-9*#]{1,255}$/.test(n)) throw new Error('Numéro invalide (chiffres, * et # seulement).');
    if (cx !== '@line') return fixed({ type: 'extension', exten: n, context: cx });
    return { target: (cur, u) => ({ type: 'extension', exten: n, context: lineContext(u) }), desc: `Renvoi par défaut ${label} : numéro ${n} (contexte de la ligne)` };
  },
  prefill: (v, u) => {
    if (!v) return { 'm-dt': 'none' };
    if (v.type === 'voicemail' && u?.voicemail && v.voicemail_id === u.voicemail.id) return { 'm-dt': 'selfvm' };
    const f = { user: ['m-du', v.user_id], group: ['m-dg', v.group_id], queue: ['m-dq', v.queue_id], switchboard: ['m-ds', v.switchboard_uuid], hangup: ['m-dh', v.cause] }[v.type];
    if (f) return { 'm-dt': v.type, [f[0]]: f[1] };
    if (v.type === 'extension') return { 'm-dt': 'extension', 'm-dn': v.exten, 'm-dc': v.context };
    return {};
  },
  read: (u) => normDest(u.fallbacks?.[`${k}_destination`]),
  text: (v, c) => c.destText(v) || 'aucun',
  check: (u, v) => {
    if (v?.type === 'voicemail' && !v.voicemail_id) return 'pas de messagerie';
    if (v?.type === 'user' && v.user_id === u.id) return 'renvoi vers lui-même';
    if (v?.type === 'extension' && !v.context) return 'pas de ligne : contexte inconnu';
    return '';
  },
  write: async (u, v) => {
    await api('PUT', `/users/${u.uuid}/fallbacks`, Object.fromEntries(FB_KEYS.map((x) => [`${x}_destination`, x === k ? v : normDest(u.fallbacks?.[`${x}_destination`])])));
    // Plusieurs renvois par défaut dans la même opération : le suivant repart
    // de cette valeur, pas de celle relue avant la première écriture.
    u.fallbacks = { ...(u.fallbacks || {}), [`${k}_destination`]: v };
  },
});
// Numéro présenté : champ outgoing_caller_id de l'utilisateur (« default »,
// « anonymous » ou `"Nom" <numéro>`). La route /callerids/outgoing/default
// est trop récente (26.10) pour être présente partout : non utilisée.
// SDA() renvoie null si l'utilisateur n'a pas d'appel entrant : « impossible ».
const SDA = (u) => (u.incalls || []).flatMap((i) => i.extensions || []).map((e) => String(e.exten || '').replace(/^_/, '')).find((x) => /^\+?\d+$/.test(x)) || null;
// Même règle que confd (format_caller_id) : sans nom, le numéro seul.
const cidFmt = (number, name) => { const n = String(name || '').replace(/"/g, '').trim(); return n ? `"${n}" <${number}>` : String(number); };
const CID_TYPE = { main: 'numéro principal', shared: 'numéro partagé' };
const callerIdSetting = {
  id: 'outgoing_caller_id', label: 'Numéro présenté', grp: 'Identité d\'appel', ...userField('outgoing_caller_id'),
  read: (u) => (!u.outgoing_caller_id || u.outgoing_caller_id === 'default' ? 'default' : u.outgoing_caller_id),
  form: (c) => `<label>Numéro présenté <select id="m-v">${options([['default', 'Par défaut'], ['anonymous', 'Anonyme'],
    ...c.callerOpts.map((o) => [cidFmt(o.number, o.caller_id_name), `${o.number}${o.caller_id_name ? ` « ${o.caller_id_name} »` : ''} (${CID_TYPE[o.type] || o.type})`]),
    ['@sda', 'Sa SDA (numéro entrant associé à chaque utilisateur)'], ['@free', 'Autre numéro…']])}</select></label>
    <div data-cid="@free"><label>Numéro <input id="m-fn" inputmode="tel" placeholder="0145000000"></label><label>Nom affiché (facultatif) <input id="m-fname"></label></div>
    ${c.callerOptsErr ? `<p class="muted small">Liste des numéros du tenant indisponible (${esc(c.callerOptsErr)}).</p>` : ''}`,
  wire: () => showSub('m-v', 'data-cid'),
  parse: () => {
    const v = $v('m-v');
    // Comme confd pour un numéro « associated » : sans nom.
    if (v === '@sda') return { target: (cur, u) => SDA(u), desc: 'Numéro présenté : sa SDA' };
    if (v === '@free') {
      const n = $v('m-fn').trim();
      if (!/^\+?\d{2,20}$/.test(n)) throw new Error('Numéro invalide (chiffres, + en tête).');
      const s = cidFmt(n, $v('m-fname').trim());
      return { target: () => s, desc: `Numéro présenté : ${s}` };
    }
    return { target: () => v, desc: `Numéro présenté : ${v === 'default' ? 'par défaut' : v === 'anonymous' ? 'anonyme' : v}` };
  },
  text: (v) => (v === 'default' ? 'Par défaut' : v === 'anonymous' ? 'Anonyme' : v ?? '—'),
  check: (u, v) => (v === null ? 'aucune SDA associée' : ''),
};
// Licence (« Type de souscription » du portail) = subscription_type.
// Correspondance relevée en réel le 13/10/2026 (Tom, Jerry, Bart) ; 2 non vu.
export const SUBS = { 0: 'Voix', 1: 'Communication unifiée', 3: 'Relation client' };
export const subLabel = (v) => (v == null ? '—' : SUBS[v] || `Type ${v}`);
const licence = {
  id: 'subscription_type', label: 'Licence', grp: 'Licence', ...userField('subscription_type'),
  form: (c) => {
    const n = {};
    for (const u of c.users) n[u.subscription_type] = (n[u.subscription_type] || 0) + 1;
    return `<label>Licence <select id="m-v">${options(Object.entries(SUBS))}</select></label>
      <p class="muted small">Attribuées sur ce tenant : ${Object.entries(n).map(([k, x]) => `${esc(subLabel(Number(k)))} ${x}`).join(' · ')}. Les quotas (« souscriptions restantes ») sont gérés par le portail : la stack ne bloque pas un dépassement, vérifiez-les avant.</p>`;
  },
  parse: () => { const v = Number($v('m-v')); return { target: () => v, desc: `Licence : ${subLabel(v)}` }; },
  text: (v) => subLabel(v),
};
// Boîte vocale associée : les boîtes se configurent dans Messageries
// vocales ; ici seulement l'association (une boîte peut être partagée par
// plusieurs utilisateurs). confd refuse d'associer si l'utilisateur en a déjà
// une (dissocier d'abord) ou si la boîte est « globale » (vérifié dans le code).
const voicemailLink = {
  id: 'voicemail', label: 'Boîte vocale associée', grp: 'Boîte vocale', heavy: true, reload: 'user',
  form: (c) => `<label>Action <select id="m-v">${options([['', 'Dissocier (l\'utilisateur n\'a plus de boîte vocale)'],
    ...[...c.vms.values()].filter((v) => v.accesstype !== 'global').sort((a, b) => String(a.number).localeCompare(String(b.number), 'fr', { numeric: true }))
      .map((v) => [v.id, `Associer à ${v.number}${v.name ? ` (${v.name})` : ''}`])])}</select></label>
    <p class="muted small">Les réglages de la boîte (e-mail, code, options) se modifient dans Messageries vocales. Les renvois par défaut qui visaient l'ancienne boîte ne sont pas modifiés (étape « Renvois par défaut » si besoin).</p>`,
  parse: (c) => { const v = Number($v('m-v')) || null; const b = c.vms.get(v); return { target: () => v, desc: v ? `Boîte vocale : associer à ${b?.number || v}` : 'Boîte vocale : dissocier' }; },
  read: (u) => u.voicemail?.id ?? null,
  text: (v, c) => { if (!v) return 'aucune'; const b = c.vms.get(v); return b ? `${b.number}${b.name ? ` (${b.name})` : ''}` : `#${v}`; },
  write: async (u, v, cur) => {
    if (cur) await api('DELETE', `/users/${u.uuid}/voicemails`);
    if (v) await api('PUT', `/users/${u.uuid}/voicemails/${v}`);
  },
};

// ---------------------------------------------------------------------------
// Lot 3 : fiche. Champs propres à chaque utilisateur (single : pas en masse).
// ---------------------------------------------------------------------------
const textField = (field, label, { required = false, re = null, max = 128, hint = '', check = null } = {}) => ({
  id: field, label, grp: 'Identité', single: true, ...userField(field),
  form: () => `<label>${esc(label)} <input id="m-v" maxlength="${max}"></label>${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}`,
  prefill: (v) => ({ 'm-v': v ?? '' }),
  parse: () => {
    const s = $v('m-v').trim();
    if (!s && required) throw new Error(`${label} : obligatoire.`);
    if (s && re && !re.test(s)) throw new Error(`${label} : format invalide.`);
    const v = s || null;
    return { target: () => v, desc: `${label} : ${s || 'vide'}` };
  },
  text: (v) => v || '—',
  ...(check ? { check } : {}),
});
// Nom présenté : caller_id `"Nom"` (éventuellement suivi de ` <numéro>`,
// conservé). Regex confd : ^"(.*)"( <\+?\d+>)?$ ; null refusé en PUT.
const cidName = (v) => (String(v || '').match(/^"(.*)"/) || [])[1] ?? '';
const callerName = {
  id: 'caller_id', label: 'Nom présenté', grp: 'Identité', single: true, ...userField('caller_id'),
  form: () => '<label>Nom présenté <input id="m-v" maxlength="150"></label><p class="muted small">Nom affiché lors des appels (par défaut prénom et nom).</p>',
  prefill: (v) => ({ 'm-v': cidName(v) }),
  parse: () => {
    const n = $v('m-v').trim().replace(/"/g, '');
    if (!n) throw new Error('Nom présenté : obligatoire.');
    return { target: (cur) => `"${n}"${String(cur || '').replace(/^"(.*)"/, '')}`, desc: `Nom présenté : ${n}` };
  },
  text: (v) => cidName(v) || v || '—',
};
// user.enabled = colonne `commented` de userfeatures (xivo-dao). La génération
// de la config Asterisk filtre les lignes et extensions « commented », pas
// les utilisateurs (asterisk_conf_dao.py, 13/10/2026) ; absent du portail ;
// essai de Brice : aucun effet visible. Proposé seulement sur la fiche d'un
// utilisateur déjà désactivé, pour le réactiver (showIf).
const enabledSetting = {
  id: 'enabled', label: 'Utilisateur actif', grp: 'Identité', single: true, showIf: (u) => u.enabled === false, ...userField('enabled'),
  form: () => onOff('Utilisateur actif'),
  prefill: (v) => ({ 'm-v': v === false ? '0' : '1' }),
  parse: () => { const v = $v('m-v') === '1'; return { target: () => v, desc: `Utilisateur ${v ? 'actif' : 'désactivé'}` }; },
  read: (u) => u.enabled !== false,
  text: (v) => (v ? 'oui' : 'non'),
};

export const SETTINGS = [
  textField('firstname', 'Prénom', { required: true }),
  textField('lastname', 'Nom'),
  textField('email', 'E-mail (annuaire)', { re: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, max: 254, hint: 'Courriel public, visible dans les annuaires. Doit être unique sur tout le serveur (tous les clients).' }),
  textField('mobile_phone_number', 'Mobile', { re: /^\+?[0-9*#]+$/, max: 80, check: (u, v) => (!v && u.mobile_fallback_enabled ? 'le renvoi vers le mobile est activé : impossible de vider le numéro' : '') }),
  textField('description', 'Description', { max: 1000 }),
  callerName,
  enabledSetting,
  service('dnd', 'Ne pas déranger'),
  service('incallfilter', 'Filtrage des appels'),
  forward('busy', 'occupé'),
  forward('unconditional', 'inconditionnel'),
  forward('noanswer', 'pas de réponse'),
  fallback('busy', 'si occupé'),
  fallback('congestion', 'congestion'),
  fallback('fail', 'échec'),
  fallback('noanswer', 'non répondu'),
  callerIdSetting,
  licence,
  voicemailLink,
  number('ring_seconds', 'Durée de sonnerie', 0, 10800, 's'),
  number('simultaneous_calls', 'Appels simultanés', 1, 20),
  {
    id: 'music_on_hold', label: 'Musique d\'attente', grp: 'Divers', ...userField('music_on_hold'),
    // Valeur = `name` d'une MOH du tenant de l'utilisateur, ou « default ».
    form: (c) => `<label>Musique d'attente <select id="m-v">${options([['default', 'Par défaut'], ...[...c.moh].filter(([n]) => n !== 'default').map(([n, l]) => [n, l]).sort((a, b) => a[1].localeCompare(b[1], 'fr'))])}</select></label>`,
    parse: (c) => { const v = $v('m-v'); return { target: () => v, desc: `Musique d'attente : ${v === 'default' ? 'Par défaut' : c.moh.get(v) || v}` }; },
    text: (v, c) => (!v ? '—' : v === 'default' ? 'Par défaut' : c.moh.get(v) || v),
  },
  {
    id: 'language', label: 'Langue', grp: 'Divers', ...userField('language'),
    form: () => `<label>Langue <select id="m-v">${options(Object.entries(LANG), 'fr_FR')}</select></label>`,
    parse: () => { const v = $v('m-v'); return { target: () => v, desc: `Langue : ${LANG[v]}` }; },
    text: (v) => LANG[v] || v || '—',
  },
  {
    id: 'timezone', label: 'Fuseau horaire', grp: 'Divers', ...userField('timezone'),
    form: () => `<label>Fuseau horaire (vide = aucun) <input id="m-v" list="m-tz" value="Europe/Paris"></label><datalist id="m-tz">${TZ.map((z) => `<option value="${z}">`).join('')}</datalist>`,
    parse: () => {
      const v = $v('m-v').trim() || null;
      if (v && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(v)) throw new Error('Fuseau invalide (ex. Europe/Paris).');
      return { target: () => v, desc: `Fuseau : ${v || 'aucun'}` };
    },
    text: (v) => v || '—',
  },
  {
    // PUT /users/{uuid}/groups remplace TOUTE la liste : on part de la liste
    // relue juste avant l'écriture. Un utilisateur sans ligne ne peut pas
    // être membre d'un groupe (refus de confd).
    id: 'groups', label: 'Groupes d\'appel', grp: 'Groupes et droits', heavy: true, reload: 'user',
    form: (c) => addRemove('Groupe', [...c.groups.values()].map((g) => [g.uuid, g.label || g.name]).sort((a, b) => a[1].localeCompare(b[1], 'fr'))),
    parse: (c) => {
      const g = $v('m-v'), add = $v('m-mode') === 'add';
      if (!g) throw new Error('Aucun groupe disponible.');
      const name = c.groups.get(g)?.label || g;
      return { target: (cur) => (add ? [...new Set([...(cur || []), g])].sort() : (cur || []).filter((x) => x !== g)), desc: `${add ? 'Ajouter au' : 'Retirer du'} groupe ${name}` };
    },
    read: (u) => sortedIds(u.groups, 'uuid'),
    text: (v, c) => (v?.length ? v.map((x) => c.groups.get(x)?.label || x).join(', ') : '—'),
    check: (u, v) => (v?.length && !(u.lines || []).length ? 'aucune ligne : ne peut pas être membre d\'un groupe' : ''),
    write: (u, v) => api('PUT', `/users/${u.uuid}/groups`, { groups: v.map((uuid) => ({ uuid })) }),
  },
  {
    // Association idempotente, une route par droit (pas de remplacement).
    id: 'call_permissions', label: 'Droits d\'appel', grp: 'Groupes et droits',
    form: (c) => addRemove('Droit d\'appel', [...c.perms.values()].map((p) => [p.id, p.name]).sort((a, b) => a[1].localeCompare(b[1], 'fr'))),
    parse: (c) => {
      const id = Number($v('m-v')), add = $v('m-mode') === 'add';
      if (!id) throw new Error('Aucun droit d\'appel disponible.');
      return { target: (cur) => (add ? [...new Set([...(cur || []), id])].sort((a, b) => a - b) : (cur || []).filter((x) => x !== id)), desc: `${add ? 'Ajouter' : 'Retirer'} le droit ${c.perms.get(id)?.name || id}` };
    },
    read: (u) => sortedIds(u.call_permissions, 'id').sort((a, b) => a - b),
    text: (v, c) => (v?.length ? v.map((x) => c.perms.get(x)?.name || `#${x}`).join(', ') : '—'),
    write: async (u, v, cur) => {
      for (const id of v) if (!cur.includes(id)) await api('PUT', `/users/${u.uuid}/callpermissions/${id}`);
      for (const id of cur) if (!v.includes(id)) await api('DELETE', `/users/${u.uuid}/callpermissions/${id}`);
    },
  },
  {
    // Un seul horaire par utilisateur : dissocier l'ancien avant d'associer.
    id: 'schedule', label: 'Horaire', grp: 'Groupes et droits',
    form: (c) => `<label>Horaire <select id="m-v">${options([['', 'Aucun (retirer l\'horaire)'], ...[...c.scheds.values()].map((s) => [s.id, s.name || `#${s.id}`])])}</select></label>`,
    parse: (c) => { const v = Number($v('m-v')) || null; return { target: () => v, desc: `Horaire : ${v ? c.scheds.get(v)?.name || v : 'aucun'}` }; },
    read: (u) => u.schedules?.[0]?.id ?? null,
    text: (v, c) => (v ? c.scheds.get(v)?.name || `#${v}` : '—'),
    write: async (u, v, cur) => {
      if (cur) await api('DELETE', `/users/${u.uuid}/schedules/${cur}`);
      if (v) await api('PUT', `/users/${u.uuid}/schedules/${v}`);
    },
  },
];
export const settingById = (id) => SETTINGS.find((s) => s.id === id);
