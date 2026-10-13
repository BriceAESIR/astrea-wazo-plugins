// User Manager — réglages modifiables en masse (lot 2a). Chaque réglage :
//  read(u)            valeur actuelle, lue sur un utilisateur (GET /users/{uuid})
//  form(ctx)          champs du dialogue (ids m-*), parse(ctx) → { target(cur), desc }
//                     (lève une Error si la saisie est invalide)
//  text(v, ctx)       valeur lisible (aperçu, sauvegarde)
//  check(u, v)        message si l'écriture est impossible pour cet utilisateur
//  write(u, v, cur)   écriture (seulement si v diffère de cur)
//  heavy              true = PUT /users ou groupes : recharge Asterisk et
//                     régénère la config provd des postes (écritures espacées)
// Routes et sémantique vérifiées dans le code de wazo-confd (13/10/2026),
// voir docs/USER-MANAGER.md. Écritures non encore testées en réel.
import { api, esc } from '../common/core.js?v=0.24.0';

export const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
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
  heavy: true,
});
const service = (key, label) => ({
  id: key, label, grp: 'Services', form: () => onOff(label),
  parse: () => { const v = $v('m-v') === '1'; return { target: () => v, desc: `${label} : ${v ? 'activé' : 'désactivé'}` }; },
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

export const SETTINGS = [
  service('dnd', 'Ne pas déranger'),
  service('incallfilter', 'Filtrage des appels'),
  forward('busy', 'occupé'),
  forward('unconditional', 'inconditionnel'),
  forward('noanswer', 'pas de réponse'),
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
    id: 'groups', label: 'Groupes d\'appel', grp: 'Groupes et droits', heavy: true,
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
