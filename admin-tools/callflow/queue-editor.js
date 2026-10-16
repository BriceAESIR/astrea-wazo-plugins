// Call Flow Manager — réglage complet d'une file d'attente (demande de Brice,
// 16/10/2026 : « la même chose » que pour les groupes), selon la norme
// d'édition du module (ed-ui.js). Sans écriture : renvoie une valeur au
// brouillon (onSave), écrite ensuite par write.js.
// Vérifié dans wazo-confd master (queue/schema.py, queue_member, queue_extension,
// queue_fallback) et xivo-dao (alchemy/queue.py, helpers/asterisk.py) :
//  - champs Wazo : label, enabled, timeout (durée totale de Queue()),
//    music_on_hold, caller_id_mode/name, preprocess_subroutine, booléens
//    (ignore_forward, mark_answered_elsewhere, retry_on_timeout, ring_on_hold,
//    announce_hold_time_on_entry, data_quality, dtmf_*), seuils d'attente ;
//    le nom technique n'est pas modifiable (PUT) ;
//  - options Asterisk (`options`, liste de paires [clé, valeur]) : stratégie,
//    sonnerie par agent (timeout), pause (retry), wrapuptime, maxlen… Le PUT
//    REMPLACE toute la liste (les clés absentes reviennent au défaut) : on
//    renvoie donc toutes les options ;
//  - membres : PUT/DELETE un par un (/members/users/{uuid} {priority},
//    /members/agents/{id} {penalty, priority}). Un PUT sur un membre déjà
//    présent sort sans notifier Asterisk : pour changer priorité ou pénalité,
//    write.js retire puis rajoute le membre ;
//  - une seule extension, contexte internal, dans les queue_ranges.
import { $, esc, confirmModal, helpButton, helpBox, fullName } from '../common/core.js?v=0.37.0';
import { M, listOf, QSTRAT } from './model.js?v=0.37.0';
import { pickerHtml, bindPicker, readPicker, fillSoundSelect } from './sched-editor.js?v=0.37.0';
import { sec, field, setSums, openSec } from './ed-ui.js?v=0.37.0';

const QSTRAT_HELP = {
  ringall: 'Tous les agents disponibles sonnent ensemble ; le premier qui décroche prend l\'appel.',
  linear: 'Un agent à la fois, dans l\'ordre de la liste.',
  rrordered: 'Un agent à la fois, à tour de rôle, en reprenant après le dernier appelé, dans l\'ordre de la liste.',
  rrmemory: 'Un agent à la fois, à tour de rôle, en reprenant après le dernier appelé.',
  leastrecent: 'Un agent à la fois : celui qui a raccroché depuis le plus longtemps d\'abord.',
  fewestcalls: 'Un agent à la fois : celui qui a pris le moins d\'appels de cette file d\'abord.',
  random: 'Un agent à la fois, au hasard.',
  wrandom: 'Un agent à la fois, au hasard, pondéré par la pénalité.',
};
export const QUEUE_FIELDS = ['label', 'enabled', 'timeout', 'music_on_hold', 'caller_id_mode', 'caller_id_name', 'preprocess_subroutine', 'ignore_forward', 'mark_answered_elsewhere',
  'retry_on_timeout', 'ring_on_hold', 'announce_hold_time_on_entry', 'data_quality', 'dtmf_hangup_callee_enabled', 'dtmf_hangup_caller_enabled', 'dtmf_transfer_callee_enabled',
  'dtmf_transfer_caller_enabled', 'dtmf_record_callee_enabled', 'dtmf_record_caller_enabled', 'dtmf_record_toggle', 'wait_time_threshold', 'wait_ratio_threshold'];
