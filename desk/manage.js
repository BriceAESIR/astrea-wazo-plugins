// Astrea Desk — gestion (0.5.0) : groupes d'appels, plages horaires,
// messageries vocales. Modification seulement (ni création ni suppression).
// Règles d'écriture reprises de Call Flow Manager (admin-tools/callflow/write.js
// et éditeurs), elles-mêmes lues dans wazo-confd master et vérifiées en réel :
//  - groupes : PUT /groups/{uuid} partiel ; ignore_forward toujours renvoyé
//    (sinon confd le remet à false) ; label ^[-_.a-zA-Z0-9 ]+$ ≤ 128 (sans
//    accents : il finit dans queues.conf) ; membres : PUT
//    /groups/{uuid}/members/users, liste remplacée en entier, ordre = priorité ;
//  - plages horaires : PUT /schedules/{id}, périodes envoyées en entier ;
//    listes vides refusées par confd (« month_days cannot be empty », constaté
//    en réel le 14/10/2026) → « tous » envoyé en liste complète ; une fermeture
//    exceptionnelle n'a pas d'année (elle revient chaque année) ;
//  - messageries : PUT /voicemails/{id} partiel ; delete_messages exige email et
//    attach_audio dans le même envoi ; fuseau = nom d'une zonemessage du
//    serveur (eu-fr), pas un nom IANA ; code : chiffres seulement.
// Toujours : relire juste avant d'écrire ; refuser si l'objet a changé
// ailleurs depuis l'ouverture ; n'écrire que ce qui a changé.
import { S, $, esc, toast, api, listAll, confirmModal, canWrite, fullName } from '../admin-tools/common/core.js?v=0.5.0';
import { loadPresences, phoneBadge } from './live.js?v=0.5.0';

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const same = (a, b) => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
const head = (title, site, sub) => `<div class="phonehead"><div><h2>${esc(title)}</h2><div class="muted small">${esc(site.name)}${sub ? ` · ${esc(sub)}` : ''}</div></div></div>`;
const intOrNull = (v) => { v = String(v ?? '').trim(); if (v === '') return null; return /^\d+$/.test(v) ? Number(v) : undefined; };

// Écran de liste commun : tableau, clic sur une ligne = édition.
async function listScreen(view, site, { title, path, none, cols, key, edit, sub, prep, note = '' }) {
  view.innerHTML = head(title, site, sub) + '<p class="dk-empty">Lecture…</p>';
  const [items] = await Promise.all([listAll(path), prep?.()]);
  if (!view.isConnected) return;
  const draw = (list) => {
    view.innerHTML = head(title, site, sub)
      + (S.readonly ? '<p class="warn small">Lecture seule : modification désactivée.</p>' : '') + note
      + (list.length ? `<div class="dk-scroll"><table class="dk-table dk-click"><thead><tr>${cols.map(([h]) => `<th>${esc(h)}</th>`).join('')}<th></th></tr></thead><tbody>${list.map((o) => `<tr data-k="${esc(key(o))}">${cols.map(([, f]) => { const v = f(o); return `<td>${v && typeof v === 'object' ? v.html : esc(v)}</td>`; }).join('')}<td class="num">${S.readonly ? '' : '<button class="dk-text">Modifier</button>'}</td></tr>`).join('')}</tbody></table></div>` : `<p class="dk-empty">${esc(none)}</p>`);
    view.querySelector('tbody')?.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-k]'); if (!tr || S.readonly) return;
      const o = list.find((x) => String(key(x)) === tr.dataset.k);
      if (o && canWrite()) edit(o, async () => { const [l] = await Promise.all([listAll(path), prep?.()]); draw(l); });
    });
  };
  draw(items);
}

// Résultat d'une suite d'écritures : [{ label, run }] exécutées dans l'ordre.
async function runWrites(steps) {
  const done = [];
  for (const s of steps) {
    try { await s.run(); done.push(s.label); }
    catch (e) { throw new Error(`${done.length ? `Déjà écrit : ${done.join(', ')}. ` : ''}Échec sur « ${s.label} » : ${e.message}`); }
  }
  return done;
}
function changedElsewhere(label) { return new Error(`${label} a été modifié ailleurs (Portal ou autre poste) depuis l'ouverture : rien n'a été écrit. Fermez puis rouvrez pour repartir de la version actuelle.`); }

