// Call Flow Manager — réglage complet d'un groupe d'appel (lot 2c, demande de
// Brice 15/10/2026 : « toutes les options possibles par API »). Sans écriture :
// renvoie une valeur au brouillon (onSave), écrite ensuite par write.js.
// Vérifié dans wazo-confd master (group/schema.py, group_member, group_extension,
// group_call_permission, group_schedule, group_fallback) :
//  - label obligatoire, ≤ 128, ^[-_.a-zA-Z0-9 ]+$ (pas d'accents : il finit dans queues.conf) ;
//  - ring_strategy : all, random, least_recent, linear, fewest_calls,
//    memorized_round_robin, weight_random ;
//  - timeout (durée totale ; vide ou 0 = sonne indéfiniment), user_timeout
//    (sonnerie par membre, défaut 15), retry_delay (pause, défaut 5), max_calls
//    (0 = illimité ; au-delà : débordement « congestion ») : entiers ≥ 0 ou null ;
//  - music_on_hold : 'default' ou name d'une MOH du tenant ; null = sonnerie ;
//  - caller_id_mode prepend | overwrite | append (+ caller_id_name ≤ 80) ;
//  - preprocess_subroutine ≤ 79 ; enabled, ring_in_use, ignore_forward,
//    mark_answered_elsewhere, dtmf_record_toggle : booléens ;
//  - membres : liste remplacée en entier, ordre = priorité (utilisée en
//    linéaire ; les utilisateurs sonnent avant les numéros) ;
//  - une seule extension, contexte internal, dans les group_ranges ; un seul
//    horaire ; plusieurs autorisations d'appels.
import { $, esc, confirmModal, helpButton, helpBox, fullName } from '../common/core.js?v=0.36.0';
import { M, STRATEGY, listOf } from './model.js?v=0.36.0';
import { pickerHtml, bindPicker, readPicker } from './sched-editor.js?v=0.36.0';

const STRATS = ['all', 'linear', 'random', 'least_recent', 'fewest_calls', 'memorized_round_robin', 'weight_random'];
const STRAT_HELP = {
  all: 'Tous les membres sonnent en même temps ; le premier qui décroche prend l\'appel.',
  linear: 'Un par un, dans l\'ordre de la liste (utilisateurs puis numéros), chacun pendant « sonnerie par membre » ; après le dernier, pause puis nouveau tour.',
  random: 'Un membre à la fois, choisi au hasard.',
  least_recent: 'Un membre à la fois : celui qui a raccroché depuis le plus longtemps d\'abord.',
  fewest_calls: 'Un membre à la fois : celui qui a pris le moins d\'appels de ce groupe d\'abord.',
  memorized_round_robin: 'Un membre à la fois, à tour de rôle, en reprenant après le dernier qui a répondu.',
  weight_random: 'Un membre à la fois, au hasard pondéré (pénalités).',
};
const FIELDS = ['label', 'ring_strategy', 'timeout', 'user_timeout', 'retry_delay', 'max_calls', 'music_on_hold', 'caller_id_mode', 'caller_id_name', 'preprocess_subroutine', 'enabled', 'ring_in_use', 'ignore_forward', 'mark_answered_elsewhere', 'dtmf_record_toggle'];
const BOOL = {
  enabled: ['Groupe activé', 'Désactivé, le groupe n\'existe plus pour Asterisk : les appels qui le visent échouent (vérifié : absent de queues.conf).'],
  ring_in_use: ['Sonnerie en cours', 'Fait sonner un membre même s\'il est déjà en communication.'],
  ignore_forward: ['Ignorer la redirection', 'Ignore les renvois faits par le POSTE du membre (SIP 302). Ne concerne pas les renvois du profil utilisateur, qui ne jouent de toute façon pas dans un groupe.'],
  mark_answered_elsewhere: ['Marquer « répondu ailleurs »', 'Quand un membre décroche, les autres postes affichent « répondu ailleurs » au lieu d\'un appel manqué.'],
  dtmf_record_toggle: ['Enregistrement sur demande', 'Le membre qui a décroché peut démarrer / arrêter l\'enregistrement par une touche.'],
};