const BOOL = {
  enabled: ['File activée', 'Désactivée, les appels qui la visent échouent (supposé, comme pour un groupe).'],
  retry_on_timeout: ['Continuer après un tour sans réponse', 'Décoché : l\'appelant quitte la file dès que la sonnerie des agents arrive à son terme (option n de Queue(), supposé), vers « pas de réponse ».'],
  ring_on_hold: ['Sonnerie au lieu de la musique', 'L\'appelant entend la tonalité de sonnerie pendant l\'attente (supposé : option r de Queue()).'],
  announce_hold_time_on_entry: ['Annoncer le temps d\'attente à l\'entrée', 'L\'appelant entend une estimation de son attente en entrant dans la file.'],
  mark_answered_elsewhere: ['Marquer « répondu ailleurs »', 'Quand un agent décroche, les autres postes affichent « répondu ailleurs » au lieu d\'un appel manqué.'],
  ignore_forward: ['Ignorer la redirection', 'Ignore les renvois faits par le POSTE de l\'agent (SIP 302).'],
  data_quality: ['Appel de données', 'Réduit les traitements audio (fax, modem). Rarement utile.'],
  dtmf_hangup_callee_enabled: ['L\'agent peut raccrocher par touche', ''],
  dtmf_hangup_caller_enabled: ['L\'appelant peut raccrocher par touche', ''],
  dtmf_transfer_callee_enabled: ['L\'agent peut transférer par touche', ''],
  dtmf_transfer_caller_enabled: ['L\'appelant peut transférer par touche', ''],
  dtmf_record_callee_enabled: ['L\'agent peut enregistrer par touche', ''],
  dtmf_record_caller_enabled: ['L\'appelant peut enregistrer par touche', ''],
  dtmf_record_toggle: ['Enregistrement sur demande', 'Démarrer / arrêter l\'enregistrement par une touche.'],
};
// Options Asterisk présentées par un champ ; les autres restent dans « Autres options Asterisk ».
const OPT_KNOWN = ['strategy', 'timeout', 'retry', 'wrapuptime', 'maxlen', 'weight', 'ringinuse', 'autopause', 'joinempty', 'leavewhenempty', 'announce-frequency',
  'announce-holdtime', 'announce-position', 'periodic-announce', 'periodic-announce-frequency', 'servicelevel', 'timeoutrestart', 'memberdelay'];

