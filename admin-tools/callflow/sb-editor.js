// Call Flow Manager — réglage d'un standard (POPC), selon la norme d'édition du
// module (ed-ui.js). Retour de Brice (16/10/2026) : une carte standard posée en
// mode édition ne se réglait pas. Sans écriture : valeur au brouillon (onSave).
// Vérifié dans wazo-confd master (switchboard/schema.py, switchboard_member,
// switchboard_fallback) :
//  - name (≤ 128, obligatoire), timeout (≥ 1 ou null : délai avant le
//    débordement « pas de réponse »), queue_music_on_hold et
//    waiting_room_music_on_hold (nom de MOH, ≤ 128) ; PUT partiel ;
//  - opérateurs : PUT /switchboards/{uuid}/members/users {users:[{uuid}]},
//    liste remplacée en entier ;
//  - un seul débordement : noanswer (PUT /switchboards/{uuid}/fallbacks).
import { $, esc, confirmModal, helpButton, helpBox, fullName } from '../common/core.js?v=0.40.14';
import { M } from './model.js?v=0.40.14';
import { pickerHtml, bindPicker, readPicker } from './sched-editor.js?v=0.40.14';
import { sec, field, setSums, openSec } from './ed-ui.js?v=0.40.14';

// Ordre sans importance pour un standard : trié pour comparer.
const byUuid = (a, b) => a.uuid.localeCompare(b.uuid);
export const SB_FIELDS = ['name', 'timeout', 'queue_music_on_hold', 'waiting_room_music_on_hold'];
export function sbCfgOf(s) {
  const f = {}; for (const k of SB_FIELDS) f[k] = s[k] ?? null;
  return { fields: f, users: (s.members?.users || []).map((u) => ({ uuid: u.uuid })).sort(byUuid) };
}
export function applySbCfg(s, v) {
  Object.assign(s, v.fields);
  s.members = { users: v.users.map((m) => { const u = M.userByUuid.get(m.uuid); return { uuid: m.uuid, firstname: u?.firstname, lastname: u?.lastname }; }) };
}

