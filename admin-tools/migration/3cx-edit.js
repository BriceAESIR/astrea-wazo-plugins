// Migration Assistant — tableaux modifiables du brouillon d'import 3CX.
// Modèle et règles : 3cx-draft.js. Chaque modification est enregistrée dans le
// navigateur (brouillon par fichier et date de sauvegarde) ; rien n'est écrit
// dans Wazo depuis ces tableaux.
import { $, esc, toast, helpButton, helpBox, confirmModal, downloadJson } from '../common/core.js?v=0.40.63';
import { I } from './inventory.js?v=0.40.63';
import {
  GROUP_STRATEGIES, MODES, HUNT_TARGETS, LICENCES, AUTH_METHODS, effectiveUsername, isVoix, applyLicence, fillCallerIds, callerIdWazo, upgradeDraft, saveDraft, clearDraft, buildDraft, acceptDraft, userBy, userName, imported,
  destLabel, destProblem, draftIssues, usersCsv, blfRows, devicesCsv, deviceDesc, macWazo, macValid, tenantIssues,
  LINE_MODES, linesOf, VM_LANGS, vmEmail, upperName, upgradeSchedules, pastHolidays, didWazo, VERIFY,
} from './3cx-draft.js?v=0.40.63';
import { setWizard, wizardTab, wizardChange, wizardClick, wizardDone, wizardTotal } from './3cx-wizard.js?v=0.40.63';
import { unitCfg, unitLabels, autoRanges, RANGE_KEYS, rangeIssues, unitPrefix, wazoNum, wazoNumOf, renumbers, numberIssues } from './3cx-sites.js?v=0.40.63';
import { rangesText } from './multisite.js?v=0.40.63';
import { WAZO_FIELDS, tagsOf, tagLabel, tagChecked, ensurePhonebook, phonebookName, phonebookIssues, companyContacts, personalCsv, toWazoContact, csvKeys } from './3cx-phonebook.js?v=0.40.63';
import { SORTS, CATEGORY_RE, soundUsages, ensureSounds, mohLabel, soundCategory, FILES, keyOf, loaded, addFiles, addFileAs, targetName } from './3cx-sounds.js?v=0.40.63';
import { DEPT_MODES, deptLabel, ensureDepts, deptObjects, unitOf, unitList, setDeptMode, moveObject } from './3cx-depts.js?v=0.40.63';

const E = { d: null, m: null, file: '', tab: 'users', sel: { users: new Set(), dids: new Set(), vms: new Set() }, q: '', onReset: null };
export const TABS = [
  // Ordre essayé selon la trame (0.40.58), puis remis comme avant à la demande de Brice (0.40.59).
  ['fiche', 'Fiche 3CX'], ['depts', 'Départements'], ['users', 'Utilisateurs'], ['vms', 'Messageries'], ['devices', 'Appareils'], ['hunts', 'Groupes et files'], ['ivrs', 'SVI'], ['dids', 'SDA'], ['scheds', 'Horaires'], ['sounds', 'Sons'], ['phonebook', 'Annuaire'], ['checks', 'Contrôles'], ['exports', 'Exports'], ['write', 'Écriture'],
];
// Brouillon complété (versions précédentes, champs ajoutés depuis) : même chaîne à
// l'ouverture, au chargement d'un fichier et à la réinitialisation.
const normalize = (d, m) => ensurePhonebook(ensureSounds(ensureDepts(upgradeSchedules(fillCallerIds(upgradeDraft(d), m), m), m), m), m);
export function setDraft(d, m, file, onReset) { E.d = normalize(d, m); E.m = m; E.file = file; E.onReset = onReset; E.sel.users.clear(); E.sel.dids.clear(); E.sel.vms.clear(); E.review = null; setWizard(E.d, m); }
export const draft = () => E.d;
// Contextes cibles (choisis dans Exports, gardés dans le brouillon) : ceux du
// tenant ouvert ; à défaut, le premier interne / entrant du tenant.
function tenantCtx() {
  const ctxs = I.lists.context || [];
  const pick = (cur, type) => (ctxs.some((c) => c.name === cur && c.type === type) ? cur : (ctxs.find((c) => c.type === type)?.name || ''));
  return { ctx: pick(E.d.ctx, 'internal'), incallCtx: pick(E.d.incallCtx, 'incall') };
}
const tenantChecks = () => tenantIssues(E.d, { ...tenantCtx(), numOf: (u) => wazoNum(E.d, u) }, { contexts: I.lists.context, extensions: I.lists.extension, users: I.lists.user, voicemails: I.lists.voicemail });
export function tabCounts() {
  const d = E.d; if (!d) return {};
  const iss = [...draftIssues(d), ...tenantChecks()];
  const snd = Object.entries(d.sounds?.files || {}).filter(([, x]) => x.to !== 'skip');
  return { phonebook: (d.phonebook?.contacts || []).filter((c) => c.import).length, depts: unitList(d).filter((u) => u.key !== '_').length || undefined, sounds: `${snd.filter(([f]) => loaded(f)).length}/${snd.length}`, users: imported(d).length, vms: d.users.filter((u) => u.mode !== 'skip' && u.vm).length, devices: (d.devices || []).filter((x) => x.import).length, hunts: d.hunts.filter((h) => h.target !== 'skip').length, ivrs: d.ivrs.filter((v) => v.import).length, dids: d.dids.filter((r) => r.import).length, scheds: d.schedules.length, checks: iss.filter((x) => x.sev !== 'info').length, write: `${wizardDone()}/${wizardTotal()}` };
}

