// User Manager — réglages modifiables en masse (lots 2a et 2b). Chaque réglage :
//  read(u)            valeur actuelle, lue sur un utilisateur (GET /users/{uuid})
//  form(ctx, cur, u, users) champs du dialogue (ids m-*) ; cur/u : fiche ; users :
//                     cibles de l'assistant ;
//                     parse(ctx) → { target(cur), desc }
//                     (lève une Error si la saisie est invalide)
//  text(v, ctx)       valeur lisible (aperçu, sauvegarde)
//  check(u, v)        message si l'écriture est impossible pour cet utilisateur
//  write(u, v, cur)   écriture (seulement si v diffère de cur)
//  prefill(v, u)      valeurs des champs (id → valeur) pour la fiche ; sans prefill,
//                     la fiche met v dans #m-v s'il existe
//  single             true = fiche seulement (champ propre à chaque utilisateur)
//  showIf(u)          fiche : réglage affiché seulement si vrai pour cet utilisateur
//  help               texte d'aide (table HELP, ajouté au rangement)
//  auth               true = compte de connexion wazo-auth (u._auth, relu avant écriture)
//  available(ctx)     faux = rien à proposer dans ce tenant (assistant : grisé ; fiche : pas de ✎)
//  heavy              true = l'écriture recharge Asterisk (écritures espacées, ou
//                     regroupées en coupant le live reload) ; reload = type de
//                     rechargement à redéclencher à la fin ('user')
// Routes et sémantique vérifiées dans le code de wazo-confd (13/10/2026),
// voir docs/USER-MANAGER.md. Écritures non encore testées en réel.
import { S, api, esc, fullName } from '../common/core.js?v=0.40.24';

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
// Appartenance (groupes, droits d'appel) : tous les éléments du tenant avec
// l'état actuel des utilisateurs ciblés (demande de Brice : « afficher ce qui
// est en place »). Un utilisateur : cases à cocher (cochée = membre). Plusieurs :
// nombre de membres et, par élément, Inchangé / Ajouter / Retirer. Champs
// m-it-<index> pour que l'assistant garde la saisie (Précédent / Suivant).
const membership = (items, read, label, sortIds) => ({
  showsCurrent: true, // le formulaire affiche lui-même l'état actuel
  prefill: () => ({}),
  form: (c, cur, u, users) => {
    const list = items(c), targets = users || (u ? [u] : []);
    if (targets.length <= 1) {
      const mine = new Set((cur ?? (targets[0] ? read(targets[0]) : [])).map(String));
      return `<div class="memb">${list.map(([id, name], i) => `<label class="inline"><input type="checkbox" id="m-it-${i}"${mine.has(String(id)) ? ' checked' : ''}> ${esc(name)}</label>`).join('')}</div>
        <p class="muted small">Coché = membre (état actuel). Cocher pour ajouter, décocher pour retirer.</p>`;
    }
    return `<table class="diff memb"><tr><th>${esc(label)}</th><th>Membres actuels</th><th>Action</th></tr>${list.map(([id, name], i) => {
      const n = targets.filter((t) => read(t).map(String).includes(String(id))).length;
      return `<tr><td>${esc(name)}</td><td class="muted">${n} / ${targets.length}</td><td><select id="m-it-${i}"><option value="">Inchangé</option><option value="add">Ajouter</option><option value="remove">Retirer</option></select></td></tr>`;
    }).join('')}</table>`;
  },
  parse: (c) => {
    const list = items(c);
    const els = list.map((_, i) => document.getElementById(`m-it-${i}`)).filter(Boolean);
    const known = new Set(list.map(([id]) => String(id)));
    const nameOf = (id) => list.find(([x]) => String(x) === String(id))?.[1] || id;
    if (els[0]?.type === 'checkbox') {
      const on = list.filter((_, i) => document.getElementById(`m-it-${i}`)?.checked).map(([id]) => id);
      // Éléments inconnus de la liste (autre tenant…) : conservés tels quels.
      return { target: (cur) => sortIds([...(cur || []).filter((x) => !known.has(String(x))), ...on]), desc: `${label} : ${on.map(nameOf).join(', ') || 'aucun'}` };
    }
    const add = list.filter((_, i) => document.getElementById(`m-it-${i}`)?.value === 'add').map(([id]) => id);
    const rem = list.filter((_, i) => document.getElementById(`m-it-${i}`)?.value === 'remove').map(([id]) => String(id));
    if (!add.length && !rem.length) throw new Error('Choisissez au moins une action (Ajouter ou Retirer).');
    return {
      target: (cur) => sortIds([...new Set([...(cur || []).filter((x) => !rem.includes(String(x))), ...add])]),
      desc: [add.length ? `ajouter : ${add.map(nameOf).join(', ')}` : '', rem.length ? `retirer : ${rem.map(nameOf).join(', ')}` : ''].filter(Boolean).join(' ; ').replace(/^./, (x) => `${label} — ${x}`),
    };
  },
});

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
    <div data-dt="hangup"><label>Cause <select id="m-dh">${options([['normal', 'Normale'], ['busy', 'Occupé'], ['congestion', 'Encombré']])}</select></label></div>
    <div data-dt="selfvm"><label>Message d'accueil <select id="m-dvg">${options([['busy', 'Occupé'], ['unavailable', 'Indisponible'], ['', 'Non précisé (choix de la messagerie)']], k === 'busy' ? 'busy' : 'unavailable')}</select></label></div>`,
  wire: () => showSub('m-dt', 'data-dt'),
  parse: (c) => {
    const t = $v('m-dt');
    const fixed = (d) => ({ target: () => d, desc: `Renvoi par défaut ${label} : ${c.destText(d) || 'aucun'}` });
    if (t === 'none') return fixed(null);
    if (t === 'selfvm') {
      // Message d'accueil (greeting, schéma VoicemailDestinationSchema : busy,
      // unavailable ou null) choisi et affiché, pas laissé au défaut caché.
      // Déjà sur sa propre messagerie : consignes (skip_instructions) gardées.
      const g = $v('m-dvg') || null;
      const gt = { busy: 'message « occupé »', unavailable: 'message « indisponible »' }[g] || 'message non précisé';
      return {
        target: (cur, u) => (cur?.type === 'voicemail' && u.voicemail && cur.voicemail_id === u.voicemail.id ? normDest({ ...cur, greeting: g }) : normDest({ type: 'voicemail', voicemail_id: u.voicemail?.id ?? null, skip_instructions: false, greeting: g })),
        desc: `Renvoi par défaut ${label} : sa propre messagerie (${gt})`,
      };
    }
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
    if (v.type === 'voicemail' && u?.voicemail && v.voicemail_id === u.voicemail.id) return { 'm-dt': 'selfvm', 'm-dvg': v.greeting || '' };
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
// Même règle que confd (user_callerid/service.py, format_caller_id) : sans nom,
// ou si `"Nom" <numéro>` dépasse 80 caractères (taille de la colonne), le numéro seul.
const cidFmt = (number, name) => { const n = String(name || '').replace(/"/g, '').trim(); const f = n ? `"${n}" <${number}>` : ''; return f && f.length <= 80 ? f : String(number); };
const CID_TYPE = { main: 'numéro principal', shared: 'numéro partagé' };
const callerIdSetting = {
  id: 'outgoing_caller_id', label: 'Identification de l\'appelant sortant', grp: 'Appels sortants', ...userField('outgoing_caller_id'),
  read: (u) => (!u.outgoing_caller_id || u.outgoing_caller_id === 'default' ? 'default' : u.outgoing_caller_id),
  form: (c) => `<label>Numéro présenté aux appels externes <select id="m-v">${options([['default', 'Par défaut'], ['anonymous', 'Anonyme'],
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
  // Règles du portail (code du portail lu le 21/10/2026, contrôle au changement
  // de licence et validation du formulaire utilisateur) ; confd, lui, accepte tout.
  check: (u, v) => {
    if (v === 0 && readLines(u).some((l) => l.type === 'webrtc')) return 'ligne WebRTC : licence Voix refusée par le portail (supprimer la ligne WebRTC d\'abord)';
    if (u.agent && v !== 3) return 'agent associé : seule la licence Relation client est acceptée par le portail';
    if ((v === 1 || v === 3) && !u.email) return 'e-mail (annuaire) vide : obligatoire pour cette licence dans le portail';
    return '';
  },
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
// Identifiant de l'appelant (interne, d'après Brice) : caller_id `"Nom"` (éventuellement suivi de ` <numéro>`,
// conservé). Regex confd : ^"(.*)"( <\+?\d+>)?$ ; null refusé en PUT.
const cidName = (v) => (String(v || '').match(/^"(.*)"/) || [])[1] ?? '';
const callerName = {
  id: 'caller_id', label: 'Identifiant de l\'appelant (interne)', grp: 'Identité', single: true, ...userField('caller_id'),
  form: () => '<label>Nom affiché <input id="m-v" maxlength="60"></label><p class="muted small">Nom affiché sur les postes des collègues lors des appels internes (par défaut prénom et nom). Les appels externes utilisent l\'identification de l\'appelant sortant.</p>',
  prefill: (v) => ({ 'm-v': cidName(v) }),
  parse: () => {
    const n = $v('m-v').trim().replace(/"/g, '');
    if (!n) throw new Error('Identifiant de l\'appelant : obligatoire.');
    if (n.length > 60) throw new Error('Identifiant de l\'appelant : 60 caractères au plus (règle du portail).');
    return { target: (cur) => `"${n}"${String(cur || '').replace(/^"(.*)"/, '')}`, desc: `Identifiant de l'appelant (interne) : ${n}` };
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

// ---------------------------------------------------------------------------
// Compte des applications (wazo-auth, onglet « Compte » du portail), lu dans
// le code le 13/10/2026 :
//  - PUT /api/auth/0.1/users/{uuid} (ACL auth.users.{uuid}.update) n'est PAS
//    partiel : username, firstname, lastname, purpose, authentication_method,
//    enabled reprennent leur défaut s'ils manquent → relire puis tout renvoyer ;
//  - authentication_method validée contre les fournisseurs d'identité
//    configurés (default, native, saml, ldap) ;
//  - PUT /api/auth/0.1/admin/users/{uuid}/emails (ACL
//    auth.admin.users.{uuid}.emails.update) remplace TOUTE la liste
//    {address, main, confirmed} : une seule principale, pas de doublon.
// « Autorisé à utiliser des applications » = enabled : supposé, à vérifier.
// ---------------------------------------------------------------------------
export async function authApi(method, path, body) {
  if (S.readonly && method !== 'GET') throw new Error(`Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${S.base}/api/auth/0.1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) {
    let m = `${method} auth${path} → ${r.status}`;
    try { m += ' ' + JSON.stringify(await r.json()).slice(0, 300); } catch { /* */ }
    const e = new Error(m); e.status = r.status; throw e;
  }
  return r.status === 204 ? null : r.json();
}
async function authPut(u, patch) {
  const a = await authApi('GET', `/users/${u.uuid}`);
  const body = { username: a.username, firstname: a.firstname, lastname: a.lastname, purpose: a.purpose, authentication_method: a.authentication_method, enabled: a.enabled, ...patch };
  await authApi('PUT', `/users/${u.uuid}`, body);
  u._auth = { ...a, ...patch };
}
const noAccount = (u) => (!u._auth ? 'pas de compte de connexion' : '');
const AUTH_METHODS = { default: 'Défaut de l\'organisation', native: 'Authentification native', saml: 'SAML', ldap: 'LDAP' };
const authEnabled = {
  id: 'auth_enabled', label: 'Accès aux applications', auth: true,
  form: () => onOff('Autorisé à utiliser des applications'),
  prefill: (v) => ({ 'm-v': v ? '1' : '0' }),
  parse: () => { const v = $v('m-v') === '1'; return { target: () => v, desc: `Accès aux applications : ${v ? 'autorisé' : 'coupé'}` }; },
  read: (u) => (u._auth ? u._auth.enabled !== false : null),
  text: (v) => (v == null ? 'pas de compte' : v ? 'oui' : 'non'),
  check: noAccount,
  write: (u, v) => authPut(u, { enabled: v }),
};
const authUsername = {
  id: 'auth_username', label: 'Identifiant', auth: true, single: true,
  form: () => '<label>Identifiant de connexion <input id="m-v" maxlength="256" spellcheck="false"></label><p class="muted small">Doit être unique sur le serveur.</p>',
  prefill: (v) => ({ 'm-v': v ?? '' }),
  parse: () => { const v = $v('m-v').trim(); if (!v) throw new Error('Identifiant obligatoire.'); return { target: () => v, desc: `Identifiant : ${v}` }; },
  read: (u) => u._auth?.username ?? null,
  text: (v) => v || '—',
  check: noAccount,
  write: (u, v) => authPut(u, { username: v }),
};
const authMethod = {
  id: 'auth_method', label: 'Méthode d\'authentification', auth: true,
  form: () => `<label>Méthode <select id="m-v">${options(Object.entries(AUTH_METHODS))}</select></label><p class="muted small">Refusée par le serveur si le fournisseur (SAML, LDAP) n'est pas configuré.</p>`,
  parse: () => { const v = $v('m-v'); return { target: () => v, desc: `Méthode : ${AUTH_METHODS[v]}` }; },
  read: (u) => u._auth?.authentication_method ?? null,
  text: (v) => AUTH_METHODS[v] || v || '—',
  check: noAccount,
  write: (u, v) => authPut(u, { authentication_method: v }),
};
// Adresses : liste triée {address, main, confirmed} ; formulaire en lignes.
const mailList = (arr) => (arr || []).map((m) => ({ address: String(m.address || '').trim(), main: m.main === true, confirmed: m.confirmed === true })).sort((a, b) => a.address.localeCompare(b.address));
const mailRow = (m = {}) => `<div class="mailrow"><input data-mail value="${esc(m.address || '')}" placeholder="adresse@domaine.fr" spellcheck="false">
  <label class="inline"><input type="radio" name="m-main"${m.main ? ' checked' : ''}> principale</label>
  <label class="inline"><input type="checkbox" data-conf${m.confirmed ? ' checked' : ''}> confirmée</label>
  <button type="button" class="icon" data-del title="Supprimer">×</button></div>`;
const authEmails = {
  id: 'auth_emails', label: 'Adresses courriels', auth: true, single: true,
  form: (c, cur) => `<div id="m-mails">${(cur || []).map(mailRow).join('')}</div><div class="btnrow"><button type="button" id="m-addmail">Ajouter une adresse</button></div>
    <p class="muted small">Adresses du compte de connexion (mot de passe oublié…). Une seule principale ; « confirmée » évite l'e-mail de confirmation.</p>`,
  prefill: () => ({}),
  wire: () => {
    const box = document.getElementById('m-mails');
    const changed = () => box.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('m-addmail').onclick = () => { box.insertAdjacentHTML('beforeend', mailRow({ main: !box.children.length })); changed(); };
    box.onclick = (e) => { if (e.target.closest('[data-del]')) { e.target.closest('.mailrow').remove(); changed(); } };
  },
  parse: () => {
    const rows = [...document.querySelectorAll('#m-mails .mailrow')].map((r) => ({ address: r.querySelector('[data-mail]').value.trim(), main: r.querySelector('input[type=radio]').checked, confirmed: r.querySelector('[data-conf]').checked })).filter((m) => m.address);
    for (const m of rows) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.address)) throw new Error(`Adresse invalide : ${m.address}`);
    if (new Set(rows.map((m) => m.address.toLowerCase())).size !== rows.length) throw new Error('La même adresse apparaît deux fois.');
    if (rows.length && !rows.some((m) => m.main)) rows[0].main = true;
    const v = mailList(rows);
    return { target: () => v, desc: `Adresses courriels : ${v.map((m) => m.address).join(', ') || 'aucune'}` };
  },
  read: (u) => (u._auth ? mailList(u._auth.emails) : null),
  text: (v) => (v == null ? '—' : v.map((m) => `${m.address}${m.main ? ' (principale)' : ''}${m.confirmed ? '' : ' (non confirmée)'}`).join(', ') || 'aucune'),
  check: noAccount,
  write: async (u, v) => {
    await authApi('PUT', `/admin/users/${u.uuid}/emails`, { emails: v });
    u._auth = { ...(u._auth || {}), emails: v };
  },
};

// ---------------------------------------------------------------------------
// Lignes (lu dans le code de wazo-confd le 19/10/2026) :
//  - POST /lines {context, endpoint_sip: {templates, auth_section_options},
//    extensions: [{exten, context}]} crée ligne + endpoint + numéro en un appel
//    (numéro existant repris s'il est libre d'usage : lignes multiples d'un
//    même utilisateur) ; nom technique de l'endpoint généré par confd, pas
//    l'identifiant ni le mot de passe SIP (générés ici, comme l'import CSV) ;
//  - WebRTC = endpoint SIP avec les modèles « global » + « webrtc » du tenant
//    (WebRTCCreator de l'import) ; GET /lines donne is_webrtc, pas GET /users ;
//  - PUT /users/{uuid}/lines/{id} : la ligne doit avoir un endpoint ; un numéro
//    ne peut pas être partagé avec la ligne d'un autre utilisateur ;
//  - numéro : contexte de type internal et dans ses plages « utilisateurs » ;
//  - DELETE /lines/{id}?recursive=true dissocie utilisateur et numéro (numéro
//    supprimé s'il ne sert plus) et supprime l'endpoint ; refusé tant qu'un
//    appareil est associé (DELETE /lines/{id}/devices/{device} avant) ; confd
//    retire les inscriptions aux groupes et files passées par cette ligne ;
//  - PUT /extensions/{id} {exten} partiel : change le numéro de toutes les
//    lignes qui le partagent.
// Index remplis par app.js au chargement (check() n'a pas le contexte).
// ---------------------------------------------------------------------------
export const IDX = { lines: new Map(), exts: new Map(), devices: new Map(), contexts: [], tpl: {}, pending: new Set() };

// Appartenance aux groupes, groupe par groupe : PUT /groups/{uuid}/members/users
// avec la liste complète relue juste avant, priorités conservées (confd garde
// le membre existant, group_member/resource.py _find_or_create_member).
// PAS PUT /users/{uuid}/groups : il recrée toutes les appartenances de
// l'utilisateur avec la position 0 (xivo-dao associate_all_groups, relation
// group_members en delete-orphan, lu le 21/10/2026), ce qui casse l'ordre des
// groupes à sonnerie linéaire. Ajout : en fin de liste, ou à la priorité donnée.
async function groupMembers(g) {
  const grp = await api('GET', `/groups/${g}`);
  return (grp?.members?.users || []).map((m) => ({ uuid: m.uuid, priority: m.priority ?? 0 }));
}
async function setGroups(u, v, cur, prio = {}) {
  for (const g of v.filter((x) => !cur.includes(x))) {
    const users = await groupMembers(g);
    if (users.some((m) => m.uuid === u.uuid)) continue;
    users.push({ uuid: u.uuid, priority: prio[g] ?? users.reduce((n, m) => Math.max(n, m.priority + 1), 0) });
    await api('PUT', `/groups/${g}/members/users`, { users });
  }
  for (const g of cur.filter((x) => !v.includes(x))) {
    const users = await groupMembers(g);
    if (!users.some((m) => m.uuid === u.uuid)) continue;
    await api('PUT', `/groups/${g}/members/users`, { users: users.filter((m) => m.uuid !== u.uuid) });
  }
}
const LTYPE = { sip: 'SIP', webrtc: 'WebRTC', sccp: 'SCCP', custom: 'Custom' };
const lineType = (l) => (l.endpoint_sccp ? 'sccp' : l.endpoint_custom ? 'custom' : IDX.lines.get(l.id)?.is_webrtc ? 'webrtc' : 'sip');
// Valeur du réglage : lignes de l'utilisateur, triées par id ; les nouvelles
// (sans id) à la fin. ext_id = numéro à modifier en place.
export const readLines = (u) => (u.lines || []).map((l) => {
  const e = (l.extensions || [])[0] || {}, x = IDX.lines.get(l.id);
  return { id: l.id, type: lineType(l), exten: e.exten || '', context: e.context || l.context || x?.context || '', ext_id: e.id ?? null, device: l.device_id ?? x?.device_id ?? null };
}).sort((a, b) => a.id - b.id);
export const deviceName = (id) => { const d = IDX.devices.get(id); return d ? [d.vendor, d.model].filter(Boolean).join(' ') + (d.mac ? ` · ${d.mac}` : '') || id : `appareil ${String(id).slice(0, 8)}`; };
const lineText = (l) => `${LTYPE[l.type] || l.type} ${l.exten || 'sans numéro'}${l.device ? ` (${deviceName(l.device)})` : ''}${l.id ? '' : ' (nouvelle)'}`;
const internalCtx = (c) => c.contexts.filter((x) => x.type === 'internal');
const ctxText = (cx) => (cx ? `${cx.label || cx.name}${(cx.user_ranges || []).length ? ` (${cx.user_ranges.map((r) => (r.start === r.end ? r.start : `${r.start}-${r.end}`)).join(', ')})` : ''}` : '');
const inRange = (cx, n) => /^\d+$/.test(n) && (cx?.user_ranges || []).some((r) => Number(n) >= Number(r.start) && Number(n) <= Number(r.end));
// Numéro utilisé par autre chose que les lignes de cet utilisateur.
function takenBy(u, exten, context) {
  const e = IDX.exts.get(`${context}|${exten}`);
  if (!e) return '';
  const mine = new Set((u.lines || []).map((l) => l.id)), ls = (e.lines || []).map((l) => l.id);
  if (ls.length && ls.every((id) => mine.has(id))) return '';
  const o = ls.length ? IDX.lines.get(ls[0])?.users?.[0] : null;
  const what = ls.length ? (o ? fullName(o) : 'une autre ligne') : e.group ? `groupe ${e.group.name}` : e.queue ? `file ${e.queue.label || e.queue.name}` : e.conference ? 'conférence' : e.parking_lot ? 'parking' : e.incall ? 'appel entrant' : e.outcall ? 'appel sortant' : 'autre usage';
  return `numéro ${exten} déjà pris (${what})`;
}
// Numéros libres à la suite (plages du contexte, numéros déjà pris sautés).
const usedIn = (ctxName) => new Set([...IDX.exts.values()].filter((e) => e.context === ctxName).map((e) => e.exten));
function defaultStart(ctxName) {
  const cx = IDX.contexts.find((x) => x.name === ctxName), rs = cx?.user_ranges || [];
  if (!rs.length) return '';
  const used = [...usedIn(ctxName)].filter((n) => inRange(cx, n)).map(Number);
  return String(used.length ? Math.max(...used) + 1 : Number(rs[0].start));
}
function nextFree(ctxName, from, count, reserved = new Set()) {
  const cx = IDX.contexts.find((x) => x.name === ctxName), rs = cx?.user_ranges || [];
  const used = usedIn(ctxName), out = [];
  if (!rs.length) return out;
  const max = Math.max(...rs.map((r) => Number(r.end)));
  const ok = (n) => inRange(cx, String(n)) && !used.has(String(n)) && !reserved.has(String(n));
  let n = Number(from) || Number(rs[0].start);
  for (; out.length < count && n <= max; n++) if (ok(n)) out.push(String(n));
  // Fin de plage atteinte : on repart du début pour les trous.
  for (n = Math.min(...rs.map((r) => Number(r.start))); out.length < count && n < (Number(from) || 0); n++) if (ok(n) && !out.includes(String(n))) out.push(String(n));
  return out;
}
const firstExten = (u, ctxName) => readLines(u).find((l) => l.exten && (!ctxName || l.context === ctxName))?.exten || '';
let LF = { users: [], cur: [] }; // cibles du formulaire affiché (wire)
const LTYPES_NEW = [['sip', 'SIP (poste de bureau, DECT, softphone tiers)'], ['webrtc', 'WebRTC (applications Wazo : web, bureau, mobile)'], ['both', 'SIP + WebRTC (deux lignes, même numéro)']];
function freeDevices(keep = []) {
  const used = new Set([...IDX.lines.values()].map((l) => l.device_id).filter(Boolean));
  return [...IDX.devices.values()].filter((d) => !used.has(d.id) || keep.includes(d.id)).sort((a, b) => String(a.mac || '').localeCompare(String(b.mac || '')));
}
const deviceOptions = (sel) => options([['', 'Aucun'], ...freeDevices([sel].filter(Boolean)).map((d) => [d.id, deviceName(d.id)])], sel || '');
const defaultCtx = (c) => {
  const n = {};
  for (const u of c.users) for (const l of readLines(u)) if (l.context) n[l.context] = (n[l.context] || 0) + 1;
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0];
  return internalCtx(c).some((x) => x.name === best) ? best : internalCtx(c)[0]?.name || '';
};
const numCheck = (n) => { if (n && !/^\d{1,40}$/.test(n)) throw new Error(`Numéro invalide : ${n} (chiffres seulement).`); };
// Remplit les numéros proposés. Ajouter : numéro actuel, sinon libres à la suite.
// Changer le numéro : numéros actuels (rien ne change tant qu'on n'a rien saisi),
// ou à la suite avec le bouton (seq).
function fillNumbers(seq = false) {
  const act = $v('m-la') || 'add', ctxName = $v('m-lc'), from = $v('m-lstart');
  if (act === 'renum' && !seq) { for (const u of LF.users) { const el = document.getElementById(`m-ln-${u.id}`); if (el) el.value = firstExten(u); } document.getElementById('m-form')?.dispatchEvent(new Event('change')); return; }
  const need = LF.users.filter((u) => !(act === 'add' && firstExten(u, ctxName)) && !(act === 'renum' && !firstExten(u)));
  const free = nextFree(ctxName, from || defaultStart(ctxName), need.length);
  for (const u of LF.users) {
    const el = document.getElementById(`m-ln-${u.id}`);
    if (!el) continue;
    el.value = act === 'add' && firstExten(u, ctxName) ? firstExten(u, ctxName) : act === 'renum' && !firstExten(u) ? '' : free.shift() || '';
  }
  document.getElementById('m-form')?.dispatchEvent(new Event('change'));
}
const linesSetting = {
  id: 'lines', label: 'Lignes', heavy: true, reload: 'user', showsCurrent: true,
  available: (c) => internalCtx(c).length > 0,
  prefill: () => ({}),
  read: readLines,
  text: (v) => (v?.length ? v.map(lineText).join(' · ') : 'aucune'),
  form: (c, cur, u, users) => {
    const targets = users || (u ? [u] : []);
    LF = { users: targets, cur: cur ?? (targets[0] ? readLines(targets[0]) : []) };
    const cx = defaultCtx(c);
    const ctxSel = `<label>Contexte <select id="m-lc">${options(internalCtx(c).map((x) => [x.name, ctxText(x)]), cx)}</select></label>`;
    if (targets.length <= 1) {
      // Fiche : éditeur des lignes de l'utilisateur + ajout.
      const t = targets[0];
      const rows = LF.cur.map((l) => `<tr><td>${esc(LTYPE[l.type] || l.type)}</td><td><input id="m-le-${l.id}" value="${esc(l.exten)}" inputmode="numeric" size="8"></td>
        <td>${l.type === 'webrtc' ? '<span class="muted small">(applications)</span>' : `<select id="m-ld-${l.id}">${deviceOptions(l.device)}</select>`}</td>
        <td><label class="inline"><input type="checkbox" id="m-lx-${l.id}"> supprimer</label></td></tr>`).join('');
      const start = t ? firstExten(t, cx) || nextFree(cx, defaultStart(cx), 1)[0] || '' : '';
      return `${LF.cur.length ? `<table class="diff"><tr><th>Type</th><th>Numéro</th><th>Appareil</th><th></th></tr>${rows}</table>` : '<p class="muted small">Aucune ligne : l\'utilisateur ne peut ni appeler, ni être appelé, ni être membre d\'un groupe.</p>'}
        <h4 class="side-title">Ajouter une ligne</h4>
        <label>Type <select id="m-lt">${options([['', 'Aucune'], ...LTYPES_NEW])}</select></label>
        <div data-lnew>${ctxSel}<label>Numéro <input id="m-ln-${t?.id}" value="${esc(start)}" inputmode="numeric" size="8"></label>
        <label>Appareil (ligne SIP) <select id="m-lnd">${deviceOptions('')}</select></label>
        <p class="muted small">Même numéro qu'une ligne existante = lignes multiples (tous ses postes sonnent). Identifiant et mot de passe SIP générés au hasard.</p></div>
        <p class="muted small">Supprimer une ligne : groupes repris (même position) s'il en reste une, files d'attente non reprises. Appareils proposés : ceux du tenant sans ligne.</p>`;
    }
    return `<label>Action <select id="m-la">${options([['add', 'Ajouter une ligne'], ['renum', 'Changer le numéro'], ['del', 'Supprimer des lignes']])}</select></label>
      <div data-la="add"><label>Type <select id="m-lt">${options(LTYPES_NEW)}</select></label>
        <label class="inline"><input type="checkbox" id="m-lskip" checked> Ignorer les utilisateurs qui ont déjà une ligne de ce type</label>${ctxSel}</div>
      <div data-la="del"><label>Lignes à supprimer <select id="m-ldt">${options([['all', 'Toutes les lignes'], ['sip', 'Lignes SIP'], ['webrtc', 'Lignes WebRTC'], ['sccp', 'Lignes SCCP']])}</select></label>
        <div class="warn">Appareils dissociés, numéros libérés s'ils ne servent plus, identifiants SIP perdus (une restauration recrée des lignes avec de nouveaux identifiants : postes à reprovisionner). Groupes repris (même position) s'il reste une ligne à l'utilisateur ; files d'attente non reprises.</div></div>
      <div data-lnum><div class="btnrow"><label>À partir de <input id="m-lstart" inputmode="numeric" size="8" placeholder="${esc(defaultStart(cx))}"></label><button type="button" id="m-lprop">Numéroter à la suite</button></div>
        <table class="diff"><tr><th>Utilisateur</th><th>Lignes actuelles</th><th>Numéro</th></tr>${targets.map((x) => `<tr><td>${esc(fullName(x))}</td><td class="muted">${esc(linesSetting.text(readLines(x)))}</td><td><input id="m-ln-${x.id}" inputmode="numeric" size="8"></td></tr>`).join('')}</table>
        <p class="muted small">Ajouter : numéro actuel repris s'il en a un (lignes multiples), sinon numéros libres à la suite dans les plages du contexte. Numéro vide = utilisateur ignoré. Changer le numéro : modifie le numéro de toutes ses lignes qui le partagent.</p></div>`;
  },
  wire: () => {
    const la = document.getElementById('m-la');
    if (!la) { // fiche
      const f = () => { document.querySelector('[data-lnew]').hidden = !$v('m-lt'); };
      document.getElementById('m-lt').addEventListener('change', f); f();
      return;
    }
    const show = () => { document.querySelectorAll('[data-la]').forEach((x) => (x.hidden = x.dataset.la !== la.value)); document.querySelector('[data-lnum]').hidden = la.value === 'del'; };
    la.addEventListener('change', () => { show(); fillNumbers(); });
    document.getElementById('m-lc').addEventListener('change', () => { document.getElementById('m-lstart').placeholder = defaultStart($v('m-lc')); fillNumbers(); });
    document.getElementById('m-lprop').onclick = () => fillNumbers(true);
    show();
    // Premier affichage (rien de saisi) : numéros proposés.
    if (LF.users.every((u) => !$v(`m-ln-${u.id}`))) fillNumbers();
  },
  parse: (c) => {
    const ctxName = $v('m-lc'), cx = c.contexts.find((x) => x.name === ctxName);
    if (!document.getElementById('m-la')) {
      // Fiche
      const u = LF.users[0], edits = new Map(), del = new Set();
      for (const l of LF.cur) {
        if (document.getElementById(`m-lx-${l.id}`)?.checked) { del.add(l.id); continue; }
        const n = $v(`m-le-${l.id}`).trim();
        numCheck(n);
        edits.set(l.id, { exten: n || l.exten, device: document.getElementById(`m-ld-${l.id}`) ? $v(`m-ld-${l.id}`) || null : l.device });
      }
      for (const a of LF.cur) for (const b of LF.cur) if (a.ext_id && a.ext_id === b.ext_id && edits.has(a.id) && edits.has(b.id) && edits.get(a.id).exten !== edits.get(b.id).exten) throw new Error(`Les lignes qui partagent le numéro ${a.exten} doivent garder le même numéro.`);
      const t = $v('m-lt'), n = u ? $v(`m-ln-${u.id}`).trim() : '';
      if (t) { numCheck(n); if (!n) throw new Error('Numéro de la nouvelle ligne obligatoire.'); if (!cx) throw new Error('Aucun contexte interne.'); }
      const dev = $v('m-lnd') || null;
      const added = !t ? [] : (t === 'both' ? ['sip', 'webrtc'] : [t]).map((ty) => ({ type: ty, exten: n, context: ctxName, device: ty === 'sip' ? dev : null }));
      const devs = [...[...edits.values()].map((e) => e.device), ...added.map((l) => l.device)].filter(Boolean);
      if (new Set(devs).size !== devs.length) throw new Error('Le même appareil est choisi pour deux lignes.');
      const changed = LF.cur.filter((l) => edits.has(l.id)), renum = changed.filter((l) => edits.get(l.id).exten !== l.exten), redev = changed.filter((l) => (edits.get(l.id).device || null) !== (l.device || null));
      const parts = [del.size ? `${del.size} supprimée(s)` : '', renum.length ? `numéro ${[...new Set(renum.map((l) => edits.get(l.id).exten))].join(', ')}` : '', redev.length ? 'appareil modifié' : '', added.length ? `ajout ${added.map((l) => LTYPE[l.type]).join(' + ')} ${n}` : ''].filter(Boolean);
      return {
        target: (cur) => [...cur.filter((l) => !del.has(l.id)).map((l) => (edits.has(l.id) ? { ...l, ...edits.get(l.id) } : l)), ...added],
        desc: `Lignes : ${parts.join(', ') || 'modification'}`,
      };
    }
    const act = $v('m-la');
    if (act === 'del') {
      const t = $v('m-ldt');
      return { target: (cur) => cur.filter((l) => !(t === 'all' || l.type === t)), desc: `Lignes : supprimer ${t === 'all' ? 'toutes les lignes' : `les lignes ${LTYPE[t]}`}` };
    }
    const nums = new Map(LF.users.map((u) => [u.id, $v(`m-ln-${u.id}`).trim()]));
    for (const n of nums.values()) numCheck(n);
    const seen = new Map();
    for (const [id, n] of nums) {
      if (!n) continue;
      const u = LF.users.find((x) => x.id === id);
      // Ajout : un même numéro ne peut servir qu'à un utilisateur (sauf le sien).
      if (seen.has(n) && !(act === 'add' && firstExten(u, ctxName) === n)) throw new Error(`Numéro ${n} donné à deux utilisateurs (${seen.get(n)}, ${fullName(u)}).`);
      seen.set(n, fullName(u));
    }
    if (act === 'renum') {
      return {
        target: (cur, u) => {
          const n = nums.get(u.id), old = cur.find((l) => l.exten)?.exten;
          return !n || !old ? cur : cur.map((l) => (l.exten === old ? { ...l, exten: n } : l));
        },
        desc: 'Lignes : changer le numéro',
      };
    }
    if (!cx) throw new Error('Aucun contexte interne dans ce tenant.');
    const t = $v('m-lt'), types = t === 'both' ? ['sip', 'webrtc'] : [t], skip = document.getElementById('m-lskip')?.checked;
    return {
      target: (cur, u) => {
        const n = nums.get(u.id);
        if (!n) return cur;
        const add = types.filter((ty) => !(skip && cur.some((l) => l.type === ty))).map((ty) => ({ type: ty, exten: n, context: ctxName, device: null }));
        return add.length ? [...cur, ...add] : cur;
      },
      desc: `Lignes : ajouter ${types.map((x) => LTYPE[x]).join(' + ')} (${cx.label || cx.name})`,
    };
  },
  check: (u, next) => {
    const cur = readLines(u), byId = new Map(cur.map((l) => [l.id, l]));
    for (const l of next || []) {
      const o = l.id != null ? byId.get(l.id) : null;
      if (o && o.exten === l.exten) continue;
      if (!o && l.type !== 'sip' && l.type !== 'webrtc') return `création d'une ligne ${LTYPE[l.type] || l.type} non gérée`;
      if (!o && !IDX.tpl.global) return 'modèle SIP « global » du tenant introuvable';
      if (!o && l.type === 'webrtc' && !IDX.tpl.webrtc) return 'modèle SIP « webrtc » du tenant introuvable';
      if (!o && l.type === 'webrtc' && u.subscription_type === 0) return 'licence Voix : pas de ligne WebRTC (règle du portail)';
      if (!l.exten) return 'aucun numéro';
      const cx = IDX.contexts.find((x) => x.name === l.context);
      if (!cx) return `contexte ${l.context || '?'} introuvable`;
      if (!inRange(cx, l.exten)) return `numéro ${l.exten} hors des plages du contexte ${ctxText(cx)}`;
      const t = takenBy(u, l.exten, l.context);
      if (t) return t;
    }
    return '';
  },
  write: async (u, next, cur) => {
    const byId = new Map(cur.map((l) => [l.id, l]));
    const keep = new Set(next.filter((l) => l.id != null && byId.has(l.id)).map((l) => l.id));
    // Supprimer une ligne retire l'utilisateur des groupes passés par elle
    // (xivo-dao user_line delete_queue_member), même s'il garde une autre ligne.
    // Appartenances et priorités relues avant, reprises à la fin s'il lui reste
    // une ligne (le portail, lui, les perd).
    const grpPrio = {};
    if (cur.some((l) => !keep.has(l.id))) {
      for (const g of (u.groups || []).map((x) => x.uuid)) { const m = (await groupMembers(g)).find((x) => x.uuid === u.uuid); if (m) grpPrio[g] = m.priority; }
    }
    // 1. Suppressions (appareil dissocié d'abord, sinon refus de confd).
    for (const l of cur) {
      if (keep.has(l.id)) continue;
      if (l.device) await api('DELETE', `/lines/${l.id}/devices/${l.device}`);
      await api('DELETE', `/lines/${l.id}?recursive=true`);
    }
    // 2. Numéros et appareils des lignes gardées.
    const done = new Set();
    for (const l of next) {
      const o = l.id != null && byId.get(l.id);
      if (!o) continue;
      if (l.exten !== o.exten) {
        if (o.ext_id) { if (!done.has(o.ext_id)) { done.add(o.ext_id); await api('PUT', `/extensions/${o.ext_id}`, { exten: l.exten }); } }
        else {
          const ex = IDX.exts.get(`${o.context}|${l.exten}`) || await api('POST', '/extensions', { exten: l.exten, context: o.context });
          await api('PUT', `/lines/${l.id}/extensions/${ex.id}`);
        }
      }
      if ((l.device || null) !== (o.device || null)) {
        if (o.device) await api('DELETE', `/lines/${l.id}/devices/${o.device}`);
        if (l.device) await api('PUT', `/lines/${l.id}/devices/${l.device}`);
      }
    }
    // 3. Créations (et lignes d'une sauvegarde qui n'existent plus).
    for (const l of next) {
      if (l.id != null && byId.has(l.id)) continue;
      const templates = (l.type === 'webrtc' ? [IDX.tpl.global, IDX.tpl.webrtc] : [IDX.tpl.global]).map((uuid) => ({ uuid }));
      // Nom de l'endpoint = identifiant d'authentification, comme l'import de Wazo
      // (vérifié, wazo-confd user_import/creators.py : 'name': fields['username']).
      // Deux valeurs différentes = ligne qui ne s'authentifie pas (retour de Brice,
      // 21/10/2026, lignes WebRTC : 4 h de diagnostic). Le portail fait de même et pose
      // aussi le libellé égal au nom (code du portail, pbx.lines getEndpointData).
      const sipName = rnd(8, 'abcdefghijklmnopqrstuvwxyz');
      const line = await api('POST', '/lines', {
        context: l.context,
        endpoint_sip: { name: sipName, label: sipName, templates, auth_section_options: [['username', sipName], ['password', rnd(16, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789')]] },
        extensions: l.exten ? [{ exten: l.exten, context: l.context }] : [],
      });
      try { await api('PUT', `/users/${u.uuid}/lines/${line.id}`); } catch (e) {
        // Ligne orpheline : supprimée pour ne pas bloquer le numéro.
        try { await api('DELETE', `/lines/${line.id}?recursive=true`); } catch { /* signalé par l'erreur d'origine */ }
        throw e;
      }
      if (l.device) {
        try { await api('PUT', `/lines/${line.id}/devices/${l.device}`); } catch (e) { throw new Error(`ligne ${l.exten} créée, mais appareil non associé : ${e.message}`); }
      }
    }
    // 4. Groupes perdus par une suppression : repris s'il reste une ligne.
    if (Object.keys(grpPrio).length) {
      const f = await api('GET', `/users/${u.uuid}`);
      const now = (f.groups || []).map((x) => x.uuid), lost = Object.keys(grpPrio).filter((g) => !now.includes(g));
      if ((f.lines || []).length && lost.length) await setGroups(f, [...now, ...lost], now, grpPrio);
    }
  },
};
const rnd = (n, cs) => { const b = new Uint32Array(n); crypto.getRandomValues(b); return [...b].map((x) => cs[x % cs.length]).join(''); };

// Prénom, nom : le portail les écrit aussi dans le compte des applications
// (code du portail lu le 21/10/2026, updateAuthUser : PUT /api/auth/0.1/users/{uuid}
// avec firstname, lastname), comme l'import de Wazo (WAZO_USER_RULES).
// PUT /users/{uuid} seul ne touche pas wazo-auth : on fait les deux.
// L'identifiant de l'appelant (interne) ne suit pas : champ séparé dans le
// portail (« Nom de l'appelant », 60 caractères), comme ici.
const nameField = (field, label, opts) => ({
  ...textField(field, label, { ...opts, hint: 'Aussi écrit dans le compte des applications, comme le portail. L\'identifiant de l\'appelant (interne) ne change pas : il se modifie à part, comme dans le portail.' }),
  auth: true, // compte relu avant écriture
  write: async (u, v) => {
    await api('PUT', `/users/${u.uuid}`, { [field]: v });
    if (u._auth) await authPut(u, { [field]: v });
  },
});
// E-mail (annuaire) : le portail ne le reporte dans le compte des applications
// qu'à la création (createAuthUser : email_address) ; à la modification, les
// adresses du compte restent celles de l'onglet Compte. Même chose ici.
// Règle du portail : obligatoire pour les licences Communication unifiée et
// Relation client.
const directoryEmail = {
  ...textField('email', 'E-mail (annuaire)', { re: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, max: 254, hint: 'Courriel public, visible dans les annuaires. Unique sur tout le serveur (tous les clients). Comme dans le portail, les adresses du compte des applications ne changent pas (réglage « Adresses courriels »).' }),
  check: (u, v) => (!v && (u.subscription_type === 1 || u.subscription_type === 3) ? 'obligatoire pour la licence Communication unifiée ou Relation client (règle du portail)' : ''),
};

const ALL_SETTINGS = [
  linesSetting,
  authEnabled, authUsername, authMethod, authEmails,
  nameField('firstname', 'Prénom', { required: true }),
  nameField('lastname', 'Nom'),
  directoryEmail,
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
    // Liste déroulante comme les autres réglages (pas de datalist native) ;
    // valeur actuelle hors liste ajoutée ; « Autre… » = saisie libre.
    form: (c, cur, u, users) => {
      const extra = [...new Set([cur, ...(users || []).map((x) => x.timezone)].filter((z) => z && !TZ.includes(z)))];
      return `<label>Fuseau horaire <select id="m-v">${options([['', 'Aucun (fuseau du serveur)'], ...TZ.map((z) => [z, z]), ...extra.map((z) => [z, z]), ['@other', 'Autre…']], 'Europe/Paris')}</select></label>
        <div data-tz="@other"><label>Autre fuseau (ex. America/Toronto) <input id="m-tzo" spellcheck="false"></label></div>`;
    },
    wire: () => showSub('m-v', 'data-tz'),
    parse: () => {
      const v = ($v('m-v') === '@other' ? $v('m-tzo') : $v('m-v')).trim() || null;
      if (v && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(v)) throw new Error('Fuseau invalide (ex. Europe/Paris).');
      return { target: () => v, desc: `Fuseau : ${v || 'aucun'}` };
    },
    text: (v) => v || '—',
  },
  {
    // Écriture groupe par groupe (setGroups, priorités conservées). Un
    // utilisateur sans ligne ne peut pas être membre d'un groupe (refus de confd).
    id: 'groups', label: 'Groupes d\'appel', grp: 'Groupes et droits', heavy: true, reload: 'user', available: (c) => c.groups.size > 0,
    ...membership((c) => [...c.groups.values()].map((g) => [g.uuid, g.label || g.name]).sort((a, b) => a[1].localeCompare(b[1], 'fr')), (u) => sortedIds(u.groups, 'uuid'), 'Groupes d\'appel', (a) => [...a].sort()),
    read: (u) => sortedIds(u.groups, 'uuid'),
    text: (v, c) => (v?.length ? v.map((x) => c.groups.get(x)?.label || x).join(', ') : '—'),
    // IDX.pending : ligne créée plus tôt dans la même opération (étape Lignes).
    check: (u, v) => (v?.length && !(u.lines || []).length && !IDX.pending.has(u.uuid) ? 'aucune ligne : ne peut pas être membre d\'un groupe (étape Lignes pour en créer une)' : ''),
    write: (u, v, cur) => setGroups(u, v, cur || []),
  },
  {
    // Association idempotente, une route par droit (pas de remplacement).
    id: 'call_permissions', label: 'Droits d\'appel', grp: 'Groupes et droits', available: (c) => c.perms.size > 0,
    ...membership((c) => [...c.perms.values()].map((p) => [p.id, p.name]).sort((a, b) => a[1].localeCompare(b[1], 'fr')), (u) => sortedIds(u.call_permissions, 'id').sort((a, b) => a - b), 'Droits d\'appel', (a) => [...a].map(Number).sort((x, y) => x - y)),
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
// Aide de chaque réglage (norme Astrea : bouton « ? » dans le formulaire,
// infobulle sur les colonnes et les cases de l'assistant). Sources : code
// Wazo (confd, wazo-auth) et essais réels notés dans docs/USER-MANAGER.md ;
// « supposé » quand ce n'est pas vérifié.
const FB_HELP = 'Renvoi par défaut (« appel de secours »), réglable seulement par l\'administrateur. Toujours actif : il s\'applique quand aucun renvoi d\'appel de l\'utilisateur n\'a pris l\'appel.';
const FWD_HELP = 'Renvoi d\'appel que l\'utilisateur peut aussi gérer lui-même (postes, applications). Activer vers un numéro ; désactiver garde le numéro enregistré pour une prochaine fois.';
const HELP = {
  firstname: 'Prénom de l\'utilisateur, affiché dans les annuaires et, par défaut, sur les postes des collègues. Obligatoire.',
  lastname: 'Nom de famille de l\'utilisateur. Facultatif.',
  email: 'Courriel public de la fiche (Renseignements personnels), affiché dans les annuaires. Unique sur tout le serveur (tous les clients). Différent des adresses de connexion (Compte) et de l\'e-mail de la boîte vocale.',
  mobile_phone_number: 'Numéro de mobile de l\'utilisateur, affiché dans les annuaires. Ne peut pas être vidé si le renvoi vers le mobile est activé.',
  description: 'Texte libre, visible seulement des administrateurs.',
  caller_id: 'Nom affiché sur le poste des collègues lors d\'un appel interne (par défaut « Prénom Nom »). Sans effet sur les appels externes, qui utilisent l\'identification de l\'appelant sortant.',
  enabled: 'Ancien indicateur hérité de XiVO, absent du portail et sans effet constaté sur les appels. Proposé seulement pour réactiver un utilisateur désactivé.',
  subscription_type: 'Type de souscription du portail. Voix : téléphonie seule, les applications Wazo refusent la connexion (vérifié). Communication unifiée : applications Wazo en plus. Relation client : Support Center et POPC en plus. Les quotas (« souscriptions restantes ») sont gérés par le portail, la stack ne bloque pas un dépassement.',
  language: 'Langue des annonces et messages vocaux joués à l\'utilisateur (messagerie, services).',
  timezone: 'Fuseau horaire de l\'utilisateur (supposé : horodatages dans les applications et la messagerie). Aucun = fuseau du serveur.',
  auth_enabled: '« Autorisé à utiliser des applications » (onglet Compte) : le compte peut se connecter aux applications Wazo (web, bureau, mobile). Avec une licence Voix, la connexion est refusée de toute façon.',
  auth_username: 'Identifiant de connexion aux applications Wazo. Unique sur le serveur.',
  auth_method: 'Comment le compte s\'authentifie : méthode par défaut de l\'organisation (Paramètres › Mon organisation), mot de passe Wazo (native), SAML ou LDAP (le fournisseur doit être configuré, sinon le serveur refuse).',
  auth_emails: 'Adresses du compte de connexion. La principale reçoit les e-mails de mot de passe oublié ; une adresse non confirmée reçoit d\'abord un e-mail de confirmation.',
  dnd: 'Ne pas déranger : les appels ne font plus sonner les postes de l\'utilisateur. Il peut l\'activer lui-même depuis son poste ou les applications.',
  incallfilter: 'Filtrage des appels entrants (fonction patron / secrétaire) : les appels passent par le filtre configuré dans le portail pour cet utilisateur.',
  ring_seconds: 'Durée de sonnerie des postes de l\'utilisateur avant le renvoi « pas de réponse » ou le renvoi par défaut « non répondu » (0 à 10800 s, 30 par défaut).',
  simultaneous_calls: 'Nombre d\'appels que l\'utilisateur peut avoir en même temps, double appel compris ; au-delà, il est considéré comme occupé (1 à 20, 5 par défaut).',
  music_on_hold: 'Musique entendue par le correspondant quand l\'utilisateur le met en attente. « Par défaut » : musique du tenant.',
  fwd_busy: `${FWD_HELP} Occupé : quand l'utilisateur est déjà en ligne.`,
  fwd_unconditional: `${FWD_HELP} Inconditionnel : tous les appels partent vers ce numéro, sans faire sonner les postes.`,
  fwd_noanswer: `${FWD_HELP} Pas de réponse : après la durée de sonnerie.`,
  fb_busy: `${FB_HELP} Si occupé : l'utilisateur est en ligne (ou au maximum de ses appels simultanés).`,
  fb_congestion: `${FB_HELP} Congestion : l'appel ne peut pas être acheminé (ressources saturées).`,
  fb_fail: `${FB_HELP} Échec : le poste est injoignable (non enregistré, erreur).`,
  fb_noanswer: `${FB_HELP} Non répondu : personne n'a décroché pendant la durée de sonnerie.`,
  outgoing_caller_id: 'Numéro présenté aux correspondants externes : par défaut (règle du tenant ou de la ligne), anonyme, un numéro du tenant, la SDA de l\'utilisateur, ou un autre numéro (l\'opérateur peut refuser un numéro qui n\'appartient pas au client).',
  call_permissions: 'Droits d\'appel : listes de numéros autorisés ou interdits (avec mot de passe éventuel), définies dans le portail. L\'utilisateur est soumis à tous ceux qui lui sont associés.',
  voicemail: 'Boîte vocale de l\'utilisateur (une boîte peut être partagée). Les réglages de la boîte (code, e-mail, options) se font dans Messageries vocales.',
  lines: 'Lignes téléphoniques de l\'utilisateur : sans ligne, il ne peut ni appeler, ni être appelé, ni être membre d\'un groupe. SIP : poste de bureau, DECT ou softphone tiers (identifiants SIP générés au hasard). WebRTC : applications Wazo (web, bureau, mobile). Plusieurs lignes sur le même numéro sonnent ensemble. Le numéro doit être libre et dans une plage « utilisateurs » du contexte. Supprimer une ligne libère son numéro et dissocie son appareil ; confd retire l\'utilisateur des groupes et files liés à cette ligne : User Manager remet les groupes (même position) s\'il lui reste une ligne, pas les files.',
  groups: 'Groupes d\'appel dont l\'utilisateur est membre : ses postes sonnent quand le groupe est appelé. Il faut une ligne pour être membre. Ajout en fin de liste des membres ; la position des autres membres et celle de l\'utilisateur dans ses autres groupes ne changent pas.',
  schedule: 'Plage horaire de l\'utilisateur : hors plage, ses appels vont vers la destination « fermé » de la plage. Un seul horaire par utilisateur.',
};

// Rangement commun aux colonnes de l'audit (app.js), à l'assistant et à la
// fiche, calqué sur les onglets de la fiche utilisateur du portail.
const LAYOUT = [
  ['Utilisateur', ['firstname', 'lastname', 'email', 'mobile_phone_number', 'description', 'caller_id', 'enabled', 'subscription_type', 'language']],
  ['Compte (applications)', ['auth_enabled', 'auth_username', 'auth_method', 'auth_emails']],
  ['Lignes', ['lines']],
  ['Services voix', ['dnd', 'incallfilter', 'ring_seconds', 'simultaneous_calls', 'music_on_hold']],
  ['Renvois d\'appel (utilisateur)', ['fwd_busy', 'fwd_unconditional', 'fwd_noanswer']],
  ['Renvois par défaut (admin)', ['fb_busy', 'fb_congestion', 'fb_fail', 'fb_noanswer']],
  ['Appels sortants', ['outgoing_caller_id', 'call_permissions']],
  ['Boîte vocale', ['voicemail']],
  ['Groupes', ['groups']],
  ['Horaires', ['schedule', 'timezone']],
];
export const SETTINGS = LAYOUT.flatMap(([grp, ids]) => ids.map((id) => {
  const s = ALL_SETTINGS.find((x) => x.id === id);
  if (!s) console.error('[astrea] réglage inconnu dans LAYOUT', id);
  if (s && !HELP[id]) console.warn('[astrea] réglage sans aide', id);
  return s && { ...s, grp, help: HELP[id] || '' };
})).filter(Boolean);
if (SETTINGS.length !== ALL_SETTINGS.length) console.error('[astrea] réglage absent de LAYOUT', ALL_SETTINGS.filter((s) => !SETTINGS.some((x) => x.id === s.id)).map((s) => s.id));
export const settingById = (id) => SETTINGS.find((s) => s.id === id);
