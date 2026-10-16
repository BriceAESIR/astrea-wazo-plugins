// Call Flow Manager — éditeurs des autres cartes (demande de Brice, 16/10/2026 :
// « toutes les cartes modifiables depuis le mode édition »), selon la norme
// d'édition du module (ed-ui.js) : SDA, utilisateur (routage), messagerie,
// conférence, horaire (général). Sans écriture : valeur au brouillon (onSave).
// Vérifié dans wazo-confd master : PUT partiels (helpers/restful.py,
// incall/middleware.py, middleware.py) ; renvois PUT /users/{uuid}/forwards/{type}
// {enabled, destination (texte ≤ 128)} ; services PUT /users/{uuid}/services/
// {dnd|incallfilter} {enabled} ; messagerie : delete_messages exige email et
// attach_audio dans le même envoi (validates_schema).
// Codes (messagerie, conférence) : champ masqué avec « Afficher » / « Générer » ;
// jamais en clair dans le brouillon, l'aperçu ni la sauvegarde JSON (redact).
// Le mot de passe de connexion d'un utilisateur reste dans User Manager.
import { $, esc, confirmModal, helpButton, helpBox, fullName } from '../common/core.js?v=0.39.1';
import { M } from './model.js?v=0.39.1';
import { fillSoundSelect } from './sched-editor.js?v=0.39.1';
import { sec, field, check, setSums, openSec, secretField, bindSecrets } from './ed-ui.js?v=0.39.1';

const pickFields = (o, keys) => { const f = {}; for (const k of keys) f[k] = o?.[k] ?? null; return f; };
const diffKeys = (a, b, keys, L) => keys.filter((k) => JSON.stringify(a?.fields?.[k] ?? null) !== JSON.stringify(b?.fields?.[k] ?? null)).map((k) => L[k] || k);
const mohOpts = (cur, none = 'Par défaut') => `<option value="">${esc(none)}</option>${(M.lists.moh || []).map((m) => `<option value="${esc(m.name)}"${cur === m.name ? ' selected' : ''}>${esc(m.label || m.name)}</option>`).join('')}${cur && !(M.lists.moh || []).some((m) => m.name === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)} (actuelle)</option>` : ''}`;
const cidOpts = (cur) => [['', 'Inchangé : nom de l\'appelant seul'], ['prepend', 'Texte, puis nom de l\'appelant'], ['overwrite', 'Texte seul, à la place du nom'], ['append', 'Nom de l\'appelant, puis texte']].map(([k, l]) => `<option value="${k}"${(cur || '') === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
const head = (id, title, sub, help) => `<div class="cf-ge-head"><div><h3>${esc(title)}</h3>${sub ? `<div class="small muted">${esc(sub)}</div>` : ''}</div>${helpButton(id, 'Aide')}</div>${helpBox(id, `${help} Les modifications vont dans le brouillon ; « Appliquer… » relit l'objet et n'écrit que ce qui change.`)}`;
const val = (box, sel) => box.querySelector(sel)?.value?.trim() ?? '';
const intOrNull = (s, min, max) => (s === '' ? null : /^\d+$/.test(s) && Number(s) >= min && (max == null || Number(s) <= max) ? Number(s) : undefined);
// Fuseaux horaires du navigateur (liste complète si disponible).
const zones = () => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['Europe/Paris', 'Europe/Brussels', 'Europe/Zurich', 'Europe/Luxembourg', 'America/Montreal', 'Indian/Reunion', 'America/Martinique', 'America/Guadeloupe', 'Pacific/Noumea', 'UTC']; } };
const tzSelect = (attr, cur) => `<select ${attr}><option value="">Fuseau du serveur</option>${zones().map((z) => `<option value="${esc(z)}"${cur === z ? ' selected' : ''}>${esc(z)}</option>`).join('')}${cur && !zones().includes(cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ''}</select>`;

