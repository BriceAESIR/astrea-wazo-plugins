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
import { $, esc, confirmModal, helpButton, helpBox, fullName } from '../common/core.js?v=0.40.13';
import { M, STRATEGY, listOf, linearRound } from './model.js?v=0.40.13';
import { pickerHtml, bindPicker, readPicker } from './sched-editor.js?v=0.40.13';
import { sec, field } from './ed-ui.js?v=0.40.13';
import { bindNewSchedule, schedValue } from './create.js?v=0.40.13';
import { numberFieldHtml, bindNumberField, checkNumber } from './numbers.js?v=0.40.13';

const STRATS = ['all', 'linear', 'random', 'least_recent', 'fewest_calls', 'memorized_round_robin', 'weight_random'];
const STRAT_HELP = {
  all: 'Tous les membres sonnent en même temps ; le premier qui décroche prend l\'appel.',
  linear: 'Un par un, dans l\'ordre de la liste (utilisateurs puis numéros) : chaque membre sonne pendant « sonnerie par membre », puis la pause de réessai, puis le suivant ; après le dernier, nouveau tour. Membres en NPD sautés.',
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
// Présentation (retour de Brice 15/10/2026 : « trop condensé ») : sections
// dépliables, une colonne aérée, un résumé de chaque section dans son titre,
// mis à jour pendant la saisie ; nom technique en petit dans l'en-tête.
export function openGroupEditor(g, onSave) {
  const v = groupCfgOf(g);
  const f = v.fields;
  let users = [...v.users], exts = [...v.exts];
  const ctxInt = (M.lists.context || []).filter((c) => c.type === 'internal');
  const ctxAll = (M.lists.context || []).filter((c) => c.type !== 'incall');
  const cand = (M.lists.user || []).filter((u) => (u.lines || []).length).sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  const uname = (uuid) => fullName(M.userByUuid.get(uuid)) || uuid;
  const isDnd = (uuid) => !!M.userByUuid.get(uuid)?.services?.dnd?.enabled;
  const ctxName = (n) => M.by.context?.get(n)?.label || n;
  const num = (k, label, help, ph) => field(label, `<input type="number" min="0" step="1" data-f="${k}" value="${esc(f[k] ?? '')}" placeholder="${esc(ph || '')}">`, help);
  const bool = (k) => `<label class="cf-ge-b"><input type="checkbox" data-b="${k}"${f[k] ? ' checked' : ''}><span><strong>${esc(BOOL[k][0])}</strong><span class="small muted">${esc(BOOL[k][1])}</span></span></label>`;
  const moves = (p, i, n) => `<button class="icon" data-up="${p}${i}" title="Monter"${i ? '' : ' disabled'}>↑</button><button class="icon" data-down="${p}${i}" title="Descendre"${i < n - 1 ? '' : ' disabled'}>↓</button><button class="icon" data-del="${p}${i}" title="Retirer du groupe">×</button>`;
  const userRows = () => users.map((m, i) => `<li><span class="cf-ge-n">${i + 1}</span><span>${esc(uname(m.uuid))}</span>${isDnd(m.uuid) ? '<span class="cf-ge-dnd">NPD : ne sonne pas</span>' : ''}<span class="spacer"></span>${moves('u', i, users.length)}</li>`).join('') || '<li class="muted">Aucun utilisateur</li>';
  const extRows = () => exts.map((m, i) => `<li><span class="cf-ge-n">${users.length + i + 1}</span><span>${esc(m.exten)} <span class="small muted">composé depuis ${esc(ctxName(m.context))}</span></span><span class="spacer"></span>${moves('e', i, exts.length)}</li>`).join('');
  // Liste d'ajout : seulement les utilisateurs pas encore membres.
  const addOpts = () => `<option value="">Choisir un utilisateur à ajouter…</option>${cand.filter((u) => !users.some((m) => m.uuid === u.uuid)).map((u) => `<option value="${esc(u.uuid)}">${esc(fullName(u))}</option>`).join('')}`;
  const live = (M.live?.get(g.name) || []).filter((x) => x.dynamic);
  const sched = (g.schedules || [])[0]?.id;
  const fb = g.fallbacks || {};
  const ctxOpts = (list, cur) => list.map((c) => `<option value="${esc(c.name)}"${cur === c.name ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('');
  const mohOpts = `<option value="">Aucune : l'appelant entend la sonnerie</option><option value="default"${f.music_on_hold === 'default' ? ' selected' : ''}>Par défaut</option>${(M.lists.moh || []).filter((m) => m.name !== 'default').map((m) => `<option value="${esc(m.name)}"${f.music_on_hold === m.name ? ' selected' : ''}>${esc(m.label || m.name)}</option>`).join('')}${f.music_on_hold && f.music_on_hold !== 'default' && !(M.lists.moh || []).some((m) => m.name === f.music_on_hold) ? `<option value="${esc(f.music_on_hold)}" selected>${esc(f.music_on_hold)} (actuelle)</option>` : ''}`;
  const cidOpts = [['', 'Inchangé : nom de l\'appelant seul'], ['prepend', 'Texte, puis nom de l\'appelant'], ['overwrite', 'Texte seul, à la place du nom'], ['append', 'Nom de l\'appelant, puis texte']].map(([k, l]) => `<option value="${k}"${(f.caller_id_mode || '') === k ? ' selected' : ''}>${esc(l)}</option>`).join('');

  confirmModal(`<div class="cf-ed cf-group-ed">
    <div class="cf-ge-head"><div><h3>Groupe « ${esc(g.label || g.name)} »</h3><div class="small muted" title="Nom technique, généré par Wazo (nom de la file Asterisk)">${esc(g.name || '')}</div></div>${helpButton('ge-hb', 'Aide')}</div>${helpBox('ge-hb', 'Toutes les options de l\'API Wazo pour un groupe d\'appel, rangées par thème. Cliquez sur un titre pour déplier la section ; le résumé à droite reflète la saisie. Les modifications vont dans le brouillon ; « Appliquer… » relit le groupe et n\'écrit que ce qui change.')}
    ${sec('gen', 'Général', `
      ${field('Nom *', `<input data-f="label" value="${esc(f.label || '')}" maxlength="128">`, 'Lettres sans accent, chiffres, espace, - _ . (contrainte Wazo).')}
      ${numberFieldHtml('group', { exten: v.extension?.exten || '', ctx: v.extension?.context || ctxInt[0]?.name, ctxList: ctxInt, field })}
      ${bool('enabled')}`, { open: true })}
    ${sec('ring', 'Sonnerie', `
      ${field('Stratégie *', `<select data-f="ring_strategy">${STRATS.map((s) => `<option value="${s}"${f.ring_strategy === s ? ' selected' : ''}>${esc(STRATEGY[s] || s)}</option>`).join('')}</select>`)}
      <p class="small muted cf-ge-note" id="ge-strat-h">${esc(STRAT_HELP[f.ring_strategy] || '')}</p>
      <div class="cf-ge-3">
        ${num('timeout', 'Durée totale (s)', 'Avant le débordement « pas de réponse ». Vide ou 0 : sonne indéfiniment.', 'illimitée')}
        ${num('user_timeout', 'Sonnerie par membre (s)', 'Combien de temps chaque membre sonne.', '15')}
        ${num('retry_delay', 'Pause de réessai (s)', 'Attente après une sonnerie sans réponse : après chaque membre en « un par un ».', '5')}
      </div>
      <div id="ge-tour" class="cf-ge-tour" hidden></div>
      ${bool('ring_in_use')}`, { help: 'Vérifié dans le code Wazo : « sonnerie par membre » = timeout de chaque membre ; « pause » = retry ; « durée totale » = délai de Queue() (ou du Dial en « un par un ») avant le débordement « pas de réponse ». En « un par un » (dialplan group-linear), la pause a lieu après CHAQUE membre : un tour complet = nombre de membres × (sonnerie + pause). Pour les autres stratégies (file Asterisk), la pause sépare deux tentatives (supposé, non vérifié dans Asterisk).' })}
    ${sec('mem', 'Membres', `
      <div class="cf-ge-l">Utilisateurs</div>
      <ul class="cf-ge-list" id="ge-users">${userRows()}</ul>
      <div class="cf-ge-row"><select id="ge-uadd">${addOpts()}</select><button data-add="u">Ajouter</button></div>
      ${live.length ? `<p class="small muted">Inscrits par touche en ce moment (gérés par leur touche, pas ici) : ${esc(live.map((x) => x.name).join(', '))}</p>` : ''}
      <label class="cf-ge-b cf-ge-gap"><input type="checkbox" id="ge-exton"${exts.length ? ' checked' : ''}><span><strong>Faire sonner aussi des numéros</strong><span class="small muted">Portable, poste d'un autre site… Option peu utilisée.</span></span></label>
      <div id="ge-extbox" class="cf-ge-sub"${exts.length ? '' : ' hidden'}>
      <p class="small muted">Pour un numéro qui n'est pas un utilisateur Wazo du groupe : un portable, un poste d'un autre site… Le numéro est composé comme si on l'appelait depuis le contexte choisi (il doit donc permettre de sortir vers l'extérieur pour un numéro externe).</p>
      <ul class="cf-ge-list" id="ge-exts"${exts.length ? '' : ' hidden'}>${extRows()}</ul>
      <div class="cf-ge-row"><input id="ge-eadd" placeholder="ex. 0612345678"><select id="ge-ectx" title="Contexte depuis lequel le numéro est composé">${ctxOpts(ctxAll, ctxInt[0]?.name)}</select><button data-add="e">Ajouter</button></div></div>
      <p class="warn small" id="ge-extwarn" hidden><span>Case décochée : les numéros du groupe seront retirés à l'enregistrement.</span></p>`, { open: true, help: 'La liste est remplacée en entier à l\'écriture ; l\'ordre sert de priorité (stratégie « un par un » : les utilisateurs sonnent avant les numéros). Un membre en NPD ne sonne pas et l\'appel n\'est pas renvoyé. Les renvois et le filtrage d\'un utilisateur ne s\'appliquent pas dans un groupe (supposé), sauf s\'il est ajouté comme numéro.' })}
    ${sec('fb', 'Débordements', `
      <div class="cf-ge-f"><span class="cf-ge-l">Si personne ne répond</span>${pickerHtml('ge-noans', fb.noanswer_destination)}</div>
      ${num('max_calls', 'Appels simultanés maximum', '0 = illimité. Au-delà, les appels suivants partent vers « Si trop d\'appels ».', '0')}
      <div class="cf-ge-f"><span class="cf-ge-l">Si trop d'appels</span>${pickerHtml('ge-cong', fb.congestion_destination)}</div>`)}
    ${sec('opt', 'Appelant et options', `
      ${field('Musique d\'attente', `<select data-f="music_on_hold">${mohOpts}</select>`, 'Ce qu\'entend l\'appelant pendant que le groupe sonne.')}
      <div class="cf-ge-2">
        ${field('Nom affiché aux membres', `<select data-f="caller_id_mode">${cidOpts}</select>`)}
        <span id="ge-cidtxt"${f.caller_id_mode ? '' : ' hidden'}>${field('Texte', `<input data-f="caller_id_name" value="${esc(f.caller_id_name || '')}" maxlength="80" placeholder="ex. Compta">`, 'Pour savoir que l\'appel vient du groupe.')}</span>
      </div>
      ${bool('mark_answered_elsewhere')}${bool('dtmf_record_toggle')}${bool('ignore_forward')}`)}
    ${sec('sch', 'Horaire', field('Horaire du groupe', `<select id="ge-sched"><option value="">Aucun : toujours ouvert</option>${listOf('schedule').map((x) => `<option value="${esc(x.key.slice(9))}"${String(sched) === x.key.slice(9) ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select>`, 'Un seul horaire par groupe.'))}
    ${sec('perm', 'Autorisations d\'appels', `<div class="cf-ge-perms">${(M.lists.callpermission || []).map((p) => `<label class="inline"><input type="checkbox" data-perm="${p.id}"${v.perms.includes(p.id) ? ' checked' : ''}> ${esc(p.name)}${p.mode ? ` <span class="small muted">(${esc(p.mode === 'deny' ? 'refus' : 'autorisation')})</span>` : ''}</label>`).join('') || '<span class="small muted">Aucune autorisation d\'appel définie (ou liste non lisible).</span>'}</div>`)}
    ${sec('adv', 'Avancé', field('Sous-routine', `<input data-f="preprocess_subroutine" value="${esc(f.preprocess_subroutine || '')}" maxlength="79" placeholder="aucune">`, 'Sous-routine du plan de numérotation Asterisk exécutée avant le groupe.'))}
    <p id="ge-err" class="error small"></p></div>`, () => {
    const err = (m) => { $('ge-err').textContent = m; return false; };
    const box = $('modal-body');
    const open = (id) => { const d = box.querySelector(`[data-sec="${id}"]`); if (d) d.open = true; };
    const nf = { ...f };
    nf.label = box.querySelector('[data-f="label"]').value.trim();
    if (!nf.label || nf.label.length > 128 || !/^[-_.a-zA-Z0-9 ]+$/.test(nf.label)) { open('gen'); return err('Nom : obligatoire, sans accents (lettres, chiffres, espace, - _ .).'); }
    nf.ring_strategy = box.querySelector('[data-f="ring_strategy"]').value;
    for (const k of ['timeout', 'user_timeout', 'retry_delay', 'max_calls']) {
      const s = box.querySelector(`[data-f="${k}"]`).value.trim();
      if (s === '') nf[k] = k === 'max_calls' ? 0 : null; else if (!/^\d+$/.test(s)) { open(k === 'max_calls' ? 'fb' : 'ring'); return err('Durées et appels maximum : nombres entiers positifs.'); } else nf[k] = Number(s);
    }
    nf.music_on_hold = box.querySelector('[data-f="music_on_hold"]').value || null;
    nf.caller_id_mode = box.querySelector('[data-f="caller_id_mode"]').value || null;
    nf.caller_id_name = nf.caller_id_mode ? box.querySelector('[data-f="caller_id_name"]').value.trim() || null : null;
    if (nf.caller_id_mode && !nf.caller_id_name) { open('opt'); return err('Nom affiché aux membres : saisissez le texte, ou choisissez « Inchangé ».'); }
    nf.preprocess_subroutine = box.querySelector('[data-f="preprocess_subroutine"]').value.trim() || null;
    for (const k of Object.keys(BOOL)) nf[k] = box.querySelector(`[data-b="${k}"]`).checked;
    const ex = box.querySelector('[data-ext]').value.trim();
    let extension = null;
    if (ex) {
      const ctx = box.querySelector('[data-extctx]').value;
      const bad = checkNumber(ctx, 'group', ex, ctx === g.extensions?.[0]?.context ? g.extensions?.[0]?.exten : '');
      if (bad) { open('gen'); return err(bad); }
      extension = { exten: ex, context: ctx };
    }
    let noanswer, congestion;
    try { noanswer = readPicker('ge-noans'); congestion = readPicker('ge-cong'); } catch (e) { open('fb'); return err(e.message); }
    const perms = [...box.querySelectorAll('[data-perm]:checked')].map((c) => Number(c.dataset.perm)).sort((a, b) => a - b);
    const s = schedValue($('ge-sched'));
    onSave({ cfg: { fields: nf, users, exts: $('ge-exton').checked ? exts : [], extension, perms }, noanswer, congestion, schedule: s ? Number(s) : null });
    return true;
  }, 'Ajouter au brouillon');

  ['ge-noans', 'ge-cong'].forEach(bindPicker);
  const box = $('modal-body');
  bindNumberField(box, 'group', { own: g.extensions?.[0]?.exten || '' });
  bindNewSchedule($('ge-sched'));
  const val = (sel) => box.querySelector(sel)?.value?.trim() || '';
  const on = (sel) => !!box.querySelector(sel)?.checked;
  const pick = (id) => { const el = $(id); const t = el?.querySelector('[data-dt]'); if (!t || t.value === 'none') return 'rien'; const o = el.querySelector('[data-do]'); const x = o?.selectedOptions?.[0]?.text; return `${t.selectedOptions[0].text.toLowerCase()}${x && o.value ? ` ${x}` : ''}`; };
  // Résumés des sections (titres), relus dans le formulaire.
  const recap = () => {
    const dnd = users.filter((m) => isDnd(m.uuid)).length;
    const S = {
      gen: [val('[data-f="label"]') || '(sans nom)', val('[data-ext]') ? `n° ${val('[data-ext]')}` : 'sans numéro', on('[data-b="enabled"]') ? '' : 'DÉSACTIVÉ'],
      ring: [STRATEGY[val('[data-f="ring_strategy"]')], Number(val('[data-f="timeout"]')) ? `${val('[data-f="timeout"]')} s au total` : 'sans limite', `${val('[data-f="user_timeout"]') || 15} s par membre`],
      mem: [`${users.length} utilisateur${users.length > 1 ? 's' : ''}`, exts.length && $('ge-exton')?.checked ? `${exts.length} numéro${exts.length > 1 ? 's' : ''}` : '', dnd ? `${dnd} en NPD` : ''],
      fb: [`sans réponse : ${pick('ge-noans')}`, Number(val('[data-f="max_calls"]')) ? `max ${val('[data-f="max_calls"]')} appels` : ''],
      opt: [box.querySelector('[data-f="music_on_hold"]')?.selectedOptions[0]?.value ? `musique ${box.querySelector('[data-f="music_on_hold"]').selectedOptions[0].text}` : 'sonnerie', val('[data-f="caller_id_mode"]') ? `nom « ${val('[data-f="caller_id_name"]')} »` : ''],
      sch: [schedValue($('ge-sched')) ? $('ge-sched').selectedOptions[0].text : 'aucun'],
      perm: [((c) => (c ? `${c} autorisation${c > 1 ? 's' : ''}` : 'aucune'))(box.querySelectorAll('[data-perm]:checked').length)],
      adv: [val('[data-f="preprocess_subroutine"]') || ''],
    };
    for (const [k, a] of Object.entries(S)) { const el = box.querySelector(`[data-sum="${k}"]`); if (el) el.textContent = a.filter(Boolean).join(' · '); }
    tourBox(dnd);
  };
  // « Un par un » : durée d'un tour complet, proposée comme durée totale
  // (demande de Brice). Vérifié : pause après chaque membre ; NPD sautés.
  const tourBox = (dnd) => {
    const el = $('ge-tour'); if (!el) return;
    const n = users.length + ($('ge-exton')?.checked ? exts.length : 0);
    if (val('[data-f="ring_strategy"]') !== 'linear' || !n) { el.hidden = true; return; }
    const ut = Number(val('[data-f="user_timeout"]') || 15), rd = Number(val('[data-f="retry_delay"]') || 0), step = ut + rd;
    const tour = linearRound(n, ut, rd), cur = Number(val('[data-f="timeout"]') || 0);
    const reached = cur ? Math.min(n, Math.ceil(cur / step)) : n;
    const now = cur === tour ? '<strong>réglée sur un tour complet.</strong>'
      : !cur ? 'actuellement illimitée : les tours se répètent sans fin.'
      : cur < tour ? `actuellement ${cur} s : seul${reached > 1 ? 's' : ''} le${reached > 1 ? 's' : ''} ${reached} premier${reached > 1 ? 's' : ''} membre${reached > 1 ? 's' : ''} sur ${n} sonne${reached > 1 ? 'nt' : ''}${cur % step && cur % step < ut ? ` (le dernier pendant ${cur % step} s seulement)` : ''}.`
      : `actuellement ${cur} s ≈ ${(Math.round((cur / tour) * 10) / 10).toLocaleString('fr')} tours.`;
    el.innerHTML = `<div><strong>Un tour complet : ${n} membre${n > 1 ? 's' : ''} × (${ut} s + ${rd} s de pause) = ${tour} s</strong>
      <span class="small muted">Durée totale ${now}${dnd ? ` ${dnd} membre${dnd > 1 ? 's' : ''} en NPD en ce moment : sauté${dnd > 1 ? 's' : ''}, le tour dure alors ${linearRound(n - dnd, ut, rd)} s.` : ''}</span></div>
      ${cur === tour ? '' : `<button type="button" data-usetour="${tour}">Utiliser ${tour} s</button>`}`;
    el.hidden = false;
  };
  const redraw = () => { $('ge-users').innerHTML = userRows(); $('ge-uadd').innerHTML = addOpts(); $('ge-exts').innerHTML = extRows(); $('ge-exts').hidden = !exts.length; recap(); };
  box.addEventListener('input', recap);
  box.addEventListener('change', (e) => {
    if (e.target.matches('[data-f="ring_strategy"]')) $('ge-strat-h').textContent = STRAT_HELP[e.target.value] || '';
    if (e.target.matches('[data-f="caller_id_mode"]')) $('ge-cidtxt').hidden = !e.target.value;
    if (e.target.id === 'ge-exton') { $('ge-extbox').hidden = !e.target.checked; $('ge-extwarn').hidden = e.target.checked || !exts.length; } recap(); });
  box.onclick = (e) => {
    const t = e.target.closest('[data-usetour]');
    if (t) { box.querySelector('[data-f="timeout"]').value = t.dataset.usetour; recap(); return; }
    const b = e.target.closest('[data-up],[data-down],[data-del],[data-add]'); if (!b) return;
    const ref = b.dataset.up || b.dataset.down || b.dataset.del;
    if (ref) {
      const list = ref[0] === 'u' ? users : exts; const i = Number(ref.slice(1));
      if (b.dataset.up && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      if (b.dataset.down && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      if (b.dataset.del) list.splice(i, 1);
      redraw(); return;
    }
    if (b.dataset.add === 'u') { const uu = $('ge-uadd').value; if (uu && !users.some((m) => m.uuid === uu)) { users.push({ uuid: uu }); $('ge-uadd').value = ''; redraw(); } }
    if (b.dataset.add === 'e') { const x = $('ge-eadd').value.trim(); const c = $('ge-ectx').value; if (/^[*#0-9]+$/.test(x) && !exts.some((m) => m.exten === x && m.context === c)) { exts.push({ exten: x, context: c }); $('ge-eadd').value = ''; redraw(); } }
  };
  recap();
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