// ---------------------------------------------------------------------------
// Briques
// ---------------------------------------------------------------------------
const get = (path) => path.split('.').reduce((o, k) => o?.[k], E.d);
function set(path, v) { const ks = path.split('.'); const last = ks.pop(); const o = ks.reduce((x, k) => x[k], E.d); o[last] = v; }
const destKey = (x) => (x ? `${x.t}:${x.t === 'ext' ? '' : (x.ref || '')}` : 'none:');
// Options de destination (construites une fois par rendu).
function destOptions() {
  const d = E.d;
  const o = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
  const grp = (label, items) => (items.length ? `<optgroup label="${esc(label)}">${items.join('')}</optgroup>` : '');
  return o('none:', 'Aucune') + o('hangup:', 'Raccrocher') + o('ext:', 'Numéro externe…') + o('sound:holiday', 'Message du jour férié')
    + grp('Utilisateurs', d.users.filter((u) => u.mode === 'user').map((u) => o(`user:${u.n}`, `${u.n} ${userName(u)}`)))
    + grp('Groupes et files', d.hunts.filter((h) => h.target !== 'skip').map((h) => o(`hunt:${h.n}`, `${h.n} ${h.name} (${h.target === 'group' ? 'groupe' : 'file'})`)))
    + grp('SVI', d.ivrs.filter((v) => v.import).map((v) => o(`ivr:${v.n}`, `SVI ${v.n} ${v.name}`)))
    + grp('Messageries', d.users.filter((u) => u.mode !== 'skip' && u.vm).map((u) => o(`vm:${u.n}`, `Messagerie ${u.n} ${userName(u)}`)));
}
function destCell(path, opts) {
  const x = get(path);
  const p = destProblem(E.d, x);
  return `<div class="x3-dest${p ? ' bad' : ''}" title="${esc(p ? `${destLabel(E.d, x)} : ${p}` : destLabel(E.d, x))}">
    <select data-dest="${path}" data-val="${esc(destKey(x))}" data-label="${esc(destLabel(E.d, x))}">${opts}</select>
    ${x?.t === 'ext' ? `<input data-destnum="${path}" value="${esc(x.num || '')}" placeholder="0612345678" class="x3-num">` : ''}
    ${x?.fixed ? `<span class="x3-note" title="${esc(x.fixed)}">corrigé</span>` : ''}</div>`;
}
const input = (path, attrs = '') => `<input data-p="${path}" value="${esc(get(path) ?? '')}" ${attrs}>`;
const num = (path, min, max) => `<input type="number" data-p="${path}" data-type="num" min="${min}" max="${max}" value="${esc(get(path) ?? '')}" class="x3-short">`;
const check = (path, title = '') => `<input type="checkbox" data-p="${path}" data-type="bool" ${get(path) ? 'checked' : ''} title="${esc(title)}">`;
const sel = (path, map) => `<select data-p="${path}">${Object.entries(map).map(([k, l]) => `<option value="${esc(k)}" ${get(path) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
// Licence : valeur entière ou null (« À choisir », sans défaut : retour terrain du 20/10).
const licSel = (path) => { const v = get(path); return `<select data-p="${path}" data-type="int" class="${v == null ? 'x3-todo' : ''}"><option value="" ${v == null ? 'selected' : ''}>À choisir</option>${Object.entries(LICENCES).map(([k, l]) => `<option value="${k}" ${v === Number(k) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`; };
// Une colonne libellée « [all:users] » devient la case « tout sélectionner » (lignes affichées).
const head = (cols) => `<thead><tr>${cols.map(([l, h]) => { const m = l.match(/^\[all:(\w+)\]$/); return m ? `<th><input type="checkbox" data-selall="${m[1]}" title="Tout sélectionner (lignes affichées)"></th>` : `<th${h ? ` title="${esc(h)}"` : ''}>${esc(l)}</th>`; }).join('')}</tr></thead>`;
const intro = (id, title, text, extra = '') => `<div class="titlerow"><h3>${esc(title)}</h3>${helpButton(`x3e-${id}`, `Aide : ${title}`)}${extra}</div>${helpBox(`x3e-${id}`, text)}`;

// ---------------------------------------------------------------------------
// Rendu des onglets
// ---------------------------------------------------------------------------
export function renderTab(root, tab) {
  E.tab = tab;
  // Un seul défilement : celui de la page (#workbench), gardé d'un rendu à l'autre.
  const wb = document.getElementById('workbench'); const keepWb = wb ? [wb.scrollTop, wb.scrollLeft] : null;
  const keep = [...root.querySelectorAll('.x3-edit-wrap')].map((w) => w.x3left || 0);
  const opts = destOptions();
  const html = { phonebook: phonebookTab, sounds: soundsTab, depts: deptsTab, users: usersTab, vms: vmsTab, devices: devicesTab, hunts: huntsTab, ivrs: ivrsTab, dids: didsTab, scheds: schedsTab, checks: checksTab, exports: exportsTab, write: wizardTab }[tab]?.(opts) || '';
  root.innerHTML = html;
  // Listes à valeur posée après rendu (utilisateur d'un appareil).
  for (const s of root.querySelectorAll('select[data-p][data-val]')) {
    if (![...s.options].some((o) => o.value === s.dataset.val)) s.insertAdjacentHTML('beforeend', `<option value="${esc(s.dataset.val)}">${esc(s.dataset.val)} (non repris)</option>`);
    s.value = s.dataset.val;
  }
  // Valeur des listes de destinations (avec la cible absente si besoin).
  for (const s of root.querySelectorAll('select[data-dest]')) {
    if (![...s.options].some((o) => o.value === s.dataset.val)) s.insertAdjacentHTML('beforeend', `<option value="${esc(s.dataset.val)}">${esc(s.dataset.label)}</option>`);
    s.value = s.dataset.val;
  }
  // Case « tout sélectionner » : cochée si toutes les lignes affichées le sont (sinon elle
  // restait décochée après chaque rendu et un clic ne pouvait que recocher : retour de Brice).
  for (const a of root.querySelectorAll('input[data-selall]')) {
    const rows = [...root.querySelectorAll(`input[data-sel="${a.dataset.selall}"]`)];
    const n = rows.filter((x) => x.checked).length;
    a.checked = rows.length > 0 && n === rows.length; a.indeterminate = n > 0 && n < rows.length;
  }
  root.querySelectorAll('.x3-edit-wrap').forEach((w, i) => hscroll(w, keep[i] || 0));
  if (keepWb) [wb.scrollTop, wb.scrollLeft] = keepWb;
  root.onchange = (e) => onChange(e, root);
  root.onclick = (e) => onClick(e, root);
  // Glisser-déposer des fichiers son (onglet Sons).
  // Sur une ligne (data-drop-as) : le fichier est rattaché au fichier 3CX de cette ligne.
  root.ondragover = (e) => { if (e.target.closest?.('[data-drop],[data-drop-as]')) e.preventDefault(); };
  root.ondrop = (e) => {
    const slot = e.target.closest?.('[data-drop-as]'); const zone = e.target.closest?.('[data-drop]');
    if (!slot && !zone) return; e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (slot) loadSoundAs(files[0], slot.dataset.dropAs, root); else loadSounds(files, root);
  };
  root.oninput = (e) => { if (e.target.id === 'x3e-q') { E.q = e.target.value; renderTab(root, tab); const q = $('x3e-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); } };
}

// Tableau plus large que l'écran (retour de Brice, 04/11/2026 : en demi-écran, la
// barre horizontale n'était qu'en bas de la page) : le tableau est coupé à la
// largeur de la page (overflow: clip, qui ne crée pas de zone de défilement :
// l'en-tête reste collé en haut), décalé par translateX, et piloté par sa propre
// barre collée en bas de l'écran. Molette avec Maj, ou glissement horizontal,
// et champ qui prend le focus : la barre suit.
function hscroll(wrap, left = 0) {
  const table = wrap.querySelector('table'); if (!table) return;
  const bar = document.createElement('div'); bar.className = 'x3-hbar'; bar.innerHTML = '<div></div>';
  wrap.after(bar);
  const fit = () => {
    const over = table.offsetWidth - wrap.clientWidth;
    bar.hidden = over <= 1; bar.firstChild.style.width = `${table.offsetWidth}px`;
    if (over <= 1) { bar.scrollLeft = 0; table.style.transform = ''; wrap.x3left = 0; }
  };
  const move = () => { wrap.x3left = bar.scrollLeft; table.style.transform = bar.scrollLeft ? `translateX(${-bar.scrollLeft}px)` : ''; };
  bar.addEventListener('scroll', move);
  wrap.addEventListener('wheel', (e) => {
    if (bar.hidden) return;
    const dx = e.shiftKey ? (e.deltaX || e.deltaY) : (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0);
    if (!dx) return; e.preventDefault(); bar.scrollLeft += dx;
  }, { passive: false });
  wrap.addEventListener('focusin', (e) => {
    if (bar.hidden) return;
    const r = e.target.getBoundingClientRect(); const w = wrap.getBoundingClientRect();
    if (r.right > w.right) bar.scrollLeft += r.right - w.right + 24; else if (r.left < w.left) bar.scrollLeft -= w.left - r.left + 24;
  });
  new ResizeObserver(fit).observe(wrap);
  fit(); bar.scrollLeft = left; move();
}

const USER_HELP = 'Une ligne par poste 3CX. « Vérifier un par un » ouvre la fiche de chaque utilisateur (nom, e-mail, licence, connexion, renvois, appareil) avec ses problèmes : « Valider et suivant » le marque vérifié. Licence : à choisir pour chacun (aucune valeur par défaut : les licences sont décomptées par le portail). Identifiant de connexion : vide = l\'e-mail, comme l\'import Wazo. Licence Voix : ni identifiant, ni méthode, ni accès aux applications (rien à saisir, comme User Manager). Méthode de connexion et accès aux applications ne passent pas par le CSV : à régler après l\'import. Reprise : utilisateur Wazo (ligne SIP + numéro), messagerie seule (boîte vocale sans utilisateur, pour les répondeurs) ou non repris. Les noms en italique sont déduits de l\'e-mail. Sonnerie : durée avant le débordement « pas de réponse » (ring_seconds). Renvois du profil 3CX « Disponible » → débordements de l\'utilisateur Wazo (pas de réponse, occupé, indisponible). « corrigé » : un renvoi vers un numéro du client a été remplacé par sa destination. Touches : reprendre les BLF de ce poste. Lignes (fiche « Vérifier un par un » ou action groupée) : en Auto, une ligne SIP pour le téléphone et, si les applications sont autorisées hors licence Voix, une ligne WebRTC au même numéro ; identifiant d\'authentification de chaque ligne = nom de son endpoint, comme l\'import de Wazo. Messagerie : réglages dans l\'onglet Messageries. Cochez des lignes pour une modification groupée.';
// Numéro présenté : saisie libre, SDA du client proposées (liste x3-cids, posée par usersTab).
const cidInput = (path) => input(path, 'class="x3-num" list="x3-cids" placeholder="défaut" title="Vide : défaut (numéro du trunk) ; anonymous : masqué"');
const cidList = (d) => `<datalist id="x3-cids">${[...new Set((d.dids || []).map((r) => callerIdWazo(r.did)).filter(Boolean))].map((n) => `<option value="${esc(n)}">`).join('')}<option value="anonymous"></datalist>`;
// Numéro Wazo modifiable (nouvelle base) : vide = numéro calculé (préfixe du site + numéro 3CX, ou numéro 3CX).
const numInput = (path, o) => input(path, `class="x3-short" inputmode="numeric" placeholder="${esc(wazoNum(E.d, { ...o, wn: '' }))}" title="Numéro dans Wazo ; vide : ${esc(wazoNum(E.d, { ...o, wn: '' }))} (calculé)"`);
// Numéro 3CX rappelé seulement quand le numéro Wazo en diffère.
const was3cx = (d, o) => (wazoNum(d, o) !== o.n ? `<div class="muted small">${esc(o.n)} dans 3CX</div>` : '');
// Vérification objet par objet (comme les utilisateurs) : compteur et « tout marquer vérifié ».
const VERIFIED_TIP = 'Objet contrôlé : case à cocher une fois relu (rappel dans l\'onglet Écriture tant qu\'il en reste)';
const verifyBar = (tab) => { const v = VERIFY[tab]; const l = v.list(E.d); const done = l.filter((o) => o[v.key]).length; return l.length ? `<span class="small ${done < l.length ? 'x3-warn' : 'muted'}">${done}/${l.length} vérifié(s)</span>${done < l.length ? `<button data-act="verify-all" data-tab="${tab}" title="Cocher « Vérifié » pour tous les objets repris de cet onglet">Tout marquer vérifié</button>` : ''}` : ''; };
const VOIX_NOTE = 'Licence Voix : pas d\'accès aux applications Wazo, rien à saisir (identifiant, méthode, accès), comme dans User Manager. Le CSV laisse l\'identifiant vide : Wazo prend l\'e-mail, sinon l\'identifiant interne. Aucun mot de passe généré.';
function usersTab(opts) {
  const d = E.d; const q = E.q.trim().toLowerCase();
  const list = d.users.map((u, i) => [u, i]).filter(([u]) => !q || `${u.n} ${userName(u)} ${u.email}`.toLowerCase().includes(q));
  const rows = list.map(([u, i]) => {
    const p = `users.${i}`; const on = u.mode === 'user';
    return `<tr class="${u.mode !== 'user' ? 'x3-off' : ''}${E.sel.users.has(i) ? ' sel' : ''}${on && !u.checked ? ' x3-unchecked' : ''}">
      <td><input type="checkbox" data-sel="users" data-i="${i}" ${E.sel.users.has(i) ? 'checked' : ''}></td>
      <td class="x3-c">${on ? check(`${p}.checked`, 'Utilisateur vérifié') : ''}</td>
      <td>${numInput(`${p}.wn`, u)}${was3cx(d, u)}${u.src.enabled ? '' : '<div class="muted small">désactivé 3CX</div>'}</td>
      <td>${sel(`${p}.mode`, MODES)}</td>
      <td>${on ? licSel(`${p}.sub`) : ''}</td>
      <td>${input(`${p}.first`, `class="${u.guessed ? 'x3-guess' : ''}" title="${esc(`Dans 3CX : ${[u.src.first, u.src.last].filter(Boolean).join(' ') || 'vide'}`)}"`)}</td>
      <td>${input(`${p}.last`)}</td>
      <td>${input(`${p}.email`, 'type="email" class="x3-mail"')}</td>
      ${on && isVoix(u) ? `<td colspan="3" class="muted small" title="${esc(VOIX_NOTE)}">Licence Voix : pas d'accès aux applications</td>` : `<td>${on ? input(`${p}.username`, `placeholder="${esc(u.email || 'identifiant')}" class="x3-mail" title="Vide : Wazo prend l'e-mail comme identifiant (comme l'import Wazo)"`) : ''}</td>
      <td>${on ? sel(`${p}.authMethod`, AUTH_METHODS) : ''}</td>
      <td class="x3-c">${on ? check(`${p}.appAccess`, 'Autorisé à utiliser les applications Wazo') : ''}</td>`}
      <td>${input(`${p}.mobile`, 'class="x3-num"')}</td>
      <td>${on ? cidInput(`${p}.callerId`) : ''}</td>
      <td class="x3-c">${check(`${p}.vm`, 'Messagerie')}${u.vm ? `<button class="x3-link x3-mini" data-act="goto-vms" title="Réglages de la messagerie (onglet Messageries)">${esc(vmSummary(u))}</button>` : ''}</td>
      <td>${on ? num(`${p}.ring`, 5, 300) : ''}</td>
      <td>${on ? destCell(`${p}.fb.noanswer`, opts) : ''}</td>
      <td>${on ? destCell(`${p}.fb.busy`, opts) : ''}</td>
      <td>${on ? destCell(`${p}.fb.fail`, opts) : ''}</td>
      <td class="x3-c">${on ? check(`${p}.blf`, 'Reprendre les touches BLF de ce poste') : ''}</td>
      <td class="small">${(d.devices || []).filter((x) => x.owner === u.n).map((x) => `${esc(x.model)}<div class="muted">${esc(x.mac)}${x.import ? '' : ' (non repris)'}</div>`).join('') || '<span class="muted">aucun</span>'}</td>
    </tr>`;
  }).join('');
  const n = E.sel.users.size;
  const imp = imported(d); const done = imp.filter((u) => u.checked).length;
  return `${intro('users', 'Utilisateurs', USER_HELP, `<label class="inline small" title="Met le nom de tous les utilisateurs en majuscules, et ceux saisis ensuite (Tessier → TESSIER). Décocher ne rétablit pas l'ancienne casse.">${check('upperLast')} NOM en majuscules</label><button data-act="review-start" class="${done < imp.length ? 'primary' : ''}">Vérifier un par un (${done}/${imp.length})</button><input id="x3e-q" type="search" placeholder="Filtrer" value="${esc(E.q)}" class="x3-q">`)}
    ${cidList(d)}
    ${E.review != null ? reviewPanel(opts) : ''}
    ${n ? '' : '<p class="x3-bulk-hint muted small">Cochez des lignes pour les modifier en groupe (reprise, licence, connexion, lignes, nom en majuscules, sonnerie, renvois, messagerie).</p>'}
    <div class="x3-bulk"${n ? '' : ' hidden'}>
      <strong>${n} sélectionné(s)</strong>
      <label>Reprise <select id="xb-mode"><option value="">inchangée</option>${Object.entries(MODES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <label>Licence <select id="xb-sub"><option value="">inchangée</option>${Object.entries(LICENCES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <label>Méthode <select id="xb-auth"><option value="">inchangée</option>${Object.entries(AUTH_METHODS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <label>Applications <select id="xb-app"><option value="">inchangé</option><option value="1">autorisées</option><option value="0">refusées</option></select></label>
      <label>Lignes <select id="xb-lines"><option value="">inchangées</option>${Object.entries(LINE_MODES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <label>Nom <select id="xb-last"><option value="">inchangé</option><option value="upper">en MAJUSCULES</option></select></label>
      <label>Numéro présenté <input id="xb-cid" list="x3-cids" placeholder="inchangé ; - = défaut" class="x3-num"></label>
      <label>Sonnerie <input id="xb-ring" type="number" min="5" max="300" placeholder="s" class="x3-short"></label>
      <label>Renvoi <select id="xb-fbk"><option value="all">tous</option><option value="noanswer">pas de réponse</option><option value="busy">occupé</option><option value="fail">indisponible</option></select></label>
      <label>vers <select id="xb-dest"><option value="keep">inchangé</option>${opts}</select></label>
      <input id="xb-num" placeholder="numéro externe" class="x3-num">
      <label>Messagerie <select id="xb-vmset"><option value="">inchangée</option><option value="1">activer</option><option value="0">désactiver</option></select></label>
      <button data-act="bulk-users" ${n ? '' : 'disabled'}>Appliquer</button>
    </div>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['[all:users]'], ['Vérifié', 'Utilisateur contrôlé (fiche « Vérifier un par un » ou case)'], ['N°'], ['Reprise', 'Utilisateur, messagerie seule ou non repris'], ['Licence', 'subscription_type : Voix, Communication unifiée, Relation client'], ['Prénom'], ['Nom'], ['E-mail'], ['Identifiant', 'Identifiant de connexion aux applications ; vide = e-mail'], ['Méthode', 'Méthode de connexion du compte des applications (non portée par le CSV)'], ['Applis', 'Accès aux applications Wazo (non porté par le CSV)'], ['Mobile'], ['Numéro présenté', 'OutboundCallerID du poste 3CX → outgoing_caller_id ; vide = défaut (numéro du trunk) ; anonymous = masqué'], ['Messagerie'], ['Sonnerie', 'Secondes avant « pas de réponse »'], ['Pas de réponse'], ['Occupé'], ['Indisponible', 'Poste non enregistré ou injoignable (chanunavail)'], ['Touches'], ['Appareil']])}<tbody>${rows}</tbody></table></div>`;
}

// Fiche de vérification d'un utilisateur (retour terrain du 20/10 : rien ne
// demandait de contrôler chaque utilisateur). Mêmes champs que le tableau,
// avec ses problèmes ; « Valider et suivant » coche Vérifié et passe au
// prochain non vérifié.
function reviewPanel(opts) {
  const d = E.d;
  const imp = imported(d);
  if (!imp.length) { E.review = null; return ''; }
  const k = Math.max(0, Math.min(E.review, imp.length - 1)); E.review = k;
  const u = imp[k]; const i = d.users.indexOf(u); const p = `users.${i}`;
  const iss = draftIssues(d).filter((x) => x.area === `Utilisateur ${u.n}` || x.area.startsWith(`Utilisateur ${u.n} `));
  const devs = (d.devices || []).filter((x) => x.owner === u.n);
  const blf = blfRows(d, E.m).filter((b) => b.owner === u.n);
  const f = (label, html, hint = '') => `<label class="x3-rf"><span>${esc(label)}</span>${html}${hint ? `<small class="muted">${esc(hint)}</small>` : ''}</label>`;
  return `<div class="card x3-review">
    <div class="x3-review-head"><strong>Utilisateur ${esc(wazoNum(d, u))}${wazoNum(d, u) !== u.n ? ` (${esc(u.n)} dans 3CX)` : ''} · ${esc(userName(u))}</strong><span class="muted small">${k + 1} / ${imp.length}${u.checked ? ' · vérifié' : ''}</span><span class="spacer"></span><button class="icon" data-act="review-close" title="Fermer">×</button></div>
    ${iss.length ? `<div class="x3-review-iss">${iss.sort(bySev).map((x) => `<div class="${x.sev === 'error' ? 'compat blocking' : x.sev === 'warn' ? 'warn' : 'muted small'}">${esc(x.text)}</div>`).join('')}</div>` : '<p class="small x3-ok">Aucun problème pour cet utilisateur.</p>'}
    <div class="x3-review-grid">
      ${f('Numéro dans Wazo', numInput(`${p}.wn`, u), `${u.n} dans 3CX ; vide : ${wazoNum(d, { ...u, wn: '' })} (calculé). Touches, renvois et SDA suivent.`)}
      ${f('Prénom', input(`${p}.first`), u.guessed ? `déduit de l'e-mail ; dans 3CX : ${[u.src.first, u.src.last].filter(Boolean).join(' ') || 'vide'}` : '')}
      ${f('Nom', input(`${p}.last`))}
      ${f('E-mail', input(`${p}.email`, 'type="email"'), 'Unique sur tout le serveur ; obligatoire pour Communication unifiée et Relation client.')}
      ${f('Mobile', input(`${p}.mobile`))}
      ${f('Numéro présenté', cidInput(`${p}.callerId`), `Dans 3CX : ${E.m?.extensions?.find((e) => e.number === u.n)?.callerId || 'vide'}. Vide = défaut (numéro du trunk) ; anonymous = masqué. Écrit en +33…, comme les numéros créés dans Wazo.`)}
      ${f('Licence', licSel(`${p}.sub`), 'Voix : téléphonie seule. Communication unifiée : applications Wazo. Relation client : Support Center et POPC en plus.')}
      ${isVoix(u) ? f('Compte des applications', '<span class="small">rien à saisir</span>', VOIX_NOTE) : `${f('Identifiant de connexion', input(`${p}.username`, `placeholder="${esc(u.email || '')}"`), `Vide : ${effectiveUsername(u) ? `« ${effectiveUsername(u)} » (e-mail)` : 'identifiant interne'}.`)}
      ${f('Méthode de connexion', sel(`${p}.authMethod`, AUTH_METHODS), 'Non portée par le CSV : à régler après l\'import.')}
      ${f('Applications Wazo', `<span>${check(`${p}.appAccess`)} autorisées</span>`, 'Non porté par le CSV.')}`}
      ${f('Lignes', sel(`${p}.lines`, LINE_MODES), `Créées : ${linesOf(u).map((t) => `${t === 'sip' ? 'SIP' : 'WebRTC'} ${u.n}`).join(' + ')} (même numéro). Identifiant d'authentification = nom de l'endpoint, comme l'import de Wazo.`)}
      ${vmFields(p, u, f)}
      ${f('Sonnerie (s)', num(`${p}.ring`, 5, 300))}
      ${f('Pas de réponse', destCell(`${p}.fb.noanswer`, opts))}
      ${f('Occupé', destCell(`${p}.fb.busy`, opts))}
      ${f('Indisponible', destCell(`${p}.fb.fail`, opts))}
      ${f('Appareil', `<span class="small">${devs.map((x) => `${esc(x.model)} ${esc(x.mac)} · « ${esc(deviceDesc(d, x))} »${x.import ? '' : ' (non repris)'}`).join('<br>') || 'aucun'}</span>`, 'Modifiable dans l\'onglet Appareils.')}
      ${f('Touches', `<span class="small">${check(`${p}.blf`)} reprendre (${blf.filter((b) => b.ok).length} sur ${blf.length})</span>`)}
    </div>
    <div class="btnrow"><button data-act="review-prev" ${k ? '' : 'disabled'}>Précédent</button><button data-act="review-next">Suivant sans valider</button><span class="spacer"></span><button data-act="review-ok" class="primary">Valider et suivant</button></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Annuaire de la société (demande de Brice, 04/11/2026). Règles et API : 3cx-phonebook.js.
// ---------------------------------------------------------------------------
const PB_HELP = 'Annuaire de la société 3CX et contacts personnels des postes. Correspondance : chaque champ 3CX et le champ Wazo qui le reçoit (« vérifié » : contrôlé sur une fiche 3CX ; sinon supposé, d\'après l\'ordre de la fiche). Comparez l\'exemple avec la fiche d\'un contact dans 3CX et corrigez ici : tous les contacts suivent. Numéro principal Wazo, à défaut : bureau, domicile, mobile. Dans Wazo : un carnet d\'adresses (wazo-dird) rempli contact par contact, puis une source d\'annuaire ajoutée au profil d\'annuaire du site, pour que les postes et les applications le consultent et affichent le nom à la réception d\'un appel (phase Fondations). Contacts personnels : Wazo ne les accepte qu\'avec le jeton de l\'utilisateur lui-même (wazo-dird /personal) ; l\'outil donne un CSV par poste, au format d\'import de Wazo, ou peut les verser dans le carnet de la société (visibles alors par tous).';
function phonebookTab() {
  const d = E.d; const pb = d.phonebook; const q = E.q.trim().toLowerCase();
  const tags = tagsOf(E.m); const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
  const all = [...pb.contacts, ...pb.personal];
  const sample = (t) => all.find((c) => c.raw?.[t])?.raw[t] || '';
  const mapRows = tags.map((t) => { const k = pb.map[t]; const cur = k || pb.mapPrev?.[t] || ''; return `<tr class="${k ? '' : 'x3-off'}">
    <td class="x3-c"><input type="checkbox" data-pb-keep="${esc(t)}" ${k ? 'checked' : ''} title="Reprendre ce champ"></td>
    <td>${esc(tagLabel(t))}<div class="muted small">${esc(t)}${tagChecked(t) ? ' · vérifié' : ' · supposé'}</div></td>
    <td class="small">${pb.contacts.filter((c) => c.raw?.[t]).length} / ${pb.personal.filter((c) => c.raw?.[t]).length}</td>
    <td class="small">${esc(sample(t))}</td>
    <td><select data-pb-map="${esc(t)}" ${k ? '' : 'disabled'}>${cur ? '' : opt('', 'À choisir', '')}${Object.entries(WAZO_FIELDS).map(([w, l]) => opt(w, l, cur)).join('')}</select></td></tr>`; }).join('');
  // Contacts de la société : une colonne par champ 3CX repris.
  const cols = tags.filter((t) => pb.map[t]);
  const rows = pb.contacts.map((c, i) => [c, i]).filter(([c]) => !q || Object.values(c.raw || {}).some((v) => String(v).toLowerCase().includes(q))).map(([c, i]) => `<tr class="${c.import ? '' : 'x3-off'}">
    <td class="x3-c">${check(`phonebook.contacts.${i}.import`, 'Reprendre ce contact')}</td>
    ${cols.map((t) => `<td>${input(`phonebook.contacts.${i}.raw.${t}`, pb.map[t] === 'email' ? 'type="email" class="x3-mail"' : '')}</td>`).join('')}
    <td><button class="icon" data-act="pb-del" data-i="${i}" title="Supprimer ce contact">×</button></td></tr>`).join('');
  // Contacts personnels, par poste.
  const owners = [...new Set(pb.personal.map((c) => c.owner))].sort((a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true }));
  const persRows = owners.map((o) => { const n = pb.personal.filter((c) => c.owner === o && c.import).length; const u = userBy(d, o); return `<tr><td>${esc(o)} ${u ? esc(userName(u)) : ''}${u && u.mode !== 'user' ? '<div class="muted small">poste non repris</div>' : ''}</td><td class="small">${n} contact(s)</td><td>${n ? `<button data-act="pb-csv" data-o="${esc(o)}">CSV</button>` : ''}</td></tr>`; }).join('');
  const iss = phonebookIssues(d);
  return `${intro('phonebook', 'Annuaire', PB_HELP, `<input id="x3e-q" type="search" placeholder="Filtrer" value="${esc(E.q)}" class="x3-q">`)}
    <div class="ms-tools small"><label>Carnet Wazo <input data-pb-name="1" value="${esc(pb.name)}" placeholder="${esc(phonebookName(d))}" class="x3-mail"></label>
      <span class="muted">${companyContacts(d).length} contact(s) envoyés au carnet</span></div>
    <h4 class="x3-h">Correspondance des champs</h4>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Reprise'], ['Champ 3CX'], ['Contacts', 'Société / personnels où ce champ est rempli'], ['Exemple'], ['Champ Wazo']])}<tbody>${mapRows || '<tr><td colspan="5" class="muted">Aucun contact dans la sauvegarde.</td></tr>'}</tbody></table></div>
    ${iss.length ? `<div class="small">${iss.slice(0, 8).map((x) => `<div class="warn">${esc(x.text)}</div>`).join('')}${iss.length > 8 ? `<div class="muted">… et ${iss.length - 8} autre(s)</div>` : ''}</div>` : ''}
    <h4 class="x3-h">Annuaire de la société (${pb.contacts.length})</h4>
    <div class="btnrow"><button data-act="pb-all" data-v="1">Tout reprendre</button><button data-act="pb-all" data-v="0">Ne rien reprendre</button><button data-act="pb-add">+ contact</button></div>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Reprise'], ...cols.map((t) => [`${tagLabel(t)} → ${WAZO_FIELDS[pb.map[t]]}`]), ['']])}<tbody>${rows || `<tr><td colspan="${cols.length + 2}" class="muted">Aucun contact.</td></tr>`}</tbody></table></div>
    <h4 class="x3-h">Contacts personnels des postes (${pb.personal.length})</h4>
    ${pb.personal.length ? `<label class="inline small"><input type="checkbox" data-pb-incl="1" ${pb.includePersonal ? 'checked' : ''}> Les verser aussi dans le carnet de la société (visibles par tous, doublons retirés)</label>
    <div class="btnrow"><button data-act="pb-csv-all">CSV de tous les postes (colonne « poste »)</button></div>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Poste'], ['Contacts'], ['Export', 'CSV au format d\'import des contacts personnels de Wazo, à importer par l\'utilisateur']])}<tbody>${persRows}</tbody></table></div>` : '<p class="muted small">Aucun contact personnel dans la sauvegarde.</p>'}`;
}

// ---------------------------------------------------------------------------
// Sons et musiques d'attente (demande de Brice, 04/11/2026). Règles et API :
// 3cx-sounds.js. Les fichiers restent dans la mémoire de la page : à redéposer
// après un rechargement.
// ---------------------------------------------------------------------------
// Fichier son d'une ligne : état, écoute, bouton « Déposer… » et zone de dépôt (le fichier
// déposé est rattaché à ce fichier 3CX, quel que soit son nom). Utilisé dans Sons, SVI,
// Groupes et files.
function soundSlot(f, { player = true } = {}) {
  if (!f) return '';
  const l = loaded(f);
  return `<div class="x3-slot" data-drop-as="${esc(f)}" title="Déposer un fichier ici pour « ${esc(f)} »">${l ? `${player ? `<audio controls preload="none" src="${esc(l.url)}"></audio>` : ''}<div class="muted">${l.seconds.toFixed(1)} s${l.source && keyOf(l.source) !== keyOf(f) ? ` · depuis « ${esc(l.source)} »` : ''} · ${esc(l.from)} → WAV 8 kHz mono 16 bits</div>` : '<span class="x3-warn">à déposer</span>'}
    <label class="x3-link">${l ? 'Remplacer' : 'Déposer'}…<input type="file" accept="audio/*,.wav,.mp3" data-snd-slot="${esc(f)}" hidden></label></div>`;
}
const SOUNDS_HELP ='La sauvegarde 3CX ne donne que le nom des fichiers son (répondeurs, SVI, messages de fermeture, musiques). Déposez ici les fichiers (récupérés dans la sauvegarde complète de 3CX, ou fournis par le client) : ils sont reconnus par leur nom, sans tenir compte de l\'extension, et convertis dans le navigateur en WAV 8 kHz mono 16 bits, le format exigé par Wazo pour une musique d\'attente. Ils restent dans la mémoire de la page (à redéposer après un rechargement) et sont envoyés par la phase Fondations (onglet Écriture). Reprise : décochez un fichier à ne pas reprendre (onhold.wav, fourni par 3CX lui-même, l\'est d\'office). Dans Wazo : une musique d\'attente, ou la catégorie de sons du client (messages : SVI, fermetures…). Musique d\'attente par défaut : réglée dans le modèle SIP global du site (option moh_suggest), comme le Wizard de déploiement de Wazo.';
// Destination proposée quand on recoche une ligne sans choix antérieur : musique si 3CX
// s'en sert comme musique, sinon son.
const keepTo = (r) => (r.uses.some((u) => u.kind === 'moh') ? `moh:${E.d.sounds.moh[0]?.key || 'attente'}` : 'sound');
function soundsTab() {
  const d = E.d; const s = d.sounds; const us = soundUsages(E.m);
  const known = new Set(us.map((u) => keyOf(u.file)));
  const rows = [...us, ...[...FILES.values()].filter((f) => !known.has(keyOf(f.name))).map((f) => ({ file: f.name, uses: [], extra: true }))];
  for (const r of rows) s.files[r.file] ||= { to: 'sound' };
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
  // « Ne pas reprendre » = case Reprise décochée (retour de Brice) ; le menu ne propose que la
  // destination dans Wazo, grisé et gardé (prev) tant que la ligne n'est pas reprise.
  const toSel = (r) => { const x = s.files[r.file]; const cur = x.to === 'skip' ? (x.prev || keepTo(r)) : x.to; return `<select data-snd-to="${esc(r.file)}" ${x.to === 'skip' ? 'disabled' : ''}>${s.moh.map((m) => opt(`moh:${m.key}`, `Musique d'attente « ${mohLabel(d, m)} »`, cur)).join('')}${opt('sound', `Son « ${soundCategory(d)} »`, cur)}</select>`; };
  const fileRows = rows.map((r) => {
    const to = s.files[r.file].to;
    return `<tr class="${to === 'skip' ? 'x3-off' : ''}"><td class="x3-c"><input type="checkbox" data-snd-keep="${esc(r.file)}" ${to === 'skip' ? '' : 'checked'} title="Reprendre ce fichier dans Wazo"></td><td>${esc(r.file)}<div class="muted small">${to === 'skip' ? '' : `Wazo : ${esc(targetName(E.d, r.file))}.wav`}</div></td>
      <td class="small">${r.uses.map((u) => esc(u.what)).join('<br>') || '<span class="muted">ajouté, non cité par 3CX</span>'}</td>
      <td>${toSel(r)}</td>
      <td class="small">${to === 'skip' && !loaded(r.file) ? '' : soundSlot(r.file)}</td></tr>`;
  }).join('');
  const count = (k) => Object.entries(s.files).filter(([, x]) => x.to === `moh:${k}`).length;
  const mohRows = s.moh.map((x, i) => `<tr><td class="x3-c"><input type="radio" name="x3-moh-def" data-moh-def="${esc(x.key)}" ${s.defaultMoh === x.key ? 'checked' : ''} title="Musique d'attente par défaut du site"></td>
    <td><input data-moh="${i}|label" value="${esc(x.label)}" placeholder="${esc(mohLabel(d, { key: x.key }))}" class="x3-mail"></td>
    <td><select data-moh="${i}|sort">${Object.entries(SORTS).map(([k, l]) => opt(k, l, x.sort)).join('')}</select></td>
    <td class="small">${count(x.key)} fichier(s)</td>
    <td>${s.moh.length > 1 ? `<button class="icon" data-act="moh-del" data-i="${i}" title="Retirer cette musique d'attente (ses fichiers ne sont plus repris)">×</button>` : ''}</td></tr>`).join('');
  const cat = soundCategory(d); const catOk = CATEGORY_RE.test(cat);
  const missing = rows.filter((r) => s.files[r.file].to !== 'skip' && !loaded(r.file)).length;
  return `${intro('sounds', 'Sons et musiques d\'attente', SOUNDS_HELP)}
    <div class="x3-drop" data-drop="1"><label class="filebtn"><input type="file" id="x3-snd-file" multiple accept="audio/*,.wav,.mp3" hidden><span>Déposer des fichiers son…</span></label>
      <span class="muted small">ou glissez-les ici · ${FILES.size} chargé(s)${missing ? ` · <span class="x3-warn">${missing} à déposer</span>` : ''}</span></div>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Reprise', 'Décoché : fichier non repris dans Wazo'], ['Fichier 3CX'], ['Utilisé par'], ['Dans Wazo'], ['Fichier chargé']])}<tbody>${fileRows || '<tr><td colspan="5" class="muted">Aucun fichier son dans la sauvegarde.</td></tr>'}</tbody></table></div>
    <h4 class="x3-h">Musiques d'attente à créer</h4>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Défaut', 'Musique d\'attente par défaut du site (modèle SIP global, moh_suggest)'], ['Nom'], ['Lecture', 'Ordre de lecture des fichiers'], ['Fichiers'], ['']])}<tbody>${mohRows}</tbody></table></div>
    <div class="btnrow"><button data-act="moh-add">+ musique d'attente</button></div>
    <h4 class="x3-h">Catégorie de sons</h4>
    <label class="small">Nom <input data-snd-cat="1" value="${esc(s.category)}" placeholder="${esc(cat)}" class="x3-mail${catOk ? '' : ' bad'}"></label>
    ${catOk ? '' : '<span class="x3-warn small"> lettres, chiffres, - _ . seulement, sans espace (règle de Wazo)</span>'}`;
}

// ---------------------------------------------------------------------------
// Départements 3CX (demande de Brice, 04/11/2026) : jeu de contextes propre,
// fusion dans un autre, ou site Wazo séparé. Règles : 3cx-depts.js.
// ---------------------------------------------------------------------------
const DEPT_HELP = 'Un département 3CX (groupe en v16-v18) correspond souvent à un établissement. Jeu de contextes propre : contexte interne, contexte sortant et trunk à lui dans Wazo, sur le même site Wazo que les autres (appels internes entre eux en option, onglet Écriture). Fusionné : ses objets vont dans le jeu de contextes d\'un autre département (un seul jeu pour tous). Site Wazo séparé : ses objets ne sont pas importés ici ; ouvrir son site Wazo dans le Portal et refaire l\'import avec la même sauvegarde, en gardant seulement ce département. Rattachement : le département réel de chaque objet (hors __DEFAULT__, département principal de presque tous les postes dans 3CX) ; un objet seul dans __DEFAULT__ suit les SDA qui le visent. Il se corrige objet par objet ci-dessous.';
const DEPT_BY = { SDA: 'd\'après les SDA qui le visent', nom: 'd\'après son nom', manuel: 'modifié à la main' };
function deptsTab() {
  const d = E.d; const q = E.q.trim().toLowerCase();
  if (!d.depts?.length) return `${intro('depts', 'Départements', DEPT_HELP)}<p class="muted">Aucun département dans cette sauvegarde.</p>`;
  const units = unitList(d);
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
  // Noms des futurs contextes (demande de Brice, 04/11/2026), mêmes réglages que l'onglet Écriture :
  // un jeu par département « propre » (plusieurs), ou celui du client (un seul, mode « Nouveaux contextes pour ce client »).
  const many = units.length > 1;
  const ctxNames = (k) => {
    const u = units.find((y) => y.key === k); if (!u || (!many && k !== units[0].key)) return '<span class="muted small">—</span>';
    const cfg = many ? unitCfg(d, k) : d.write?.site; if (!cfg) return '';
    const L = unitLabels(d, { key: k, label: u.label });
    if (cfg.created) return `<span class="small">créés : ${[cfg.created.ctxName, cfg.created.incName, cfg.created.outName].filter(Boolean).map(esc).join(', ')}</span>`;
    return `<input data-ctxname="${esc(k)}|newLabel" value="${esc(cfg.newLabel || '')}" placeholder="${esc(L.ctx)}" class="x3-mail" title="Contexte interne">
      <input data-ctxname="${esc(k)}|incLabel" value="${esc(cfg.incLabel || '')}" placeholder="${esc(L.inc)}" class="x3-mail" title="Contexte entrant (le trunk du jeu y est pointé)">
      <input data-ctxname="${esc(k)}|outLabel" value="${esc(cfg.outLabel || '')}" placeholder="${esc(L.out)}" class="x3-mail" title="Contexte sortant">${many ? `<label class="inline small" title="Numéro Wazo = préfixe du site + numéro 3CX à 3 chiffres (201 → ${esc(unitPrefix(d, k))}201, groupe 801 → ${esc(unitPrefix(d, k))}801). Le CSV, les touches et les plages suivent. Décoché (par défaut) : numéros 3CX et plages existantes gardés, les annuaires des postes n'ont rien à changer."><input type="checkbox" data-renum="${esc(k)}" ${renumbers(d, k) ? 'checked' : ''}> Renuméroter (suggestion : ${esc(unitPrefix(d, k))}XXX)</label> ${renumbers(d, k) ? '' : '<span class="muted small">numéros 3CX gardés</span>'}<label class="small"${renumbers(d, k) ? '' : ' hidden'}>Préfixe des plages <input data-ctxname="${esc(k)}|prefix" value="${esc(cfg.prefix || '')}" placeholder="${esc(unitPrefix(d, k))}" class="x3-short" title="Plages standard du jeu précédées de ce chiffre : ${esc(unitPrefix(d, k))}200-${esc(unitPrefix(d, k))}299 (postes), …800-…899 (groupes), …900-…999 (files), …700-…799 (conférences). Vide : rang du jeu."></label>` : '<div class="muted small">si « Nouveaux contextes pour ce client » (onglet Écriture)</div>'}
      <div class="x3-ranges">${RANGE_KEYS.map(([rk, rl]) => { const auto = rangesText(autoRanges(d, many ? k : null)[rk]); return `<label class="small">${esc(rl)} <input data-ctxrange="${esc(k)}|${rk}" value="${esc(cfg.ranges?.[rk] || '')}" placeholder="${esc(auto || 'aucune')}" title="Plages du contexte interne, ex. 200-260, 321 ; vide : ${esc(auto || 'aucune')} (plages standard, plus celles des numéros du client qui n'y tombent pas) ; « - » : aucune"></label>`; }).join('')}</div>`;
  };
  const count = (k) => { const o = deptObjects(d, k); return [`${o.users.filter((u) => u.mode === 'user').length} postes`, `${o.hunts.length} groupes / files`, `${o.ivrs.length} SVI`, `${o.dids.length} SDA`].join(', '); };
  const rows = d.depts.map((x) => `<tr class="${x.mode === 'skip' ? 'x3-off' : ''}">
    <td><strong>${esc(deptLabel(x.key))}</strong><div class="muted small">${esc(x.number || '')}</div></td>
    <td class="small">${esc(x.trunk || 'aucune règle sortante')}</td>
    <td class="small">${esc(x.hours || 'non précisés')}${x.holidays ? `<div class="muted">${x.holidays} jour(s) férié(s) à venir</div>` : ''}</td>
    <td class="x3-c small">${x.visible ? 'oui' : 'non'}</td>
    <td class="small">${esc(count(x.key))}</td>
    <td><select data-dept-mode="${esc(x.key)}">${Object.entries(DEPT_MODES).map(([k, l]) => opt(k, l, x.mode)).join('')}</select>
      ${x.mode === 'merge' ? `<select data-dept-into="${esc(x.key)}">${d.depts.filter((y) => y.key !== x.key && y.mode === 'own').map((y) => opt(y.key, `dans ${deptLabel(y.key)}`, x.into)).join('') || '<option value="">aucun département « propre »</option>'}</select>` : ''}</td>
    <td>${ctxNames(x.key)}</td>
  </tr>`).join('');
  const deptSel = (kind, n, cur) => `<select data-move="${kind}|${esc(n)}">${d.depts.map((y) => opt(y.key, deptLabel(y.key), cur)).join('')}</select>`;
  const objs = [
    ...d.users.filter((u) => u.mode !== 'skip' || u.deptPrev).map((u) => ['user', u.n, `${u.n} ${userName(u)}`, MODES[u.deptPrev || u.mode], u]),
    ...d.hunts.map((h) => ['hunt', h.n, `${h.n} ${h.name}`, h.src === 'Queue' ? 'File 3CX' : 'Groupe 3CX', h]),
    ...d.ivrs.map((v) => ['ivr', v.n, `${v.n} ${v.name}`, 'SVI', v]),
    ...d.dids.filter((r) => r.import || 'deptPrev' in r).map((r) => ['did', r.did, `${r.did} ${r.name || ''}`, 'SDA', r]),
  ].filter(([, , l]) => !q || l.toLowerCase().includes(q));
  const orows = objs.map(([kind, n, l, type, o]) => { const u = unitOf(d, o); return `<tr class="${u ? '' : 'x3-off'}"><td>${esc(l)}</td><td class="small">${esc(type)}</td><td>${deptSel(kind, n, o.dept)}${o.deptAlso ? `<div class="x3-warn small">aussi dans ${esc(o.deptAlso.join(', '))} (3CX)</div>` : ''}${o.deptBy ? `<div class="muted small">${DEPT_BY[o.deptBy]}</div>` : ''}</td><td class="small">${u ? esc(u === '_' ? 'jeu unique' : deptLabel(u)) : '<span class="muted">non importé ici</span>'}</td></tr>`; }).join('');
  return `${intro('depts', 'Départements', DEPT_HELP, `<input id="x3e-q" type="search" placeholder="Filtrer les objets" value="${esc(E.q)}" class="x3-q">`)}
    <p class="small">${units.length > 1 ? `${units.length} jeux de contextes Wazo : ${units.map((u) => esc(u.label)).join(', ')}.` : 'Un seul jeu de contextes Wazo pour tout le client.'}</p>
    ${many ? `<div class="ms-tools small"><label class="inline" title="Chaque contexte interne inclut les autres : les postes des départements s'appellent par leur numéro interne"><input type="checkbox" data-w="site.interUnits" ${d.write.site.interUnits ? 'checked' : ''}> Appels internes entre départements</label>
      <label class="inline" title="Inclusions avec les contextes internes déjà présents sur ce site Wazo (choix des établissements : onglet Écriture)"><input type="checkbox" data-w="site.inter" ${d.write.site.inter ? 'checked' : ''}> Appels internes avec les établissements déjà présents</label></div>` : ''}
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Département'], ['Trunk 3CX', 'Passerelle de la règle sortante qui vise ce département'], ['Horaires'], ['Présence visible', 'GLOBALLY_VISIBLE : présence visible hors du département'], ['Objets rattachés'], ['Dans Wazo'], ['Futurs contextes', 'Noms des contextes interne, entrant et sortant créés pour ce jeu, et plages du contexte interne (vide : valeur proposée, en gris)']])}<tbody>${rows}</tbody></table></div>
    ${(() => { const iss = rangeIssues(d); return iss.length ? `<div class="small">${iss.map((x) => `<div class="${x.sev === 'error' ? 'compat blocking' : 'warn'}"><strong>${esc(x.title)}</strong> : ${esc(x.text)}</div>`).join('')}</div>` : ''; })()}
    <h4 class="x3-h">Rattachement des objets</h4>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Objet'], ['Type'], ['Département'], ['Jeu de contextes Wazo']])}<tbody>${orows || '<tr><td colspan="4" class="muted">Aucun objet.</td></tr>'}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Messageries (demande de Brice, 03/11/2026 : plus de réglages par boîte).
// Champs de confd voicemail/schema.py ; le code 3CX n'est jamais stocké dans
// le brouillon (lu dans la sauvegarde au moment de l'écriture ou de l'export).
// ---------------------------------------------------------------------------
const pinOf = (n) => E.m?.extensions.find((e) => e.number === n)?.vm.pin || '';
function vmSummary(u) {
  const o = u.vmo; const mail = vmEmail(u);
  return [mail ? (o.attach ? 'e-mail + audio' : 'e-mail') : 'sans e-mail', o.del ? 'supprimé après envoi' : '', o.ask ? '' : 'sans code demandé', u.vmPin ? 'code 3CX' : ''].filter(Boolean).join(' · ');
}
const nullStr = (path, attrs = '') => `<input data-p="${path}" data-type="nullstr" value="${esc(get(path) ?? '')}" ${attrs}>`;
const nullInt = (path, ph) => `<input type="number" min="0" max="9999" data-p="${path}" data-type="nullint" value="${esc(get(path) ?? '')}" placeholder="${esc(ph)}" class="x3-short">`;
function vmFields(p, u, f) {
  const on = `${f('Messagerie', `<span>${check(`${p}.vm`)} active</span>`)}`;
  if (!u.vm) return on;
  const pin = pinOf(u.n);
  return `${on}
    ${f('Notification', `<span>${check(`${p}.vmo.notify`)} par e-mail</span>`, 'Chaque nouveau message est annoncé par e-mail.')}
    ${f('Adresse de notification', nullStr(`${p}.vmo.email`, `type="email" placeholder="${esc(u.email || 'adresse')}"`), 'Vide : l\'e-mail de l\'utilisateur.')}
    ${f('Message en pièce jointe', `<span>${check(`${p}.vmo.attach`)} joindre l'audio</span>`)}
    ${f('Après envoi', `<span>${check(`${p}.vmo.del`)} supprimer de la boîte</span>`, 'Exige une adresse et « joindre l\'audio » (règle de Wazo).')}
    ${f('Code d\'accès', `<span>${check(`${p}.vmo.ask`)} demander le code</span>${pin ? `<span>${check(`${p}.vmPin`)} reprendre le code 3CX</span>` : '<span class="muted small">pas de code dans 3CX</span>'}`, 'Le code 3CX est lu dans la sauvegarde à l\'écriture, jamais stocké dans le brouillon.')}
    ${f('Messages au maximum', nullInt(`${p}.vmo.max`, 'défaut'), 'Vide : valeur du serveur.')}
    ${f('Langue des annonces', sel(`${p}.vmo.lang`, VM_LANGS))}`;
}
const VM_HELP = 'Une ligne par poste repris (utilisateur ou messagerie seule). Réglages envoyés à Wazo tels quels, sans valeur par défaut du serveur (sauf « Max » vide). Notification : un e-mail par nouveau message, à l\'adresse indiquée ou, si vide, à l\'e-mail de l\'utilisateur. Joindre l\'audio : le message en pièce jointe. Supprimer après envoi : la boîte reste vide (exige l\'adresse et la pièce jointe, règle de Wazo). Demander le code : décoché, l\'utilisateur entre dans sa boîte depuis son poste sans code. Code 3CX : reprend le code de la sauvegarde (lu à l\'écriture, jamais stocké dans le brouillon). Cochez des lignes pour une modification groupée.';
const VM_BULK = [['vm', 'Messagerie'], ['vmo.notify', 'Notification'], ['vmo.attach', 'Joindre l\'audio'], ['vmo.del', 'Supprimer après envoi'], ['vmo.ask', 'Demander le code'], ['vmPin', 'Code 3CX']];
function vmsTab() {
  const d = E.d; const q = E.q.trim().toLowerCase();
  const list = d.users.map((u, i) => [u, i]).filter(([u]) => u.mode !== 'skip' && (!q || `${u.n} ${userName(u)} ${u.email}`.toLowerCase().includes(q)));
  const rows = list.map(([u, i]) => {
    const p = `users.${i}`; const pin = pinOf(u.n);
    const cells = u.vm ? `
      <td class="x3-c">${check(`${p}.vmo.notify`, 'Notification par e-mail')}</td>
      <td>${u.vmo.notify ? nullStr(`${p}.vmo.email`, `type="email" placeholder="${esc(u.email || 'adresse')}" class="x3-mail" title="Vide : e-mail de l'utilisateur"`) : '<span class="muted small">aucune</span>'}</td>
      <td class="x3-c">${check(`${p}.vmo.attach`, 'Joindre le message audio à l\'e-mail')}</td>
      <td class="x3-c">${check(`${p}.vmo.del`, 'Supprimer le message de la boîte après l\'envoi par e-mail')}</td>
      <td class="x3-c">${check(`${p}.vmo.ask`, 'Demander le code d\'accès')}</td>
      <td class="x3-c">${pin ? check(`${p}.vmPin`, 'Reprendre le code 3CX') : '<span class="muted small">aucun</span>'}</td>
      <td>${nullInt(`${p}.vmo.max`, 'défaut')}</td>
      <td>${sel(`${p}.vmo.lang`, VM_LANGS)}</td>` : '<td colspan="8" class="muted small">messagerie désactivée</td>';
    return `<tr class="${u.vm ? '' : 'x3-off'}${E.sel.vms.has(i) ? ' sel' : ''}${u.vm && !u.vmChecked ? ' x3-unchecked' : ''}">
      <td><input type="checkbox" data-sel="vms" data-i="${i}" ${E.sel.vms.has(i) ? 'checked' : ''}></td>
      <td class="x3-c">${u.vm ? check(`${p}.vmChecked`, 'Vérifié') : ''}</td>
      <td>${esc(u.n)}</td><td>${esc(userName(u))}<div class="muted small">${esc(MODES[u.mode])}</div></td>
      <td class="x3-c">${check(`${p}.vm`, 'Messagerie active')}</td>${cells}</tr>`;
  }).join('');
  const n = E.sel.vms.size;
  const yn = (id, l) => `<label>${esc(l)} <select id="${id}"><option value="">inchangé</option><option value="1">oui</option><option value="0">non</option></select></label>`;
  return `${intro('vms', 'Messageries', VM_HELP, `${verifyBar('vms')}<input id="x3e-q" type="search" placeholder="Filtrer" value="${esc(E.q)}" class="x3-q">`)}
    ${n ? '' : '<p class="x3-bulk-hint muted small">Cochez des lignes pour les modifier en groupe.</p>'}
    <div class="x3-bulk"${n ? '' : ' hidden'}><strong>${n} sélectionnée(s)</strong>
      ${VM_BULK.map(([, l], j) => yn(`xv-${j}`, l)).join('')}
      <label>Langue <select id="xv-lang"><option value="">inchangée</option>${Object.entries(VM_LANGS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <label>Max <input id="xv-max" type="number" min="0" placeholder="inchangé" class="x3-short"></label>
      <button data-act="bulk-vms" ${n ? '' : 'disabled'}>Appliquer</button></div>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['[all:vms]'], ['Vérifié', VERIFIED_TIP], ['N°'], ['Nom'], ['Active'], ['Notification', 'E-mail à chaque nouveau message'], ['Adresse', 'Vide : e-mail de l\'utilisateur'], ['Audio joint', 'attach_audio'], ['Supprimer après envoi', 'delete_messages : exige adresse et audio joint'], ['Code demandé', 'ask_password'], ['Code 3CX', 'Reprendre le code de la sauvegarde 3CX'], ['Max', 'max_messages ; vide = défaut du serveur'], ['Langue', 'language']])}<tbody>${rows || '<tr><td colspan="13" class="muted">Aucun poste repris.</td></tr>'}</tbody></table></div>`;
}
function bulkVms(root) {
  const d = E.d; const ids = [...E.sel.vms];
  const vals = VM_BULK.map(([k], j) => [k, $(`xv-${j}`).value]).filter(([, v]) => v);
  const lang = $('xv-lang').value; const max = $('xv-max').value;
  for (const i of ids) {
    for (const [k, v] of vals) set(`users.${i}.${k}`, v === '1');
    if (lang) d.users[i].vmo.lang = lang;
    if (max !== '') d.users[i].vmo.max = Math.max(0, Number(max) || 0);
  }
  toast(`${ids.length} messagerie(s) modifiée(s).`);
  changed(root);
}

const DEVICE_HELP ='Une ligne par téléphone de la sauvegarde 3CX. MAC : convertie au format Wazo (00:15:65:a1:b2:c3), modifiable. Utilisateur : celui dont la ligne sera associée à l\'appareil (au départ, le poste 3CX qui l\'utilisait) ; « aucun » = appareil créé seul, en stock. Description : « Prénom Nom » de l\'utilisateur, mise à jour automatiquement quand son nom change ; une description saisie à la main n\'est plus mise à jour (case « auto » pour revenir au nom). Une MAC déjà présente dans le tenant Wazo ouvert est signalée.';
function devicesTab() {
  const d = E.d;
  const wazo = new Map((I.lists.device || []).filter((x) => x.mac).map((x) => [String(x.mac).toLowerCase(), x]));
  const owners = `<option value="">Aucun (stock)</option>${d.users.filter((u) => u.mode === 'user').map((u) => `<option value="${esc(u.n)}">${esc(u.n)} ${esc(userName(u))}</option>`).join('')}`;
  const rows = (d.devices || []).map((dv, i) => {
    const p = `devices.${i}`;
    const inWazo = wazo.get(String(dv.mac).toLowerCase());
    const owner = dv.owner ? userBy(d, dv.owner) : null;
    return `<tr class="${dv.import ? '' : 'x3-off'}${dv.import && !dv.checked ? ' x3-unchecked' : ''}">
      <td class="x3-c">${dv.import ? check(`${p}.checked`, 'Vérifié') : ''}</td>
      <td class="x3-c">${check(`${p}.import`, 'Reprendre cet appareil')}</td>
      <td><input data-p="${p}.mac" data-type="mac" value="${esc(dv.mac)}" class="x3-mac${macValid(dv.mac) ? '' : ' bad'}">${inWazo ? `<div class="x3-warn small" title="${esc(`Déjà dans Wazo : ${inWazo.description || ''} ${inWazo.model || ''}`)}">déjà dans ce tenant</div>` : ''}</td>
      <td class="x3-nowrap">${esc(dv.model)}${dv.vendor && !dv.model.toLowerCase().startsWith(dv.vendor.toLowerCase()) ? `<div class="muted small">${esc(dv.vendor)}</div>` : ''}</td>
      <td><select data-p="${p}.owner" data-val="${esc(dv.owner || '')}">${owners}</select>${owner && owner.mode !== 'user' ? '<div class="x3-warn small">poste non repris</div>' : ''}</td>
      <td><input data-p="${p}.desc" data-type="desc" value="${esc(deviceDesc(d, dv))}" placeholder="Prénom Nom" class="x3-desc${dv.descAuto ? ' x3-auto' : ''}"></td>
      <td class="x3-c">${check(`${p}.descAuto`, 'Description = Prénom Nom de l\'utilisateur, mise à jour automatiquement')}</td>
    </tr>`;
  }).join('');
  return `${intro('devices', 'Appareils', DEVICE_HELP, verifyBar('devices'))}<div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Vérifié', VERIFIED_TIP], ['Reprise'], ['MAC'], ['Modèle'], ['Utilisateur', 'Ligne associée à l\'appareil'], ['Description'], ['Auto', 'Description automatique (Prénom Nom)']])}<tbody>${rows || '<tr><td colspan="7" class="muted">Aucun appareil dans la sauvegarde.</td></tr>'}</tbody></table></div>`;
}

const HUNT_HELP = 'Groupes de sonnerie et files 3CX. Wazo : choisissez groupe d\'appel ou file d\'attente pour chacun (une file 3CX à 2 membres en « Hunt » devient souvent un groupe « un par un »). Les destinations qui visent cet objet le suivent automatiquement. Durée totale : délai avant le débordement « sans réponse » (timeout) ; sonnerie par membre : user_timeout pour un groupe, délai de sonnerie d\'un agent pour une file. Membres : utilisateurs repris seulement.';
function huntsTab(opts) {
  const d = E.d;
  const users = d.users.filter((u) => u.mode === 'user');
  const rows = d.hunts.map((h, i) => {
    const p = `hunts.${i}`;
    const add = users.filter((u) => !h.members.includes(u.n)).map((u) => `<option value="${esc(u.n)}">${esc(u.n)} ${esc(userName(u))}</option>`).join('');
    return `<tr class="${h.target === 'skip' ? 'x3-off' : ''}${h.target !== 'skip' && !h.checked ? ' x3-unchecked' : ''}">
      <td class="x3-c">${h.target !== 'skip' ? check(`${p}.checked`, 'Vérifié') : ''}</td>
      <td>${numInput(`hunts.${i}.wn`, h)}${was3cx(d, h)}</td><td class="small">${h.src === 'Queue' ? 'File' : 'Groupe'} 3CX</td>
      <td>${sel(`${p}.target`, HUNT_TARGETS)}</td>
      <td>${input(`${p}.name`)}</td>
      <td>${sel(`${p}.strategy`, GROUP_STRATEGIES)}</td>
      <td>${num(`${p}.timeout`, 5, 3600)}</td>
      <td>${num(`${p}.userTimeout`, 5, 600)}</td>
      <td><div class="x3-chips">${h.members.map((n) => { const u = userBy(d, n); const ok = u?.mode === 'user'; return `<span class="x3-chip${ok ? '' : ' bad'}" title="${esc(ok ? userName(u) : 'non repris')}">${esc(n)}${u ? ` ${esc(userName(u))}` : ''}<button data-act="rm-member" data-i="${i}" data-n="${esc(n)}" title="Retirer">×</button></span>`; }).join('')}
        ${add ? `<select data-act="add-member" data-i="${i}" class="x3-add"><option value="">+ membre</option>${add}</select>` : ''}</div></td>
      <td>${destCell(`${p}.noanswer`, opts)}</td>
      <td class="small">${esc(h.music || '')}${h.music ? soundSlot(h.music, { player: false }) : ''}</td>
    </tr>`;
  }).join('');
  return `${intro('hunts', 'Groupes et files', HUNT_HELP, verifyBar('hunts'))}<div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Vérifié', VERIFIED_TIP], ['N°'], ['Origine'], ['Wazo'], ['Nom'], ['Stratégie'], ['Durée totale', 'Secondes avant « sans réponse »'], ['Par membre', 'Secondes de sonnerie par membre'], ['Membres'], ['Sans réponse'], ['Musique 3CX']])}<tbody>${rows}</tbody></table></div>`;
}