// onSave({ cfg, noanswer })
export function openSbEditor(s, onSave) {
  const v = sbCfgOf(s); const f = v.fields;
  let users = [...v.users];
  const cand = (M.lists.user || []).sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  const uname = (uuid) => fullName(M.userByUuid.get(uuid)) || uuid;
  const rows = () => users.map((m, i) => `<li><span>${esc(uname(m.uuid))}</span><span class="spacer"></span><button class="icon" data-del="${i}" title="Retirer des opérateurs">×</button></li>`).join('') || '<li class="muted">Aucun opérateur</li>';
  const addOpts = () => `<option value="">Choisir un utilisateur à ajouter…</option>${cand.filter((u) => !users.some((m) => m.uuid === u.uuid)).map((u) => `<option value="${esc(u.uuid)}">${esc(fullName(u))}</option>`).join('')}`;
  const moh = (k) => `<select data-f="${k}"><option value="">Par défaut du serveur</option>${(M.lists.moh || []).map((m) => `<option value="${esc(m.name)}"${f[k] === m.name ? ' selected' : ''}>${esc(m.label || m.name)}</option>`).join('')}${f[k] && !(M.lists.moh || []).some((m) => m.name === f[k]) ? `<option value="${esc(f[k])}" selected>${esc(f[k])} (actuelle)</option>` : ''}</select>`;

  confirmModal(`<div class="cf-ed cf-sb-ed">
    <div class="cf-ge-head"><div><h3>Standard « ${esc(s.name)} »</h3></div>${helpButton('se2-hb', 'Aide')}</div>${helpBox('se2-hb', 'Options de l\'API Wazo pour un standard (POPC) : nom, opérateurs, délai, musiques d\'attente et débordement. Les modifications vont dans le brouillon ; « Appliquer… » relit le standard et n\'écrit que ce qui change.')}
    ${sec('gen', 'Général', field('Nom *', `<input data-f="name" value="${esc(f.name || '')}" maxlength="128">`), { open: true })}
    ${sec('ops', 'Opérateurs', `<ul class="cf-ge-list" id="sbe-users">${rows()}</ul>
      <div class="cf-ge-row"><select id="sbe-add">${addOpts()}</select><button data-add>Ajouter</button></div>`, { open: true, help: 'Utilisateurs qui prennent les appels du standard dans l\'application (Wazo Desktop / web). La liste est remplacée en entier à l\'écriture.' })}
    ${sec('wait', 'Attente', `
      ${field('Délai avant débordement (s)', `<input type="number" min="1" step="1" data-f="timeout" value="${esc(f.timeout ?? '')}" placeholder="aucun">`, 'Vide : l\'appel attend sans limite qu\'un opérateur le prenne.')}
      <div class="cf-ge-2">
        ${field('Musique d\'attente (file d\'appels)', moh('queue_music_on_hold'), 'Pendant que l\'appel attend d\'être pris.')}
        ${field('Musique de la salle d\'attente', moh('waiting_room_music_on_hold'), 'Pour un appel mis en attente par l\'opérateur.')}
      </div>
      <div class="cf-ge-f"><span class="cf-ge-l">Si personne ne prend l'appel</span>${pickerHtml('sbe-noans', s.fallbacks?.noanswer_destination)}</div>`, { open: true })}
    <p id="sbe-err" class="error small"></p></div>`, () => {
    const box = $('modal-body');
    const err = (m, sc) => { openSec(box, sc); $('sbe-err').textContent = m; return false; };
    const nf = { ...f };
    nf.name = box.querySelector('[data-f="name"]').value.trim();
    if (!nf.name) return err('Nom obligatoire.', 'gen');
    const t = box.querySelector('[data-f="timeout"]').value.trim();
    if (t === '') nf.timeout = null; else if (!/^\d+$/.test(t) || Number(t) < 1) return err('Délai : nombre entier, au moins 1 s (ou vide).', 'wait'); else nf.timeout = Number(t);
    nf.queue_music_on_hold = box.querySelector('[data-f="queue_music_on_hold"]').value || null;
    nf.waiting_room_music_on_hold = box.querySelector('[data-f="waiting_room_music_on_hold"]').value || null;
    let noanswer; try { noanswer = readPicker('sbe-noans'); } catch (e) { return err(e.message, 'wait'); }
    onSave({ cfg: { fields: nf, users: [...users].sort(byUuid) }, noanswer });
    return true;
  }, 'Ajouter au brouillon');

  bindPicker('sbe-noans');
  const box = $('modal-body');
  const pick = (id) => { const el = $(id); const tt = el?.querySelector('[data-dt]'); if (!tt || tt.value === 'none') return 'rien'; const x = el.querySelector('[data-do]'); return `${tt.selectedOptions[0].text.toLowerCase()}${x?.value ? ` ${x.selectedOptions[0].text.split(' — ')[0]}` : ''}`; };
  const recap = () => setSums(box, {
    gen: [box.querySelector('[data-f="name"]').value.trim() || '(sans nom)'],
    ops: [`${users.length} opérateur${users.length > 1 ? 's' : ''}`],
    wait: [box.querySelector('[data-f="timeout"]').value ? `${box.querySelector('[data-f="timeout"]').value} s` : 'sans limite', `puis ${pick('sbe-noans')}`],
  });
  const redraw = () => { $('sbe-users').innerHTML = rows(); $('sbe-add').innerHTML = addOpts(); recap(); };
  box.addEventListener('input', () => { $('sbe-err').textContent = ''; recap(); });
  box.addEventListener('change', recap);
  box.onclick = (e) => {
    const d = e.target.closest('[data-del]'); if (d) { users.splice(Number(d.dataset.del), 1); redraw(); return; }
    if (e.target.closest('[data-add]')) { const uu = $('sbe-add').value; if (uu) { users.push({ uuid: uu }); redraw(); } }
  };
  recap();
}

export function sbCfgDiff(a, b) {
  if (!a || !b) return '';
  const L = { name: 'nom', timeout: 'délai', queue_music_on_hold: 'musique d\'attente', waiting_room_music_on_hold: 'musique de salle d\'attente' };
  const out = SB_FIELDS.filter((k) => JSON.stringify(a.fields[k] ?? null) !== JSON.stringify(b.fields[k] ?? null)).map((k) => L[k]);
  if (JSON.stringify(a.users) !== JSON.stringify(b.users)) out.push('opérateurs');
  return out.join(', ');
}
