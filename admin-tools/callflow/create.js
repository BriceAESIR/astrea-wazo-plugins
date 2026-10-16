// Call Flow Manager — création d'objets depuis la palette (demande de Brice,
// 16/10/2026) : une carte grisée (aucun objet de ce type) ou « Créer un
// nouveau… » ouvre ce panneau. Choix de Brice : création IMMÉDIATE dans Wazo
// (POST), puis branchement sur la sortie par le brouillon habituel. Si le
// brouillon est ensuite annulé, l'objet créé reste (non relié).
// Champs minimaux ; le reste se règle ensuite avec l'éditeur complet.
// Vérifié dans wazo-confd master (schémas) :
//  - groupe : label obligatoire ^[-_.a-zA-Z0-9 ]+$ ; extension dans group_ranges ;
//  - file : name obligatoire ^[-_.a-zA-Z0-9]+$ (≠ nom de groupe), label ;
//    options [[clé, valeur]] ; extension dans queue_ranges ;
//  - SVI : name et menu_sound obligatoires ;
//  - standard : name ; messagerie : name, number (chiffres), context ;
//  - conférence : rien d'obligatoire ; extension dans conference_room_ranges ;
//  - horaire : closed_destination obligatoire ; listes de jours / mois non vides.
// Extension : POST /extensions {exten, context} puis PUT /<objet>/{id}/extensions/{ext}
// (une seule par objet, contexte internal).
import { $, esc, toast, confirmModal } from '../common/core.js?v=0.40.5';
// Créations liées au tenant des données chargées (tapi, model.js).
import { M, tapi as api } from './model.js?v=0.40.5';
import { pickerHtml, bindPicker, readPicker, fillSoundSelect } from './sched-editor.js?v=0.40.5';
import { field, secretField, bindSecrets } from './ed-ui.js?v=0.40.5';
import { RANGE_KEY as RANGE, numberFieldHtml, bindNumberField, checkNumber, incallNumberHtml, bindIncallNumber, readIncallNumber, checkIncallNumber } from './numbers.js?v=0.40.5';

export const CREATABLE = new Set(['group', 'queue', 'ivr', 'switchboard', 'voicemail', 'conference', 'schedule', 'outcall']);
export const LABEL = { group: 'un groupe d\'appel', queue: 'une file d\'attente', ivr: 'un SVI', switchboard: 'un standard', voicemail: 'une messagerie', conference: 'une conférence', schedule: 'un horaire', outcall: 'une règle sortante' };
const internal = () => (M.lists.context || []).filter((c) => c.type === 'internal');
const ctxSel = (attr) => `<select ${attr}>${internal().map((c) => `<option value="${esc(c.name)}">${esc(c.label || c.name)}</option>`).join('')}</select>`;
const ALL7 = [1, 2, 3, 4, 5, 6, 7], ALL31 = Array.from({ length: 31 }, (_, i) => i + 1), ALL12 = Array.from({ length: 12 }, (_, i) => i + 1);
const per = (days, a, b) => ({ hours_start: a, hours_end: b, week_days: days, month_days: ALL31, months: ALL12 });
const PRESETS = {
  bureau: ['Lun–ven, 9 h–12 h et 14 h–18 h', [per([1, 2, 3, 4, 5], '09:00', '12:00'), per([1, 2, 3, 4, 5], '14:00', '18:00')]],
  journee: ['Lun–ven, 9 h–18 h', [per([1, 2, 3, 4, 5], '09:00', '18:00')]],
  toujours: ['Tous les jours, 24 h/24', [per(ALL7, '00:00', '23:59')]],
  aucune: ['Aucune plage (toujours fermé, à régler ensuite)', []],
};
const QSTRATS = [['ringall', 'Tous en même temps'], ['linear', 'Un par un, dans l\'ordre'], ['rrmemory', 'Tour de rôle mémorisé'], ['leastrecent', 'Le moins récemment appelé'], ['fewestcalls', 'Le moins d\'appels pris'], ['random', 'Aléatoire']];
const GSTRATS = [['all', 'Tous en même temps'], ['linear', 'Un par un, dans l\'ordre'], ['random', 'Aléatoire'], ['least_recent', 'Le moins récemment appelé'], ['fewest_calls', 'Le moins d\'appels pris'], ['memorized_round_robin', 'Tour de rôle mémorisé']];
const opts = (l) => l.map(([k, x]) => `<option value="${k}">${esc(x)}</option>`).join('');