const IVR_HELP = 'SVI 3CX (les SVI internes de 3CX sont exclus). Touches : destination de chaque touche ; « + touche » ajoute la première touche libre. Délai : secondes d\'attente d\'une saisie avant « sans saisie ». Le message est à téléverser dans les sons Wazo.';
function ivrsTab(opts) {
  const d = E.d;
  const rows = E.d.ivrs.map((v, i) => {
    const p = `ivrs.${i}`;
    return `<tr class="${v.import ? '' : 'x3-off'}${v.import && !v.checked ? ' x3-unchecked' : ''}">
      <td class="x3-c">${v.import ? check(`${p}.checked`, 'Vérifié') : ''}</td>
      <td>${numInput(`${p}.wn`, v)}${was3cx(d, v)}</td><td class="x3-c">${check(`${p}.import`, 'Reprendre')}</td><td>${input(`${p}.name`)}</td><td class="small">${esc(v.prompt || '')}${v.prompt ? soundSlot(v.prompt, { player: false }) : ''}</td>
      <td>${num(`${p}.timeout`, 1, 120)}</td>
      <td>${v.choices.map((c, k) => `<div class="x3-choice"><input data-p="${p}.choices.${k}.key" value="${esc(c.key)}" class="x3-key">${destCell(`${p}.choices.${k}.dest`, opts)}<button class="icon" data-act="rm-choice" data-i="${i}" data-k="${k}" title="Retirer la touche">×</button></div>`).join('')}
        <button class="x3-link" data-act="add-choice" data-i="${i}">+ touche</button></td>
      <td>${destCell(`${p}.timeoutDest`, opts)}</td>
    </tr>`;
  }).join('');
  return `${intro('ivrs', 'SVI', IVR_HELP, verifyBar('ivrs'))}<div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Vérifié', VERIFIED_TIP], ['N°'], ['Reprise'], ['Nom'], ['Message'], ['Délai'], ['Touches'], ['Sans saisie']])}<tbody>${rows}</tbody></table></div>`;
}

