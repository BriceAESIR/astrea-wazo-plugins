// Call Flow Manager — champs et options de chaque type de destination, communs
// au dialogue de destination d'une sortie (dest-editor.js) et aux sélecteurs
// intégrés des éditeurs (sched-editor.js : débordements, fermetures…).
// Demande de Brice (20/10/2026) : la musique de distribution d'un appel vers un
// utilisateur manquait ; « vérifier TOUTES les autres cartes ». Champs relus
// dans wazo-confd master (helpers/destination.py) :
//  - user : ring_time (≥ 0), moh_uuid (musique de distribution) ;
//  - group, switchboard : ring_time ; queue : ring_time (skill_rule_id et
//    skill_rule_variables : non proposés, conservés tels quels) ;
//  - voicemail : greeting (busy | unavailable), skip_instructions ;
//  - sound : filename, skip, no_answer ;
//  - hangup : cause (normal | busy | congestion), timeout (busy et congestion) ;
//  - outcall : outcall_id, exten (chiffres, ≤ 255) ;
//  - custom : command (^(?!(try)?system\()[a-zA-Z]{3,}\((.*)\)$, ≤ 255) ;
//  - application : disa et callback_disa (pin chiffres ≤ 40, context),
//    directory et voicemail (context), fax_to_mail (email ≤ 80),
//    custom (application_uuid).
// Les champs portent data-x="…" : lus dans leur conteneur (pas d'id), donc
// utilisables plusieurs fois dans un même dialogue.
import { esc } from '../common/core.js?v=0.40.22';
import { M } from './model.js?v=0.40.22';

