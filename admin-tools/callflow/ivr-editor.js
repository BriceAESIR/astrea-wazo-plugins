// Call Flow Manager — réglage complet d'un SVI (demande de Brice, 16/10/2026),
// selon la norme d'édition du module (ed-ui.js). Sans écriture : renvoie une
// valeur au brouillon (onSave), écrite par write.js en un seul PUT /ivr/{id}.
// Vérifié dans wazo-confd master (ivr/schema.py, ivr/validator.py,
// helpers/restful.py) :
//  - name (≤ 128, obligatoire), description, greeting_sound, menu_sound
//    (obligatoire), invalid_sound, abort_sound (≤ 255), timeout (≥ 0),
//    max_tries (≥ 1), timeout/invalid/abort_destination, choices
//    [{ exten, destination }] (touche unique, refus sinon) ;
//  - PUT partiel (partial=True) : seuls les champs envoyés changent ; choices
//    envoyé = liste complète.
// Le format des champs *_sound n'est pas documenté : on garde la valeur lue et
// on propose les sons du tenant (même valeur que destination.filename, supposé).
import { $, esc, confirmModal, helpButton, helpBox } from '../common/core.js?v=0.39.6';
import { pickerHtml, bindPicker, readPicker, fillSoundSelect } from './sched-editor.js?v=0.39.6';
import { sec, field, setSums, openSec } from './ed-ui.js?v=0.39.6';

export const IVR_FIELDS = ['name', 'description', 'greeting_sound', 'menu_sound', 'invalid_sound', 'abort_sound', 'timeout', 'max_tries'];
const DESTS = ['timeout_destination', 'invalid_destination', 'abort_destination'];
const keySort = (a, b) => String(a.exten).localeCompare(String(b.exten), 'fr', { numeric: true });

export function ivrCfgOf(o) {
  const f = {}; for (const k of IVR_FIELDS) f[k] = o[k] ?? null;
  const d = {}; for (const k of DESTS) d[k] = o[k] || null;
  return { fields: f, ...d, choices: [...(o.choices || [])].map((c) => ({ exten: String(c.exten), destination: c.destination || null })).sort(keySort) };
}
export function applyIvrCfg(o, v) {
  Object.assign(o, v.fields);
  for (const k of DESTS) o[k] = v[k] || null;
  o.choices = v.choices.map((c) => ({ ...c }));
}