// Valeur de réglage d'un groupe (copie locale) : celle que le brouillon compare et écrit.
export function groupCfgOf(g) {
  const f = {}; for (const k of FIELDS) f[k] = g[k] ?? null;
  return {
    fields: f,
    users: [...(g.members?.users || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((m) => ({ uuid: m.uuid })),
    exts: [...(g.members?.extensions || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((m) => ({ exten: m.exten, context: m.context })),
    extension: g.extensions?.[0] ? { exten: g.extensions[0].exten, context: g.extensions[0].context } : null,
    perms: (g.call_permissions || []).map((p) => p.id).sort((a, b) => a - b),
  };
}
// Applique une valeur à la copie locale (le graphe suit le brouillon).
export function applyGroupCfg(g, v) {
  Object.assign(g, v.fields);
  g.members = {
    users: v.users.map((m, i) => { const u = M.userByUuid.get(m.uuid); return { uuid: m.uuid, firstname: u?.firstname, lastname: u?.lastname, priority: i }; }),
    extensions: v.exts.map((m, i) => ({ ...m, priority: i })),
  };
  const old = g.extensions?.[0];
  g.extensions = v.extension ? [{ ...(old && old.exten === v.extension.exten && old.context === v.extension.context ? old : {}), ...v.extension }] : [];
  g.call_permissions = v.perms.map((id) => ({ id, name: M.by.callpermission?.get(String(id))?.name || `#${id}` }));
}

// value pour onSave : { cfg, noanswer, congestion, schedule } (fallbacks et horaire passent par leurs propres entrées de brouillon).
export function openGroupEditor(g, onSave) {
  const v = groupCfgOf(g);
  const f = v.fields;
  let users = [...v.users], exts = [...v.exts];
  const ctxInt = (M.lists.context || []).filter((c) => c.type === 'internal');
  const ctxAll = (M.lists.context || []).filter((c) => c.type !== 'incall');
  const cand = (M.lists.user || []).filter((u) => (u.lines || []).length).sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  const uname = (uuid) => fullName(M.userByUuid.get(uuid)) || uuid;
  const sec = (id, title, help) => `<div class="titlerow cf-ge-t"><h4 class="cf-per-t">${esc(title)}</h4>${help ? helpButton(id, title) : ''}</div>${help ? helpBox(id, help) : ''}`;
  const num = (k, label, help, ph) => `<label title="${esc(help)}">${esc(label)}<input type="number" min="0" step="1" data-f="${k}" value="${esc(f[k] ?? '')}" placeholder="${esc(ph || '')}"><span class="small muted">${esc(help)}</span></label>`;
  const userRows = () => users.map((m, i) => `<li data-u="${i}"><span class="cf-ge-n">${i + 1}</span>${esc(uname(m.uuid))}${M.userByUuid.get(m.uuid)?.services?.dnd?.enabled ? ' <span class="cf-ge-dnd">NPD : ne sonne pas</span>' : ''}<span class="spacer"></span><button class="icon" data-up="u${i}" title="Monter"${i ? '' : ' disabled'}>↑</button><button class="icon" data-down="u${i}" title="Descendre"${i < users.length - 1 ? '' : ' disabled'}>↓</button><button class="icon" data-del="u${i}" title="Retirer">×</button></li>`).join('') || '<li class="muted">Aucun utilisateur</li>';
  const extRows = () => exts.map((m, i) => `<li data-e="${i}"><span class="cf-ge-n">${users.length + i + 1}</span>Numéro ${esc(m.exten)} <span class="small muted">(${esc(M.by.context?.get(m.context)?.label || m.context)})</span><span class="spacer"></span><button class="icon" data-up="e${i}" title="Monter"${i ? '' : ' disabled'}>↑</button><button class="icon" data-down="e${i}" title="Descendre"${i < exts.length - 1 ? '' : ' disabled'}>↓</button><button class="icon" data-del="e${i}" title="Retirer">×</button></li>`).join('') || '<li class="muted">Aucun numéro</li>';
  const live = (M.live?.get(g.name) || []).filter((x) => x.dynamic);
  const sched = (g.schedules || [])[0]?.id;
  const fb = g.fallbacks || {};

  confirmModal(`<div class="cf-group-ed">
    <div class="titlerow"><h3>Groupe « ${esc(g.label || g.name)} »</h3>${helpButton('ge-hb', 'Aide')}</div>${helpBox('ge-hb', 'Toutes les options de l\'API Wazo pour un groupe d\'appel. Les modifications vont dans le brouillon ; « Appliquer… » relit le groupe et n\'écrit que ce qui change (un PUT par partie : réglages, membres, numéro, autorisations).')}
    ${sec('ge-g', 'Général')}
    <div class="cf-ge-grid">
      <label>Nom (label) *<input data-f="label" value="${esc(f.label || '')}" maxlength="128"><span class="small muted">Lettres sans accent, chiffres, espace, - _ . (contrainte Wazo).</span></label>
      <label>Nom technique<input value="${esc(g.name || '')}" disabled><span class="small muted">Généré par Wazo (nom de la file Asterisk).</span></label>
      <label>Numéro interne<span class="cf-ge-row"><input data-ext value="${esc(v.extension?.exten || '')}" placeholder="aucun"><select data-extctx>${ctxInt.map((c) => `<option value="${esc(c.name)}"${(v.extension?.context || ctxInt[0]?.name) === c.name ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('')}</select></span><span class="small muted">Une seule extension, dans un contexte interne et dans sa plage « groupes ».</span></label>
    </div>
    ${sec('ge-p', 'Personnalisation')}
    <div class="cf-ge-grid">
      <label>Stratégie de sonnerie *<select data-f="ring_strategy">${STRATS.map((s) => `<option value="${s}"${f.ring_strategy === s ? ' selected' : ''}>${esc(STRATEGY[s] || s)}</option>`).join('')}</select><span class="small muted" id="ge-strat-h">${esc(STRAT_HELP[f.ring_strategy] || '')}</span></label>
      <label>Musique d'attente<select data-f="music_on_hold"><option value="">— Aucune (tonalité de sonnerie) —</option><option value="default"${f.music_on_hold === 'default' ? ' selected' : ''}>Par défaut</option>${(M.lists.moh || []).filter((m) => m.name !== 'default').map((m) => `<option value="${esc(m.name)}"${f.music_on_hold === m.name ? ' selected' : ''}>${esc(m.label || m.name)}</option>`).join('')}${f.music_on_hold && f.music_on_hold !== 'default' && !(M.lists.moh || []).some((m) => m.name === f.music_on_hold) ? `<option value="${esc(f.music_on_hold)}" selected>${esc(f.music_on_hold)} (actuelle)</option>` : ''}</select><span class="small muted">Ce qu'entend l'appelant pendant que le groupe sonne.</span></label>
      <label>Identification de l'appelant<select data-f="caller_id_mode"><option value="">— Inchangée —</option><option value="prepend"${f.caller_id_mode === 'prepend' ? ' selected' : ''}>Ajouter avant (« texte - appelant »)</option><option value="overwrite"${f.caller_id_mode === 'overwrite' ? ' selected' : ''}>Remplacer par le texte</option><option value="append"${f.caller_id_mode === 'append' ? ' selected' : ''}>Ajouter après (« appelant - texte »)</option></select><span class="small muted">Nom affiché sur les postes des membres.</span></label>
      <label>Texte d'identification<input data-f="caller_id_name" value="${esc(f.caller_id_name || '')}" maxlength="80" placeholder="ex. Compta"></label>
      <label>Sous-routine<input data-f="preprocess_subroutine" value="${esc(f.preprocess_subroutine || '')}" maxlength="79" placeholder="aucune"><span class="small muted">Sous-routine du plan de numérotation Asterisk exécutée avant le groupe.</span></label>
    </div>
    <div class="cf-ge-bools">${Object.entries(BOOL).map(([k, [l, h]]) => `<label class="inline" title="${esc(h)}"><input type="checkbox" data-b="${k}"${f[k] ? ' checked' : ''}> ${esc(l)} <span class="small muted">— ${esc(h)}</span></label>`).join('')}</div>
    ${sec('ge-d', 'Délais', 'Vérifié dans le code Wazo : « sonnerie par membre » = timeout de chaque membre dans la file Asterisk ; « pause » = retry ; « durée totale » = délai de Queue() (ou du Dial en linéaire) avant le débordement « pas de réponse ». Durée totale vide ou 0 : le groupe sonne indéfiniment.')}
    <div class="cf-ge-grid">
      ${num('timeout', 'Durée totale avant débordement (s)', 'Vide ou 0 : sonne indéfiniment.', 'illimitée')}
      ${num('user_timeout', 'Sonnerie par membre (s)', 'Durée de sonnerie de chaque membre.', '15')}
      ${num('retry_delay', 'Pause avant de recommencer (s)', 'Attente entre deux tours.', '5')}
    </div>
    ${sec('ge-m', 'Membres', 'La liste est remplacée en entier à l\'écriture ; l\'ordre sert de priorité (stratégie un par un : les utilisateurs sonnent avant les numéros). Un membre en NPD ne sonne pas et l\'appel n\'est pas renvoyé. Les renvois et le filtrage d\'un utilisateur ne s\'appliquent pas dans un groupe (supposé), sauf s\'il est ajouté comme numéro. Les inscrits par touche de bascule ne se gèrent pas ici : ils n\'existent que dans Asterisk.')}
    <div class="cf-ge-cols">
      <div><div class="small muted">Utilisateurs</div><ul class="cf-ge-list" id="ge-users">${userRows()}</ul>
        <span class="cf-ge-row"><select id="ge-uadd"><option value="">— Ajouter un utilisateur —</option>${cand.map((u) => `<option value="${esc(u.uuid)}">${esc(fullName(u))}</option>`).join('')}</select><button data-add="u">Ajouter</button></span></div>
      <div><div class="small muted">Numéros (internes ou externes)</div><ul class="cf-ge-list" id="ge-exts">${extRows()}</ul>
        <span class="cf-ge-row"><input id="ge-eadd" placeholder="numéro"><select id="ge-ectx">${ctxAll.map((c) => `<option value="${esc(c.name)}">${esc(c.label || c.name)}</option>`).join('')}</select><button data-add="e">Ajouter</button></span></div>
    </div>
    ${live.length ? `<p class="small muted">Inscrits par touche en ce moment (non modifiables ici) : ${esc(live.map((x) => x.name).join(', '))}</p>` : ''}
    ${sec('ge-f', 'Débordements')}
    <div class="cf-ge-fb">
      <div>Pas de réponse → ${pickerHtml('ge-noans', fb.noanswer_destination)}</div>
      <label class="cf-ge-inl">Appels maximum<input type="number" min="0" step="1" data-f="max_calls" value="${esc(f.max_calls ?? 0)}"><span class="small muted">0 = illimité ; au-delà, débordement « encombré ».</span></label>
      <div>Encombré (trop d'appels) → ${pickerHtml('ge-cong', fb.congestion_destination)}</div>
    </div>
    ${sec('ge-s', 'Plage horaire')}
    <label>Horaire<select id="ge-sched"><option value="">— Aucun horaire —</option>${listOf('schedule').map((x) => `<option value="${esc(x.key.slice(9))}"${String(sched) === x.key.slice(9) ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select><span class="small muted">Un seul horaire par groupe.</span></label>
    ${sec('ge-a', 'Autorisations d\'appels')}
    <div class="cf-ge-perms">${(M.lists.callpermission || []).map((p) => `<label class="inline"><input type="checkbox" data-perm="${p.id}"${v.perms.includes(p.id) ? ' checked' : ''}> ${esc(p.name)}${p.mode ? ` <span class="small muted">(${esc(p.mode === 'deny' ? 'refus' : 'autorisation')})</span>` : ''}</label>`).join('') || '<span class="small muted">Aucune autorisation d\'appel définie (ou liste non lisible).</span>'}</div>
    <p id="ge-err" class="error small"></p></div>`, () => {
    const err = (m) => { $('ge-err').textContent = m; return false; };
    const box = $('modal-body');
    const nf = { ...f };
    nf.label = box.querySelector('[data-f="label"]').value.trim();
    if (!nf.label || nf.label.length > 128 || !/^[-_.a-zA-Z0-9 ]+$/.test(nf.label)) return err('Nom : obligatoire, sans accents (lettres, chiffres, espace, - _ .).');
    nf.ring_strategy = box.querySelector('[data-f="ring_strategy"]').value;
    for (const k of ['timeout', 'user_timeout', 'retry_delay', 'max_calls']) {
      const s = box.querySelector(`[data-f="${k}"]`).value.trim();
      if (s === '') nf[k] = k === 'max_calls' ? 0 : null; else if (!/^\d+$/.test(s)) return err('Durées et appels maximum : nombres entiers positifs.'); else nf[k] = Number(s);
    }
    nf.music_on_hold = box.querySelector('[data-f="music_on_hold"]').value || null;
    nf.caller_id_mode = box.querySelector('[data-f="caller_id_mode"]').value || null;
    nf.caller_id_name = box.querySelector('[data-f="caller_id_name"]').value.trim() || null;
    nf.preprocess_subroutine = box.querySelector('[data-f="preprocess_subroutine"]').value.trim() || null;
    for (const k of Object.keys(BOOL)) nf[k] = box.querySelector(`[data-b="${k}"]`).checked;
    const ex = box.querySelector('[data-ext]').value.trim();
    let extension = null;
    if (ex) {
      const ctx = box.querySelector('[data-extctx]').value;
      if (!/^[*#0-9]{1,40}$/.test(ex)) return err('Numéro interne : chiffres, * et # seulement.');
      const c = M.by.context?.get(ctx);
      const inRange = (c?.group_ranges || []).some((r) => ex.length === String(r.start).length && ex >= String(r.start) && ex <= String(r.end));
      if (c?.group_ranges && !inRange) return err(`Numéro interne ${ex} : hors des plages « groupes » du contexte ${c.label || c.name} (${(c.group_ranges || []).map((r) => `${r.start}-${r.end}`).join(', ') || 'aucune'}).`);
      extension = { exten: ex, context: ctx };
    }
    let noanswer, congestion;
    try { noanswer = readPicker('ge-noans'); congestion = readPicker('ge-cong'); } catch (e) { return err(e.message); }
    const perms = [...box.querySelectorAll('[data-perm]:checked')].map((c) => Number(c.dataset.perm)).sort((a, b) => a - b);
    const s = $('ge-sched').value;
    onSave({ cfg: { fields: nf, users, exts, extension, perms }, noanswer, congestion, schedule: s ? Number(s) : null });
    return true;
  }, 'Ajouter au brouillon');

  ['ge-noans', 'ge-cong'].forEach(bindPicker);
  const box = $('modal-body');
  const redraw = () => { $('ge-users').innerHTML = userRows(); $('ge-exts').innerHTML = extRows(); };
  box.onchange = (e) => { if (e.target.matches('[data-f="ring_strategy"]')) $('ge-strat-h').textContent = STRAT_HELP[e.target.value] || ''; };
  box.onclick = (e) => {
    const b = e.target.closest('[data-up],[data-down],[data-del],[data-add]'); if (!b) return;
    const ref = b.dataset.up || b.dataset.down || b.dataset.del;
    if (ref) {
      const list = ref[0] === 'u' ? users : exts; const i = Number(ref.slice(1));
      if (b.dataset.up && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      if (b.dataset.down && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      if (b.dataset.del) list.splice(i, 1);
      redraw(); return;
    }
    if (b.dataset.add === 'u') { const uu = $('ge-uadd').value; if (uu && !users.some((m) => m.uuid === uu)) { users.push({ uuid: uu }); redraw(); } }
    if (b.dataset.add === 'e') { const x = $('ge-eadd').value.trim(); const c = $('ge-ectx').value; if (/^[*#0-9]+$/.test(x) && !exts.some((m) => m.exten === x && m.context === c)) { exts.push({ exten: x, context: c }); $('ge-eadd').value = ''; redraw(); } }
  };
}

// Libellé court des différences (brouillon, aperçu).
export function groupCfgDiff(a, b) {
  if (!a || !b) return '';
  const L = { label: 'nom', ring_strategy: 'stratégie', timeout: 'durée totale', user_timeout: 'sonnerie par membre', retry_delay: 'pause', max_calls: 'appels max', music_on_hold: 'musique', caller_id_mode: 'identification', caller_id_name: 'texte d\'identification', preprocess_subroutine: 'sous-routine', enabled: 'activé', ring_in_use: 'sonnerie en cours', ignore_forward: 'ignorer la redirection', mark_answered_elsewhere: 'répondu ailleurs', dtmf_record_toggle: 'enregistrement' };
  const out = FIELDS.filter((k) => JSON.stringify(a.fields[k] ?? null) !== JSON.stringify(b.fields[k] ?? null)).map((k) => L[k]);
  if (JSON.stringify(a.users) !== JSON.stringify(b.users) || JSON.stringify(a.exts) !== JSON.stringify(b.exts)) out.push('membres');
  if (JSON.stringify(a.extension) !== JSON.stringify(b.extension)) out.push('numéro interne');
  if (JSON.stringify(a.perms) !== JSON.stringify(b.perms)) out.push('autorisations d\'appels');
  return out.join(', ');
}
export const GROUP_FIELDS = FIELDS;
