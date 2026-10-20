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
import { $, esc, toast, confirmModal, helpButton, helpBox, fullName } from '../common/core.js?v=0.40.21';
import { M } from './model.js?v=0.40.21';
import { fillSoundSelect, pickerHtml, bindPicker, readPicker } from './sched-editor.js?v=0.40.21';
import { GREETINGS, greetingExists, playGreeting, saveGreeting, deleteGreeting, toWav8k, moTxt } from './sound-play.js?v=0.40.21';
import { incallNumberHtml, bindIncallNumber, readIncallNumber, checkIncallNumber } from './numbers.js?v=0.40.21';
import { sec, field, check, setSums, openSec, secretField, bindSecrets, tzSelect, langSelect } from './ed-ui.js?v=0.40.21';
import { bindNewSchedule, schedValue } from './create.js?v=0.40.21';

const pickFields = (o, keys) => { const f = {}; for (const k of keys) f[k] = o?.[k] ?? null; return f; };
const diffKeys = (a, b, keys, L) => keys.filter((k) => JSON.stringify(a?.fields?.[k] ?? null) !== JSON.stringify(b?.fields?.[k] ?? null)).map((k) => L[k] || k);
const mohOpts = (cur, none = 'Par défaut') => `<option value="">${esc(none)}</option>${(M.lists.moh || []).map((m) => `<option value="${esc(m.name)}"${cur === m.name ? ' selected' : ''}>${esc(m.label || m.name)}</option>`).join('')}${cur && !(M.lists.moh || []).some((m) => m.name === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)} (actuelle)</option>` : ''}`;
const cidOpts = (cur) => [['', 'Inchangé : nom de l\'appelant seul'], ['prepend', 'Texte, puis nom de l\'appelant'], ['overwrite', 'Texte seul, à la place du nom'], ['append', 'Nom de l\'appelant, puis texte']].map(([k, l]) => `<option value="${k}"${(cur || '') === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
const head = (id, title, sub, help) => `<div class="cf-ge-head"><div><h3>${esc(title)}</h3>${sub ? `<div class="small muted">${esc(sub)}</div>` : ''}</div>${helpButton(id, 'Aide')}</div>${helpBox(id, `${help} Les modifications vont dans le brouillon ; « Appliquer… » relit l'objet et n'écrit que ce qui change.`)}`;
const val = (box, sel) => box.querySelector(sel)?.value?.trim() ?? '';
const intOrNull = (s, min, max) => (s === '' ? null : /^\d+$/.test(s) && Number(s) >= min && (max == null || Number(s) <= max) ? Number(s) : undefined);

// ---------------------------------------------------------------------------
// SDA : mêmes options que le formulaire du portail (retour de Brice,
// 17/10/2026) : numéro ou motif, destination, horaire, message d'accueil,
// nom affiché, sous-routine. Destination et horaire vont dans leurs entrées
// habituelles du brouillon (incall, sched_assoc) ; le numéro dans incall_cfg
// (PUT /extensions/{id}, une seule extension modifiable ici).
// ---------------------------------------------------------------------------
export const INCALL_FIELDS = ['description', 'caller_id_mode', 'caller_id_name', 'greeting_sound', 'preprocess_subroutine'];
export const incallCfgOf = (o) => ({ fields: pickFields(o, INCALL_FIELDS), exten: o?.extensions?.length === 1 ? String(o.extensions[0].exten) : null });
export const applyIncallCfg = (o, v) => { Object.assign(o, v.fields); if (v.exten != null && o.extensions?.length === 1) o.extensions[0].exten = v.exten; };
export function openIncallEditor(o, num, onSave) {
  const f = incallCfgOf(o).fields;
  const ext = o.extensions?.length === 1 ? o.extensions[0] : null;
  const isPat = !!ext && String(ext.exten).startsWith('_');
  const sched = (o.schedules || [])[0]?.id;
  confirmModal(`<div class="cf-ed">
    ${head('ie2-hb', `SDA ${num}`, o.description || '', 'Options de l\'API Wazo pour une SDA, comme dans le portail.')}
    ${sec('gen', 'Numéro et description', `
      ${ext ? `${incallNumberHtml({ exten: String(ext.exten), pattern: isPat, field })}
      <p class="small muted">Contexte : ${esc(M.by.context?.get(ext.context)?.label || ext.context)} (non modifiable ici).</p>` : `<p class="small muted">${(o.extensions || []).length ? 'Plusieurs numéros : à modifier dans le portail.' : 'Aucun numéro.'}</p>`}
      ${field('Description', `<input data-f="description" value="${esc(f.description || '')}" placeholder="ex. Standard">`)}`, { open: true })}
    ${sec('dest', 'Destination', `<div class="cf-ge-f"><span class="cf-ge-l">Destination *</span>${pickerHtml('ice-dest', o.destination)}</div>`, { open: true })}
    ${sec('call', 'Appel entrant', `
      ${field('Pré-décroché (message d\'accueil)', '<select data-f="greeting_sound" id="ice-greet"><option value="">Chargement des sons…</option></select>', 'Joué à l\'appelant avant de l\'envoyer vers la destination.')}
      ${field('Horaire', `<select id="ice-sched"><option value="">Aucun : toujours ouvert</option>${(M.lists.schedule || []).map((s) => `<option value="${s.id}"${String(sched) === String(s.id) ? ' selected' : ''}>${esc(s.name || `#${s.id}`)}</option>`).join('')}</select>`, 'Quand la SDA envoie vers sa destination ; hors horaire : destination « fermé » de l\'horaire.')}
      <div class="cf-ge-2">
        ${field('Nom affiché à l\'appelé', `<select data-f="caller_id_mode">${cidOpts(f.caller_id_mode)}</select>`)}
        <span id="ice-cidtxt"${f.caller_id_mode ? '' : ' hidden'}>${field('Texte', `<input data-f="caller_id_name" value="${esc(f.caller_id_name || '')}" maxlength="80" placeholder="ex. Accueil">`, 'Pour savoir par quel numéro l\'appel est arrivé.')}</span>
      </div>`, { open: true })}
    ${sec('adv', 'Avancé', field('Sous-routine de pré-traitement', `<input data-f="preprocess_subroutine" value="${esc(f.preprocess_subroutine || '')}" maxlength="79" placeholder="aucune">`, 'Sous-routine Asterisk exécutée avant de recevoir l\'appel.'))}
    <p id="ice-err" class="error small"></p></div>`, () => {
    const box = $('modal-body');
    const err = (m, s) => { if (s) openSec(box, s); $('ice-err').textContent = m; return false; };
    const nf = { ...f };
    nf.description = val(box, '[data-f="description"]') || null;
    nf.greeting_sound = box.querySelector('[data-f="greeting_sound"]').value || null;
    nf.caller_id_mode = box.querySelector('[data-f="caller_id_mode"]').value || null;
    nf.caller_id_name = nf.caller_id_mode ? val(box, '[data-f="caller_id_name"]') || null : null;
    if (nf.caller_id_mode && !nf.caller_id_name) return err('Nom affiché : saisissez le texte, ou choisissez « Inchangé ».', 'call');
    nf.preprocess_subroutine = val(box, '[data-f="preprocess_subroutine"]') || null;
    let exten = ext ? String(ext.exten) : null;
    if (ext) {
      exten = readIncallNumber(box);
      const bad = checkIncallNumber(ext.context, exten, String(ext.exten));
      if (bad) return err(bad, 'gen');
    }
    let destination; try { destination = readPicker('ice-dest'); } catch (e) { return err(e.message, 'dest'); }
    const s = schedValue($('ice-sched'));
    onSave({ cfg: { fields: nf, exten }, destination, schedule: s ? Number(s) : null });
    return true;
  }, 'Ajouter au brouillon');
  const box = $('modal-body');
  bindPicker('ice-dest');
  bindNewSchedule($('ice-sched'));
  if (ext) bindIncallNumber(box, ext.context, String(ext.exten));
  const recap = () => setSums(box, {
    gen: [ext ? readIncallNumber(box) : '', val(box, '[data-f="description"]')],
    call: [box.querySelector('#ice-greet')?.value ? 'avec accueil' : 'sans accueil', schedValue($('ice-sched')) ? `horaire ${$('ice-sched').selectedOptions[0].text}` : 'sans horaire', val(box, '[data-f="caller_id_mode"]') ? `nom « ${val(box, '[data-f="caller_id_name"]')} »` : ''],
    adv: [val(box, '[data-f="preprocess_subroutine"]')],
  });
  fillSoundSelect($('ice-greet'), f.greeting_sound || '').then(() => { const s = $('ice-greet'); if (s?.options[0] && !s.options[0].value) s.options[0].textContent = 'Aucun'; recap(); });
  box.addEventListener('input', recap);
  box.addEventListener('change', (e) => { if (e.target.matches('[data-f="caller_id_mode"]')) $('ice-cidtxt').hidden = !e.target.value; recap(); });
  recap();
}
export const incallCfgDiff = (a, b) => [...diffKeys(a, b, INCALL_FIELDS, { description: 'description', caller_id_mode: 'nom affiché', caller_id_name: 'texte du nom', greeting_sound: 'accueil', preprocess_subroutine: 'sous-routine' }), ...((a?.exten ?? null) !== (b?.exten ?? null) ? [`numéro ${a?.exten ?? '—'} → ${b?.exten ?? '—'}`] : [])].join(', ');
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
// Messagerie : réglages, utilisateurs associés (brouillon) et messages
// d'accueil (écriture immédiate, sound-play.js) — onglets du portail.
// ---------------------------------------------------------------------------
export const VM_FIELDS = ['name', 'number', 'context', 'accesstype', 'email', 'language', 'timezone', 'pager', 'max_messages', 'attach_audio', 'delete_messages', 'ask_password', 'enabled', 'password'];
export const vmCfgOf = (o) => ({ fields: pickFields(o, VM_FIELDS), users: (o?.users || []).map((u) => u.uuid).sort() });
// Utilisateurs : une seule messagerie par utilisateur (vérifié) → retiré des autres boîtes du module.
export const applyVmCfg = (o, v) => {
  Object.assign(o, v.fields);
  if (!Array.isArray(v.users)) return;
  for (const x of M.lists.voicemail || []) if (x !== o) x.users = (x.users || []).filter((u) => !v.users.includes(u.uuid));
  o.users = v.users.map((uuid) => { const u = M.userByUuid?.get(uuid); return { uuid, firstname: u?.firstname || '', lastname: u?.lastname || '' }; });
};
export function openVmEditor(o, onSave) {
  const f = vmCfgOf(o).fields;
  const ctx = (M.lists.context || []).filter((c) => c.type === 'internal');
  const users = (o.users || []).map((u) => fullName(u)).filter(Boolean);
  const b = (k, l, h) => check(`vme-${k}`, l, h, !!f[k], `data-b="${k}"`);
  let vu = [...vmCfgOf(o).users];
  // Messagerie actuelle de chaque utilisateur (listes du module, brouillon compris).
  const vmOf = new Map(); for (const x of M.lists.voicemail || []) for (const u of x.users || []) vmOf.set(u.uuid, x);
  confirmModal(`<div class="cf-ed">
    ${head('vme-hb', `Messagerie « ${o.name} »`, users.length ? `Utilisée par ${users.join(', ')}` : (o.accesstype === 'global' ? 'Messagerie partagée' : ''), 'Options de l\'API Wazo pour une boîte vocale. Le code est masqué dans le brouillon, l\'aperçu et la sauvegarde JSON.')}
    ${sec('gen', 'Général', `
      ${field('Nom *', `<input data-f="name" value="${esc(f.name || '')}" maxlength="80">`)}
      <div class="cf-ge-2">
        ${field('Numéro *', `<input data-f="number" value="${esc(f.number || '')}">`, 'Pour consulter la boîte.')}
        ${field('Contexte *', `<select data-f="context">${ctx.map((c) => `<option value="${esc(c.name)}"${f.context === c.name ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('')}${f.context && !ctx.some((c) => c.name === f.context) ? `<option value="${esc(f.context)}" selected>${esc(f.context)}</option>` : ''}</select>`)}
      </div>
      ${field('Type', `<select data-f="accesstype"><option value="personal"${f.accesstype !== 'global' ? ' selected' : ''}>Personnelle : associée à des utilisateurs</option><option value="global"${f.accesstype === 'global' ? ' selected' : ''}>Partagée (globale) : sans utilisateur associé</option></select>`, 'Wazo refuse d\'associer un utilisateur à une messagerie partagée.')}
      ${b('enabled', 'Messagerie activée', '')}`, { open: true })}
    ${sec('users', 'Utilisateurs', `
      <p class="small muted">Utilisateurs qui consultent cette boîte depuis leur poste. Un utilisateur n'a qu'une messagerie : en ajouter un qui en a déjà une la lui retire (à l'écriture).</p>
      <ul class="cf-ge-list" id="vme-users"></ul>
      <div class="cf-ge-row"><select id="vme-uadd"></select><button type="button" id="vme-uaddb">Ajouter</button></div>
      <p class="warn small" id="vme-glob" hidden><span>Messagerie partagée : les utilisateurs seront retirés à l'écriture.</span></p>`)}
    ${sec('greet', 'Messages d\'accueil', `
      <p class="small muted">Sons joués à l'appelant selon le statut de l'appelé. Envoi et suppression <strong>immédiats</strong> dans Wazo (hors brouillon).</p>
      <div class="cf-info"><span><strong>Limites de Wazo : 2 Mo envoyés, 90 secondes au plus.</strong> Tout fichier audio est accepté (wav, mp3…) : il est converti en WAV 8 kHz, 16 bits, mono. Après chaque envoi, le module relit Wazo et indique sur la ligne si le message est bien enregistré.</span></div>
      ${GREETINGS.map(([g, l]) => `<div class="cf-vm-greet" data-g="${g}"><span class="cf-ge-l">${esc(l)}</span><span class="small muted" data-gs>…</span><span class="cf-ge-row"><button type="button" data-gplay hidden>Écouter</button><button type="button" data-gup>Envoyer un fichier…</button><button type="button" data-gdel hidden>Supprimer</button></span><input type="file" accept="audio/*,.wav,.mp3" data-gfile hidden><span class="cf-ge-row" data-gconf hidden></span><span class="small cf-vm-res" data-gres hidden></span></div>`).join('')}`)}
    ${sec('mail', 'Messages par e-mail', `
      ${field('E-mail', `<input type="email" data-f="email" value="${esc(f.email || '')}" maxlength="80" placeholder="aucun">`, 'Chaque nouveau message y est signalé.')}
      ${b('attach_audio', 'Joindre le message audio', '')}
      ${b('delete_messages', 'Supprimer le message après l\'envoi', 'Exige un e-mail et la pièce jointe (contrainte Wazo).')}
      ${field('Pager (e-mail court)', `<input data-f="pager" value="${esc(f.pager || '')}" maxlength="80" placeholder="aucun">`)}`, { open: true })}
    ${sec('opt', 'Options', `
      <div class="cf-ge-2">
        ${field('Langue', langSelect('data-f="language"', f.language), 'Langue des messages de la boîte. Vide : langue du serveur (souvent l\'anglais).')}
        ${field('Fuseau horaire', tzSelect('data-f="timezone"', f.timezone), 'Pour l\'heure annoncée des messages.')}
      </div>
      <p class="warn small" id="vme-lw"${f.language && f.timezone ? ' hidden' : ''}><span>Langue ou fuseau vide : Wazo prend ceux du serveur (messages possiblement en anglais, heure décalée). Choisissez Français et Europe/Paris.</span></p>
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
    nf.accesstype = box.querySelector('[data-f="accesstype"]').value;
    nf.email = val(box, '[data-f="email"]') || null; if (nf.email && !/^[^@\s]+@[^@\s]+$/.test(nf.email)) return err('E-mail invalide.', 'mail');
    nf.pager = val(box, '[data-f="pager"]') || null;
    nf.language = box.querySelector('[data-f="language"]').value || null;
    nf.timezone = box.querySelector('[data-f="timezone"]').value || null;
    const mm = intOrNull(val(box, '[data-f="max_messages"]'), 0); if (mm === undefined) return err('Nombre de messages : entier positif.', 'opt'); nf.max_messages = mm;
    nf.password = val(box, '[data-f="password"]') || null; if (nf.password && !/^[0-9]{1,80}$/.test(nf.password)) return err('Code de la messagerie : chiffres seulement.', 'opt');
    // Case non lue (valeur absente) et laissée décochée : rien n'est écrit.
    for (const el of box.querySelectorAll('[data-b]')) nf[el.dataset.b] = f[el.dataset.b] == null && !el.checked ? f[el.dataset.b] : el.checked;
    if (nf.delete_messages && (!nf.email || !nf.attach_audio)) return err('« Supprimer après l\'envoi » exige un e-mail et la pièce jointe audio.', 'mail');
    // Partagée : aucun utilisateur (refusé par Wazo). Partagée → personnelle : retirer d'abord serait inutile.
    onSave({ fields: nf, users: nf.accesstype === 'global' ? [] : [...vu].sort() });
    return true;
  }, 'Ajouter au brouillon');
  const box = $('modal-body');
  // Utilisateurs associés.
  const uname = (uuid) => { const u = M.userByUuid?.get(uuid) || (o.users || []).find((x) => x.uuid === uuid); return fullName(u) || uuid; };
  const drawUsers = () => {
    const glob = box.querySelector('[data-f="accesstype"]').value === 'global';
    $('vme-glob').hidden = !(glob && vu.length);
    $('vme-users').innerHTML = vu.map((uuid) => `<li><span>${esc(uname(uuid))}</span><span class="spacer"></span><button type="button" class="icon" data-urm="${esc(uuid)}" title="Retirer de cette messagerie">×</button></li>`).join('') || '<li class="small muted">Aucun utilisateur.</li>';
    $('vme-uadd').innerHTML = `<option value="">Choisir un utilisateur…</option>${(M.lists.user || []).filter((u) => !vu.includes(u.uuid)).sort((a, c) => fullName(a).localeCompare(fullName(c), 'fr')).map((u) => { const cur = vmOf.get(u.uuid); return `<option value="${esc(u.uuid)}">${esc(fullName(u))}${cur && cur !== o ? ` (a « ${esc(cur.name)} » : elle lui sera retirée)` : ''}</option>`; }).join('')}`;
    $('vme-uadd').disabled = glob; $('vme-uaddb').disabled = glob;
  };
  $('vme-uaddb').onclick = () => { const u = $('vme-uadd').value; if (u && !vu.includes(u)) { vu.push(u); drawUsers(); recap(); } };
  $('vme-users').onclick = (e) => { const x = e.target.closest('[data-urm]'); if (x) { vu = vu.filter((u) => u !== x.dataset.urm); drawUsers(); recap(); } };
  box.querySelector('[data-f="accesstype"]').addEventListener('change', drawUsers);
  drawUsers();
  // Messages d'accueil : état lu sur Wazo (HEAD), écoute, envoi, suppression immédiats.
  for (const row of box.querySelectorAll('.cf-vm-greet')) {
    const g = row.dataset.g; let exists = false;
    const st = row.querySelector('[data-gs]'), play = row.querySelector('[data-gplay]'), del = row.querySelector('[data-gdel]'), up = row.querySelector('[data-gup]'), file = row.querySelector('[data-gfile]'), conf = row.querySelector('[data-gconf]'), res = row.querySelector('[data-gres]');
    const hm = () => new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const result = (ok, msg) => { res.hidden = false; res.className = `small cf-vm-res ${ok ? 'ok' : 'ko'}`; res.textContent = msg; };
    const show = (s) => { exists = s; st.textContent = s ? 'Enregistré' : 'Aucun (message par défaut de Wazo)'; play.hidden = !s; del.hidden = !s; up.textContent = s ? 'Remplacer…' : 'Envoyer un fichier…'; };
    const ask = (html, onYes) => { conf.innerHTML = `${html}<button type="button" class="primary" data-y>Confirmer</button><button type="button" data-n>Annuler</button>`; conf.hidden = false; conf.querySelector('[data-n]').onclick = () => { conf.hidden = true; }; conf.querySelector('[data-y]').onclick = async (e) => { e.target.disabled = true; try { await onYes(); conf.hidden = true; } catch (x) { conf.hidden = true; result(false, `Échec (${hm()}) : ${x.message}`); } }; };
    greetingExists(o.id, g).then(show).catch((e) => { st.textContent = `Illisible : ${e.message}`; up.disabled = true; });
    play.onclick = () => playGreeting(o.id, g, play);
    up.onclick = () => file.click();
    file.onchange = async () => {
      const fl = file.files?.[0]; file.value = ''; if (!fl) return;
      res.hidden = true;
      let w; try { w = await toWav8k(fl); } catch (e) { result(false, `Fichier refusé, rien n'a été envoyé : ${e.message}`); return; }
      ask(`<span class="small">${esc(fl.name)} · ${w.seconds} s · ${moTxt(w.sent)} envoyés (2 Mo max). ${exists ? 'Remplacer' : 'Envoyer'} maintenant ?</span>`, async () => {
        result(true, 'Envoi en cours…');
        await saveGreeting(o.id, g, w.blob, exists, () => result(true, 'Envoyé, vérification dans Wazo…'));
        show(true); result(true, `Téléversement vérifié (${hm()}) : le message est bien enregistré dans Wazo (${w.seconds} s).`);
      });
    };
    del.onclick = () => ask('<span class="small">Supprimer ce message maintenant ? Wazo rejouera son message par défaut.</span>', async () => { await deleteGreeting(o.id, g); const still = await greetingExists(o.id, g); show(still); if (still) throw new Error('Wazo a répondu OK mais le message est toujours présent.'); result(true, `Suppression vérifiée (${hm()}) : Wazo rejouera son message par défaut.`); });
  }
  const recap = () => setSums(box, {
    gen: [val(box, '[data-f="name"]'), val(box, '[data-f="number"]') ? `n° ${val(box, '[data-f="number"]')}` : '', box.querySelector('[data-f="accesstype"]').value === 'global' ? 'partagée' : '', box.querySelector('[data-b="enabled"]').checked ? '' : 'DÉSACTIVÉE'],
    users: [vu.length ? vu.map(uname).join(', ') : 'aucun'],
    mail: [val(box, '[data-f="email"]') || 'pas d\'e-mail', box.querySelector('[data-b="attach_audio"]').checked ? 'avec audio' : ''],
    opt: [box.querySelector('[data-f="language"]').selectedOptions[0]?.text, val(box, '[data-f="max_messages"]') ? `${val(box, '[data-f="max_messages"]')} messages max.` : ''],
  });
  bindSecrets(box);
  box.addEventListener('input', () => { $('vme-err').textContent = ''; recap(); });
  box.addEventListener('change', recap);
  box.addEventListener('change', () => { $('vme-lw').hidden = !!(box.querySelector('[data-f="language"]').value && box.querySelector('[data-f="timezone"]').value); });
  recap();
}
export const vmCfgDiff = (a, b) => [...diffKeys(a, b, VM_FIELDS, { name: 'nom', number: 'numéro', context: 'contexte', accesstype: 'type', email: 'e-mail', language: 'langue', timezone: 'fuseau', pager: 'pager', max_messages: 'messages max.', attach_audio: 'pièce jointe', delete_messages: 'suppression après envoi', ask_password: 'demande du code', enabled: 'activée', password: 'code' }), ...(JSON.stringify(a?.users || []) !== JSON.stringify(b?.users || []) ? ['utilisateurs'] : [])].join(', ');

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
      <p class="warn small" id="sge-tzw"${f.timezone ? ' hidden' : ''}><span>Aucun fuseau : Wazo applique celui du serveur, les heures peuvent être décalées. Choisissez Europe/Paris.</span></p>
      ${check('sge-en', 'Horaire activé', '', f.enabled !== false)}
      <div class="btnrow"><button type="button" id="sge-hours">Modifier les heures…</button></div>`, { open: true })}
    </div>`, () => {
    const box = $('modal-body');
    onSave({ fields: { name: val(box, '[data-f="name"]') || null, timezone: box.querySelector('[data-f="timezone"]').value || null, enabled: $('sge-en').checked } });
    return true;
  }, 'Ajouter au brouillon');
  const box = $('modal-body');
  const recap = () => { $('sge-tzw').hidden = !!box.querySelector('[data-f="timezone"]').value; setSums(box, { gen: [val(box, '[data-f="name"]'), box.querySelector('[data-f="timezone"]').value || 'fuseau du serveur', $('sge-en').checked ? '' : 'DÉSACTIVÉ'] }); };
  box.addEventListener('input', recap); box.addEventListener('change', recap);
  $('sge-hours').onclick = openHours;
  recap();
}
export const schedCfgDiff = (a, b) => diffKeys(a, b, SCHED_FIELDS, { name: 'nom', timezone: 'fuseau', enabled: 'activé' }).join(', ');