// ---------------------------------------------------------------------------
// SDA (destination et horaire : entrées habituelles du brouillon)
// ---------------------------------------------------------------------------
export const INCALL_FIELDS = ['description', 'caller_id_mode', 'caller_id_name', 'greeting_sound', 'preprocess_subroutine'];
export const incallCfgOf = (o) => ({ fields: pickFields(o, INCALL_FIELDS) });
export const applyIncallCfg = (o, v) => Object.assign(o, v.fields);
export function openIncallEditor(o, num, onSave) {
  const f = incallCfgOf(o).fields;
  confirmModal(`<div class="cf-ed">
    ${head('ie2-hb', `SDA ${num}`, o.description || '', 'Options de l\'API Wazo pour une SDA. La destination se change sur la sortie « Destination », l\'horaire sur la carte horaire.')}
    ${sec('gen', 'Général', field('Description', `<input data-f="description" value="${esc(f.description || '')}" placeholder="ex. Standard">`), { open: true })}
    ${sec('call', 'Appel entrant', `
      ${field('Message d\'accueil', '<select data-f="greeting_sound" id="ice-greet"><option value="">Chargement des sons…</option></select>', 'Joué à l\'appelant avant la destination.')}
      <div class="cf-ge-2">
        ${field('Nom affiché à l\'appelé', `<select data-f="caller_id_mode">${cidOpts(f.caller_id_mode)}</select>`)}
        <span id="ice-cidtxt"${f.caller_id_mode ? '' : ' hidden'}>${field('Texte', `<input data-f="caller_id_name" value="${esc(f.caller_id_name || '')}" maxlength="80" placeholder="ex. Accueil">`, 'Pour savoir par quel numéro l\'appel est arrivé.')}</span>
      </div>`, { open: true })}
    ${sec('adv', 'Avancé', field('Sous-routine', `<input data-f="preprocess_subroutine" value="${esc(f.preprocess_subroutine || '')}" maxlength="79" placeholder="aucune">`))}
    <p id="ice-err" class="error small"></p></div>`, () => {
    const box = $('modal-body');
    const nf = { ...f };
    nf.description = val(box, '[data-f="description"]') || null;
    nf.greeting_sound = box.querySelector('[data-f="greeting_sound"]').value || null;
    nf.caller_id_mode = box.querySelector('[data-f="caller_id_mode"]').value || null;
    nf.caller_id_name = nf.caller_id_mode ? val(box, '[data-f="caller_id_name"]') || null : null;
    if (nf.caller_id_mode && !nf.caller_id_name) { openSec(box, 'call'); $('ice-err').textContent = 'Nom affiché : saisissez le texte, ou choisissez « Inchangé ».'; return false; }
    nf.preprocess_subroutine = val(box, '[data-f="preprocess_subroutine"]') || null;
    onSave({ fields: nf });
    return true;
  }, 'Ajouter au brouillon');
  const box = $('modal-body');
  const recap = () => setSums(box, {
    gen: [val(box, '[data-f="description"]') || 'sans description'],
    call: [box.querySelector('#ice-greet')?.value ? 'avec accueil' : 'sans accueil', val(box, '[data-f="caller_id_mode"]') ? `nom « ${val(box, '[data-f="caller_id_name"]')} »` : ''],
    adv: [val(box, '[data-f="preprocess_subroutine"]')],
  });
  fillSoundSelect($('ice-greet'), f.greeting_sound || '').then(() => { const s = $('ice-greet'); if (s?.options[0] && !s.options[0].value) s.options[0].textContent = 'Aucun'; recap(); });
  box.addEventListener('input', recap);
  box.addEventListener('change', (e) => { if (e.target.matches('[data-f="caller_id_mode"]')) $('ice-cidtxt').hidden = !e.target.value; recap(); });
  recap();
}
export const incallCfgDiff = (a, b) => diffKeys(a, b, INCALL_FIELDS, { description: 'description', caller_id_mode: 'nom affiché', caller_id_name: 'texte du nom', greeting_sound: 'accueil', preprocess_subroutine: 'sous-routine' }).join(', ');