// Valeur de réglage d'une file (copie locale) : celle que le brouillon compare et écrit.
export function queueCfgOf(q) {
  const f = {}; for (const k of QUEUE_FIELDS) f[k] = q[k] ?? null;
  const opts = {}; for (const [k, val] of q.options || []) opts[k] = String(val ?? '');
  return {
    fields: f, opts,
    users: [...(q.members?.users || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((m) => ({ uuid: m.uuid })),
    agents: [...(q.members?.agents || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((m) => ({ id: m.id, penalty: m.penalty ?? 0 })),
    extension: q.extensions?.[0] ? { exten: q.extensions[0].exten, context: q.extensions[0].context } : null,
  };
}
// Liste d'options pour confd (valeurs vides retirées).
export const optionsList = (opts) => Object.entries(opts || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]);
export function applyQueueCfg(q, v) {
  Object.assign(q, v.fields);
  q.options = optionsList(v.opts);
  q.members = {
    users: v.users.map((m, i) => { const u = M.userByUuid.get(m.uuid); return { uuid: m.uuid, firstname: u?.firstname, lastname: u?.lastname, priority: i }; }),
    agents: v.agents.map((m, i) => { const a = M.by.agent?.get(String(m.id)); return { id: m.id, number: a?.number, firstname: a?.firstname, lastname: a?.lastname, penalty: m.penalty, priority: i }; }),
  };
  const old = q.extensions?.[0];
  q.extensions = v.extension ? [{ ...(old && old.exten === v.extension.exten && old.context === v.extension.context ? old : {}), ...v.extension }] : [];
}
export const agentName = (a) => (a ? [fullName(a), a.number ? `agent ${a.number}` : ''].filter(Boolean).join(' · ') || `agent #${a.id}` : '');

// onSave({ cfg, fb: { noanswer, busy, congestion, fail }, wait: { time, ratio }, schedule })
export function openQueueEditor(q, onSave) {
  const v = queueCfgOf(q); const f = v.fields; const o = { ...v.opts };
  let users = [...v.users], agents = v.agents.map((a) => ({ ...a }));
  const ctxInt = (M.lists.context || []).filter((c) => c.type === 'internal');
  const candU = (M.lists.user || []).filter((u) => (u.lines || []).length).sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  const candA = [...(M.lists.agent || [])].sort((a, b) => agentName(a).localeCompare(agentName(b), 'fr'));
  const uname = (uuid) => fullName(M.userByUuid.get(uuid)) || uuid;
  const isDnd = (uuid) => !!M.userByUuid.get(uuid)?.services?.dnd?.enabled;
  const num = (k, label, help, ph) => field(label, `<input type="number" min="0" step="1" data-f="${k}" value="${esc(f[k] ?? '')}" placeholder="${esc(ph || '')}">`, help);
  const onum = (k, label, help, ph) => field(label, `<input type="number" min="0" step="1" data-o="${k}" value="${esc(o[k] ?? '')}" placeholder="${esc(ph || '')}">`, help);
  const osel = (k, label, list, help) => field(label, `<select data-o="${k}"><option value="">Défaut Asterisk</option>${list.map(([x, l]) => `<option value="${esc(x)}"${o[k] === x ? ' selected' : ''}>${esc(l)}</option>`).join('')}${o[k] && !list.some(([x]) => x === o[k]) ? `<option value="${esc(o[k])}" selected>${esc(o[k])} (actuel)</option>` : ''}</select>`, help);
  const otext = (k, label, help, ph) => field(label, `<input data-o="${k}" value="${esc(o[k] ?? '')}" placeholder="${esc(ph || '')}">`, help);
  const bool = (k) => `<label class="cf-ge-b"><input type="checkbox" data-b="${k}"${f[k] ? ' checked' : ''}><span><strong>${esc(BOOL[k][0])}</strong>${BOOL[k][1] ? `<span class="small muted">${esc(BOOL[k][1])}</span>` : ''}</span></label>`;
  const moves = (p, i, n) => `<button class="icon" data-up="${p}${i}" title="Monter"${i ? '' : ' disabled'}>↑</button><button class="icon" data-down="${p}${i}" title="Descendre"${i < n - 1 ? '' : ' disabled'}>↓</button><button class="icon" data-del="${p}${i}" title="Retirer de la file">×</button>`;
  const userRows = () => users.map((m, i) => `<li><span class="cf-ge-n">${i + 1}</span><span>${esc(uname(m.uuid))}</span>${isDnd(m.uuid) ? '<span class="cf-ge-dnd">NPD : en pause</span>' : ''}<span class="spacer"></span>${moves('u', i, users.length)}</li>`).join('') || '<li class="muted">Aucun utilisateur</li>';
  const agentRows = () => agents.map((m, i) => `<li><span class="cf-ge-n">${i + 1}</span><span>${esc(agentName(M.by.agent?.get(String(m.id))) || `agent #${m.id}`)}</span><span class="spacer"></span><label class="cf-ge-pen" title="Pénalité : les agents à pénalité plus basse sont appelés d'abord">pénalité <input type="number" min="0" step="1" data-pen="${i}" value="${esc(m.penalty)}"></label>${moves('a', i, agents.length)}</li>`).join('') || '<li class="muted">Aucun agent</li>';
  const addU = () => `<option value="">Choisir un utilisateur à ajouter…</option>${candU.filter((u) => !users.some((m) => m.uuid === u.uuid)).map((u) => `<option value="${esc(u.uuid)}">${esc(fullName(u))}</option>`).join('')}`;
  const addA = () => `<option value="">${candA.length ? 'Choisir un agent à ajouter…' : 'Aucun agent lisible (droit confd.agents.read ?)'}</option>${candA.filter((a) => !agents.some((m) => m.id === a.id)).map((a) => `<option value="${a.id}">${esc(agentName(a))}</option>`).join('')}`;
  const live = (M.live?.get(q.name) || []).filter((x) => x.dynamic);
  const sched = (q.schedules || [])[0]?.id;
  const fb = q.fallbacks || {};
  const mohOpts = `<option value="">Aucune</option><option value="default"${f.music_on_hold === 'default' ? ' selected' : ''}>Par défaut</option>${(M.lists.moh || []).filter((m) => m.name !== 'default').map((m) => `<option value="${esc(m.name)}"${f.music_on_hold === m.name ? ' selected' : ''}>${esc(m.label || m.name)}</option>`).join('')}${f.music_on_hold && f.music_on_hold !== 'default' && !(M.lists.moh || []).some((m) => m.name === f.music_on_hold) ? `<option value="${esc(f.music_on_hold)}" selected>${esc(f.music_on_hold)} (actuelle)</option>` : ''}`;
  const cidOpts = [['', 'Inchangé : nom de l\'appelant seul'], ['prepend', 'Texte, puis nom de l\'appelant'], ['overwrite', 'Texte seul, à la place du nom'], ['append', 'Nom de l\'appelant, puis texte']].map(([k, l]) => `<option value="${k}"${(f.caller_id_mode || '') === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const others = () => Object.keys(o).filter((k) => !OPT_KNOWN.includes(k));
  const otherRows = () => others().map((k) => `<li><code>${esc(k)}</code><input data-o="${esc(k)}" value="${esc(o[k])}"><span class="spacer"></span><button class="icon" data-odel="${esc(k)}" title="Retirer cette option (valeur par défaut d'Asterisk)">×</button></li>`).join('') || '<li class="muted">Aucune autre option</li>';

  confirmModal(`<div class="cf-ed cf-queue-ed">
    <div class="cf-ge-head"><div><h3>File d'attente « ${esc(q.label || q.name)} »</h3><div class="small muted" title="Nom technique (file Asterisk), non modifiable">${esc(q.name || '')}</div></div>${helpButton('qe-hb', 'Aide')}</div>${helpBox('qe-hb', 'Toutes les options de l\'API Wazo pour une file d\'attente, rangées par thème, y compris les options Asterisk (stratégie, sonnerie par agent, pause…). Les modifications vont dans le brouillon ; « Appliquer… » relit la file et n\'écrit que ce qui change.')}
    ${sec('gen', 'Général', `
      ${field('Nom affiché', `<input data-f="label" value="${esc(f.label || '')}" maxlength="128">`)}
      <div class="cf-ge-2">
        ${field('Numéro interne', `<input data-ext value="${esc(v.extension?.exten || '')}" placeholder="aucun">`, 'Le numéro à composer pour joindre la file. Vide : pas de numéro.')}
        ${field('Contexte du numéro', `<select data-extctx>${ctxInt.map((c) => `<option value="${esc(c.name)}"${(v.extension?.context || ctxInt[0]?.name) === c.name ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('')}</select>`, 'Contexte interne ; le numéro doit être dans sa plage « files d\'attente ».')}
      </div>
      ${bool('enabled')}`, { open: true })}
    ${sec('ring', 'Distribution des appels', `
      ${osel('strategy', 'Stratégie', Object.entries(QSTRAT), '')}
      <p class="small muted cf-ge-note" id="qe-strat-h">${esc(QSTRAT_HELP[o.strategy || 'ringall'] || '')}</p>
      <div class="cf-ge-3">
        ${num('timeout', 'Durée totale (s)', 'Avant le débordement « pas de réponse ». Vide ou 0 : sans limite.', 'illimitée')}
        ${onum('timeout', 'Sonnerie par agent (s)', 'Option Asterisk timeout.', '15')}
        ${onum('retry', 'Pause de réessai (s)', 'Attente entre deux tentatives.', '5')}
      </div>
      <div id="qe-tour" class="cf-ge-tour" hidden></div>
      <div class="cf-ge-3">
        ${onum('wrapuptime', 'Repos après un appel (s)', 'L\'agent n\'est pas rappelé pendant ce temps.', '0')}
        ${onum('maxlen', 'Appelants en attente max.', '0 = illimité ; au-delà : « occupé ».', '0')}
        ${onum('weight', 'Poids', 'Priorité de cette file sur les autres pour un même agent.', '0')}
      </div>
      ${osel('ringinuse', 'Agent déjà en communication', [['no', 'Ne pas le faire sonner'], ['yes', 'Le faire sonner quand même']])}
      ${osel('autopause', 'Pause automatique', [['no', 'Non'], ['yes', 'Oui, dans cette file'], ['all', 'Oui, dans toutes ses files']], 'Un agent qui ne répond pas est mis en pause.')}
      ${bool('retry_on_timeout')}`, { help: 'Durée totale = champ Wazo timeout (délai de Queue() avant « pas de réponse ») ; sonnerie par agent = option Asterisk timeout ; pause = option retry (vérifié dans xivo-dao, valeurs par défaut 15 et 5 s). La façon dont Asterisk enchaîne les agents et les pauses (app_queue) n\'a pas été vérifiée dans le code : le calcul d\'un tour est une estimation.' })}
    ${sec('mem', 'Membres', `
      <div class="cf-ge-l">Agents</div>
      <ul class="cf-ge-list" id="qe-agents">${agentRows()}</ul>
      <div class="cf-ge-row"><select id="qe-aadd">${addA()}</select><button data-add="a">Ajouter</button></div>
      <div class="cf-ge-l cf-ge-gap">Utilisateurs</div>
      <ul class="cf-ge-list" id="qe-users">${userRows()}</ul>
      <div class="cf-ge-row"><select id="qe-uadd">${addU()}</select><button data-add="u">Ajouter</button></div>
      ${live.length ? `<p class="small muted">Connectés en ce moment (agents logués, lus dans Asterisk) : ${esc(live.map((x) => x.name).join(', '))}</p>` : ''}`, { open: true, help: 'Agents : membres de la file par leur fiche agent (pénalité : les plus basses d\'abord). Utilisateurs : membres directs. Chaque ajout, retrait ou changement est une écriture séparée ; pour changer l\'ordre ou la pénalité d\'un membre existant, l\'appli le retire puis le rajoute (confd ne notifie pas Asterisk sinon, vérifié).' })}
    ${sec('fb', 'Débordements', `
      <div class="cf-ge-f"><span class="cf-ge-l">Si personne ne répond (durée totale)</span>${pickerHtml('qe-noans', fb.noanswer_destination)}</div>
      <div class="cf-ge-f"><span class="cf-ge-l">Si la file est pleine (occupé)</span>${pickerHtml('qe-busy', fb.busy_destination)}</div>
      <div class="cf-ge-f"><span class="cf-ge-l">Si encombré</span>${pickerHtml('qe-cong', fb.congestion_destination)}</div>
      <div class="cf-ge-f"><span class="cf-ge-l">Si échec (aucun agent, file désactivée…)</span>${pickerHtml('qe-fail', fb.fail_destination)}</div>
      <div class="cf-ge-2">
        ${num('wait_time_threshold', 'Attente estimée max. (s)', 'Au-delà, l\'appelant part vers la destination ci-dessous dès l\'entrée.', 'aucun seuil')}
        <div class="cf-ge-f"><span class="cf-ge-l">Destination si attente trop longue</span>${pickerHtml('qe-wtime', q.wait_time_destination)}</div>
      </div>
      <div class="cf-ge-2">
        ${field('Rapport appelants / agents max.', `<input type="number" min="0" step="0.1" data-f="wait_ratio_threshold" value="${esc(f.wait_ratio_threshold ?? '')}" placeholder="aucun seuil">`, 'Ex. 2 : plus de 2 appelants par agent disponible.')}
        <div class="cf-ge-f"><span class="cf-ge-l">Destination si trop d'appelants</span>${pickerHtml('qe-wratio', q.wait_ratio_destination)}</div>
      </div>`)}
    ${sec('ann', 'Annonces', `
      <div class="cf-ge-2">
        ${onum('announce-frequency', 'Annonce de position, toutes les (s)', '0 = jamais.', '0')}
        ${osel('announce-position', 'Annoncer la position', [['no', 'Non'], ['yes', 'Oui'], ['limit', 'Seulement sous la limite'], ['more', 'Seulement au-delà de la limite']])}
      </div>
      ${osel('announce-holdtime', 'Annoncer le temps d\'attente', [['no', 'Non'], ['yes', 'Oui'], ['once', 'Une fois']])}
      <div class="cf-ge-2">
        ${field('Message périodique', `<select data-o="periodic-announce" id="qe-pann"><option value="">Chargement des sons…</option></select>`, 'Joué régulièrement pendant l\'attente.')}
        ${onum('periodic-announce-frequency', 'Toutes les (s)', '0 = jamais.', '0')}
      </div>
      ${bool('announce_hold_time_on_entry')}`)}
    ${sec('opt', 'Appelant et options', `
      ${field('Musique d\'attente', `<select data-f="music_on_hold">${mohOpts}</select>`)}
      ${bool('ring_on_hold')}
      <div class="cf-ge-2">
        ${field('Nom affiché aux agents', `<select data-f="caller_id_mode">${cidOpts}</select>`)}
        <span id="qe-cidtxt"${f.caller_id_mode ? '' : ' hidden'}>${field('Texte', `<input data-f="caller_id_name" value="${esc(f.caller_id_name || '')}" maxlength="80" placeholder="ex. Support">`)}</span>
      </div>
      ${bool('mark_answered_elsewhere')}${bool('dtmf_record_toggle')}${bool('ignore_forward')}`)}
    ${sec('dtmf', 'Touches pendant l\'appel', ['dtmf_hangup_callee_enabled', 'dtmf_hangup_caller_enabled', 'dtmf_transfer_callee_enabled', 'dtmf_transfer_caller_enabled', 'dtmf_record_callee_enabled', 'dtmf_record_caller_enabled'].map(bool).join(''))}
    ${sec('sch', 'Horaire', field('Horaire de la file', `<select id="qe-sched"><option value="">Aucun : toujours ouverte</option>${listOf('schedule').map((x) => `<option value="${esc(x.key.slice(9))}"${String(sched) === x.key.slice(9) ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select>`, 'Un seul horaire par file.'))}
    ${sec('adv', 'Avancé', `
      ${field('Sous-routine', `<input data-f="preprocess_subroutine" value="${esc(f.preprocess_subroutine || '')}" maxlength="79" placeholder="aucune">`)}
      ${bool('data_quality')}
      <div class="cf-ge-2">
        ${otext('joinempty', 'Entrer dans une file sans agent', 'Option Asterisk joinempty (ex. unavailable,invalid,unknown).', 'défaut')}
        ${otext('leavewhenempty', 'Quitter quand plus d\'agent', 'Option Asterisk leavewhenempty.', 'défaut')}
      </div>
      <div class="cf-ge-3">
        ${onum('servicelevel', 'Niveau de service (s)', 'Statistiques.', '0')}
        ${onum('memberdelay', 'Délai avant connexion (s)', 'Silence avant de connecter l\'agent.', '0')}
        ${osel('timeoutrestart', 'Relancer la sonnerie si occupé', [['no', 'Non'], ['yes', 'Oui']])}
      </div>
      <div class="cf-ge-l">Autres options Asterisk</div>
      <ul class="cf-ge-list cf-qe-raw" id="qe-raw">${otherRows()}</ul>
      <div class="cf-ge-row"><input id="qe-rk" placeholder="option (ex. reportholdtime)"><input id="qe-rv" placeholder="valeur"><button data-add="o">Ajouter</button></div>`, { help: 'Options de la file Asterisk telles que confd les expose. confd remplace toute la liste à chaque écriture : l\'appli renvoie toujours toutes les options, modifiées ou non. Une option retirée revient à la valeur par défaut d\'Asterisk.' })}
    <p id="qe-err" class="error small"></p></div>`, () => {
    const box = $('modal-body');
    const err = (m, s) => { openSec(box, s); $('qe-err').textContent = m; return false; };
    const nf = { ...f };
    nf.label = box.querySelector('[data-f="label"]').value.trim() || null;
    for (const k of ['timeout', 'wait_time_threshold']) { const s = box.querySelector(`[data-f="${k}"]`).value.trim(); if (s === '') nf[k] = null; else if (!/^\d+$/.test(s)) return err('Durées : nombres entiers positifs.', k === 'timeout' ? 'ring' : 'fb'); else nf[k] = Number(s); }
    { const s = box.querySelector('[data-f="wait_ratio_threshold"]').value.trim(); if (s === '') nf.wait_ratio_threshold = null; else if (!(Number(s) >= 0)) return err('Rapport appelants / agents : nombre positif.', 'fb'); else nf.wait_ratio_threshold = Number(s); }
    nf.music_on_hold = box.querySelector('[data-f="music_on_hold"]').value || null;
    nf.caller_id_mode = box.querySelector('[data-f="caller_id_mode"]').value || null;
    nf.caller_id_name = nf.caller_id_mode ? box.querySelector('[data-f="caller_id_name"]').value.trim() || null : null;
    if (nf.caller_id_mode && !nf.caller_id_name) return err('Nom affiché aux agents : saisissez le texte, ou choisissez « Inchangé ».', 'opt');
    nf.preprocess_subroutine = box.querySelector('[data-f="preprocess_subroutine"]').value.trim() || null;
    for (const k of Object.keys(BOOL)) nf[k] = box.querySelector(`[data-b="${k}"]`).checked;
    // Options : champs connus + lignes libres.
    const no = {};
    for (const el of box.querySelectorAll('[data-o]')) { const k = el.dataset.o; const s = el.value.trim(); if (s !== '') no[k] = s; }
    for (const k of ['timeout', 'retry', 'wrapuptime', 'maxlen', 'weight', 'announce-frequency', 'periodic-announce-frequency', 'servicelevel', 'memberdelay']) if (no[k] != null && !/^\d+$/.test(no[k])) return err(`Option ${k} : nombre entier positif.`, 'ring');
    const ex = box.querySelector('[data-ext]').value.trim();
    let extension = null;
    if (ex) {
      const ctx = box.querySelector('[data-extctx]').value;
      if (!/^[*#0-9]{1,40}$/.test(ex)) return err('Numéro interne : chiffres, * et # seulement.', 'gen');
      const c = M.by.context?.get(ctx);
      const inRange = (c?.queue_ranges || []).some((r) => ex.length === String(r.start).length && ex >= String(r.start) && ex <= String(r.end));
      if (c?.queue_ranges && !inRange) return err(`Numéro interne ${ex} : hors des plages « files d'attente » du contexte ${c.label || c.name} (${(c.queue_ranges || []).map((r) => `${r.start}-${r.end}`).join(', ') || 'aucune'}).`, 'gen');
      extension = { exten: ex, context: ctx };
    }
    for (const a of agents) if (!(Number.isInteger(a.penalty) && a.penalty >= 0)) return err('Pénalité des agents : nombre entier positif.', 'mem');
    let fbv, wait;
    try {
      fbv = { noanswer: readPicker('qe-noans'), busy: readPicker('qe-busy'), congestion: readPicker('qe-cong'), fail: readPicker('qe-fail') };
      wait = { time: readPicker('qe-wtime'), ratio: readPicker('qe-wratio') };
    } catch (e) { return err(e.message, 'fb'); }
    const s = $('qe-sched').value;
    onSave({ cfg: { fields: nf, opts: no, users, agents, extension }, fb: fbv, wait, schedule: s ? Number(s) : null });
    return true;
  }, 'Ajouter au brouillon');

  ['qe-noans', 'qe-busy', 'qe-cong', 'qe-fail', 'qe-wtime', 'qe-wratio'].forEach(bindPicker);
  fillSoundSelect($('qe-pann'), o['periodic-announce'] || '').then(() => { const s = $('qe-pann'); if (s?.options[0]) s.options[0].textContent = s.options[0].value ? s.options[0].textContent : 'Aucun'; recap(); });
  const box = $('modal-body');
  const val = (sel) => box.querySelector(sel)?.value?.trim() || '';
  const txt = (sel) => { const e = box.querySelector(sel); return e?.value ? e.selectedOptions[0]?.text : ''; };
  const pick = (id) => { const el = $(id); const t = el?.querySelector('[data-dt]'); if (!t || t.value === 'none') return 'rien'; const x = el.querySelector('[data-do]'); return `${t.selectedOptions[0].text.toLowerCase()}${x?.value ? ` ${x.selectedOptions[0].text.split(' — ')[0]}` : ''}`; };
  const ann = () => {
    const a = [Number(val('[data-o="announce-frequency"]')) ? `position toutes les ${val('[data-o="announce-frequency"]')} s` : '',
      val('#qe-pann') ? `message : ${txt('#qe-pann')}` : '',
      box.querySelector('[data-b="announce_hold_time_on_entry"]')?.checked ? 'attente annoncée à l\'entrée' : ''].filter(Boolean);
    return a.length ? a : ['aucune annonce'];
  };
  const recap = () => {
    const strat = val('[data-o="strategy"]') || 'ringall';
    setSums(box, {
      gen: [val('[data-f="label"]') || q.name, val('[data-ext]') ? `n° ${val('[data-ext]')}` : 'sans numéro', box.querySelector('[data-b="enabled"]')?.checked ? '' : 'DÉSACTIVÉE'],
      ring: [QSTRAT[strat] || strat, Number(val('[data-f="timeout"]')) ? `${val('[data-f="timeout"]')} s au total` : 'sans limite', `${val('[data-o="timeout"]') || 15} s par agent`],
      mem: [`${agents.length} agent${agents.length > 1 ? 's' : ''}`, `${users.length} utilisateur${users.length > 1 ? 's' : ''}`],
      fb: [`sans réponse : ${pick('qe-noans')}`, val('[data-f="wait_time_threshold"]') ? `attente > ${val('[data-f="wait_time_threshold"]')} s` : ''],
      ann: ann(),
      opt: [val('[data-f="music_on_hold"]') ? `musique ${txt('[data-f="music_on_hold"]')}` : 'sans musique', val('[data-f="caller_id_mode"]') ? `nom « ${val('[data-f="caller_id_name"]')} »` : ''],
      dtmf: [`${box.querySelectorAll('[data-sec="dtmf"] input:checked').length} activée(s)`],
      sch: [$('qe-sched')?.value ? $('qe-sched').selectedOptions[0].text : 'aucun'],
      adv: [others().length ? `${others().length} autre${others().length > 1 ? 's' : ''} option${others().length > 1 ? 's' : ''}` : ''],
    });
    tourBox(strat);
  };
  // Estimation d'un tour (supposé : app_queue tente un agent — ou tous en
  // « ringall » — pendant la sonnerie, puis attend la pause avant la tentative suivante).
  const tourBox = (strat) => {
    const el = $('qe-tour'); if (!el) return;
    const n = agents.length + users.length;
    if (!n) { el.hidden = true; return; }
    const ut = Number(val('[data-o="timeout"]') || 15), rd = Number(val('[data-o="retry"]') || 5);
    const tour = strat === 'ringall' ? ut + rd : n * (ut + rd);
    const cur = Number(val('[data-f="timeout"]') || 0);
    el.innerHTML = `<div><strong>Un tour ≈ ${strat === 'ringall' ? `${ut} s + ${rd} s de pause` : `${n} membre${n > 1 ? 's' : ''} × (${ut} s + ${rd} s de pause)`} = ${tour} s</strong>
      <span class="small muted">Estimation (fonctionnement d'Asterisk supposé, non vérifié dans son code). Durée totale ${cur ? `actuellement ${cur} s ≈ ${(Math.round((cur / tour) * 10) / 10).toLocaleString('fr')} tour${cur / tour >= 2 ? 's' : ''}` : 'illimitée'}.</span></div>
      ${cur === tour ? '' : `<button type="button" data-usetour="${tour}">Utiliser ${tour} s</button>`}`;
    el.hidden = false;
  };
  const redraw = () => {
    $('qe-users').innerHTML = userRows(); $('qe-uadd').innerHTML = addU();
    $('qe-agents').innerHTML = agentRows(); $('qe-aadd').innerHTML = addA();
    $('qe-raw').innerHTML = otherRows(); recap();
  };
  box.addEventListener('input', (e) => { if (e.target.dataset.pen != null) agents[Number(e.target.dataset.pen)].penalty = e.target.value === '' ? NaN : Number(e.target.value); recap(); });
  box.addEventListener('change', (e) => {
    if (e.target.matches('[data-o="strategy"]')) $('qe-strat-h').textContent = QSTRAT_HELP[e.target.value || 'ringall'] || '';
    if (e.target.matches('[data-f="caller_id_mode"]')) $('qe-cidtxt').hidden = !e.target.value;
    recap();
  });
  box.onclick = (e) => {
    const t = e.target.closest('[data-usetour]');
    if (t) { box.querySelector('[data-f="timeout"]').value = t.dataset.usetour; recap(); return; }
    const od = e.target.closest('[data-odel]');
    if (od) { delete o[od.dataset.odel]; redraw(); return; }
    const b = e.target.closest('[data-up],[data-down],[data-del],[data-add]'); if (!b) return;
    const ref = b.dataset.up || b.dataset.down || b.dataset.del;
    if (ref) {
      const list = ref[0] === 'u' ? users : agents; const i = Number(ref.slice(1));
      if (b.dataset.up && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      if (b.dataset.down && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      if (b.dataset.del) list.splice(i, 1);
      redraw(); return;
    }
    if (b.dataset.add === 'u') { const uu = $('qe-uadd').value; if (uu) { users.push({ uuid: uu }); redraw(); } }
    if (b.dataset.add === 'a') { const id = Number($('qe-aadd').value); if (id) { agents.push({ id, penalty: 0 }); redraw(); } }
    if (b.dataset.add === 'o') {
      const k = $('qe-rk').value.trim(), x = $('qe-rv').value.trim();
      if (!/^[a-z][a-z0-9_-]*$/i.test(k)) { $('qe-err').textContent = 'Nom d\'option : lettres, chiffres, - et _.'; return; }
      if (OPT_KNOWN.includes(k)) { $('qe-err').textContent = `L'option ${k} a déjà son champ plus haut.`; return; }
      o[k] = x; $('qe-rk').value = ''; $('qe-rv').value = ''; $('qe-err').textContent = ''; redraw();
    }
  };
  recap();
}

// Libellé court des différences (brouillon, aperçu).
export function queueCfgDiff(a, b) {
  if (!a || !b) return '';
  const out = QUEUE_FIELDS.filter((k) => JSON.stringify(a.fields[k] ?? null) !== JSON.stringify(b.fields[k] ?? null)).map((k) => ({ label: 'nom', timeout: 'durée totale', music_on_hold: 'musique', wait_time_threshold: 'seuil d\'attente', wait_ratio_threshold: 'seuil appelants/agents' }[k] || BOOL[k]?.[0]?.toLowerCase() || k));
  const ok = new Set([...Object.keys(a.opts || {}), ...Object.keys(b.opts || {})]);
  for (const k of ok) if ((a.opts?.[k] ?? '') !== (b.opts?.[k] ?? '')) out.push({ strategy: 'stratégie', timeout: 'sonnerie par agent', retry: 'pause' }[k] || `option ${k}`);
  if (JSON.stringify(a.users) !== JSON.stringify(b.users) || JSON.stringify(a.agents) !== JSON.stringify(b.agents)) out.push('membres');
  if (JSON.stringify(a.extension) !== JSON.stringify(b.extension)) out.push('numéro interne');
  return out.join(', ');
}
