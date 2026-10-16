// Call Flow Manager — choix de la destination d'une sortie (débordement, touche
// de SVI, destination de SDA, fermeture…), selon la norme d'édition du module
// (ed-ui.js). Un seul dialogue, qu'on y arrive par un clic sur la sortie ou par
// une carte déposée dessus (type, voire objet, déjà choisis). Sans écriture :
// renvoie la destination au brouillon (onSave). Champs vérifiés dans le schéma
// des destinations de wazo-confd (ring_time, greeting, skip_instructions,
// filename, skip, no_answer, cause, exten + context).
import { $, esc, confirmModal, helpButton, helpBox } from '../common/core.js?v=0.39.9';
import { TYPES, M, listOf, destLabel } from './model.js?v=0.39.9';
import { fillSoundSelect } from './sched-editor.js?v=0.39.9';
import { sec, field, check, setSums, openSec } from './ed-ui.js?v=0.39.9';

export const DEST_TYPES = [
  ['user', 'Utilisateur'], ['group', 'Groupe'], ['queue', 'File d\'attente'], ['ivr', 'SVI'], ['voicemail', 'Messagerie'],
  ['switchboard', 'Standard'], ['conference', 'Conférence'], ['extension', 'Numéro'], ['sound', 'Fichier son'], ['hangup', 'Raccrocher'],
];
export const ENTITY_DEST = { user: 'user_id', group: 'group_id', queue: 'queue_id', ivr: 'ivr_id', voicemail: 'voicemail_id', conference: 'conference_id', switchboard: 'switchboard_uuid' };
const RINGS = new Set(['user', 'group', 'queue', 'switchboard']);
const KNOWN = new Set(DEST_TYPES.map(([t]) => t));
const THELP = {
  user: 'L\'appel sonne sur le poste de l\'utilisateur, puis suit ses propres débordements.',
  group: 'L\'appel sonne sur les membres du groupe, selon sa stratégie.',
  queue: 'L\'appelant attend dans la file jusqu\'à ce qu\'un agent réponde.',
  ivr: 'Un menu vocal : l\'appelant choisit par une touche.',
  voicemail: 'L\'appelant laisse un message.',
  switchboard: 'L\'appel arrive sur le standard (opérateur).',
  conference: 'L\'appelant entre dans la salle de conférence.',
  extension: 'Un numéro composé dans un contexte : poste interne, autre site, numéro externe… Si le numéro correspond à un objet Wazo, le graphe le montre à sa place.',
  sound: 'Joue un fichier son puis raccroche.',
  hangup: 'Termine l\'appel avec la tonalité choisie.',
};
const GREET = [['', 'Par défaut'], ['unavailable', 'Indisponible'], ['busy', 'Occupé']];
const CAUSE = [['normal', 'Tonalité normale'], ['busy', 'Occupé'], ['congestion', 'Encombré']];
const opt = (list, cur) => list.map(([k, l]) => `<option value="${esc(k)}"${(cur ?? '') === k ? ' selected' : ''}>${esc(l)}</option>`).join('');