// ---------------------------------------------------------------------------
// Utilisateur : réglages de routage seulement (le reste : User Manager).
// Débordements et horaire : entrées habituelles du brouillon.
// ---------------------------------------------------------------------------
export const USER_FIELDS = ['ring_seconds', 'simultaneous_calls'];
const FWD = [['unconditional', 'Renvoi immédiat'], ['busy', 'Renvoi si occupé'], ['noanswer', 'Renvoi si pas de réponse']];
export function userCfgOf(u) {
  const fw = {}; for (const [k] of FWD) fw[k] = { enabled: !!u?.forwards?.[k]?.enabled, destination: u?.forwards?.[k]?.destination || null };
  return { fields: pickFields(u, USER_FIELDS), dnd: !!u?.services?.dnd?.enabled, incallfilter: !!u?.services?.incallfilter?.enabled, forwards: fw };
}
export function applyUserCfg(u, v) {
  Object.assign(u, v.fields);
  u.services = { ...(u.services || {}), dnd: { enabled: v.dnd }, incallfilter: { enabled: v.incallfilter } };
  u.forwards = JSON.parse(JSON.stringify(v.forwards));
}
export function openUserEditor(u, onSave) {
  const v = userCfgOf(u); const f = v.fields;
  confirmModal(`<div class="cf-ed">
    ${head('ue-hb', fullName(u), [u.username, u.email].filter(Boolean).join(' · '), 'Réglages de l\'utilisateur qui jouent sur le parcours des appels. Les autres (identité, lignes, touches…) se règlent dans User Manager ou le portail. Les débordements (pas de réponse, occupé…) se changent sur les sorties de la carte.')}
    ${sec('ring', 'Sonnerie', `
      <div class="cf-ge-2">
        ${field('Durée de sonnerie (s)', `<input type="number" min="0" max="10800" step="1" data-f="ring_seconds" value="${esc(f.ring_seconds ?? '')}">`, 'Avant le débordement « pas de réponse ».')}
        ${field('Appels simultanés', `<input type="number" min="1" max="20" step="1" data-f="simultaneous_calls" value="${esc(f.simultaneous_calls ?? '')}">`, 'Au-delà : débordement « occupé ».')}
      </div>`, { open: true })}
    ${sec('svc', 'Services', `${check('ue-dnd', 'Ne pas déranger (NPD)', 'Les appels ne sonnent pas sur ses postes. Dans un groupe, il est sauté ; dans une file, mis en pause.', v.dnd)}
      ${check('ue-filter', 'Filtrage d\'appels (patron / secrétaire)', 'Active le filtrage réglé dans Wazo pour cet utilisateur.', v.incallfilter)}`, { open: true })}
    ${sec('fwd', 'Renvois d\'appel', FWD.map(([k, l]) => `${check(`ue-f-${k}`, l, '', v.forwards[k].enabled)}
      <div class="cf-ge-sub" id="ue-fb-${k}"${v.forwards[k].enabled ? '' : ' hidden'}>${field('Vers le numéro', `<input data-fwd="${k}" value="${esc(v.forwards[k].destination || '')}" maxlength="128" placeholder="ex. 0612345678 ou 1002">`)}</div>`).join(''), { open: true, help: 'Renvois du profil de l\'utilisateur, vers un numéro (interne ou externe). Ils ne jouent pas quand il est appelé par un groupe (supposé).' })}
    <p id="ue-err" class="error small"></p></div>`, () => {
    const box = $('modal-body');
    const err = (m, s) => { openSec(box, s); $('ue-err').textContent = m; return false; };
    const nf = { ...f };
    // Champ vide : valeur lue conservée (pas d'écriture).
    const r = intOrNull(val(box, '[data-f="ring_seconds"]'), 0, 10800); if (r === undefined) return err('Durée de sonnerie : 0 à 10800 s.', 'ring'); nf.ring_seconds = r ?? f.ring_seconds;
    const sc = intOrNull(val(box, '[data-f="simultaneous_calls"]'), 1, 20); if (sc === undefined) return err('Appels simultanés : 1 à 20.', 'ring'); nf.simultaneous_calls = sc ?? f.simultaneous_calls;
    const forwards = {};
    for (const [k, l] of FWD) {
      const on = $(`ue-f-${k}`).checked; const d = box.querySelector(`[data-fwd="${k}"]`).value.trim();
      if (on && !/^[0-9*#+]{1,128}$/.test(d)) return err(`${l} : numéro (chiffres, * # +).`, 'fwd');
      forwards[k] = { enabled: on, destination: d || null };
    }
    onSave({ fields: nf, dnd: $('ue-dnd').checked, incallfilter: $('ue-filter').checked, forwards });
    return true;
  }, 'Ajouter au brouillon');
  const box = $('modal-body');
  const recap = () => setSums(box, {
    ring: [`${val(box, '[data-f="ring_seconds"]') || '?'} s`, `${val(box, '[data-f="simultaneous_calls"]') || '?'} appel(s) simultané(s)`],
    svc: [$('ue-dnd').checked ? 'NPD' : '', $('ue-filter').checked ? 'filtrage' : ''].filter(Boolean).length ? [$('ue-dnd').checked ? 'NPD' : '', $('ue-filter').checked ? 'filtrage' : ''] : ['aucun'],
    fwd: FWD.filter(([k]) => $(`ue-f-${k}`).checked).map(([k, l]) => `${l.replace('Renvoi ', '')} → ${box.querySelector(`[data-fwd="${k}"]`).value || '?'}`).concat(FWD.some(([k]) => $(`ue-f-${k}`).checked) ? [] : ['aucun']),
  });
  box.addEventListener('input', () => { $('ue-err').textContent = ''; recap(); });
  box.addEventListener('change', (e) => { const m = e.target.id.match(/^ue-f-(\w+)$/); if (m) $(`ue-fb-${m[1]}`).hidden = !e.target.checked; recap(); });
  recap();
}
export function userCfgDiff(a, b) {
  const out = diffKeys(a, b, USER_FIELDS, { ring_seconds: 'durée de sonnerie', simultaneous_calls: 'appels simultanés' });
  if (a?.dnd !== b?.dnd) out.push('NPD');
  if (a?.incallfilter !== b?.incallfilter) out.push('filtrage');
  for (const [k, l] of FWD) if (JSON.stringify(a?.forwards?.[k]) !== JSON.stringify(b?.forwards?.[k])) out.push(l.toLowerCase());
  return out.join(', ');
}

// ---------------------------------------------------------------------------
// Messagerie (le code d'accès n'est pas modifiable ici)
// ---------------------------------------------------------------------------
export const VM_FIELDS = ['name', 'number', 'context', 'email', 'language', 'timezone', 'pager', 'max_messages', 'attach_audio', 'delete_messages', 'ask_password', 'enabled', 'password'];
export const vmCfgOf = (o) => ({ fields: pickFields(o, VM_FIELDS) });
export const applyVmCfg = (o, v) => Object.assign(o, v.fields);
const LANGS = [['fr_FR', 'Français (France)'], ['fr_CA', 'Français (Canada)'], ['en_US', 'Anglais (États-Unis)'], ['en_GB', 'Anglais (Royaume-Uni)'], ['de_DE', 'Allemand'], ['es_ES', 'Espagnol'], ['it_IT', 'Italien'], ['nl_NL', 'Néerlandais']];
export function openVmEditor(o, onSave) {
  const f = vmCfgOf(o).fields;
  const ctx = (M.lists.context || []).filter((c) => c.type === 'internal');
  const users = (o.users || []).map((u) => fullName(u)).filter(Boolean);
  const b = (k, l, h) => check(`vme-${k}`, l, h, !!f[k], `data-b="${k}"`);
  confirmModal(`<div class="cf-ed">
    ${head('vme-hb', `Messagerie « ${o.name} »`, users.length ? `Utilisée par ${users.join(', ')}` : (o.accesstype === 'global' ? 'Messagerie partagée' : ''), 'Options de l\'API Wazo pour une boîte vocale. Le code est masqué dans le brouillon, l\'aperçu et la sauvegarde JSON.')}
    ${sec('gen', 'Général', `
      ${field('Nom *', `<input data-f="name" value="${esc(f.name || '')}" maxlength="80">`)}
      <div class="cf-ge-2">
        ${field('Numéro *', `<input data-f="number" value="${esc(f.number || '')}">`, 'Pour consulter la boîte.')}
        ${field('Contexte *', `<select data-f="context">${ctx.map((c) => `<option value="${esc(c.name)}"${f.context === c.name ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('')}${f.context && !ctx.some((c) => c.name === f.context) ? `<option value="${esc(f.context)}" selected>${esc(f.context)}</option>` : ''}</select>`)}
      </div>
      ${b('enabled', 'Messagerie activée', '')}`, { open: true })}
    ${sec('mail', 'Messages par e-mail', `
      ${field('E-mail', `<input type="email" data-f="email" value="${esc(f.email || '')}" maxlength="80" placeholder="aucun">`, 'Chaque nouveau message y est signalé.')}
      ${b('attach_audio', 'Joindre le message audio', '')}
      ${b('delete_messages', 'Supprimer le message après l\'envoi', 'Exige un e-mail et la pièce jointe (contrainte Wazo).')}
      ${field('Pager (e-mail court)', `<input data-f="pager" value="${esc(f.pager || '')}" maxlength="80" placeholder="aucun">`)}`, { open: true })}
    ${sec('opt', 'Options', `
      <div class="cf-ge-2">
        ${field('Langue', `<select data-f="language"><option value="">Langue du serveur</option>${LANGS.map(([k, l]) => `<option value="${k}"${f.language === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}${f.language && !LANGS.some(([k]) => k === f.language) ? `<option value="${esc(f.language)}" selected>${esc(f.language)}</option>` : ''}</select>`)}
        ${field('Fuseau horaire', tzSelect('data-f="timezone"', f.timezone), 'Pour l\'heure annoncée des messages.')}
      </div>
      ${field('Nombre maximum de messages', `<input type="number" min="0" step="1" data-f="max_messages" value="${esc(f.max_messages ?? '')}" placeholder="défaut du serveur">`)}
      ${secretField('data-f="password"', 'Code de la messagerie', f.password, 'Chiffres seulement. Vide : pas de code.')}
      ${b('ask_password', 'Demander le code à la consultation', 'Décoché : accès direct depuis le poste du titulaire.')}`)}
    <p id="vme-err" class="error small"></p></div>`, () => {
    const box = $('modal-body');
    const err = (m, s) => { openSec(box, s); $('vme-err').textContent = m; return false; };
    const nf = { ...f };
    nf.name = val(box, '[data-f="name"]'); if (!nf.name) return err('Nom obligatoire.', 'gen');
    nf.number = val(box, '[data-f="number"]'); if (!/^[0-9]{1,40}$/.test(nf.number)) return err('Numéro : chiffres seulement.', 'gen');
    nf.context = box.querySelector('[data-f="context"]').value;
    nf.email = val(box, '[data-f="email"]') || null; if (nf.email && !/^[^@\s]+@[^@\s]+$/.test(nf.email)) return err('E-mail invalide.', 'mail');
    nf.pager = val(box, '[data-f="pager"]') || null;
    nf.language = box.querySelector('[data-f="language"]').value || null;
    nf.timezone = box.querySelector('[data-f="timezone"]').value || null;
    const mm = intOrNull(val(box, '[data-f="max_messages"]'), 0); if (mm === undefined) return err('Nombre de messages : entier positif.', 'opt'); nf.max_messages = mm;
    nf.password = val(box, '[data-f="password"]') || null; if (nf.password && !/^[0-9]{1,80}$/.test(nf.password)) return err('Code de la messagerie : chiffres seulement.', 'opt');
    // Case non lue (valeur absente) et laissée décochée : rien n'est écrit.
    for (const el of box.querySelectorAll('[data-b]')) nf[el.dataset.b] = f[el.dataset.b] == null && !el.checked ? f[el.dataset.b] : el.checked;
    if (nf.delete_messages && (!nf.email || !nf.attach_audio)) return err('« Supprimer après l\'envoi » exige un e-mail et la pièce jointe audio.', 'mail');
    onSave({ fields: nf });
    return true;
  }, 'Ajouter au brouillon');
  const box = $('modal-body');
  const recap = () => setSums(box, {
    gen: [val(box, '[data-f="name"]'), val(box, '[data-f="number"]') ? `n° ${val(box, '[data-f="number"]')}` : '', box.querySelector('[data-b="enabled"]').checked ? '' : 'DÉSACTIVÉE'],
    mail: [val(box, '[data-f="email"]') || 'pas d\'e-mail', box.querySelector('[data-b="attach_audio"]').checked ? 'avec audio' : ''],
    opt: [box.querySelector('[data-f="language"]').selectedOptions[0]?.text, val(box, '[data-f="max_messages"]') ? `${val(box, '[data-f="max_messages"]')} messages max.` : ''],
  });
  bindSecrets(box);
  box.addEventListener('input', () => { $('vme-err').textContent = ''; recap(); });
  box.addEventListener('change', recap);
  recap();
}
export const vmCfgDiff = (a, b) => diffKeys(a, b, VM_FIELDS, { name: 'nom', number: 'numéro', context: 'contexte', email: 'e-mail', language: 'langue', timezone: 'fuseau', pager: 'pager', max_messages: 'messages max.', attach_audio: 'pièce jointe', delete_messages: 'suppression après envoi', ask_password: 'demande du code', enabled: 'activée', password: 'code' }).join(', ');

// ---------------------------------------------------------------------------
// Conférence
// ---------------------------------------------------------------------------
export const CONF_FIELDS = ['name', 'max_users', 'record', 'quiet_join_leave', 'announce_join_leave', 'announce_user_count', 'announce_only_user', 'music_on_hold', 'preprocess_subroutine', 'pin', 'admin_pin'];
export const confCfgOf = (o) => ({ fields: pickFields(o, CONF_FIELDS) });
export const applyConfCfg = (o, v) => Object.assign(o, v.fields);
export function openConfEditor(o, onSave) {
  const f = confCfgOf(o).fields;
  const b = (k, l, h) => check(`cfe-${k}`, l, h, !!f[k], `data-b="${k}"`);
  confirmModal(`<div class="cf-ed">
    ${head('cfe-hb', `Conférence « ${o.name || o.id} »`, [o.extensions?.[0]?.exten, o.pin ? 'code d\'accès défini' : 'sans code d\'accès'].filter(Boolean).join(' · '), 'Options de l\'API Wazo pour une salle de conférence. Les codes sont masqués dans le brouillon, l\'aperçu et la sauvegarde JSON.')}
    ${sec('gen', 'Général', `
      ${field('Nom', `<input data-f="name" value="${esc(f.name || '')}" maxlength="128">`)}
      ${field('Participants maximum', `<input type="number" min="0" step="1" data-f="max_users" value="${esc(f.max_users ?? '')}">`, '0 = illimité.')}
      ${b('record', 'Enregistrer la conférence', '')}`, { open: true })}
    ${sec('ann', 'Annonces', `${b('announce_join_leave', 'Annoncer les arrivées et départs', 'Chaque participant dit son nom en entrant.')}
      ${b('quiet_join_leave', 'Arrivées et départs silencieux', 'Pas de son quand quelqu\'un entre ou sort.')}
      ${b('announce_user_count', 'Annoncer le nombre de participants', '')}
      ${b('announce_only_user', 'Annoncer « vous êtes seul »', '')}
      ${field('Musique d\'attente', `<select data-f="music_on_hold">${mohOpts(f.music_on_hold, 'Aucune')}</select>`, 'Pour le premier participant, en attendant les autres.')}`, { open: true })}
    ${sec('codes', 'Codes d\'accès', `<div class="cf-ge-2">${secretField('data-f="pin"', 'Code participant', f.pin, 'Vide : entrée libre.')}${secretField('data-f="admin_pin"', 'Code animateur', f.admin_pin, 'Vide : pas d\'animateur.')}</div>`)}
    ${sec('adv', 'Avancé', field('Sous-routine', `<input data-f="preprocess_subroutine" value="${esc(f.preprocess_subroutine || '')}" maxlength="79" placeholder="aucune">`))}
    <p id="cfe-err" class="error small"></p></div>`, () => {
    const box = $('modal-body');
    const nf = { ...f };
    nf.name = val(box, '[data-f="name"]') || null;
    const mu = intOrNull(val(box, '[data-f="max_users"]'), 0); if (mu === undefined) { openSec(box, 'gen'); $('cfe-err').textContent = 'Participants : entier positif.'; return false; } nf.max_users = mu ?? 0;
    // Case non lue (valeur absente) et laissée décochée : rien n'est écrit.
    for (const el of box.querySelectorAll('[data-b]')) nf[el.dataset.b] = f[el.dataset.b] == null && !el.checked ? f[el.dataset.b] : el.checked;
    nf.music_on_hold = box.querySelector('[data-f="music_on_hold"]').value || null;
    nf.preprocess_subroutine = val(box, '[data-f="preprocess_subroutine"]') || null;
    for (const k of ['pin', 'admin_pin']) { nf[k] = val(box, `[data-f="${k}"]`) || null; if (nf[k] && !/^[0-9]{1,80}$/.test(nf[k])) { openSec(box, 'codes'); $('cfe-err').textContent = 'Codes : chiffres seulement.'; return false; } }
    onSave({ fields: nf });
    return true;
  }, 'Ajouter au brouillon');
  const box = $('modal-body');
  bindSecrets(box);
  const recap = () => setSums(box, {
    codes: [val(box, '[data-f="pin"]') ? 'code participant' : 'entrée libre', val(box, '[data-f="admin_pin"]') ? 'code animateur' : ''],
    gen: [Number(val(box, '[data-f="max_users"]')) ? `${val(box, '[data-f="max_users"]')} participants max.` : 'illimité', box.querySelector('[data-b="record"]').checked ? 'enregistrée' : ''],
    ann: [`${box.querySelectorAll('[data-sec="ann"] [data-b]:checked').length} annonce(s)`],
    adv: [val(box, '[data-f="preprocess_subroutine"]')],
  });
  box.addEventListener('input', recap); box.addEventListener('change', recap);
  recap();
}
export const confCfgDiff = (a, b) => diffKeys(a, b, CONF_FIELDS, { name: 'nom', max_users: 'participants max.', record: 'enregistrement', quiet_join_leave: 'arrivées silencieuses', announce_join_leave: 'annonce des arrivées', announce_user_count: 'nombre de participants', announce_only_user: '« vous êtes seul »', music_on_hold: 'musique', preprocess_subroutine: 'sous-routine', pin: 'code participant', admin_pin: 'code animateur' }).join(', ');

// ---------------------------------------------------------------------------
// Horaire : nom, fuseau, activé (les heures : éditeur d'horaire)
// ---------------------------------------------------------------------------
export const SCHED_FIELDS = ['name', 'timezone', 'enabled'];
export const schedCfgOf = (o) => ({ fields: pickFields(o, SCHED_FIELDS) });
export const applySchedCfg = (o, v) => Object.assign(o, v.fields);
export function openSchedGenEditor(o, used, onSave, openHours) {
  const f = schedCfgOf(o).fields;
  confirmModal(`<div class="cf-ed">
    ${head('sge-hb', `Horaire « ${o.name || o.id} »`, used > 1 ? `Partagé par ${used} objets` : '', 'Nom, fuseau et activation de l\'horaire. Désactivé, l\'horaire laisse toujours passer (ouvert, supposé). Les heures d\'ouverture et fermetures se règlent dans l\'éditeur d\'heures.')}
    ${sec('gen', 'Général', `
      ${field('Nom', `<input data-f="name" value="${esc(f.name || '')}" maxlength="128">`)}
      ${field('Fuseau horaire', tzSelect('data-f="timezone"', f.timezone), 'Les heures sont celles de ce fuseau.')}
      ${check('sge-en', 'Horaire activé', '', f.enabled !== false)}
      <div class="btnrow"><button type="button" id="sge-hours">Modifier les heures…</button></div>`, { open: true })}
    </div>`, () => {
    const box = $('modal-body');
    onSave({ fields: { name: val(box, '[data-f="name"]') || null, timezone: box.querySelector('[data-f="timezone"]').value || null, enabled: $('sge-en').checked } });
    return true;
  }, 'Ajouter au brouillon');
  const box = $('modal-body');
  const recap = () => setSums(box, { gen: [val(box, '[data-f="name"]'), box.querySelector('[data-f="timezone"]').value || 'fuseau du serveur', $('sge-en').checked ? '' : 'DÉSACTIVÉ'] });
  box.addEventListener('input', recap); box.addEventListener('change', recap);
  $('sge-hours').onclick = openHours;
  recap();
}
export const schedCfgDiff = (a, b) => diffKeys(a, b, SCHED_FIELDS, { name: 'nom', timezone: 'fuseau', enabled: 'activé' }).join(', ');
