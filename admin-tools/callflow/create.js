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
import { $, esc, api, toast, confirmModal } from '../common/core.js?v=0.40.3';
import { M } from './model.js?v=0.40.3';
import { pickerHtml, bindPicker, readPicker, fillSoundSelect } from './sched-editor.js?v=0.40.3';
import { field, secretField, bindSecrets } from './ed-ui.js?v=0.40.3';

export const CREATABLE = new Set(['group', 'queue', 'ivr', 'switchboard', 'voicemail', 'conference', 'schedule']);
const LABEL = { group: 'un groupe d\'appel', queue: 'une file d\'attente', ivr: 'un SVI', switchboard: 'un standard', voicemail: 'une messagerie', conference: 'une conférence', schedule: 'un horaire' };
const RANGE = { group: 'group_ranges', queue: 'queue_ranges', conference: 'conference_room_ranges' };
const internal = () => (M.lists.context || []).filter((c) => c.type === 'internal');
const ctxSel = (attr) => `<select ${attr}>${internal().map((c) => `<option value="${esc(c.name)}">${esc(c.label || c.name)}</option>`).join('')}</select>`;
const inRange = (ctx, ex, key) => { const c = M.by.context?.get(ctx); if (!c?.[key]) return true; return c[key].some((r) => ex.length === String(r.start).length && ex >= String(r.start) && ex <= String(r.end)); };
const ranges = (ctx, key) => (M.by.context?.get(ctx)?.[key] || []).map((r) => `${r.start}-${r.end}`).join(', ') || 'aucune';
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
// (incall_ranges) qui n'ont pas encore de SDA, ou saisie libre dans ces plages.
// Vérifié dans wazo-confd master : POST /incalls — seule « destination » est
// obligatoire (créée sans destination, {type: 'none'}, puis réglée par le
// brouillon) ; numéro : POST /extensions {exten, context} puis
// PUT /incalls/{id}/extensions/{ext} ; le numéro doit être dans les
// incall_ranges du contexte (did_length n'entre pas dans ce contrôle).
// ---------------------------------------------------------------------------
const MAX_FREE = 300; // numéros libres listés par plage (au-delà : saisie libre)
// Numéros libres d'un contexte entrant : [{ exten, range }].
export function freeIncalls(ctxName) {
  const c = M.by.context?.get(ctxName); const out = [];
  for (const r of c?.incall_ranges || []) {
    const len = String(r.start).length; let n = BigInt(r.start); const end = BigInt(r.end || r.start);
    for (let i = 0; n <= end && i < MAX_FREE; n += 1n) {
      const ex = n.toString().padStart(len, '0');
      if (!M.ext.has(`${ex}@${ctxName}`)) { out.push({ exten: ex, range: `${r.start}–${r.end || r.start}` }); i++; }
    }
  }
  return out;
}
const inIncallRange = (ctx, ex) => (M.by.context?.get(ctx)?.incall_ranges || []).some((r) => ex.length === String(r.start).length && BigInt(ex) >= BigInt(r.start) && BigInt(ex) <= BigInt(r.end || r.start));
// onCreated(key) : clé de la SDA créée (« incall:id »).
export function openCreateIncall(onCreated, reload, ctxName = '', showNum = (x) => x) {
  const ctxs = (M.lists.context || []).filter((c) => c.type === 'incall');
  if (!ctxs.length) { toast('Aucun contexte entrant : créez-en un dans le portail (Contextes).', 7000); return; }
  const ctx0 = ctxs.some((c) => c.name === ctxName) ? ctxName : ctxs[0].name;
  const numOpts = (ctx) => { const l = freeIncalls(ctx); return l.length ? l.map((x) => `<option value="${esc(x.exten)}">${esc(showNum(x.exten))}${showNum(x.exten).replace(/\s/g, '') !== x.exten ? ` · ${esc(x.exten)}` : ''}</option>`).join('') : '<option value="">aucun numéro libre dans les plages</option>'; };
  const rangesTxt = (ctx) => (M.by.context?.get(ctx)?.incall_ranges || []).map((r) => `${r.start}–${r.end || r.start}`).join(', ') || 'aucune plage SDA déclarée';
  confirmModal(`<div class="cf-ed">
    <div class="cf-ge-head"><div><h3>Créer une SDA</h3><div class="small muted">Numéro déclaré dans les plages d'un contexte entrant, sans SDA pour l'instant</div></div></div>
    <div class="cf-ge-body cf-cr-body">
      ${field('Contexte entrant', `<select data-c="ctx">${ctxs.map((c) => `<option value="${esc(c.name)}"${c.name === ctx0 ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('')}</select>`, '')}
      <p class="small muted" id="cr-ranges">Plages SDA : ${esc(rangesTxt(ctx0))}</p>
      ${field('Numéro libre', `<select data-c="free" id="cr-free">${numOpts(ctx0)}</select>`, `Numéros des plages sans SDA (${MAX_FREE} au plus par plage).`)}
      ${field('ou saisir le numéro', '<input data-c="exten" inputmode="numeric" placeholder="tel que reçu de l\'opérateur, ex. 33978247652">', 'Doit être dans une plage SDA du contexte.')}
      ${field('Description (facultatif)', '<input data-c="desc" maxlength="255" placeholder="ex. Ligne directe compta">')}
    </div>
    <div class="warn"><span>« Créer » enregistre la SDA tout de suite dans Wazo, sans destination ; vous choisissez ensuite sa destination (brouillon, puis « Appliquer… »).</span></div>
    <p id="cr-err" class="error small"></p></div>`, async () => {
    const box = $('modal-body');
    const v = (k) => box.querySelector(`[data-c="${k}"]`)?.value?.trim() ?? '';
    const err = (m) => { $('cr-err').textContent = m; return false; };
    const ctx = v('ctx'); const ex = (v('exten') || v('free')).replace(/[\s.-]/g, '');
    if (!ex) return err('Choisissez un numéro libre ou saisissez-en un.');
    if (!/^[0-9]{1,16}$/.test(ex)) return err('Numéro : chiffres seulement (16 au plus), tel que reçu de l\'opérateur.');
    if (M.ext.has(`${ex}@${ctx}`)) return err(`Le numéro ${ex} a déjà une SDA dans ce contexte.`);
    if (!inIncallRange(ctx, ex)) return err(`Numéro ${ex} hors des plages SDA du contexte (${rangesTxt(ctx)}).`);
    let inc;
    try { inc = await api('POST', '/incalls', { destination: { type: 'none' }, ...(v('desc') ? { description: v('desc') } : {}) }); } catch (e) { return err(`Création refusée par Wazo : ${e.message}`); }
    // Numéro : extension puis association ; échec → SDA et extension retirées (une SDA sans numéro ne sert à rien).
    try {
      const e = await api('POST', '/extensions', { exten: ex, context: ctx });
      try { await api('PUT', `/incalls/${inc.id}/extensions/${e.id}`); } catch (e2) { try { await api('DELETE', `/extensions/${e.id}`); } catch { /* */ } throw e2; }
    } catch (e) {
      try { await api('DELETE', `/incalls/${inc.id}`); } catch { /* */ }
      return err(`Numéro ${ex} refusé par Wazo : ${e.message}. Rien n'a été créé.`);
    }
    console.info('[astrea] Call Flow : SDA créée', inc.id, ex, ctx);
    toast(`SDA ${showNum(ex)} créée dans Wazo. Choisissez maintenant sa destination.`, 6000);
    await reload?.();
    setTimeout(() => onCreated?.(`incall:${inc.id}`), 0);
    return true;
  }, 'Créer');
  const box = $('modal-body');
  box.querySelector('[data-c="ctx"]').onchange = (e) => { $('cr-free').innerHTML = numOpts(e.target.value); $('cr-ranges').textContent = `Plages SDA : ${rangesTxt(e.target.value)}`; };
}