// ---------------------------------------------------------------------------
// Création d'une SDA (demande de Brice, 16/10/2026 : « des SDA peuvent être
// déclarées mais non mappées ») : numéros des plages SDA du contexte entrant
// (incall_ranges) qui n'ont pas encore de SDA (numbers.js), ou un motif.
// Vérifié dans wazo-confd master : POST /incalls — seule « destination » est
// obligatoire (créée sans destination, {type: 'none'}, puis réglée par le
// brouillon) ; numéro : POST /extensions {exten, context} puis
// PUT /incalls/{id}/extensions/{ext} ; le numéro doit être dans les
// PUT /incalls/{id}/extensions/{ext} ; un numéro doit être dans les
// incall_ranges du contexte, un motif « _… » non (vérifié, numbers.js).
const CID = [['', 'Inchangé : nom de l\'appelant seul'], ['prepend', 'Texte, puis nom de l\'appelant'], ['overwrite', 'Texte seul, à la place du nom'], ['append', 'Nom de l\'appelant, puis texte']];
// Mêmes options que le formulaire « Appels entrants » du portail (retour de
// Brice, 17/10/2026) : numéro ou motif, destination, pré-décroché, horaire,
// nom affiché, sous-routine. Tout est envoyé à la création.
// onCreated(key) : clé de la SDA créée (« incall:id »).
export function openCreateIncall(onCreated, reload, ctxName = '', showNum = (x) => x) {
  const ctxs = (M.lists.context || []).filter((c) => c.type === 'incall');
  if (!ctxs.length) { toast('Aucun contexte entrant : créez-en un dans le portail (Contextes).', 7000); return; }
  const ctx0 = ctxs.some((c) => c.name === ctxName) ? ctxName : ctxs[0].name;
  confirmModal(`<div class="cf-ed">
    <div class="cf-ge-head"><div><h3>Créer une SDA</h3><div class="small muted">Comme « Appels entrants » dans le portail ; les numéros proposés sont ceux des plages sans SDA</div></div></div>
    <div class="cf-ge-body cf-cr-body">
      ${field('Contexte entrant', `<select data-c="ctx">${ctxs.map((c) => `<option value="${esc(c.name)}"${c.name === ctx0 ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('')}</select>`, '')}
      ${incallNumberHtml({ field })}
      <div class="cf-ge-f"><span class="cf-ge-l">Destination</span>${pickerHtml('cr-dest', null)}</div>
      ${field('Pré-décroché (message d\'accueil)', '<select data-c="greet" id="cr-greet"><option value="">Chargement des sons…</option></select>', 'Joué à l\'appelant avant de l\'envoyer vers la destination.')}
      ${field('Horaire', `<select data-c="sched"><option value="">Aucun : toujours ouvert</option>${(M.lists.schedule || []).map((s) => `<option value="${s.id}">${esc(s.name || `#${s.id}`)}</option>`).join('')}</select>`, 'Hors horaire : destination « fermé » de l\'horaire.')}
      <div class="cf-ge-2">
        ${field('Nom affiché à l\'appelé', `<select data-c="cidm">${opts(CID)}</select>`)}
        ${field('Texte du nom', '<input data-c="cidn" maxlength="80" placeholder="ex. Accueil">', 'Si le nom affiché n\'est pas « Inchangé ».')}
      </div>
      <div class="cf-ge-2">
        ${field('Description (facultatif)', '<input data-c="desc" maxlength="255" placeholder="ex. Ligne directe compta">')}
        ${field('Sous-routine de pré-traitement', '<input data-c="sub" maxlength="79" placeholder="aucune">', 'Sous-routine Asterisk exécutée avant de recevoir l\'appel.')}
      </div>
    </div>
    <div class="warn"><span>« Créer » enregistre la SDA tout de suite dans Wazo.</span></div>
    <p id="cr-err" class="error small"></p></div>`, async () => {
    const box = $('modal-body');
    const v = (k) => box.querySelector(`[data-c="${k}"]`)?.value?.trim() ?? '';
    const err = (m) => { $('cr-err').textContent = m; return false; };
    const ctx = v('ctx'); const ex = readIncallNumber(box);
    const bad = checkIncallNumber(ctx, ex); if (bad) return err(bad);
    if (v('cidm') && !v('cidn')) return err('Nom affiché : saisissez le texte, ou choisissez « Inchangé ».');
    let dest; try { dest = readPicker('cr-dest'); } catch (e) { return err(e.message); }
    const body = { destination: dest || { type: 'none' } };
    if (v('desc')) body.description = v('desc');
    if (v('greet')) body.greeting_sound = v('greet');
    if (v('cidm')) Object.assign(body, { caller_id_mode: v('cidm'), caller_id_name: v('cidn') });
    if (v('sub')) body.preprocess_subroutine = v('sub');
    let inc;
    try { inc = await api('POST', '/incalls', body); } catch (e) { return err(`Création refusée par Wazo : ${e.message}`); }
    // Numéro : extension puis association ; échec → SDA et extension retirées (une SDA sans numéro ne sert à rien).
    try {
      const e = await api('POST', '/extensions', { exten: ex, context: ctx });
      try { await api('PUT', `/incalls/${inc.id}/extensions/${e.id}`); } catch (e2) { try { await api('DELETE', `/extensions/${e.id}`); } catch { /* */ } throw e2; }
    } catch (e) {
      try { await api('DELETE', `/incalls/${inc.id}`); } catch { /* */ }
      return err(`Numéro ${ex} refusé par Wazo : ${e.message}. Rien n'a été créé.`);
    }
    // Horaire : association (un seul par SDA, vérifié) ; échec signalé, la SDA reste.
    if (v('sched')) { try { await api('PUT', `/incalls/${inc.id}/schedules/${v('sched')}`); } catch (e) { toast(`SDA créée, mais horaire refusé : ${e.message}`, 9000); } }
    console.info('[astrea] Call Flow : SDA créée', inc.id, ex, ctx);
    toast(`SDA ${ex.startsWith('_') ? ex : showNum(ex)} créée dans Wazo.${dest ? '' : ' Choisissez maintenant sa destination.'}`, 6000);
    await reload?.();
    setTimeout(() => onCreated?.(`incall:${inc.id}`), 0);
    return true;
  }, 'Créer');
  const box = $('modal-body');
  bindPicker('cr-dest');
  bindIncallNumber(box, () => box.querySelector('[data-c="ctx"]').value);
  fillSoundSelect($('cr-greet'), '').then(() => { const s = $('cr-greet'); if (s?.options[0] && !s.options[0].value) s.options[0].textContent = 'Aucun'; });
}
// onCreated(id) : id de l'objet créé (uuid pour un standard).
// fromList : création depuis la colonne de gauche (pas depuis une sortie du graphe).
export function openCreate(type, onCreated, reload, fromList = false) {
  if (!CREATABLE.has(type)) return;
  const NA = { ext: 'data-c="exten"', ctx: 'data-c="ctx"' };
  const num = RANGE[type] ? numberFieldHtml(type, { ctxList: internal(), attrs: NA, prefill: true, field }) : '';
  const forms = {
    group: () => `${field('Nom *', '<input data-c="label" maxlength="128" placeholder="ex. Accueil">', 'Lettres sans accent, chiffres, espace, - _ .')}${field('Stratégie', `<select data-c="strategy">${opts(GSTRATS)}</select>`)}${num}`,
    queue: () => `<div class="cf-ge-2">${field('Nom affiché', '<input data-c="label" maxlength="128" placeholder="ex. Support">')}${field('Nom technique *', '<input data-c="name" maxlength="128" placeholder="ex. support">', 'Sans espace ni accent : lettres, chiffres, - _ .')}</div>${field('Stratégie', `<select data-c="strategy">${opts(QSTRATS)}</select>`)}${num}`,
    ivr: () => `${field('Nom *', '<input data-c="name" maxlength="128" placeholder="ex. Menu principal">')}${field('Message du menu *', '<select data-c="menu" id="cr-menu"><option value="">Chargement des sons…</option></select>', '« Tapez 1 pour… ». Les touches se règlent ensuite (« Régler le SVI… »).')}`,
    switchboard: () => field('Nom *', '<input data-c="name" maxlength="128" placeholder="ex. Standard">', 'Opérateurs, délai et débordement : « Régler le standard… » ensuite.'),
    voicemail: () => `${field('Nom *', '<input data-c="name" maxlength="80" placeholder="ex. Messagerie accueil">')}<div class="cf-ge-2">${field('Numéro *', '<input data-c="number" inputmode="numeric" placeholder="ex. 8000">', 'Numéro de la boîte, souvent celui du poste. Pas de plage à respecter, mais unique dans le contexte.')}${field('Contexte *', ctxSel('data-c="ctx"'))}</div>${field('E-mail (facultatif)', '<input type="email" data-c="email" placeholder="aucun">')}${secretField('data-c="password"', 'Code (facultatif)', '', 'Chiffres. Masqué partout, jamais dans une sauvegarde.')}`,
    conference: () => `${field('Nom', '<input data-c="name" maxlength="128" placeholder="ex. Réunion">')}${num}`,
    // Règle sortante (vérifié, confd outcall/schema.py : seul name est obligatoire) ; motifs et trunks ensuite (« Régler la règle sortante… », assistant France).
    outcall: () => field('Nom *', '<input data-c="name" maxlength="128" placeholder="ex. Sortie Unyc">', 'Motifs (assistant France), trunks, horaire et autorisations : dans le réglage complet, ouvert juste après.'),
    schedule: () => `${field('Nom *', '<input data-c="name" maxlength="128" placeholder="ex. Horaires bureau">')}${field('Heures d\'ouverture', `<select data-c="preset">${Object.entries(PRESETS).map(([k, [l]]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>`, 'Point de départ : à affiner ensuite (« Modifier les heures… »).')}<div class="cf-ge-f"><span class="cf-ge-l">Si fermé *</span>${pickerHtml('cr-closed', { type: 'hangup', cause: 'normal' })}</div>`,
  };
  confirmModal(`<div class="cf-ed">
    <div class="cf-ge-head"><div><h3>Créer ${esc(LABEL[type])}</h3><div class="small muted">${fromList ? 'Création immédiate dans Wazo ; ses réglages complets s\'ouvrent ensuite (brouillon)' : 'Création immédiate dans Wazo, puis branchement sur la sortie (brouillon)'}</div></div></div>
    <div class="cf-ge-body cf-cr-body">${forms[type]()}</div>
    <div class="warn"><span>« Créer » enregistre l'objet tout de suite dans Wazo. Annuler ensuite le brouillon ne le supprime pas.</span></div>
    <p id="cr-err" class="error small"></p></div>`, async () => {
    const box = $('modal-body');
    const v = (k) => box.querySelector(`[data-c="${k}"]`)?.value?.trim() ?? '';
    const err = (m) => { $('cr-err').textContent = m; return false; };
    // Numéro facultatif : contrôlé avant toute création.
    const ex = v('exten'), ctx = v('ctx');
    if (RANGE[type] && checkNumber(ctx, type, ex)) return err(checkNumber(ctx, type, ex));
    let body, path;
    if (type === 'group') { if (!/^[-_.a-zA-Z0-9 ]{1,128}$/.test(v('label'))) return err('Nom : obligatoire, sans accents (lettres, chiffres, espace, - _ .).'); body = { label: v('label'), ring_strategy: v('strategy') }; path = '/groups'; }
    if (type === 'queue') {
      if (!/^[-_.a-zA-Z0-9]{1,128}$/.test(v('name'))) return err('Nom technique : obligatoire, sans espace ni accent.');
      if ([...(M.lists.queue || []), ...(M.lists.group || [])].some((x) => x.name === v('name'))) return err('Ce nom technique existe déjà (file ou groupe).');
      body = { name: v('name'), label: v('label') || v('name'), options: [['strategy', v('strategy')]] }; path = '/queues';
    }
    if (type === 'ivr') { if (!v('name')) return err('Nom obligatoire.'); if (!v('menu')) return err('Choisissez le message du menu.'); body = { name: v('name'), menu_sound: v('menu'), timeout: 5, max_tries: 3 }; path = '/ivr'; }
    if (type === 'switchboard') { if (!v('name')) return err('Nom obligatoire.'); body = { name: v('name') }; path = '/switchboards'; }
    if (type === 'voicemail') {
      if (!v('name')) return err('Nom obligatoire.'); if (!/^[0-9]{1,40}$/.test(v('number'))) return err('Numéro : chiffres seulement.');
      if ((M.lists.voicemail || []).some((x) => String(x.number) === v('number') && x.context === ctx)) return err(`Une messagerie porte déjà le numéro ${v('number')} dans ce contexte.`);
      if (v('password') && !/^[0-9]{1,80}$/.test(v('password'))) return err('Code : chiffres seulement.');
      body = { name: v('name'), number: v('number'), context: ctx, ...(v('email') ? { email: v('email') } : {}), ...(v('password') ? { password: v('password') } : {}) }; path = '/voicemails';
    }
    if (type === 'conference') { body = { name: v('name') || null }; path = '/conferences'; }
    if (type === 'outcall') { if (!v('name')) return err('Nom obligatoire.'); body = { name: v('name') }; path = '/outcalls'; }
    if (type === 'schedule') {
      if (!v('name')) return err('Nom obligatoire.');
      let closed; try { closed = readPicker('cr-closed'); } catch (e) { return err(e.message); }
      body = { name: v('name'), closed_destination: closed || { type: 'none' }, open_periods: PRESETS[v('preset')][1], exceptional_periods: [] }; path = '/schedules';
    }
    let created;
    try { created = await api('POST', path, body); } catch (e) { return err(`Création refusée par Wazo : ${e.message}`); }
    // Identifiant des listes du module : uuid pour un standard, id sinon (groupe compris : destination group_id).
    const id = type === 'switchboard' ? created.uuid : created.id;
    if (ex) {
      // Numéro : extension puis association ; en cas d'échec, l'objet reste créé (signalé).
      const base = type === 'group' ? `/groups/${created.uuid}` : type === 'queue' ? `/queues/${created.id}` : `/conferences/${created.id}`;
      try { const e = await api('POST', '/extensions', { exten: ex, context: ctx }); try { await api('PUT', `${base}/extensions/${e.id}`); } catch (e2) { try { await api('DELETE', `/extensions/${e.id}`); } catch { /* */ } throw e2; } } catch (e) { toast(`Objet créé, mais numéro ${ex} refusé : ${e.message}`, 9000); }
    }
    console.info('[astrea] Call Flow : création', path, id);
    toast(`${LABEL[type][0].toUpperCase()}${LABEL[type].slice(1)} : ${['queue', 'voicemail', 'conference', 'outcall'].includes(type) ? 'créée' : 'créé'} dans Wazo.`, 5000);
    await reload?.();
    setTimeout(() => onCreated?.(id), 0);
    return true;
  }, 'Créer');
  const box = $('modal-body');
  if (type === 'ivr') fillSoundSelect($('cr-menu'), '');
  if (type === 'schedule') bindPicker('cr-closed');
  if (type === 'voicemail') bindSecrets(box);
  if (RANGE[type]) bindNumberField(box, type, { attrs: NA });
  box.querySelector('input')?.focus();
}