const DID_HELP = 'Une ligne par SDA du trunk (les SDA sans règle 3CX sont décochées), au format Wazo 33… (numéro 3CX en dessous). Contexte entrant : celui où la SDA sera déclarée ; en multi-site, celui du département de la SDA (onglet Départements), dont le trunk est à régler sur ce contexte dans le Portal. Destination : en heures d\'ouverture, ou toujours si aucun horaire. Horaire : celui déduit de la règle 3CX, modifiable ; ses sorties « fermé » et « férié » se règlent dans l\'onglet Horaires (comme dans le Portal, elles appartiennent à l\'horaire, pas à la SDA). Par le CSV : créer cette SDA avec l\'utilisateur dans le CSV d\'import (destination utilisateur seulement) ; le CSV de Wazo n\'associe pas d\'horaire, la SDA perdrait donc ses sorties fermé et férié jusqu\'à ce qu\'on associe l\'horaire à la main.';
// Contexte entrant où la SDA sera déclarée (demande de Brice, 04/11/2026), même règle que
// l'écriture (3cx-wizard.js, incallOf) : celui du jeu de contextes de la SDA (créé ou à créer),
// sinon celui du trunk choisi, sinon celui choisi dans Exports. → { label, note }
function incallOfDid(r) {
  const d = E.d; const units = unitList(d); const many = units.length > 1;
  const lbl = (n) => (I.lists.context || []).find((c) => c.name === n)?.label || n;
  const u = many ? units.find((x) => x.key === unitOf(d, r)) : units[0];
  if (!u) return { label: '', note: 'non importée ici' };
  const cfg = many ? unitCfg(d, u.key) : d.write?.site;
  if (cfg?.created?.incName) return { label: lbl(cfg.created.incName), note: many ? u.label : '' };
  if (many || d.write?.site?.mode === 'new') return { label: unitLabels(d, { key: u.key, label: u.label }).inc, note: `à créer${many ? ` · ${u.label}` : ''}` };
  const tr = (I.lists.trunk || []).find((x) => String(x.id) === String(d.write?.trunkId)); // trunk facultatif : plus de « premier trunk » par défaut
  if (tr?.context) return { label: lbl(tr.context), note: 'contexte du trunk' };
  const inc = tenantCtx().incallCtx;
  return inc ? { label: lbl(inc), note: 'choisi dans Exports' } : { label: '', note: 'aucun contexte entrant lu' };
}
function didsTab(opts) {
  const d = E.d; const q = E.q.trim().toLowerCase();
  const schedOpts = (cur) => `<option value="">Toujours ouvert</option>${d.schedules.map((s) => `<option value="${esc(s.key)}" ${s.key === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
  const rows = d.dids.map((r, i) => [r, i]).filter(([r]) => !q || `${r.did} ${r.name} ${destLabel(d, r.dest)}`.toLowerCase().includes(q)).map(([r, i]) => {
    const p = `dids.${i}`;
    return `<tr class="${r.import ? '' : 'x3-off'}${E.sel.dids.has(i) ? ' sel' : ''}${r.import && !r.checked ? ' x3-unchecked' : ''}">
      <td><input type="checkbox" data-sel="dids" data-i="${i}" ${E.sel.dids.has(i) ? 'checked' : ''}></td>
      <td class="x3-c">${r.import ? check(`${p}.checked`, 'Vérifiée') : ''}</td>
      <td>${esc(didWazo(r.did))}<div class="muted small">${didWazo(r.did) !== r.did ? `${esc(r.did)} dans 3CX` : ''}${r.name ? `${didWazo(r.did) !== r.did ? ' · ' : ''}${esc(r.name)}` : ''}</div></td><td class="x3-c">${check(`${p}.import`, 'Reprendre')}</td>
      <td class="small">${(() => { const x = incallOfDid(r); return `${x.label ? esc(x.label) : '<span class="x3-warn">aucun</span>'}${x.note ? `<div class="muted">${esc(x.note)}</div>` : ''}`; })()}</td>
      <td>${destCell(`${p}.dest`, opts)}</td>
      <td><select data-p="${p}.schedule">${schedOpts(r.schedule)}</select></td>
      <td class="x3-c">${r.dest.t === 'user' ? check(`${p}.viaCsv`, 'Créer la SDA dans le CSV d\'import des utilisateurs (sans son horaire : Wazo ne le permet pas)') : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  const n = E.sel.dids.size;
  return `${intro('dids', 'SDA', DID_HELP, `${verifyBar('dids')}<input id="x3e-q" type="search" placeholder="Filtrer" value="${esc(E.q)}" class="x3-q">`)}
    ${n ? '' : '<p class="x3-bulk-hint muted small">Cochez des lignes pour les modifier en groupe (reprise, destination, horaire).</p>'}
    <div class="x3-bulk"${n ? '' : ' hidden'}><strong>${n} sélectionnée(s)</strong>
      <label>Reprise <select id="xd-imp"><option value="">inchangée</option><option value="1">oui</option><option value="0">non</option></select></label>
      <label>Destination <select id="xd-dest"><option value="keep">inchangée</option>${opts}</select></label><input id="xd-num" placeholder="numéro externe" class="x3-num">
      <label>Horaire <select id="xd-sched"><option value="keep">inchangé</option>${schedOpts('__')}</select></label>
      <button data-act="bulk-dids" ${n ? '' : 'disabled'}>Appliquer</button></div>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['[all:dids]'], ['Vérifiée', VERIFIED_TIP], ['SDA'], ['Reprise'], ['Contexte entrant', 'Où la SDA sera déclarée : contexte entrant de son jeu de contextes (département en multi-site), sinon celui du trunk'], ['Destination', 'Où va l\'appel (ou pendant les heures d\'ouverture, si la SDA a un horaire)'], ['Horaire', 'Horaire Wazo de la SDA ; ses sorties « fermé » et « férié » se règlent dans l\'onglet Horaires, comme dans le Portal'], ['Par le CSV', 'SDA créée dans le CSV d\'import des utilisateurs (destination utilisateur seulement). Le CSV n\'associe pas d\'horaire : décocher si la SDA en a un']])}<tbody>${rows}</tbody></table></div>`;
}

function schedsTab(opts) {
  const d = E.d;
  const used = (k) => d.dids.filter((r) => r.import && r.schedule === k).length;
  const past = pastHolidays(E.m);
  const where = (h) => (h.depts || ['tenant']).map((k) => (k === 'tenant' ? 'tous' : deptLabel(k))).join(', ');
  return `${intro('scheds', 'Horaires', 'Horaires Wazo à créer, déduits des règles entrantes 3CX. Une règle « heures de bureau » prend celles du département de sa SDA (heures de bureau moins la pause) ; une règle à plages propres garde les siennes. Le nom est modifiable ; les plages se modifieront dans Call Flow Manager après création. Comme dans Wazo, l\'horaire porte ses sorties : « Fermé » (hors des plages) et « Férié » (pendant les fermetures exceptionnelles) ; les SDA ne font que le viser. Des SDA 3CX aux mêmes plages mais aux sorties différentes ont donné des horaires distincts ; « Dupliquer » en crée un autre, à choisir ensuite dans l\'onglet SDA. Fermetures exceptionnelles : celles de 3CX pour tous les départements et celles d\'un département, ajoutées aux horaires concernés si cochées ; les fermetures passées ne sont pas reprises. Les jours fériés légaux français autres que ceux de la sauvegarde sont à ajouter.', verifyBar('scheds'))}
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Vérifié', VERIFIED_TIP], ['Nom'], ['Département', 'Département 3CX dont l\'horaire reprend les heures de bureau, ou règle entrante dont il reprend les heures spécifiques'], ['Plages'], ['Fermé', 'Où va l\'appel hors des plages (closed_destination)'], ['Férié', 'Où va l\'appel pendant les fermetures exceptionnelles de l\'horaire'], ['SDA'], ['']])}<tbody>${d.schedules.map((s, i) => `<tr class="${used(s.key) && !s.checked ? 'x3-unchecked' : ''}"><td class="x3-c">${used(s.key) ? check(`schedules.${i}.checked`, 'Vérifié') : ''}</td><td>${input(`schedules.${i}.name`)}</td><td class="small">${s.dept ? esc(deptLabel(s.dept)) : `<span class="muted">heures spécifiques de la règle entrante${(() => { const l = d.dids.filter((r) => r.schedule === s.key).map((r) => didWazo(r.did)); return l.length ? ` (${esc(l.join(', '))})` : ''; })()}</span>`}</td><td>${esc(s.text)}</td><td>${destCell(`schedules.${i}.closed`, opts)}</td><td>${destCell(`schedules.${i}.holiday`, opts)}</td><td>${used(s.key)}</td><td><button data-act="sched-dup" data-i="${i}" class="x3-mini" title="Même plages, autres sorties : à choisir ensuite pour certaines SDA">Dupliquer</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucun horaire.</td></tr>'}</tbody></table></div>
    <h3 class="x3-h">Fermetures exceptionnelles</h3>${past ? `<p class="small muted">${past} fermeture(s) passée(s) dans la sauvegarde, non reprises.</p>` : ''}
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Reprise'], ['Nom'], ['Départements'], ['Dates'], ['Heures']])}<tbody>${d.holidays.map((h, i) => `<tr class="${h.include ? '' : 'x3-off'}"><td class="x3-c">${check(`holidays.${i}.include`)}</td><td>${input(`holidays.${i}.name`)}</td><td class="small">${esc(where(h))}</td><td>${h.day}/${h.month}${h.recurrent ? ' (tous les ans)' : `/${h.year}`}${h.dayEnd !== h.day || h.monthEnd !== h.month ? ` → ${h.dayEnd}/${h.monthEnd}` : ''}</td><td>${esc(h.from)}-${esc(h.to)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucune à venir.</td></tr>'}</tbody></table></div>`;
}

const SEV_FR = { error: 'Erreur', warn: 'À vérifier', info: 'Info' };
const bySev = (a, b) => ['error', 'warn', 'info'].indexOf(a.sev) - ['error', 'warn', 'info'].indexOf(b.sev);
const issuesTable = (iss, okText) => (iss.length ? `<div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Gravité'], ['Où'], ['Quoi']])}<tbody>${iss.sort(bySev).map((x) => `<tr class="x3-${x.sev}"><td>${SEV_FR[x.sev]}</td><td>${esc(x.area)}</td><td>${esc(x.text)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="mg-allok">${esc(okText)}</div>`);
function checksTab() {
  const { ctx, incallCtx } = tenantCtx();
  const c = (I.lists.context || []).find((x) => x.name === ctx);
  return `${intro('checks', 'Contrôles du brouillon', 'Recalculés à chaque modification : numéros en double ou non numériques, utilisateurs sans nom, destinations vers un objet non repris, groupes sans membre repris, SDA sans destination. Les erreurs bloqueront l\'écriture dans Wazo (étape suivante) ; les exports restent possibles.')}
    ${issuesTable([...draftIssues(E.d), ...numberIssues(E.d)], 'Aucun problème dans le brouillon.')}
    <div class="titlerow x3-h"><h3>Contre le tenant Wazo ouvert</h3>${helpButton('x3e-tchk', 'Aide : contrôles contre le tenant')}</div>
    ${helpBox('x3e-tchk', 'Ce qui ferait refuser le CSV par Wazo, lu dans le code de l\'import (wazo-confd, user_import) : l\'import est tout ou rien, la première erreur annule tout. Poste hors des plages utilisateurs du contexte interne, numéro ou SDA déjà présents, messagerie existante rattachée, e-mail déjà pris dans le tenant. Contextes : ceux choisis dans l\'onglet Exports.')}
    <p class="small muted">Contexte interne : ${esc(c ? `${c.label || c.name} (${c.name})` : 'aucun')} · contexte entrant : ${esc(incallCtx || 'aucun')}.</p>
    ${issuesTable(tenantChecks(), 'Aucun conflit avec le tenant ouvert.')}`;
}

// Ce que le CSV ne porte pas (WazoUserSchema : ni méthode ni accès) : à régler
// après l'import, dans User Manager (réglages « Méthode d'authentification »,
// « Accès aux applications »).
function afterImportNote(d) {
  const users = imported(d);
  const meth = users.filter((u) => u.authMethod && u.authMethod !== 'default');
  // Voix : les applications refusent la connexion de toute façon (vérifié par User Manager).
  const off = users.filter((u) => !u.appAccess && !isVoix(u));
  if (!meth.length && !off.length) return '<p class="small muted">Méthode de connexion « défaut de l\'organisation » et accès aux applications autorisé pour tous : rien à régler après l\'import.</p>';
  return `<div class="warn small"><strong>À régler après l'import</strong> (non porté par le CSV de Wazo ; User Manager, modification en masse) :
    ${meth.length ? `<div>Méthode de connexion : ${meth.map((u) => `${esc(u.n)} ${esc(AUTH_METHODS[u.authMethod])}`).join(', ')}.</div>` : ''}
    ${off.length ? `<div>Accès aux applications refusé : ${off.map((u) => esc(u.n)).join(', ')}.</div>` : ''}</div>`;
}
function exportsTab() {
  const ctxs = I.lists.context || [];
  const tc = tenantCtx();
  const opt = (type, none, cur) => ctxs.filter((c) => c.type === type).map((c) => `<option value="${esc(c.name)}" ${c.name === cur ? 'selected' : ''}>${esc(c.label || c.name)} (${esc(c.name)})</option>`).join('') || `<option value="">${none}</option>`;
  const d = E.d;
  const blf = blfRows(d, E.m);
  const tIss = tenantChecks().filter((x) => x.sev !== 'info');
  return `${intro('exports', 'Exports du brouillon', 'Fichiers produits depuis le brouillon tel qu\'il est. Brouillon JSON : pour le reprendre sur un autre poste ou le garder avec le dossier client (sans mot de passe ni code). Réinitialiser : repart de la sauvegarde 3CX et efface les modifications.')}
    <div class="card mg-card wide">
      <h4>CSV d'import des utilisateurs Wazo <span class="muted">(${imported(d).length} utilisateurs, ${d.dids.filter((r) => r.import && r.viaCsv && r.dest.t === 'user').length} SDA directes)</span></h4>
      <div class="ms-tools"><label>Contexte interne <select id="x3-ctx" data-p="ctx">${opt('internal', 'aucun contexte interne lu', tc.ctx)}</select></label><label>Contexte entrant <select id="x3-inctx" data-p="incallCtx">${opt('incall', 'aucun contexte entrant lu', tc.incallCtx)}</select></label></div>
      ${tIss.length ? `<div class="x3-tenant-iss">${tIss.sort(bySev).map((x) => `<div class="${x.sev === 'error' ? 'compat blocking' : 'warn'}">${esc(x.area)} : ${esc(x.text)}</div>`).join('')}</div>` : '<p class="small x3-ok">Aucun conflit avec le tenant ouvert (plages, numéros, SDA, messageries, e-mails).</p>'}
      <div class="btnrow"><button data-act="csv-users" class="primary">Télécharger le CSV</button></div>
      ${afterImportNote(d)}
    </div>
    <div class="card mg-card wide">
      <h4>Appareils <span class="muted">(${(d.devices || []).filter((x) => x.import).length} repris)</span></h4>
      <p class="small muted">MAC au format Wazo, marque, modèle, description (Prénom Nom), numéro et utilisateur associé : pour déclarer les appareils (Phone Manager, reprise de parc) et les associer aux lignes.</p>
      <div class="btnrow"><button data-act="csv-devices">Télécharger le CSV des appareils</button></div>
    </div>
    <div class="card mg-card wide">
      <h4>Touches BLF <span class="muted">(${blf.filter((b) => b.ok).length} reprises sur ${blf.length})</span></h4>
      <label class="inline">Position Wazo = position 3CX + <input type="number" data-p="blfOffset" data-type="num" min="0" max="5" value="${esc(d.blfOffset ?? 1)}" class="x3-short"> <span class="muted small">(supposé : 1, la touche 1 restant la ligne ; à vérifier sur un poste)</span></label>
      <div class="btnrow"><button data-act="csv-blf">Télécharger le CSV des touches</button></div>
    </div>
    <div class="card mg-card wide">
      <h4>Brouillon</h4>
      <p class="small muted">Enregistré dans ce navigateur${d.savedAt ? ` (dernière modification ${esc(new Date(d.savedAt).toLocaleString('fr-FR'))})` : ''}.</p>
      <div class="btnrow"><button data-act="draft-dl">Télécharger le brouillon (JSON)</button><label class="filebtn"><input type="file" id="x3-draft-file" accept=".json,application/json" hidden><span>Charger un brouillon…</span></label><button data-act="draft-reset" class="danger">Réinitialiser</button></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------
function changed(root) { saveDraft(E.d); renderTab(root, E.tab); E.onChange?.(); }
export function onDraftChange(fn) { E.onChange = fn; }
function parseDest(v, numVal) { const [t, ref] = v.split(':'); return t === 'ext' ? { t, num: numVal || '' } : ref ? { t, ref } : { t }; }

function onChange(e, root) {
  if (e.target.dataset.w) { wizardChange(e.target).then(() => { renderTab(root, E.tab); E.onChange?.(); }); return; }
  const t = e.target;
  if (t.id === 'x3-draft-file') return loadDraftFile(t, root);
  if (t.dataset.sel) { const s = E.sel[t.dataset.sel]; const i = Number(t.dataset.i); t.checked ? s.add(i) : s.delete(i); return renderTab(root, E.tab); }
  if (t.dataset.selall) {
    const s = E.sel[t.dataset.selall];
    const shown = [...root.querySelectorAll(`input[data-sel="${t.dataset.selall}"]`)].map((x) => Number(x.dataset.i));
    for (const i of shown) (t.checked ? s.add(i) : s.delete(i));
    return renderTab(root, E.tab);
  }
  if (t.dataset.sndSlot) { const f = t.files?.[0]; const target = t.dataset.sndSlot; t.value = ''; return loadSoundAs(f, target, root); }
  if (t.id === 'x3-snd-file') { const list = [...(t.files || [])]; t.value = ''; return loadSounds(list, root); }
  if (t.dataset.sndTo) { E.d.sounds.files[t.dataset.sndTo].to = t.value; return changed(root); }
  if (t.dataset.sndKeep) {
    const x = E.d.sounds.files[t.dataset.sndKeep];
    if (!t.checked) { if (x.to !== 'skip') x.prev = x.to; x.to = 'skip'; } else { const r = soundUsages(E.m).find((u) => u.file === t.dataset.sndKeep) || { uses: [] }; x.to = x.prev || keepTo(r); delete x.prev; }
    return changed(root);
  }
  if (t.dataset.mohDef) { E.d.sounds.defaultMoh = t.dataset.mohDef; return changed(root); }
  if (t.dataset.moh) { const [i, f] = t.dataset.moh.split('|'); E.d.sounds.moh[Number(i)][f] = t.value.trim(); return changed(root); }
  if (t.dataset.pbName) { E.d.phonebook.name = t.value.trim(); return changed(root); }
  if (t.dataset.pbIncl) { E.d.phonebook.includePersonal = t.checked; return changed(root); }
  if (t.dataset.pbMap) { E.d.phonebook.map[t.dataset.pbMap] = t.value; return changed(root); }
  if (t.dataset.pbKeep) {
    const pb = E.d.phonebook; const k = t.dataset.pbKeep; pb.mapPrev ||= {};
    if (!t.checked) { if (pb.map[k]) pb.mapPrev[k] = pb.map[k]; pb.map[k] = ''; } else { pb.map[k] = pb.mapPrev[k] || 'other'; delete pb.mapPrev[k]; }
    return changed(root);
  }
  if (t.dataset.sndCat) { E.d.sounds.category = t.value.trim(); return changed(root); }
  if (t.dataset.ctxrange) {
    const [k, f] = t.dataset.ctxrange.split('|');
    const cfg = unitList(E.d).length > 1 ? unitCfg(E.d, k) : E.d.write.site; cfg.ranges ||= {}; cfg.ranges[f] = t.value.trim();
    return changed(root);
  }
  if (t.dataset.ctxname) {
    const [k, f] = t.dataset.ctxname.split('|');
    const cfg = unitList(E.d).length > 1 ? unitCfg(E.d, k) : E.d.write.site; cfg[f] = t.value.trim();
    return changed(root);
  }
  if (t.dataset.renum) { unitCfg(E.d, t.dataset.renum).renumber = t.checked; return changed(root); }
  if (t.dataset.deptMode) { setDeptMode(E.d, t.dataset.deptMode, t.value); return changed(root); }
  if (t.dataset.deptInto) { setDeptMode(E.d, t.dataset.deptInto, 'merge', t.value); return changed(root); }
  if (t.dataset.move) { const [kind, n] = t.dataset.move.split('|'); moveObject(E.d, kind, n, t.value); return changed(root); }
  if (t.dataset.act === 'add-member' && t.value) { const h = E.d.hunts[Number(t.dataset.i)]; h.members.push(t.value); return changed(root); }
  if (t.dataset.dest) { const cur = get(t.dataset.dest); set(t.dataset.dest, parseDest(t.value, cur?.num)); return changed(root); }
  if (t.dataset.destnum) { const cur = get(t.dataset.destnum); set(t.dataset.destnum, { ...cur, num: t.value.trim() }); return changed(root); }
  if (t.dataset.p) {
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.type === 'num') v = Math.max(Number(t.min || 0), Math.min(Number(t.max || 99999), Number(v) || 0));
    if (typeof v === 'string') v = v.trim();
    if (t.dataset.type === 'mac') v = macWazo(v);
    if (t.dataset.type === 'int') v = t.value === '' ? null : Number(t.value);
    if (t.dataset.type === 'nullstr') v = v === '' ? null : v;
    if (t.dataset.type === 'nullint') v = t.value === '' ? null : Math.max(0, Math.round(Number(t.value)) || 0);
    if (E.d.upperLast && /^users\.\d+\.last$/.test(t.dataset.p)) v = upperName(v);
    if (/^users\.\d+\.callerId$/.test(t.dataset.p)) v = callerIdWazo(v);
    const ms = t.dataset.p.match(/^users\.(\d+)\.sub$/); const prevSub = ms ? E.d.users[Number(ms[1])].sub : undefined;
    set(t.dataset.p, v);
    if (ms) applyLicence(E.d.users[Number(ms[1])], prevSub);
    if (t.dataset.p === 'upperLast' && v) for (const u of E.d.users) u.last = upperName(u.last);
    // Description saisie à la main : elle ne suit plus le nom de l'utilisateur.
    const md = t.dataset.p.match(/^devices\.(\d+)\.(desc|descAuto)$/);
    if (md && md[2] === 'desc') E.d.devices[Number(md[1])].descAuto = false;
    if (md && md[2] === 'descAuto' && v) E.d.devices[Number(md[1])].desc = '';
    // Un nom modifié n'est plus « déduit ».
    const mu = t.dataset.p.match(/^users\.(\d+)\.(first|last)$/); if (mu) E.d.users[Number(mu[1])].guessed = false;
    return changed(root);
  }
}
function onClick(e, root) {
  const wb = e.target.closest('[data-wact]');
  if (wb) { wizardClick(wb, () => { renderTab(root, 'write'); E.onChange?.(); }); return; }
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const d = E.d;
  switch (b.dataset.act) {
    case 'rm-member': { const h = d.hunts[Number(b.dataset.i)]; h.members = h.members.filter((n) => n !== b.dataset.n); return changed(root); }
    case 'rm-choice': { d.ivrs[Number(b.dataset.i)].choices.splice(Number(b.dataset.k), 1); return changed(root); }
    case 'add-choice': { const v = d.ivrs[Number(b.dataset.i)]; const used = new Set(v.choices.map((c) => c.key)); const key = '1234567890*#'.split('').find((k) => !used.has(k)); if (!key) return toast('Toutes les touches sont prises.'); v.choices.push({ key, dest: { t: 'none' } }); return changed(root); }
    case 'review-start': { const imp = imported(d); const first = imp.findIndex((u) => !u.checked); E.review = first < 0 ? 0 : first; renderTab(root, E.tab); root.querySelector('.x3-review')?.scrollIntoView({ block: 'start' }); return; }
    case 'review-close': E.review = null; return renderTab(root, E.tab);
    case 'review-prev': E.review = Math.max(0, E.review - 1); return renderTab(root, E.tab);
    case 'review-next': E.review = (E.review + 1) % imported(d).length; return renderTab(root, E.tab);
    case 'review-ok': {
      const imp = imported(d); imp[E.review].checked = true;
      const next = imp.findIndex((u, k) => k > E.review && !u.checked);
      const wrap = imp.findIndex((u) => !u.checked);
      if (next < 0 && wrap < 0) { E.review = null; toast(`Les ${imp.length} utilisateurs sont vérifiés.`); } else E.review = next >= 0 ? next : wrap;
      changed(root); root.querySelector('.x3-review')?.scrollIntoView({ block: 'start' });
      return;
    }
    case 'bulk-users': return bulkUsers(root);
    case 'bulk-vms': return bulkVms(root);
    case 'pb-del': d.phonebook.contacts.splice(Number(b.dataset.i), 1); return changed(root);
    case 'pb-add': d.phonebook.contacts.unshift({ owner: null, raw: {}, import: true }); return changed(root);
    // Sans BOM : wazo-dird lirait « ﻿firstname » comme nom de la première colonne (supposé).
    case 'pb-csv': return download(`contacts-personnels-${b.dataset.o}-${base()}.csv`, personalCsv(d, b.dataset.o));
    case 'pb-csv-all': return download(`contacts-personnels-${base()}.csv`, personalCsv(d, null, { bom: true }));
    case 'pb-all': for (const c of d.phonebook.contacts) c.import = b.dataset.v === '1'; return changed(root);
    case 'verify-all': { const v = VERIFY[b.dataset.tab]; for (const o of v.list(d)) o[v.key] = true; return changed(root); }
    case 'sched-dup': { const s = d.schedules[Number(b.dataset.i)]; d.schedules.splice(Number(b.dataset.i) + 1, 0, { ...JSON.parse(JSON.stringify(s)), key: `${s.key.split('#')[0]}#${Date.now().toString(36)}`, name: `${s.name} (copie)` }); return changed(root); }
    case 'moh-add': { const k = `moh${Date.now().toString(36)}`; d.sounds.moh.push({ key: k, label: '', sort: 'alphabetical' }); return changed(root); }
    case 'moh-del': {
      const [x] = d.sounds.moh.splice(Number(b.dataset.i), 1);
      for (const f of Object.values(d.sounds.files)) if (f.to === `moh:${x.key}`) f.to = 'skip';
      if (d.sounds.defaultMoh === x.key) d.sounds.defaultMoh = d.sounds.moh[0]?.key || '';
      return changed(root);
    }
    case 'goto-vms': return document.querySelector('#x3-tabs [data-tab="vms"]')?.click();
    case 'bulk-dids': return bulkDids(root);
    case 'csv-users': return exportUsers();
    case 'csv-blf': return exportBlf();
    case 'csv-devices': return download(`astrea-3cx-appareils-${base()}.csv`, devicesCsv(d, (u) => wazoNum(d, u)));
    case 'draft-dl': return downloadJson(`astrea-3cx-brouillon-${(E.file || '3cx').replace(/\.xml$/i, '')}.json`, d);
    case 'draft-reset': return confirmModal('<h3>Réinitialiser le brouillon ?</h3><p>Toutes les modifications sont perdues ; le brouillon repart de la sauvegarde 3CX.</p>', () => { clearDraft(d); E.d = normalize(buildDraft(E.m, E.file), E.m); saveDraft(E.d); setWizard(E.d, E.m); E.onReset?.(E.d); renderTab(root, E.tab); E.onChange?.(); }, 'Réinitialiser');
    default:
  }
}
// Fichiers déposés (bouton ou glisser-déposer) : convertis puis gardés en mémoire.
async function loadSoundAs(file, target, root) {
  if (!file) return;
  try { await addFileAs(file, target); toast(`« ${file.name} » converti et rattaché à « ${target} ».`, 4000); } catch (e) { toast(`« ${file.name} » illisible : ${e.message || e}`, 8000); }
  renderTab(root, E.tab); E.onChange?.();
}
async function loadSounds(list, root) {
  if (!list.length) return;
  toast(`Conversion de ${list.length} fichier(s)…`, 3000);
  const res = await addFiles(list);
  const bad = res.filter((x) => !x.ok);
  toast(bad.length ? `${res.length - bad.length} fichier(s) chargé(s) ; illisibles : ${bad.map((x) => `${x.name} (${x.error})`).join(', ')}` : `${res.length} fichier(s) chargé(s) et converti(s).`, bad.length ? 9000 : 4000);
  renderTab(root, E.tab); E.onChange?.();
}
function bulkUsers(root) {
  const d = E.d; const ids = [...E.sel.users];
  const mode = $('xb-mode').value; const ring = Number($('xb-ring').value); const fbk = $('xb-fbk').value; const dv = $('xb-dest').value; const vmset = $('xb-vmset').value;
  const sub = $('xb-sub').value; const auth = $('xb-auth').value; const app = $('xb-app').value; const lines = $('xb-lines').value; const last = $('xb-last').value; const cid = $('xb-cid').value.trim();
  const dest = dv === 'keep' ? null : parseDest(dv, $('xb-num').value.trim());
  for (const i of ids) {
    const u = d.users[i];
    if (mode) u.mode = mode;
    if (ring) u.ring = Math.max(5, Math.min(300, ring));
    if (dest) for (const k of fbk === 'all' ? ['noanswer', 'busy', 'fail'] : [fbk]) u.fb[k] = { ...dest };
    if (vmset) u.vm = vmset === '1';
    const prev = u.sub;
    if (sub !== '') u.sub = Number(sub);
    if (auth) u.authMethod = auth;
    if (app) u.appAccess = app === '1';
    applyLicence(u, prev);
    if (lines) u.lines = lines;
    if (last === 'upper') u.last = upperName(u.last);
    if (cid) u.callerId = cid === '-' ? '' : callerIdWazo(cid);
  }
  toast(`${ids.length} utilisateur(s) modifié(s).`);
  changed(root);
}
function bulkDids(root) {
  const d = E.d; const ids = [...E.sel.dids];
  const imp = $('xd-imp').value; const dv = $('xd-dest').value; const sc = $('xd-sched').value;
  const dest = dv === 'keep' ? null : parseDest(dv, $('xd-num').value.trim());
  for (const i of ids) {
    const r = d.dids[i];
    if (imp) r.import = imp === '1';
    if (dest) { r.dest = { ...dest }; r.viaCsv = dest.t === 'user'; }
    if (sc !== 'keep' && sc !== '__') r.schedule = sc;
  }
  toast(`${ids.length} SDA modifiée(s).`);
  changed(root);
}
function download(name, text) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { toast(`Téléchargement impossible : ${e.message}`); }
}
const base = () => (E.file || '3cx').replace(/\.xml$/i, '');
function exportUsers() {
  const { ctx, incallCtx } = tenantCtx();
  // Plusieurs départements en jeux de contextes propres : contexte de chaque utilisateur = celui
  // de son département, créé par la phase Fondations (onglet Écriture).
  let ctxOf = null;
  if (unitList(E.d).length > 1) {
    const by = Object.fromEntries(unitList(E.d).map((u) => [u.key, E.d.write?.units?.[u.key]?.created?.ctxName]));
    if (Object.values(by).some((x) => !x)) return toast('Plusieurs départements : créez d\'abord leurs contextes (onglet Écriture, phase Fondations), le CSV en dépend.', 7000);
    ctxOf = (u) => by[unitOf(E.d, u)];
  }
  // SDA : contexte entrant du trunk de son département (champ context du trunk), sinon celui d'Exports.
  const incallOf = ctxOf ? (u) => { const k = unitOf(E.d, u); const tr = (I.lists.trunk || []).find((x) => String(x.id) === String(E.d.write?.units?.[k]?.trunkId)); return tr?.context || incallCtx; } : null;
  if (!ctx && !ctxOf) return toast('Choisissez le contexte interne (tenant Wazo à ouvrir dans le portail).', 6000);
  const needIn = E.d.dids.some((r) => r.import && r.viaCsv && r.dest.t === 'user');
  if (needIn && !incallCtx) return toast('Aucun contexte entrant : décochez « CSV » dans l\'onglet SDA, ou ouvrez le bon tenant.', 6000);
  // Brouillon repris sans le XML : codes 3CX absents (jamais gardés dans le navigateur).
  if (E.m.fromCache && imported(E.d).some((u) => u.vm && u.vmPin)) return toast('Codes des messageries 3CX non disponibles (brouillon repris sans le fichier XML) : recharger la sauvegarde 3CX, puis relancer le CSV.', 8000);
  const pins = Object.fromEntries(E.m.extensions.map((e) => [e.number, e.vm.pin]));
  const go = () => download(`wazo-import-utilisateurs-${base()}.csv`, usersCsv(E.d, { ctx, incallCtx, pins, ctxOf, incallOf, numOf: (u) => wazoNum(E.d, u) }));
  const errs = [...tenantChecks(), ...draftIssues(E.d).filter((x) => x.area.startsWith('Utilisateur '))].filter((x) => x.sev === 'error');
  const unchecked = imported(E.d).filter((u) => !u.checked).length;
  if (!errs.length && !unchecked) return go();
  confirmModal(`<h3>${errs.length ? 'Wazo refusera ou faussera ce CSV' : 'Utilisateurs non vérifiés'}</h3>
    ${errs.length ? `<p>L'import de Wazo est tout ou rien : la première erreur annule tout.</p><ul class="small">${errs.map((x) => `<li>${esc(x.area)} : ${esc(x.text)}</li>`).join('')}</ul>` : ''}
    ${unchecked ? `<p class="small">${unchecked} utilisateur(s) pas encore vérifiés (onglet Utilisateurs, « Vérifier un par un »).</p>` : ''}
    <p class="small">Télécharger quand même ?</p>`, go, 'Télécharger quand même');
}
function exportBlf() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  // Numéros Wazo (renumérotation multi-site), numéro 3CX en colonne à part.
  const rows = [['poste', 'poste_3cx', 'nom', 'position_3cx', 'position_wazo', 'type', 'cible', 'cible_3cx', 'cible_nom', 'reprise'].join(';'), ...blfRows(E.d, E.m).map((b) => [wazoNumOf(E.d, b.owner), b.owner, b.ownerName, b.pos, b.wpos, b.type, b.type === 'parking' ? b.target : wazoNumOf(E.d, b.target), b.target, b.targetName, b.status].map(q).join(';'))];
  download(`astrea-3cx-blf-${base()}.csv`, '﻿' + rows.join('\r\n'));
}
function loadDraftFile(input, root) {
  const f = input.files?.[0]; input.value = '';
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try { E.d = normalize(acceptDraft(JSON.parse(r.result), E.file, E.d.sourceDate), E.m); saveDraft(E.d); setWizard(E.d, E.m); E.onReset?.(E.d); toast('Brouillon chargé.'); renderTab(root, E.tab); E.onChange?.(); }
    catch (err) { toast(`Brouillon refusé : ${err.message}`, 7000); }
  };
  r.readAsText(f);
}