// onSave(cfg)
export function openIvrEditor(o, onSave) {
  const v = ivrCfgOf(o); const f = v.fields;
  // Choix : identifiant interne stable (les touches peuvent être renommées).
  let seq = 0;
  let rows = v.choices.map((c) => ({ id: `c${seq++}`, exten: c.exten, destination: c.destination }));
  const sound = (k, label, help, req) => field(label + (req ? ' *' : ''), `<select data-s="${k}" id="ie-${k}"><option value="">Chargement des sons…</option></select>`, help);
  const rowHtml = (r) => `<li class="cf-ie-ch" data-row="${r.id}"><label class="cf-ie-key">Touche <input data-key="${r.id}" value="${esc(r.exten)}" maxlength="10"></label>${pickerHtml(`ie-d-${r.id}`, r.destination)}<span class="spacer"></span><button class="icon" data-delrow="${r.id}" title="Retirer cette touche">×</button></li>`;
  const freeKey = () => ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'].find((k) => !rows.some((r) => r.exten === k)) || '';

  confirmModal(`<div class="cf-ed cf-ivr-ed">
    <div class="cf-ge-head"><div><h3>SVI « ${esc(o.name)} »</h3><div class="small muted">${esc(o.description || '')}</div></div>${helpButton('ie-hb', 'Aide')}</div>${helpBox('ie-hb', 'Toutes les options de l\'API Wazo pour un SVI : messages, touches et leurs destinations, cas sans saisie / invalide / trop d\'essais. Les modifications vont dans le brouillon ; « Appliquer… » relit le SVI et écrit ce qui change en une fois.')}
    ${sec('gen', 'Général', `
      ${field('Nom *', `<input data-f="name" value="${esc(f.name || '')}" maxlength="128">`)}
      ${field('Description', `<input data-f="description" value="${esc(f.description || '')}">`)}`, { open: true })}
    ${sec('msg', 'Messages', `
      ${sound('greeting_sound', 'Message d\'accueil', 'Joué une fois, à l\'arrivée de l\'appel.')}
      ${sound('menu_sound', 'Menu', 'Liste des choix (« tapez 1 pour… »), rejoué à chaque essai.', true)}
      ${sound('invalid_sound', 'Message si touche invalide', '')}
      ${sound('abort_sound', 'Message avant d\'abandonner', 'Après le dernier essai.')}`, { open: true })}
    ${sec('keys', 'Touches', `<ul class="cf-ge-list cf-ie-list" id="ie-rows">${rows.map(rowHtml).join('')}</ul>
      <div class="btnrow"><button type="button" data-addrow>Ajouter une touche</button></div>`, { open: true, help: 'Une ligne par touche : chiffre, * ou #, et sa destination. Une touche ne peut apparaître qu\'une fois (refus de Wazo sinon). La liste est réécrite en entier à l\'application.' })}
    ${sec('cases', 'Sans saisie, erreurs, abandon', `
      <div class="cf-ge-2">
        ${field('Attente d\'une touche (s)', `<input type="number" min="0" step="1" data-f="timeout" value="${esc(f.timeout ?? '')}">`, 'Après le menu.')}
        ${field('Nombre d\'essais', `<input type="number" min="1" step="1" data-f="max_tries" value="${esc(f.max_tries ?? '')}">`, 'Au-delà : « Trop d\'essais ».')}
      </div>
      <div class="cf-ge-f"><span class="cf-ge-l">Sans saisie</span>${pickerHtml('ie-timeout', v.timeout_destination)}<span class="small muted">Vide : le menu est rejoué jusqu'au nombre d'essais (supposé).</span></div>
      <div class="cf-ge-f"><span class="cf-ge-l">Touche invalide</span>${pickerHtml('ie-invalid', v.invalid_destination)}</div>
      <div class="cf-ge-f"><span class="cf-ge-l">Trop d'essais</span>${pickerHtml('ie-abort', v.abort_destination)}</div>`)}
    <p id="ie-err" class="error small"></p></div>`, () => {
    const box = $('modal-body');
    const err = (m, s) => { openSec(box, s); $('ie-err').textContent = m; return false; };
    const nf = { ...f };
    nf.name = box.querySelector('[data-f="name"]').value.trim();
    if (!nf.name) return err('Nom obligatoire.', 'gen');
    nf.description = box.querySelector('[data-f="description"]').value.trim() || null;
    for (const el of box.querySelectorAll('[data-s]')) nf[el.dataset.s] = el.value || null;
    if (!nf.menu_sound) return err('Le message du menu est obligatoire (Wazo).', 'msg');
    for (const k of ['timeout', 'max_tries']) { const s = box.querySelector(`[data-f="${k}"]`).value.trim(); if (s === '') nf[k] = f[k]; else if (!/^\d+$/.test(s) || (k === 'max_tries' && Number(s) < 1)) return err(k === 'timeout' ? 'Attente : nombre entier positif.' : 'Nombre d\'essais : au moins 1.', 'cases'); else nf[k] = Number(s); }
    const choices = []; const seen = new Set();
    for (const r of rows) {
      const k = box.querySelector(`[data-key="${r.id}"]`).value.trim();
      if (!/^[0-9*#]{1,10}$/.test(k)) return err(`Touche « ${k} » : chiffres, * ou # seulement.`, 'keys');
      if (seen.has(k)) return err(`La touche ${k} apparaît deux fois.`, 'keys');
      seen.add(k);
      let d; try { d = readPicker(`ie-d-${r.id}`); } catch (e) { return err(`Touche ${k} : ${e.message}`, 'keys'); }
      if (!d) return err(`Touche ${k} : choisissez une destination (ou retirez la touche).`, 'keys');
      choices.push({ exten: k, destination: d });
    }
    let dd;
    try { dd = { timeout_destination: readPicker('ie-timeout'), invalid_destination: readPicker('ie-invalid'), abort_destination: readPicker('ie-abort') }; } catch (e) { return err(e.message, 'cases'); }
    onSave({ fields: nf, ...dd, choices: choices.sort(keySort) });
    return true;
  }, 'Ajouter au brouillon');

  const box = $('modal-body');
  for (const k of ['greeting_sound', 'menu_sound', 'invalid_sound', 'abort_sound']) fillSoundSelect($(`ie-${k}`), f[k] || '').then(() => recap());
  ['ie-timeout', 'ie-invalid', 'ie-abort'].forEach(bindPicker);
  rows.forEach((r) => bindPicker(`ie-d-${r.id}`));
  const txt = (el) => (el?.value ? el.selectedOptions[0]?.text : '');
  const pick = (id) => { const el = $(id); const t = el?.querySelector('[data-dt]'); if (!t || t.value === 'none') return 'rien'; const x = el.querySelector('[data-do]'); return `${t.selectedOptions[0].text.toLowerCase()}${x?.value ? ` ${x.selectedOptions[0].text.split(' — ')[0]}` : ''}`; };
  const recap = () => {
    const keys = rows.map((r) => box.querySelector(`[data-key="${r.id}"]`)?.value.trim()).filter(Boolean);
    setSums(box, {
      gen: [box.querySelector('[data-f="name"]').value.trim() || '(sans nom)'],
      msg: [txt($('ie-menu_sound')) ? `menu : ${txt($('ie-menu_sound'))}` : 'menu à choisir', txt($('ie-greeting_sound')) ? 'avec accueil' : ''],
      keys: [keys.length ? `${keys.length} touche${keys.length > 1 ? 's' : ''} : ${keys.join(' ')}` : 'aucune touche'],
      cases: [`${box.querySelector('[data-f="timeout"]').value || '?'} s`, `${box.querySelector('[data-f="max_tries"]').value || '?'} essais`, `trop d'essais : ${pick('ie-abort')}`],
    });
  };
  box.addEventListener('input', () => { $('ie-err').textContent = ''; recap(); });
  box.addEventListener('change', recap);
  box.onclick = (e) => {
    if (e.target.closest('[data-addrow]')) {
      const r = { id: `c${seq++}`, exten: freeKey(), destination: null };
      rows.push(r);
      $('ie-rows').insertAdjacentHTML('beforeend', rowHtml(r));
      bindPicker(`ie-d-${r.id}`);
      box.querySelector(`[data-key="${r.id}"]`).focus();
      recap(); return;
    }
    const d = e.target.closest('[data-delrow]');
    if (d) { rows = rows.filter((r) => r.id !== d.dataset.delrow); box.querySelector(`[data-row="${d.dataset.delrow}"]`)?.remove(); recap(); }
  };
  recap();
}

export function ivrCfgDiff(a, b) {
  if (!a || !b) return '';
  const L = { name: 'nom', description: 'description', greeting_sound: 'accueil', menu_sound: 'menu', invalid_sound: 'message invalide', abort_sound: 'message d\'abandon', timeout: 'attente', max_tries: 'essais', timeout_destination: 'sans saisie', invalid_destination: 'touche invalide', abort_destination: 'trop d\'essais' };
  const out = IVR_FIELDS.filter((k) => JSON.stringify(a.fields[k] ?? null) !== JSON.stringify(b.fields[k] ?? null)).map((k) => L[k]);
  for (const k of DESTS) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) out.push(L[k]);
  if (JSON.stringify(a.choices) !== JSON.stringify(b.choices)) out.push('touches');
  return out.join(', ');
}