// onCreated(id) : id de l'objet créé (uuid pour un standard).
export function openCreate(type, onCreated, reload) {
  if (!CREATABLE.has(type)) return;
  const num = RANGE[type] ? `<div class="cf-ge-2">${field('Numéro interne (facultatif)', '<input data-c="exten" placeholder="aucun" inputmode="numeric">', 'Pour l\'appeler directement.')}${field('Contexte du numéro', ctxSel('data-c="ctx"'))}</div>` : '';
  const forms = {
    group: () => `${field('Nom *', '<input data-c="label" maxlength="128" placeholder="ex. Accueil">', 'Lettres sans accent, chiffres, espace, - _ .')}${field('Stratégie', `<select data-c="strategy">${opts(GSTRATS)}</select>`)}${num}`,
    queue: () => `<div class="cf-ge-2">${field('Nom affiché', '<input data-c="label" maxlength="128" placeholder="ex. Support">')}${field('Nom technique *', '<input data-c="name" maxlength="128" placeholder="ex. support">', 'Sans espace ni accent : lettres, chiffres, - _ .')}</div>${field('Stratégie', `<select data-c="strategy">${opts(QSTRATS)}</select>`)}${num}`,
    ivr: () => `${field('Nom *', '<input data-c="name" maxlength="128" placeholder="ex. Menu principal">')}${field('Message du menu *', '<select data-c="menu" id="cr-menu"><option value="">Chargement des sons…</option></select>', '« Tapez 1 pour… ». Les touches se règlent ensuite (« Régler le SVI… »).')}`,
    switchboard: () => field('Nom *', '<input data-c="name" maxlength="128" placeholder="ex. Standard">', 'Opérateurs, délai et débordement : « Régler le standard… » ensuite.'),
    voicemail: () => `${field('Nom *', '<input data-c="name" maxlength="80" placeholder="ex. Messagerie accueil">')}<div class="cf-ge-2">${field('Numéro *', '<input data-c="number" inputmode="numeric" placeholder="ex. 8000">', 'Pour consulter la boîte.')}${field('Contexte *', ctxSel('data-c="ctx"'))}</div>${field('E-mail (facultatif)', '<input type="email" data-c="email" placeholder="aucun">')}${secretField('data-c="password"', 'Code (facultatif)', '', 'Chiffres. Masqué partout, jamais dans une sauvegarde.')}`,
    conference: () => `${field('Nom', '<input data-c="name" maxlength="128" placeholder="ex. Réunion">')}${num}`,
    schedule: () => `${field('Nom *', '<input data-c="name" maxlength="128" placeholder="ex. Horaires bureau">')}${field('Heures d\'ouverture', `<select data-c="preset">${Object.entries(PRESETS).map(([k, [l]]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>`, 'Point de départ : à affiner ensuite (« Modifier les heures… »).')}<div class="cf-ge-f"><span class="cf-ge-l">Si fermé *</span>${pickerHtml('cr-closed', { type: 'hangup', cause: 'normal' })}</div>`,
  };
  confirmModal(`<div class="cf-ed">
    <div class="cf-ge-head"><div><h3>Créer ${esc(LABEL[type])}</h3><div class="small muted">Création immédiate dans Wazo, puis branchement sur la sortie (brouillon)</div></div></div>
    <div class="cf-ge-body cf-cr-body">${forms[type]()}</div>
    <div class="warn"><span>« Créer » enregistre l'objet tout de suite dans Wazo. Annuler ensuite le brouillon ne le supprime pas.</span></div>
    <p id="cr-err" class="error small"></p></div>`, async () => {
    const box = $('modal-body');
    const v = (k) => box.querySelector(`[data-c="${k}"]`)?.value?.trim() ?? '';
    const err = (m) => { $('cr-err').textContent = m; return false; };
    // Numéro facultatif : contrôlé avant toute création.
    const ex = v('exten'), ctx = v('ctx');
    if (ex && !/^[0-9*#]{1,40}$/.test(ex)) return err('Numéro interne : chiffres, * et # seulement.');
    if (ex && RANGE[type] && !inRange(ctx, ex, RANGE[type])) return err(`Numéro ${ex} hors des plages du contexte (${ranges(ctx, RANGE[type])}).`);
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
      if (v('password') && !/^[0-9]{1,80}$/.test(v('password'))) return err('Code : chiffres seulement.');
      body = { name: v('name'), number: v('number'), context: ctx, ...(v('email') ? { email: v('email') } : {}), ...(v('password') ? { password: v('password') } : {}) }; path = '/voicemails';
    }
    if (type === 'conference') { body = { name: v('name') || null }; path = '/conferences'; }
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
    toast(`${LABEL[type][0].toUpperCase()}${LABEL[type].slice(1)} : ${['queue', 'voicemail', 'conference'].includes(type) ? 'créée' : 'créé'} dans Wazo.`, 5000);
    await reload?.();
    setTimeout(() => onCreated?.(id), 0);
    return true;
  }, 'Créer');
  const box = $('modal-body');
  if (type === 'ivr') fillSoundSelect($('cr-menu'), '');
  if (type === 'schedule') bindPicker('cr-closed');
  if (type === 'voicemail') bindSecrets(box);
  box.querySelector('input')?.focus();
}