// ---------------------------------------------------------------------------
// Groupes d'appels
// ---------------------------------------------------------------------------
const STRATS = [
  ['all', 'Tous en même temps'], ['linear', 'Un par un, dans l\'ordre'], ['random', 'Aléatoire'],
  ['least_recent', 'Le moins récemment appelé'], ['fewest_calls', 'Le moins d\'appels pris'],
  ['memorized_round_robin', 'Chacun son tour (mémorisé)'], ['weight_random', 'Aléatoire pondéré'],
];
const G_FIELDS = ['label', 'ring_strategy', 'timeout', 'user_timeout', 'retry_delay', 'enabled', 'ring_in_use', 'mark_answered_elsewhere'];
const groupCfg = (g) => ({
  fields: Object.fromEntries(G_FIELDS.map((k) => [k, g?.[k] ?? null])),
  users: [...(g?.members?.users || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((m) => m.uuid),
});
const exts = (o) => (o.extensions || []).map((e) => e.exten).filter(Boolean).join(', ');

export function renderGroups(view, site) {
  return listScreen(view, site, {
    title: "Groupes d'appels", path: '/groups', none: "Aucun groupe d'appels sur ce site.", sub: 'cliquez sur un groupe pour le modifier',
    key: (g) => g.uuid,
    cols: [['Nom', (g) => g.label || g.name], ['Numéro', exts], ['Sonnerie', (g) => STRATS.find(([k]) => k === g.ring_strategy)?.[1] || g.ring_strategy || ''], ['Membres', (g) => ({ html: memberStates(g) })], ['État', (g) => (g.enabled === false ? 'Désactivé' : 'Actif')]],
    prep: async () => { PRES = await loadPresences(); },
    note: '<p class="muted small">Membres enregistrés dans le groupe, avec l\'état de leur téléphone. Les entrées et sorties faites depuis un poste (codes *735…) ne sont pas visibles ici : Wazo ne les expose qu\'au compte principal du serveur.</p>',
    edit: editGroup,
  });
}
let PRES = new Map();
const memberStates = (g) => [...(g.members?.users || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((m) => `<span class="dk-mem">${esc(fullName(m) || m.uuid)} ${phoneBadge(PRES.get(m.uuid))}</span>`).join('') || '<span class="muted">aucun</span>';

async function editGroup(g0, onDone) {
  const [g, users] = await Promise.all([api('GET', `/groups/${g0.uuid}`), listAll('/users')]);
  const start = groupCfg(g);
  const f = start.fields;
  let members = [...start.users];
  const byUuid = new Map(users.map((u) => [u.uuid, u]));
  const uname = (uuid) => fullName(byUuid.get(uuid)) || fullName((g.members?.users || []).find((m) => m.uuid === uuid)) || uuid;
  const num = (k, label, help) => `<label>${esc(label)}<input type="number" min="0" step="1" data-f="${k}" value="${esc(f[k] ?? '')}"><span class="muted small">${esc(help)}</span></label>`;
  const chk = (k, label, help) => `<label class="inline" title="${esc(help)}"><input type="checkbox" data-b="${k}"${f[k] ? ' checked' : ''}> ${esc(label)}</label>`;
  confirmModal(`<div class="dk-ed">
    <h3>Groupe « ${esc(g.label || g.name)} »${exts(g) ? ` <span class="muted small">${esc(exts(g))}</span>` : ''}</h3>
    <label>Nom<input data-f="label" value="${esc(f.label || '')}" maxlength="128"><span class="muted small">Lettres sans accents, chiffres, espace, - _ . (contrainte Wazo).</span></label>
    <label>Façon de sonner<select data-f="ring_strategy">${STRATS.map(([k, l]) => `<option value="${k}"${f.ring_strategy === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <div class="dk-ed-3">
      ${num('timeout', 'Durée totale (s)', 'Vide ou 0 : sonne sans fin.')}
      ${num('user_timeout', 'Sonnerie par membre (s)', 'Un par un : durée sur chaque poste.')}
      ${num('retry_delay', 'Pause entre deux (s)', 'Un par un : avant le suivant.')}
    </div>
    <div class="dk-ed-checks">${chk('enabled', 'Groupe activé', 'Désactivé, les appels vers le groupe échouent.')}${chk('ring_in_use', 'Faire sonner un membre déjà en ligne', '')}${chk('mark_answered_elsewhere', '« Répondu ailleurs » chez les autres', 'Évite un appel manqué sur les autres postes.')}</div>
    <h4>Membres <span class="muted small">(ordre = priorité, utile en « un par un »)</span></h4>
    <ul class="dk-ed-list" id="ge-users"></ul>
    <div class="dk-ed-row"><select id="ge-add"></select><button type="button" id="ge-addb">Ajouter</button></div>
    ${(g.members?.extensions || []).length ? `<p class="muted small">${g.members.extensions.length} numéro(s) externe(s) membre(s), non modifiés ici.</p>` : ''}
    <p id="ge-err" class="error small"></p></div>`, async () => {
    const box = $('modal-body'), err = (m) => { $('ge-err').textContent = m; return false; };
    const nf = { ...f };
    nf.label = box.querySelector('[data-f="label"]').value.trim();
    if (!nf.label || !/^[-_.a-zA-Z0-9 ]+$/.test(nf.label)) return err('Nom : lettres sans accents, chiffres, espace, - _ . seulement.');
    nf.ring_strategy = box.querySelector('[data-f="ring_strategy"]').value;
    for (const k of ['timeout', 'user_timeout', 'retry_delay']) { const v = intOrNull(box.querySelector(`[data-f="${k}"]`).value); if (v === undefined) return err('Durées : nombres entiers positifs.'); nf[k] = v; }
    // Case jamais réglée (valeur absente) et laissée décochée : rien n'est écrit.
    for (const el of box.querySelectorAll('[data-b]')) nf[el.dataset.b] = f[el.dataset.b] == null && !el.checked ? f[el.dataset.b] : el.checked;
    const want = { fields: nf, users: members };
    if (same(want, start)) { toast('Aucune modification.'); return true; }
    // Relecture juste avant d'écrire.
    const cur = await api('GET', `/groups/${g.uuid}`);
    if (!same(groupCfg(cur), start)) return err(changedElsewhere('Ce groupe').message);
    const steps = [];
    const changed = G_FIELDS.filter((k) => !same(nf[k], f[k]));
    if (changed.length) steps.push({ label: 'réglages', run: () => api('PUT', `/groups/${g.uuid}`, { ...Object.fromEntries(changed.map((k) => [k, nf[k]])), ignore_forward: !!cur.ignore_forward }) });
    if (!same(members, start.users)) steps.push({ label: 'membres', run: () => api('PUT', `/groups/${g.uuid}/members/users`, { users: members.map((uuid, i) => ({ uuid, priority: i })) }) });
    try { await runWrites(steps); } catch (e) { onDone(); return err(e.message); }
    toast(`Groupe « ${nf.label} » enregistré.`);
    onDone();
    return true;
  }, 'Enregistrer');
  const drawUsers = () => {
    $('ge-users').innerHTML = members.map((uuid, i) => `<li><span>${esc(uname(uuid))} ${phoneBadge(PRES.get(uuid))}</span><span class="spacer"></span><button type="button" class="icon" data-up="${i}" title="Monter"${i ? '' : ' disabled'}>↑</button><button type="button" class="icon" data-dn="${i}" title="Descendre"${i < members.length - 1 ? '' : ' disabled'}>↓</button><button type="button" class="icon" data-rm="${i}" title="Retirer">×</button></li>`).join('') || '<li class="muted small">Aucun membre.</li>';
    $('ge-add').innerHTML = `<option value="">Ajouter un utilisateur…</option>${users.filter((u) => !members.includes(u.uuid)).sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr')).map((u) => `<option value="${esc(u.uuid)}">${esc(fullName(u) || u.uuid)}</option>`).join('')}`;
  };
  $('ge-users').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const i = Number(b.dataset.up ?? b.dataset.dn ?? b.dataset.rm);
    if (b.dataset.rm != null) members.splice(i, 1);
    else { const j = b.dataset.up != null ? i - 1 : i + 1; [members[i], members[j]] = [members[j], members[i]]; }
    drawUsers();
  };
  $('ge-addb').onclick = () => { const v = $('ge-add').value; if (v) { members.push(v); drawUsers(); } };
  drawUsers();
}

// ---------------------------------------------------------------------------
// Plages horaires
// ---------------------------------------------------------------------------
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const full = (a, n) => (Array.isArray(a) && a.length ? [...a].sort((x, y) => x - y) : range(n));
const isAll = (a, n) => !a?.length || full(a, n).length === n;
// Champs d'entrée d'une destination (repris de Call Flow, write.js).
const DEST_KEYS = {
  none: [], user: ['user_id', 'ring_time', 'moh_uuid'], group: ['group_id', 'ring_time'], queue: ['queue_id', 'ring_time', 'skill_rule_id', 'skill_rule_variables'],
  voicemail: ['voicemail_id', 'skip_instructions', 'greeting'], ivr: ['ivr_id'], conference: ['conference_id'], switchboard: ['switchboard_uuid', 'ring_time'],
  outcall: ['outcall_id', 'exten'], extension: ['exten', 'context'], sound: ['filename', 'skip', 'no_answer'], custom: ['command'], hangup: ['cause', 'timeout'],
  application: ['application', 'pin', 'context', 'email', 'application_uuid'],
};
function cleanDest(d) {
  if (!d || !d.type || d.type === 'none') return { type: 'none' };
  const out = { type: d.type };
  for (const k of DEST_KEYS[d.type] || Object.keys(d)) if (d[k] !== undefined && d[k] !== null && d[k] !== '') out[k] = d[k];
  return out;
}
const per = (p, withDest) => { const x = { hours_start: p.hours_start, hours_end: p.hours_end, week_days: full(p.week_days, 7), month_days: full(p.month_days, 31), months: full(p.months, 12) }; if (withDest) x.destination = cleanDest(p.destination); return x; };
const schedCfg = (s) => ({ name: s?.name ?? '', enabled: s?.enabled !== false, open: (s?.open_periods || []).map((p) => per(p, false)), exc: (s?.exceptional_periods || []).map((p) => per(p, true)), closed: cleanDest(s?.closed_destination) });
const dayList = (w) => { w = full(w, 7); if (w.length === 7) return 'Tous les jours'; const runs = []; for (const d of w) { const r = runs[runs.length - 1]; if (r && d === r[1] + 1) r[1] = d; else runs.push([d, d]); } return runs.map(([a, b]) => (a === b ? DAYS[a - 1] : b === a + 1 ? `${DAYS[a - 1]}, ${DAYS[b - 1]}` : `${DAYS[a - 1]}–${DAYS[b - 1]}`)).join(', '); };
const hours = (p) => (p.hours_start === '00:00' && p.hours_end === '23:59' ? 'toute la journée' : `${p.hours_start}–${p.hours_end}`);
const simpleOpen = (p) => isAll(p.month_days, 31) && isAll(p.months, 12);
// Fermeture simple : un seul mois, jours qui se suivent, tous les jours de semaine.
const simpleExc = (p) => full(p.months, 12).length === 1 && isAll(p.week_days, 7) && full(p.month_days, 31).every((d, i, a) => !i || d === a[i - 1] + 1);
const excText = (p) => { const m = full(p.months, 12), d = full(p.month_days, 31); if (!simpleExc(p)) return `${d.length === 31 ? '' : `jours ${d.join(', ')} · `}${m.length === 12 ? '' : `${m.map((x) => MONTHS[x - 1]).join(', ')} · `}${dayList(p.week_days)} · ${hours(p)}`; return `${d.length > 1 ? `du ${d[0]} au ${d[d.length - 1]}` : `le ${d[0]}`} ${MONTHS[m[0] - 1]} · ${hours(p)}`; };
const DEST_LABEL = { user: 'utilisateur', group: 'groupe', queue: 'file d\'attente', voicemail: 'messagerie', ivr: 'SVI', switchboard: 'POPC', conference: 'conférence', sound: 'message', hangup: 'raccrocher', extension: 'numéro', outcall: 'appel sortant', custom: 'personnalisée', application: 'application' };
const destText = (d) => (d?.type && d.type !== 'none' ? `${DEST_LABEL[d.type] || d.type}${d.voicemail_name || d.user_firstname || d.group_label || d.queue_label || d.ivr_name || d.exten ? ` ${[d.voicemail_name, [d.user_firstname, d.user_lastname].filter(Boolean).join(' '), d.group_label, d.queue_label, d.ivr_name, d.exten].filter(Boolean)[0]}` : ''}` : 'aucune');

export function renderSchedules(view, site) {
  return listScreen(view, site, {
    title: 'Plages horaires', path: '/schedules', none: 'Aucune plage horaire sur ce site.', sub: 'cliquez sur une plage pour la modifier',
    key: (s) => s.id,
    cols: [['Nom', (s) => s.name], ['Ouverture', (s) => (s.open_periods || []).map((p) => `${dayList(p.week_days)} ${hours(p)}`).join(' ; ') || '—'], ['Fermetures exceptionnelles', (s) => (s.exceptional_periods || []).length || '—'], ['État', (s) => (s.enabled === false ? 'Désactivée' : 'Active')]],
    edit: editSchedule,
  });
}

async function editSchedule(s0, onDone) {
  const s = await api('GET', `/schedules/${s0.id}`);
  const start = schedCfg(s);
  const open = start.open.map((p) => ({ ...p }));
  const exc = start.exc.map((p) => ({ ...p }));
  const used = [...(s.incalls || []).map(() => 'SDA'), ...(s.users || []).map(() => 'utilisateur'), ...(s.groups || []).map(() => 'groupe'), ...(s.queues || []).map(() => 'file'), ...(s.outcalls || []).map(() => 'sortant')];
  const t = (v) => `<input type="time" value="${esc(v)}" step="60">`;
  confirmModal(`<div class="dk-ed">
    <h3>Plage horaire « ${esc(s.name)} »</h3>
    ${used.length ? `<p class="muted small">Utilisée par ${used.length} objet(s) (${[...new Set(used)].join(', ')}). En dehors des heures d'ouverture, l'appel part vers la destination « fermé » (${esc(destText(start.closed))}), qui se règle dans le Portal.</p>` : ''}
    <label>Nom<input data-f="name" value="${esc(s.name || '')}" maxlength="128"></label>
    <label class="inline"><input type="checkbox" data-f="enabled"${start.enabled ? ' checked' : ''}> Plage active</label>
    <h4>Heures d'ouverture</h4>
    <div id="se-open"></div>
    <div class="dk-ed-row"><button type="button" id="se-oadd">Ajouter une plage d'ouverture</button></div>
    <h4>Fermetures exceptionnelles <span class="muted small">(jours fériés, congés : reviennent chaque année, Wazo ne gère pas l'année)</span></h4>
    <div id="se-exc"></div>
    <div class="dk-ed-row dk-ed-exc"><label>Du <input type="date" id="se-d1"></label><label>Au <input type="date" id="se-d2"></label><label>De ${t('00:00').replace('<input', '<input id="se-h1"')}</label><label>À ${t('23:59').replace('<input', '<input id="se-h2"')}</label><button type="button" id="se-eadd">Ajouter</button></div>
    <p id="se-err" class="error small"></p></div>`, async () => {
    const box = $('modal-body'), err = (m) => { $('se-err').textContent = m; return false; };
    readOpen();
    for (const p of open) { if (!p.week_days.length) return err('Chaque plage d\'ouverture doit avoir au moins un jour.'); if (!(p.hours_start < p.hours_end)) return err(`Plage ${dayList(p.week_days)} : l'heure de fin doit suivre l'heure de début.`); }
    const name = box.querySelector('[data-f="name"]').value.trim(); if (!name) return err('Nom obligatoire.');
    const enabled = box.querySelector('[data-f="enabled"]').checked;
    const want = { name, enabled, open: open.map((p) => per(p, false)), exc: exc.map((p) => per(p, true)), closed: start.closed };
    if (same(want, start)) { toast('Aucune modification.'); return true; }
    const cur = await api('GET', `/schedules/${s.id}`);
    if (!same(schedCfg(cur), start)) return err(changedElsewhere('Cette plage horaire').message);
    const body = { closed_destination: cleanDest(cur.closed_destination), open_periods: want.open, exceptional_periods: want.exc };
    if (name !== start.name) body.name = name;
    if (enabled !== start.enabled) body.enabled = enabled;
    try { await runWrites([{ label: 'plage horaire', run: () => api('PUT', `/schedules/${s.id}`, body) }]); } catch (e) { return err(e.message); }
    toast(`Plage « ${name} » enregistrée.`);
    onDone();
    return true;
  }, 'Enregistrer');
  // Plages d'ouverture : les plages simples (jours + heures) sont modifiables ;
  // celles limitées à certains jours du mois ou mois sont conservées telles quelles.
  function readOpen() {
    for (const row of $('se-open').querySelectorAll('[data-i]')) {
      const p = open[Number(row.dataset.i)];
      p.week_days = [...row.querySelectorAll('[data-wd]')].filter((c) => c.checked).map((c) => Number(c.dataset.wd));
      const [a, b] = row.querySelectorAll('input[type="time"]'); p.hours_start = a.value; p.hours_end = b.value;
    }
  }
  function drawOpen() {
    $('se-open').innerHTML = open.map((p, i) => (simpleOpen(p)
      ? `<div class="dk-ed-period" data-i="${i}"><span class="dk-ed-days">${DAYS.map((d, j) => `<label class="inline"><input type="checkbox" data-wd="${j + 1}"${full(p.week_days, 7).includes(j + 1) ? ' checked' : ''}>${d}</label>`).join('')}</span>${t(p.hours_start)}<span>–</span>${t(p.hours_end)}<button type="button" class="icon" data-orm="${i}" title="Retirer">×</button></div>`
      : `<div class="dk-ed-period muted small">${esc(excText(p))} <em>(plage avancée réglée dans le Portal, conservée)</em></div>`)).join('') || '<p class="muted small">Aucune plage : toujours fermé.</p>';
  }
  function drawExc() {
    $('se-exc').innerHTML = exc.map((p, i) => `<div class="dk-ed-period"><span>${esc(excText(p))}</span><span class="muted small">→ ${esc(destText(p.destination))}</span><span class="spacer"></span><button type="button" class="icon" data-erm="${i}" title="Retirer">×</button></div>`).join('') || '<p class="muted small">Aucune fermeture exceptionnelle.</p>';
  }
  $('se-open').onclick = (e) => { const b = e.target.closest('[data-orm]'); if (!b) return; readOpen(); open.splice(Number(b.dataset.orm), 1); drawOpen(); };
  $('se-oadd').onclick = () => { readOpen(); open.push({ hours_start: '08:30', hours_end: '18:00', week_days: [1, 2, 3, 4, 5], month_days: range(31), months: range(12) }); drawOpen(); };
  $('se-exc').onclick = (e) => { const b = e.target.closest('[data-erm]'); if (b) { exc.splice(Number(b.dataset.erm), 1); drawExc(); } };
  $('se-eadd').onclick = () => {
    const d1 = $('se-d1').value, d2 = $('se-d2').value || d1, h1 = $('se-h1').value || '00:00', h2 = $('se-h2').value || '23:59';
    if (!d1) { $('se-err').textContent = 'Choisissez au moins la date de début.'; return; }
    if (!(h1 < h2)) { $('se-err').textContent = "L'heure de fin doit suivre l'heure de début."; return; }
    let a = new Date(`${d1}T00:00:00`), b = new Date(`${d2}T00:00:00`); if (b < a) [a, b] = [b, a];
    if ((b - a) / 864e5 > 62) { $('se-err').textContent = 'Période trop longue (deux mois au plus).'; return; }
    // Une période par mois touché (Wazo : jours du mois × mois).
    const byMonth = new Map();
    for (let d = new Date(a); d <= b; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) { const m = d.getMonth() + 1; if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(d.getDate()); }
    for (const [m, days] of byMonth) exc.push({ hours_start: h1, hours_end: h2, week_days: range(7), month_days: days, months: [m], destination: start.closed });
    $('se-err').textContent = ''; $('se-d1').value = ''; $('se-d2').value = '';
    drawExc();
  };
  drawOpen(); drawExc();
}

// ---------------------------------------------------------------------------
// Messageries vocales
// ---------------------------------------------------------------------------
const V_FIELDS = ['name', 'email', 'attach_audio', 'delete_messages', 'max_messages', 'password', 'ask_password', 'language', 'timezone', 'enabled'];
const vmCfg = (v) => Object.fromEntries(V_FIELDS.map((k) => [k, v?.[k] ?? null]));
const LANGS = [['fr_FR', 'Français'], ['en_US', 'Anglais (US)'], ['en_GB', 'Anglais (GB)'], ['de_DE', 'Allemand'], ['es_ES', 'Espagnol'], ['it_IT', 'Italien'], ['nl_NL', 'Néerlandais']];
let ZONES = null;
async function zones() {
  if (ZONES) return ZONES;
  try { ZONES = ((await api('GET', '/asterisk/voicemail/zonemessages'))?.items || []).filter((z) => z?.name); } catch { ZONES = []; }
  if (!ZONES.length) ZONES = [{ name: 'eu-fr', timezone: 'Europe/Paris' }];
  return ZONES;
}

export function renderVoicemails(view, site) {
  return listScreen(view, site, {
    title: 'Messageries vocales', path: '/voicemails', none: 'Aucune messagerie vocale sur ce site.', sub: 'cliquez sur une messagerie pour la modifier',
    key: (v) => v.id,
    cols: [['Nom', (v) => v.name], ['Numéro', (v) => v.number], ['Utilisateurs', (v) => (v.users || []).map(fullName).join(', ') || (v.accesstype === 'global' ? 'partagée' : '—')], ['E-mail', (v) => v.email || '—'], ['État', (v) => (v.enabled === false ? 'Désactivée' : 'Active')]],
    edit: editVoicemail,
  });
}

async function editVoicemail(v0, onDone) {
  const [v, zl] = await Promise.all([api('GET', `/voicemails/${v0.id}`), zones()]);
  const f = vmCfg(v);
  const sel = (k, opts) => `<select data-f="${k}"><option value="">Défaut du serveur</option>${opts.map(([val, l]) => `<option value="${esc(val)}"${f[k] === val ? ' selected' : ''}>${esc(l)}</option>`).join('')}${f[k] && !opts.some(([val]) => val === f[k]) ? `<option value="${esc(f[k])}" selected>${esc(f[k])}</option>` : ''}</select>`;
  const chk = (k, label, help = '') => `<label class="inline" title="${esc(help)}"><input type="checkbox" data-b="${k}"${f[k] ? ' checked' : ''}> ${esc(label)}</label>`;
  confirmModal(`<div class="dk-ed">
    <h3>Messagerie « ${esc(v.name)} » <span class="muted small">n° ${esc(v.number)}</span></h3>
    <p class="muted small">${(v.users || []).length ? `Utilisée par ${esc(v.users.map(fullName).join(', '))}.` : v.accesstype === 'global' ? 'Messagerie partagée.' : 'Aucun utilisateur associé.'} L'association aux utilisateurs et les messages d'accueil se règlent dans le Portal.</p>
    <label>Nom<input data-f="name" value="${esc(f.name || '')}" maxlength="80"></label>
    <h4>Messages par e-mail</h4>
    <label>E-mail<input type="email" data-f="email" value="${esc(f.email || '')}" maxlength="80" placeholder="aucun"><span class="muted small">Chaque nouveau message y est signalé.</span></label>
    <div class="dk-ed-checks">${chk('attach_audio', 'Joindre le message audio')}${chk('delete_messages', 'Supprimer le message après l\'envoi', 'Exige un e-mail et la pièce jointe (contrainte Wazo).')}</div>
    <h4>Accès</h4>
    <div class="dk-ed-3">
      <label>Code<input data-f="password" type="password" autocomplete="new-password" inputmode="numeric" value="${esc(f.password || '')}" placeholder="aucun"><span class="muted small">Chiffres seulement.</span></label>
      <label>Messages max.<input type="number" min="0" step="1" data-f="max_messages" value="${esc(f.max_messages ?? '')}" placeholder="défaut"></label>
    </div>
    <div class="dk-ed-checks">${chk('ask_password', 'Demander le code à la consultation', 'Décoché : accès direct depuis le poste du titulaire.')}${chk('enabled', 'Messagerie activée')}<label class="inline"><input type="checkbox" id="vm-show"> Afficher le code</label></div>
    <h4>Langue et heure</h4>
    <div class="dk-ed-3"><label>Langue${sel('language', LANGS)}</label><label>Fuseau horaire${sel('timezone', zl.map((z) => [z.name, `${z.name}${z.timezone ? ` (${z.timezone})` : ''}`]))}</label></div>
    <p id="vm-err" class="error small"></p></div>`, async () => {
    const box = $('modal-body'), err = (m) => { $('vm-err').textContent = m; return false; };
    const val = (k) => box.querySelector(`[data-f="${k}"]`).value.trim();
    const nf = { ...f };
    nf.name = val('name'); if (!nf.name) return err('Nom obligatoire.');
    nf.email = val('email') || null; if (nf.email && !/^[^@\s]+@[^@\s]+$/.test(nf.email)) return err('E-mail invalide.');
    nf.password = val('password') || null; if (nf.password && !/^[0-9]{1,80}$/.test(nf.password)) return err('Code : chiffres seulement.');
    const mm = intOrNull(val('max_messages')); if (mm === undefined) return err('Messages max. : entier positif.'); nf.max_messages = mm;
    nf.language = val('language') || null; nf.timezone = val('timezone') || null;
    // Case jamais réglée (valeur absente) et laissée décochée : rien n'est écrit.
    for (const el of box.querySelectorAll('[data-b]')) nf[el.dataset.b] = f[el.dataset.b] == null && !el.checked ? f[el.dataset.b] : el.checked;
    if (nf.delete_messages && (!nf.email || !nf.attach_audio)) return err('« Supprimer après l\'envoi » exige un e-mail et la pièce jointe audio.');
    const body = {}; for (const k of V_FIELDS) if (!same(nf[k], f[k])) body[k] = nf[k];
    if (!Object.keys(body).length) { toast('Aucune modification.'); return true; }
    if (nf.delete_messages) Object.assign(body, { delete_messages: true, email: nf.email, attach_audio: nf.attach_audio });
    const cur = await api('GET', `/voicemails/${v.id}`);
    if (!same(vmCfg(cur), f)) return err(changedElsewhere('Cette messagerie').message);
    try { await runWrites([{ label: 'messagerie', run: () => api('PUT', `/voicemails/${v.id}`, body) }]); } catch (e) { return err(e.message); }
    toast(`Messagerie « ${nf.name} » enregistrée.`);
    onDone();
    return true;
  }, 'Enregistrer');
  $('vm-show').onchange = (e) => { $('modal-body').querySelector('[data-f="password"]').type = e.target.checked ? 'text' : 'password'; };
}