// o = { title, owner, cur, type?, id?, help?, periods?: { name, shared, open } }
// onSave(destination) ; o.periods.open() ouvre l'éditeur des heures.
export function openDestEditor(o, onSave) {
  const canDest = o.canDest !== false;
  let type = o.type || (KNOWN.has(o.cur?.type) ? o.cur.type : '');
  const same = () => (o.cur?.type === type ? o.cur : null);
  const label = (t) => DEST_TYPES.find(([x]) => x === t)?.[1] || t;

  // Parties qui dépendent du type : objet visé, options.
  const objBody = () => {
    const s = same();
    if (ENTITY_DEST[type]) {
      const sel = String(o.type === type && o.id != null ? o.id : s ? s[ENTITY_DEST[type]] : '');
      const items = listOf(type);
      return `${field('Rechercher', '<input id="dd-q" placeholder="Nom, numéro…" autocomplete="off">')}
        <select id="dd-obj" size="8" class="cf-dd-list">${items.map((x) => { const id = x.key.slice(x.key.indexOf(':') + 1); return `<option value="${esc(id)}"${id === sel ? ' selected' : ''}>${esc(x.title)}${x.sub ? ` — ${esc(x.sub)}` : ''}</option>`; }).join('') || '<option value="" disabled>Aucun objet de ce type</option>'}</select>
        ${o.onCreate && o.creatable?.has(type) ? `<div class="btnrow"><button type="button" data-create="${type}" title="Crée l'objet tout de suite dans Wazo, puis le choisit pour cette sortie">Créer un nouveau…</button></div>` : ''}`;
    }
    if (type === 'extension') {
      const ctx = (M.lists.context || []).filter((c) => c.type !== 'incall');
      return `<div class="cf-ge-2">${field('Numéro', `<input id="dd-exten" value="${esc(s?.exten || '')}" placeholder="ex. 1001 ou 0612345678">`, 'Chiffres, * et #.')}
        ${field('Composé depuis le contexte', `<select id="dd-ctx">${ctx.map((c) => `<option value="${esc(c.name)}"${s?.context === c.name ? ' selected' : ''}>${esc(c.label || c.name)} (${esc(c.type)})</option>`).join('')}</select>`, 'Pour un numéro externe : un contexte qui permet de sortir.')}</div>`;
    }
    if (type === 'sound') return field('Fichier son', '<select id="dd-file"><option value="">Chargement des sons…</option></select>', 'Sons du tenant, puis sons système.');
    if (type === 'hangup') return field('Tonalité', `<select id="dd-cause">${opt(CAUSE, s?.cause || 'normal')}</select>`, 'Ce que l\'appelant entend avant la fin de l\'appel.');
    return '<p class="small muted">Choisissez d\'abord un type de destination.</p>';
  };
  const optBody = () => {
    const s = same(); const parts = [];
    if (RINGS.has(type)) {
      parts.push(check('dd-ringon', 'Durée de sonnerie propre à cette sortie', 'Sinon : la durée réglée sur l\'objet lui-même (supposé : celle-ci prime quand elle est donnée).', s?.ring_time != null));
      parts.push(`<div id="dd-ringbox" class="cf-ge-sub"${s?.ring_time != null ? '' : ' hidden'}>${field('Durée (s)', `<input id="dd-ring" type="number" min="0" step="1" value="${esc(s?.ring_time ?? '')}" placeholder="ex. 20">`)}</div>`);
    }
    if (type === 'voicemail') {
      parts.push(field('Message d\'accueil', `<select id="dd-greet">${opt(GREET, s?.greeting || '')}</select>`, 'Message enregistré par le titulaire de la messagerie.'));
      parts.push(check('dd-skip', 'Ne pas lire les instructions', 'Bip direct après le message d\'accueil.', !!s?.skip_instructions));
    }
    if (type === 'sound') {
      parts.push(check('dd-sskip', 'L\'appelant peut l\'interrompre', 'Une touche arrête la lecture.', !!s?.skip));
      parts.push(check('dd-noans', 'Sans décrocher', 'Le son est joué avant que l\'appel soit décroché (pré-décroché).', !!s?.no_answer));
    }
    return parts.join('');
  };
  const hasOpt = () => RINGS.has(type) || type === 'voicemail' || type === 'sound';
  const optOpen = () => { const s = same(); return !!(s && (s.ring_time != null || s.greeting || s.skip_instructions || s.skip || s.no_answer)); };
  const main = () => `${sec('obj', type ? label(type) : 'Objet', objBody(), { open: true })}${hasOpt() ? sec('opt', 'Options', optBody(), { open: optOpen() }) : ''}`;
  const chips = () => DEST_TYPES.map(([t, l]) => `<button type="button" class="cf-chip t-${t}${t === type ? ' on' : ''}" data-type="${t}" title="${esc(THELP[t] || '')}"><span class="cf-badge">${esc(TYPES[t]?.badge || '?')}</span>${esc(l)}</button>`).join('');
  const P = o.periods;

  confirmModal(`<div class="cf-ed cf-dest-ed">
    <div class="cf-ge-head"><div><h3>${esc(o.title)}</h3><div class="small muted">${esc(o.owner || '')}${canDest ? ` · actuellement : ${esc(destLabel(o.cur))}` : ''}</div></div>${helpButton('de-hb', 'Aide')}</div>${helpBox('de-hb', `${o.help || ''} La modification va dans le brouillon ; rien n'est écrit avant « Appliquer… ».`)}
    ${canDest ? `${sec('type', 'Type de destination', `<div class="cf-palette cf-choose" id="de-types">${chips()}</div><p class="small muted cf-ge-note" id="de-thelp">${esc(THELP[type] || '')}</p>`, { open: !type })}
    <div id="de-main">${main()}</div>` : ''}
    ${P ? sec('per', `Heures de « ${P.name} »`, `<p class="small muted">Heures d'ouverture, destination si fermé, fermetures exceptionnelles${P.shared > 1 ? ` — horaire partagé par ${P.shared} objets, tous concernés` : ''}.</p><div class="btnrow"><button type="button" id="de-periods" class="primary">Modifier les heures…</button></div>`, { open: !canDest }) : ''}
    <p id="dd-err" class="error small"></p></div>`, () => {
    if (!canDest) return true;
    const box = $('modal-body');
    const err = (m, s = 'obj') => { openSec(box, s); $('dd-err').textContent = m; return false; };
    if (!type) return err('Choisissez un type de destination.', 'type');
    let d;
    if (ENTITY_DEST[type]) {
      const v = $('dd-obj').value; if (!v) return err('Choisissez un objet dans la liste.');
      d = { type, [ENTITY_DEST[type]]: type === 'switchboard' ? v : Number(v) };
      if ($('dd-ringon')?.checked) { const r = $('dd-ring').value.trim(); if (!/^\d+$/.test(r)) return err('Durée de sonnerie : un nombre entier de secondes.', 'opt'); d.ring_time = Number(r); }
      if (type === 'voicemail') { if ($('dd-greet').value) d.greeting = $('dd-greet').value; if ($('dd-skip').checked) d.skip_instructions = true; }
    } else if (type === 'extension') {
      const x = $('dd-exten').value.trim(); if (!/^[0-9*#]{1,255}$/.test(x)) return err('Numéro : chiffres, * et # seulement.');
      d = { type, exten: x, context: $('dd-ctx').value };
    } else if (type === 'sound') {
      const f = $('dd-file').value.trim(); if (!f) return err('Choisissez un fichier son.');
      d = { type, filename: f, skip: $('dd-sskip').checked, no_answer: $('dd-noans').checked };
    } else if (type === 'hangup') d = { type, cause: $('dd-cause').value };
    onSave(d);
    return true;
  }, canDest ? 'Ajouter au brouillon' : 'Fermer');

  const box = $('modal-body');
  const recap = () => {
    if (!canDest) return;
    const sel = (id) => { const e = $(id); return e?.value ? e.selectedOptions[0]?.text : ''; };
    const S = { type: [type ? label(type) : 'à choisir'] };
    if (ENTITY_DEST[type]) S.obj = [sel('dd-obj') ? sel('dd-obj').split(' — ')[0] : 'à choisir'];
    else if (type === 'extension') S.obj = [$('dd-exten')?.value.trim() || 'à saisir', sel('dd-ctx') ? `depuis ${sel('dd-ctx')}` : ''];
    else if (type === 'sound') S.obj = [sel('dd-file') || 'à choisir'];
    else if (type === 'hangup') S.obj = [sel('dd-cause')];
    S.opt = [$('dd-ringon')?.checked ? `sonne ${$('dd-ring').value || '?'} s` : RINGS.has(type) ? 'durée de l\'objet' : '',
      type === 'voicemail' ? `accueil ${sel('dd-greet') || 'par défaut'}` : '', $('dd-skip')?.checked ? 'sans instructions' : '',
      $('dd-sskip')?.checked ? 'interruptible' : '', $('dd-noans')?.checked ? 'sans décrocher' : ''];
    if (P) S.per = [P.shared > 1 ? `partagé par ${P.shared} objets` : ''];
    setSums(box, S);
  };
  // Après chaque rendu des parties qui dépendent du type.
  const bind = () => {
    if (type === 'sound') fillSoundSelect($('dd-file'), same()?.filename).then(recap);
    const q = $('dd-q'), list = $('dd-obj');
    if (q && list) {
      const all = [...list.options].map((x) => [x, x.textContent.toLowerCase()]);
      q.oninput = () => { const s = q.value.trim().toLowerCase(); for (const [x, txt] of all) x.hidden = !!s && !txt.includes(s); };
      list.ondblclick = () => $('modal-ok').click();
      (list.selectedOptions[0] || list).scrollIntoView?.({ block: 'nearest' });
      q.focus();
    }
    recap();
  };
  box.addEventListener('input', recap);
  box.addEventListener('change', (e) => {
    if (e.target.id === 'dd-ringon') { $('dd-ringbox').hidden = !e.target.checked; if (e.target.checked) $('dd-ring').focus(); }
    recap();
  });
  box.addEventListener('click', (e) => {
    const c = e.target.closest('[data-type]');
    if (c) {
      type = c.dataset.type;
      $('de-types').innerHTML = chips(); $('de-thelp').textContent = THELP[type] || '';
      $('de-main').innerHTML = main(); $('dd-err').textContent = '';
      bind(); return;
    }
    if (e.target.closest('#de-periods')) P?.open();
    const cr = e.target.closest('[data-create]'); if (cr) o.onCreate(cr.dataset.create);
  });
  if (canDest) bind();
  recap();
}