export const EXTRA_TYPES = [['outcall', 'Règle sortante'], ['application', 'Application'], ['custom', 'Commande']];
export const APPS = [['disa', 'DISA : composer un numéro après un code'], ['callback_disa', 'Rappel DISA'], ['directory', 'Annuaire'], ['fax_to_mail', 'Fax vers e-mail'], ['voicemail', 'Consultation des messageries'], ['custom', 'Application Wazo (Stasis)']];
const RINGS = new Set(['user', 'group', 'queue', 'switchboard']);
const CMD_RE = /^(?!(try)?system\()[a-zA-Z]{3,}\((.*)\)$/i;
const CTX_RE = /^[a-zA-Z0-9_-]{1,79}$/;
const opt = (list, cur) => list.map(([k, l]) => `<option value="${esc(k)}"${(cur ?? '') === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
const fld = (label, input, help) => `<label class="cf-ge-f cf-dx"><span class="cf-ge-l">${esc(label)}</span>${input}${help ? `<span class="small muted">${esc(help)}</span>` : ''}</label>`;
const box = (label, attr, on, help) => `<label class="cf-ge-b cf-dx"><input type="checkbox" ${attr}${on ? ' checked' : ''}><span><strong>${esc(label)}</strong>${help ? `<span class="small muted">${esc(help)}</span>` : ''}</span></label>`;
const ctxOpts = (cur, types) => (M.lists.context || []).filter((c) => !types || types.includes(c.type)).map((c) => `<option value="${esc(c.name)}"${cur === c.name ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('');

// Types qui ont des options (section « Options » du dialogue).
export const hasOpts = (t) => RINGS.has(t) || ['voicemail', 'sound', 'hangup'].includes(t);

// Champs « objet » des types sans liste d'objets à choisir : règle sortante, application, commande.
export function destFieldsHtml(t, cur) {
  const s = cur?.type === t ? cur : null;
  if (t === 'outcall') return `${fld('Règle sortante', `<select data-x="oc">${(M.lists.outcall || []).map((o) => `<option value="${o.id}"${String(s?.outcall_id) === String(o.id) ? ' selected' : ''}>${esc(o.label || o.name || `#${o.id}`)}</option>`).join('') || '<option value="">aucune règle</option>'}</select>`)}${fld('Numéro composé', `<input data-x="ocx" value="${esc(s?.exten || '')}" inputmode="numeric" placeholder="ex. 0612345678">`, 'Chiffres seulement : envoyé par cette règle (motifs, trunks).')}`;
  if (t === 'custom') return fld('Commande Asterisk', `<input data-x="cmd" value="${esc(s?.command || '')}" maxlength="255" placeholder="ex. Playback(beep)">`, 'Application du plan de numérotation : Nom(arguments). System() refusé par Wazo.');
  if (t === 'application') {
    const a = s?.application || 'disa';
    const sub = (k, html) => `<span data-appfor="${k}"${k.split(' ').includes(a) ? '' : ' hidden'}>${html}</span>`;
    return `${fld('Application', `<select data-x="app">${opt(APPS, a)}</select>`)}
      ${sub('disa callback_disa', fld('Code (facultatif)', `<input data-x="pin" value="${esc(s?.pin || '')}" inputmode="numeric" maxlength="40" placeholder="aucun">`, 'Chiffres. Demandé avant de composer.'))}
      ${sub('disa callback_disa directory voicemail', fld('Contexte', `<select data-x="actx">${ctxOpts(s?.context, ['internal', 'outcall'])}</select>`, 'DISA : contexte où le numéro est composé ; annuaire / messageries : contexte consulté.'))}
      ${sub('fax_to_mail', fld('E-mail', `<input type="email" data-x="mail" value="${esc(s?.email || '')}" maxlength="80" placeholder="ex. fax@exemple.fr">`))}
      ${sub('custom', fld('Application Wazo', `<select data-x="appuuid">${(M.lists.application || []).map((x) => `<option value="${esc(x.uuid)}"${s?.application_uuid === x.uuid ? ' selected' : ''}>${esc(x.name || x.uuid)}</option>`).join('') || '<option value="">aucune application</option>'}</select>`))}`;
  }
  return '';
}

// Options d'un type (sonnerie, musique, accueil, son, raccrocher).
export function destOptsHtml(t, cur) {
  const s = cur?.type === t ? cur : null; const p = [];
  if (RINGS.has(t)) p.push(fld('Durée de sonnerie (s)', `<input type="number" min="0" step="1" data-x="ring" value="${esc(s?.ring_time ?? '')}" placeholder="durée de l'objet">`, 'Propre à cette sortie. Vide : la durée réglée sur l\'objet (supposé : celle-ci prime quand elle est donnée).'));
  if (t === 'user') {
    const mohs = (M.lists.moh || []).filter((m) => m.uuid);
    p.push(fld('Musique de distribution d\'appel', `<select data-x="moh"><option value="">Aucune : sonnerie</option>${mohs.map((m) => `<option value="${esc(m.uuid)}"${s?.moh_uuid === m.uuid ? ' selected' : ''}>${esc(m.label || m.name)}</option>`).join('')}${s?.moh_uuid && !mohs.some((m) => m.uuid === s.moh_uuid) ? `<option value="${esc(s.moh_uuid)}" selected>${esc(s.moh_uuid)} (actuelle)</option>` : ''}</select>`, 'Ce qu\'entend l\'appelant pendant que l\'utilisateur sonne.'));
  }
  if (t === 'voicemail') {
    p.push(fld('Message d\'accueil', `<select data-x="greet">${opt([['unavailable', 'Indisponible'], ['busy', 'Occupé'], ['', 'Aucun (consignes seulement)']], s?.greeting || '')}</select>`, 'Indisponible / Occupé : message enregistré dans la messagerie ; s\'il n\'existe pas, Asterisk annonce le nom enregistré (supposé). Aucun : seulement les consignes.'));
    p.push(box('Ne pas lire les instructions', 'data-x="vskip"', !!s?.skip_instructions, 'Bip direct après le message d\'accueil.'));
  }
  if (t === 'sound') {
    p.push(box('L\'appelant peut l\'interrompre', 'data-x="sskip"', !!s?.skip, 'Une touche arrête la lecture.'));
    p.push(box('Sans décrocher', 'data-x="noans"', !!s?.no_answer, 'Le son est joué avant que l\'appel soit décroché (pré-décroché).'));
  }
  if (t === 'hangup') p.push(fld('Délai avant de raccrocher (s)', `<input type="number" min="0" step="1" data-x="htime" value="${esc(s?.timeout ?? '')}" placeholder="immédiat">`, 'Tonalité « occupé » ou « encombré » seulement : durée pendant laquelle elle est jouée.'));
  return p.join('');
}

// Affiche les champs de l'application choisie (à appeler une fois sur le conteneur).
export function bindDestExtra(root) {
  root.addEventListener('change', (e) => {
    if (!e.target.matches?.('[data-x="app"]')) return;
    const scope = e.target.closest('.cf-dp, .cf-ge-body, .cf-ed') || root;
    for (const el of scope.querySelectorAll('[data-appfor]')) el.hidden = !el.dataset.appfor.split(' ').includes(e.target.value);
  });
}

// Lit champs et options d'un type dans son conteneur ; lève une erreur lisible.
// Les champs vides des options valent null (retirés à l'écriture).
export function readDestExtra(t, root) {
  const q = (k) => root.querySelector(`[data-x="${k}"]`);
  const v = (k) => q(k)?.value?.trim() ?? '';
  const num = (k, label) => { const x = v(k); if (x === '') return null; if (!/^\d+(\.\d+)?$/.test(x)) throw new Error(`${label} : nombre positif.`); return Number(x); };
  const d = {};
  if (t === 'outcall') {
    if (!v('oc')) throw new Error('Choisissez une règle sortante.');
    if (!/^\d{1,255}$/.test(v('ocx'))) throw new Error('Numéro composé : chiffres seulement.');
    Object.assign(d, { outcall_id: Number(v('oc')), exten: v('ocx') });
  }
  if (t === 'custom') { if (!CMD_RE.test(v('cmd')) || v('cmd').length > 255) throw new Error('Commande : Nom(arguments), 255 caractères au plus ; System() refusé.'); d.command = v('cmd'); }
  if (t === 'application') {
    const a = v('app'); d.application = a;
    if (a === 'disa' || a === 'callback_disa') { if (v('pin') && !/^\d{1,40}$/.test(v('pin'))) throw new Error('Code : chiffres seulement.'); d.pin = v('pin') || null; }
    if (['disa', 'callback_disa', 'directory', 'voicemail'].includes(a)) { if (!CTX_RE.test(v('actx'))) throw new Error('Choisissez un contexte.'); d.context = v('actx'); }
    if (a === 'fax_to_mail') { if (!/^[^@\s]+@[^@\s]+$/.test(v('mail'))) throw new Error('E-mail invalide.'); d.email = v('mail'); }
    if (a === 'custom') { if (!v('appuuid')) throw new Error('Choisissez une application.'); d.application_uuid = v('appuuid'); }
  }
  if (RINGS.has(t) && q('ring')) d.ring_time = num('ring', 'Durée de sonnerie');
  if (t === 'user' && q('moh')) d.moh_uuid = v('moh') || null;
  if (t === 'voicemail' && q('greet')) { d.greeting = v('greet') || null; d.skip_instructions = !!q('vskip')?.checked; }
  if (t === 'sound' && q('sskip')) { d.skip = !!q('sskip').checked; d.no_answer = !!q('noans').checked; }
  if (t === 'hangup' && q('htime')) d.timeout = num('htime', 'Délai avant de raccrocher');
  return d;
}
