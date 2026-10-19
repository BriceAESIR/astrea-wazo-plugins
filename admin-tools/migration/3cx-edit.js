// Migration Assistant — tableaux modifiables du brouillon d'import 3CX.
// Modèle et règles : 3cx-draft.js. Chaque modification est enregistrée dans le
// navigateur (brouillon par fichier et date de sauvegarde) ; rien n'est écrit
// dans Wazo depuis ces tableaux.
import { $, esc, toast, helpButton, helpBox, confirmModal, downloadJson } from '../common/core.js?v=0.40.13';
import { I } from './inventory.js?v=0.40.13';
import {
  GROUP_STRATEGIES, MODES, HUNT_TARGETS, saveDraft, clearDraft, buildDraft, acceptDraft, userBy, userName, imported,
  destLabel, destProblem, draftIssues, usersCsv, blfRows, devicesCsv, deviceDesc, macWazo, macValid,
} from './3cx-draft.js?v=0.40.13';

const E = { d: null, m: null, file: '', tab: 'users', sel: { users: new Set(), dids: new Set() }, q: '', onReset: null };
export const TABS = [
  ['fiche', 'Fiche 3CX'], ['users', 'Utilisateurs'], ['devices', 'Appareils'], ['hunts', 'Groupes et files'], ['ivrs', 'SVI'], ['dids', 'SDA'], ['scheds', 'Horaires'], ['checks', 'Contrôles'], ['exports', 'Exports'],
];
export function setDraft(d, m, file, onReset) { E.d = d; E.m = m; E.file = file; E.onReset = onReset; E.sel.users.clear(); E.sel.dids.clear(); }
export const draft = () => E.d;
export function tabCounts() {
  const d = E.d; if (!d) return {};
  const iss = draftIssues(d);
  return { users: imported(d).length, devices: (d.devices || []).filter((x) => x.import).length, hunts: d.hunts.filter((h) => h.target !== 'skip').length, ivrs: d.ivrs.filter((v) => v.import).length, dids: d.dids.filter((r) => r.import).length, scheds: d.schedules.length, checks: iss.filter((x) => x.sev !== 'info').length };
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
const head = (cols) => `<thead><tr>${cols.map(([l, h]) => `<th${h ? ` title="${esc(h)}"` : ''}>${esc(l)}</th>`).join('')}</tr></thead>`;
const intro = (id, title, text, extra = '') => `<div class="titlerow"><h3>${esc(title)}</h3>${helpButton(`x3e-${id}`, `Aide : ${title}`)}${extra}</div>${helpBox(`x3e-${id}`, text)}`;

// ---------------------------------------------------------------------------
// Rendu des onglets
// ---------------------------------------------------------------------------
export function renderTab(root, tab) {
  E.tab = tab;
  const keep = [...root.querySelectorAll('.x3-edit-wrap')].map((w) => [w.scrollTop, w.scrollLeft]);
  const opts = destOptions();
  const html = { users: usersTab, devices: devicesTab, hunts: huntsTab, ivrs: ivrsTab, dids: didsTab, scheds: schedsTab, checks: checksTab, exports: exportsTab }[tab]?.(opts) || '';
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
  root.querySelectorAll('.x3-edit-wrap').forEach((w, i) => { if (keep[i]) [w.scrollTop, w.scrollLeft] = keep[i]; });
  root.onchange = (e) => onChange(e, root);
  root.onclick = (e) => onClick(e, root);
  root.oninput = (e) => { if (e.target.id === 'x3e-q') { E.q = e.target.value; renderTab(root, tab); const q = $('x3e-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); } };
}

const USER_HELP = 'Une ligne par poste 3CX. Reprise : utilisateur Wazo (ligne SIP + numéro), messagerie seule (boîte vocale sans utilisateur, pour les répondeurs) ou non repris. Les noms en italique sont déduits de l\'e-mail. Sonnerie : durée avant le débordement « pas de réponse » (ring_seconds). Renvois du profil 3CX « Disponible » → débordements de l\'utilisateur Wazo (pas de réponse, occupé, indisponible). « corrigé » : un renvoi vers un numéro du client a été remplacé par sa destination. Touches : reprendre les BLF de ce poste. Cochez des lignes pour une modification groupée.';
function usersTab(opts) {
  const d = E.d; const q = E.q.trim().toLowerCase();
  const list = d.users.map((u, i) => [u, i]).filter(([u]) => !q || `${u.n} ${userName(u)} ${u.email}`.toLowerCase().includes(q));
  const rows = list.map(([u, i]) => {
    const p = `users.${i}`; const on = u.mode === 'user';
    return `<tr class="${u.mode !== 'user' ? 'x3-off' : ''}${E.sel.users.has(i) ? ' sel' : ''}">
      <td><input type="checkbox" data-sel="users" data-i="${i}" ${E.sel.users.has(i) ? 'checked' : ''}></td>
      <td>${esc(u.n)}${u.src.enabled ? '' : '<div class="muted small">désactivé 3CX</div>'}</td>
      <td>${sel(`${p}.mode`, MODES)}</td>
      <td>${input(`${p}.first`, `class="${u.guessed ? 'x3-guess' : ''}" title="${esc(`Dans 3CX : ${[u.src.first, u.src.last].filter(Boolean).join(' ') || 'vide'}`)}"`)}</td>
      <td>${input(`${p}.last`)}</td>
      <td>${input(`${p}.email`, 'type="email" class="x3-mail"')}</td>
      <td>${input(`${p}.mobile`, 'class="x3-num"')}</td>
      <td class="x3-c">${check(`${p}.vm`, 'Messagerie')}${u.vm ? `<label class="x3-mini" title="Reprendre le code de messagerie 3CX (lu dans la sauvegarde à l'export, jamais stocké dans le brouillon)">${check(`${p}.vmPin`)} code</label>` : ''}</td>
      <td>${on ? num(`${p}.ring`, 5, 300) : ''}</td>
      <td>${on ? destCell(`${p}.fb.noanswer`, opts) : ''}</td>
      <td>${on ? destCell(`${p}.fb.busy`, opts) : ''}</td>
      <td>${on ? destCell(`${p}.fb.fail`, opts) : ''}</td>
      <td class="x3-c">${on ? check(`${p}.blf`, 'Reprendre les touches BLF de ce poste') : ''}</td>
      <td class="small">${(d.devices || []).filter((x) => x.owner === u.n).map((x) => `${esc(x.model)}<div class="muted">${esc(x.mac)}${x.import ? '' : ' (non repris)'}</div>`).join('') || '<span class="muted">aucun</span>'}</td>
    </tr>`;
  }).join('');
  const n = E.sel.users.size;
  return `${intro('users', 'Utilisateurs', USER_HELP, `<input id="x3e-q" type="search" placeholder="Filtrer" value="${esc(E.q)}" class="x3-q">`)}
    ${n ? '' : '<p class="x3-bulk-hint muted small">Cochez des lignes pour les modifier en groupe (reprise, sonnerie, renvois, messagerie).</p>'}
    <div class="x3-bulk"${n ? '' : ' hidden'}>
      <strong>${n} sélectionné(s)</strong>
      <label>Reprise <select id="xb-mode"><option value="">inchangée</option>${Object.entries(MODES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <label>Sonnerie <input id="xb-ring" type="number" min="5" max="300" placeholder="s" class="x3-short"></label>
      <label>Renvoi <select id="xb-fbk"><option value="all">tous</option><option value="noanswer">pas de réponse</option><option value="busy">occupé</option><option value="fail">indisponible</option></select></label>
      <label>vers <select id="xb-dest"><option value="keep">inchangé</option>${opts}</select></label>
      <input id="xb-num" placeholder="numéro externe" class="x3-num">
      <label>Messagerie <select id="xb-vmset"><option value="">inchangée</option><option value="1">activer</option><option value="0">désactiver</option></select></label>
      <button data-act="bulk-users" ${n ? '' : 'disabled'}>Appliquer</button>
    </div>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['', 'Sélection'], ['N°'], ['Reprise', 'Utilisateur, messagerie seule ou non repris'], ['Prénom'], ['Nom'], ['E-mail'], ['Mobile'], ['Messagerie'], ['Sonnerie', 'Secondes avant « pas de réponse »'], ['Pas de réponse'], ['Occupé'], ['Indisponible', 'Poste non enregistré ou injoignable (chanunavail)'], ['Touches'], ['Appareil']])}<tbody>${rows}</tbody></table></div>`;
}

const DEVICE_HELP = 'Une ligne par téléphone de la sauvegarde 3CX. MAC : convertie au format Wazo (00:15:65:a1:b2:c3), modifiable. Utilisateur : celui dont la ligne sera associée à l\'appareil (au départ, le poste 3CX qui l\'utilisait) ; « aucun » = appareil créé seul, en stock. Description : « Prénom Nom » de l\'utilisateur, mise à jour automatiquement quand son nom change ; une description saisie à la main n\'est plus mise à jour (case « auto » pour revenir au nom). Une MAC déjà présente dans le tenant Wazo ouvert est signalée.';
function devicesTab() {
  const d = E.d;
  const wazo = new Map((I.lists.device || []).filter((x) => x.mac).map((x) => [String(x.mac).toLowerCase(), x]));
  const owners = `<option value="">Aucun (stock)</option>${d.users.filter((u) => u.mode === 'user').map((u) => `<option value="${esc(u.n)}">${esc(u.n)} ${esc(userName(u))}</option>`).join('')}`;
  const rows = (d.devices || []).map((dv, i) => {
    const p = `devices.${i}`;
    const inWazo = wazo.get(String(dv.mac).toLowerCase());
    const owner = dv.owner ? userBy(d, dv.owner) : null;
    return `<tr class="${dv.import ? '' : 'x3-off'}">
      <td class="x3-c">${check(`${p}.import`, 'Reprendre cet appareil')}</td>
      <td><input data-p="${p}.mac" data-type="mac" value="${esc(dv.mac)}" class="x3-mac${macValid(dv.mac) ? '' : ' bad'}">${inWazo ? `<div class="x3-warn small" title="${esc(`Déjà dans Wazo : ${inWazo.description || ''} ${inWazo.model || ''}`)}">déjà dans ce tenant</div>` : ''}</td>
      <td class="x3-nowrap">${esc(dv.model)}${dv.vendor && !dv.model.toLowerCase().startsWith(dv.vendor.toLowerCase()) ? `<div class="muted small">${esc(dv.vendor)}</div>` : ''}</td>
      <td><select data-p="${p}.owner" data-val="${esc(dv.owner || '')}">${owners}</select>${owner && owner.mode !== 'user' ? '<div class="x3-warn small">poste non repris</div>' : ''}</td>
      <td><input data-p="${p}.desc" data-type="desc" value="${esc(deviceDesc(d, dv))}" placeholder="Prénom Nom" class="x3-desc${dv.descAuto ? ' x3-auto' : ''}"></td>
      <td class="x3-c">${check(`${p}.descAuto`, 'Description = Prénom Nom de l\'utilisateur, mise à jour automatiquement')}</td>
    </tr>`;
  }).join('');
  return `${intro('devices', 'Appareils', DEVICE_HELP)}<div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Reprise'], ['MAC'], ['Modèle'], ['Utilisateur', 'Ligne associée à l\'appareil'], ['Description'], ['Auto', 'Description automatique (Prénom Nom)']])}<tbody>${rows || '<tr><td colspan="6" class="muted">Aucun appareil dans la sauvegarde.</td></tr>'}</tbody></table></div>`;
}

const HUNT_HELP = 'Groupes de sonnerie et files 3CX. Wazo : choisissez groupe d\'appel ou file d\'attente pour chacun (une file 3CX à 2 membres en « Hunt » devient souvent un groupe « un par un »). Les destinations qui visent cet objet le suivent automatiquement. Durée totale : délai avant le débordement « sans réponse » (timeout) ; sonnerie par membre : user_timeout pour un groupe, délai de sonnerie d\'un agent pour une file. Membres : utilisateurs repris seulement.';
function huntsTab(opts) {
  const d = E.d;
  const users = d.users.filter((u) => u.mode === 'user');
  const rows = d.hunts.map((h, i) => {
    const p = `hunts.${i}`;
    const add = users.filter((u) => !h.members.includes(u.n)).map((u) => `<option value="${esc(u.n)}">${esc(u.n)} ${esc(userName(u))}</option>`).join('');
    return `<tr class="${h.target === 'skip' ? 'x3-off' : ''}">
      <td>${esc(h.n)}</td><td class="small">${h.src === 'Queue' ? 'File' : 'Groupe'} 3CX</td>
      <td>${sel(`${p}.target`, HUNT_TARGETS)}</td>
      <td>${input(`${p}.name`)}</td>
      <td>${sel(`${p}.strategy`, GROUP_STRATEGIES)}</td>
      <td>${num(`${p}.timeout`, 5, 3600)}</td>
      <td>${num(`${p}.userTimeout`, 5, 600)}</td>
      <td><div class="x3-chips">${h.members.map((n) => { const u = userBy(d, n); const ok = u?.mode === 'user'; return `<span class="x3-chip${ok ? '' : ' bad'}" title="${esc(ok ? userName(u) : 'non repris')}">${esc(n)}${u ? ` ${esc(userName(u))}` : ''}<button data-act="rm-member" data-i="${i}" data-n="${esc(n)}" title="Retirer">×</button></span>`; }).join('')}
        ${add ? `<select data-act="add-member" data-i="${i}" class="x3-add"><option value="">+ membre</option>${add}</select>` : ''}</div></td>
      <td>${destCell(`${p}.noanswer`, opts)}</td>
      <td class="small">${esc(h.music || '')}</td>
    </tr>`;
  }).join('');
  return `${intro('hunts', 'Groupes et files', HUNT_HELP)}<div class="x3-edit-wrap"><table class="diff x3-edit">${head([['N°'], ['Origine'], ['Wazo'], ['Nom'], ['Stratégie'], ['Durée totale', 'Secondes avant « sans réponse »'], ['Par membre', 'Secondes de sonnerie par membre'], ['Membres'], ['Sans réponse'], ['Musique 3CX']])}<tbody>${rows}</tbody></table></div>`;
}

const IVR_HELP = 'SVI 3CX (les SVI internes de 3CX sont exclus). Touches : destination de chaque touche ; « + touche » ajoute la première touche libre. Délai : secondes d\'attente d\'une saisie avant « sans saisie ». Le message est à téléverser dans les sons Wazo.';
function ivrsTab(opts) {
  const rows = E.d.ivrs.map((v, i) => {
    const p = `ivrs.${i}`;
    return `<tr class="${v.import ? '' : 'x3-off'}">
      <td>${esc(v.n)}</td><td class="x3-c">${check(`${p}.import`, 'Reprendre')}</td><td>${input(`${p}.name`)}</td><td class="small">${esc(v.prompt || '')}</td>
      <td>${num(`${p}.timeout`, 1, 120)}</td>
      <td>${v.choices.map((c, k) => `<div class="x3-choice"><input data-p="${p}.choices.${k}.key" value="${esc(c.key)}" class="x3-key">${destCell(`${p}.choices.${k}.dest`, opts)}<button class="icon" data-act="rm-choice" data-i="${i}" data-k="${k}" title="Retirer la touche">×</button></div>`).join('')}
        <button class="x3-link" data-act="add-choice" data-i="${i}">+ touche</button></td>
      <td>${destCell(`${p}.timeoutDest`, opts)}</td>
    </tr>`;
  }).join('');
  return `${intro('ivrs', 'SVI', IVR_HELP)}<div class="x3-edit-wrap"><table class="diff x3-edit">${head([['N°'], ['Reprise'], ['Nom'], ['Message'], ['Délai'], ['Touches'], ['Sans saisie']])}<tbody>${rows}</tbody></table></div>`;
}

const DID_HELP = 'Une ligne par SDA du trunk (les SDA sans règle 3CX sont décochées). Destination : en heures d\'ouverture, ou toujours si aucun horaire. Horaire : celui déduit de la règle 3CX, modifiable ; fermé et férié ne servent que s\'il y a un horaire. CSV : créer cette SDA avec l\'utilisateur par le CSV d\'import (destination utilisateur seulement, sans horaire : à associer ensuite).';
function didsTab(opts) {
  const d = E.d; const q = E.q.trim().toLowerCase();
  const schedOpts = (cur) => `<option value="">Toujours ouvert</option>${d.schedules.map((s) => `<option value="${esc(s.key)}" ${s.key === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
  const rows = d.dids.map((r, i) => [r, i]).filter(([r]) => !q || `${r.did} ${r.name} ${destLabel(d, r.dest)}`.toLowerCase().includes(q)).map(([r, i]) => {
    const p = `dids.${i}`;
    return `<tr class="${r.import ? '' : 'x3-off'}${E.sel.dids.has(i) ? ' sel' : ''}">
      <td><input type="checkbox" data-sel="dids" data-i="${i}" ${E.sel.dids.has(i) ? 'checked' : ''}></td>
      <td>${esc(r.did)}<div class="muted small">${esc(r.name || '')}</div></td><td class="x3-c">${check(`${p}.import`, 'Reprendre')}</td>
      <td>${destCell(`${p}.dest`, opts)}</td>
      <td><select data-p="${p}.schedule">${schedOpts(r.schedule)}</select></td>
      <td>${r.schedule ? destCell(`${p}.closed`, opts) : '<span class="muted">—</span>'}</td>
      <td>${r.schedule ? destCell(`${p}.holiday`, opts) : '<span class="muted">—</span>'}</td>
      <td class="x3-c">${r.dest.t === 'user' ? check(`${p}.viaCsv`, 'Créer par le CSV d\'import') : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  const n = E.sel.dids.size;
  return `${intro('dids', 'SDA', DID_HELP, `<input id="x3e-q" type="search" placeholder="Filtrer" value="${esc(E.q)}" class="x3-q">`)}
    ${n ? '' : '<p class="x3-bulk-hint muted small">Cochez des lignes pour les modifier en groupe (reprise, destination, horaire).</p>'}
    <div class="x3-bulk"${n ? '' : ' hidden'}><strong>${n} sélectionnée(s)</strong>
      <label>Reprise <select id="xd-imp"><option value="">inchangée</option><option value="1">oui</option><option value="0">non</option></select></label>
      <label>Destination <select id="xd-dest"><option value="keep">inchangée</option>${opts}</select></label><input id="xd-num" placeholder="numéro externe" class="x3-num">
      <label>Horaire <select id="xd-sched"><option value="keep">inchangé</option>${schedOpts('__')}</select></label>
      <button data-act="bulk-dids" ${n ? '' : 'disabled'}>Appliquer</button></div>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['', 'Sélection'], ['SDA'], ['Reprise'], ['Destination'], ['Horaire'], ['Fermé'], ['Férié'], ['CSV']])}<tbody>${rows}</tbody></table></div>`;
}

function schedsTab() {
  const d = E.d;
  const used = (k) => d.dids.filter((r) => r.import && r.schedule === k).length;
  return `${intro('scheds', 'Horaires', 'Horaires Wazo à créer, déduits des règles 3CX (heures de bureau moins la pause, ou plages propres d\'une règle). Le nom est modifiable ; les plages se modifieront dans Call Flow Manager après création. Fermetures exceptionnelles : ajoutées à chaque horaire si cochées. Les jours fériés légaux français autres que ceux de la sauvegarde sont à ajouter.')}
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Nom'], ['Plages'], ['SDA']])}<tbody>${d.schedules.map((s, i) => `<tr><td>${input(`schedules.${i}.name`)}</td><td>${esc(s.text)}</td><td>${used(s.key)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Aucun horaire.</td></tr>'}</tbody></table></div>
    <h3 class="x3-h">Fermetures exceptionnelles</h3>
    <div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Reprise'], ['Nom'], ['Dates'], ['Heures']])}<tbody>${d.holidays.map((h, i) => `<tr class="${h.include ? '' : 'x3-off'}"><td class="x3-c">${check(`holidays.${i}.include`)}</td><td>${input(`holidays.${i}.name`)}</td><td>${h.day}/${h.month}${h.recurrent ? ' (tous les ans)' : `/${h.year}`}${h.dayEnd !== h.day || h.monthEnd !== h.month ? ` → ${h.dayEnd}/${h.monthEnd}` : ''}</td><td>${esc(h.from)}-${esc(h.to)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucune.</td></tr>'}</tbody></table></div>`;
}

const SEV_FR = { error: 'Erreur', warn: 'À vérifier', info: 'Info' };
function checksTab() {
  const iss = draftIssues(E.d).sort((a, b) => ['error', 'warn', 'info'].indexOf(a.sev) - ['error', 'warn', 'info'].indexOf(b.sev));
  return `${intro('checks', 'Contrôles du brouillon', 'Recalculés à chaque modification : numéros en double ou non numériques, utilisateurs sans nom, destinations vers un objet non repris, groupes sans membre repris, SDA sans destination. Les erreurs bloqueront l\'écriture dans Wazo (étape suivante) ; les exports restent possibles.')}
    ${iss.length ? `<div class="x3-edit-wrap"><table class="diff x3-edit">${head([['Gravité'], ['Où'], ['Quoi']])}<tbody>${iss.map((x) => `<tr class="x3-${x.sev}"><td>${SEV_FR[x.sev]}</td><td>${esc(x.area)}</td><td>${esc(x.text)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="mg-allok">Aucun problème dans le brouillon.</div>'}`;
}

function exportsTab() {
  const ctxs = I.lists.context || [];
  const opt = (type, none) => ctxs.filter((c) => c.type === type).map((c) => `<option value="${esc(c.name)}">${esc(c.label || c.name)} (${esc(c.name)})</option>`).join('') || `<option value="">${none}</option>`;
  const d = E.d;
  const blf = blfRows(d, E.m);
  return `${intro('exports', 'Exports du brouillon', 'Fichiers produits depuis le brouillon tel qu\'il est. Brouillon JSON : pour le reprendre sur un autre poste ou le garder avec le dossier client (sans mot de passe ni code). Réinitialiser : repart de la sauvegarde 3CX et efface les modifications.')}
    <div class="card mg-card wide">
      <h4>CSV d'import des utilisateurs Wazo <span class="muted">(${imported(d).length} utilisateurs, ${d.dids.filter((r) => r.import && r.viaCsv && r.dest.t === 'user').length} SDA directes)</span></h4>
      <div class="ms-tools"><label>Contexte interne <select id="x3-ctx">${opt('internal', 'aucun contexte interne lu')}</select></label><label>Contexte entrant <select id="x3-inctx">${opt('incall', 'aucun contexte entrant lu')}</select></label></div>
      <div class="btnrow"><button data-act="csv-users" class="primary">Télécharger le CSV</button></div>
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
  const t = e.target;
  if (t.id === 'x3-draft-file') return loadDraftFile(t, root);
  if (t.dataset.sel) { const s = E.sel[t.dataset.sel]; const i = Number(t.dataset.i); t.checked ? s.add(i) : s.delete(i); return renderTab(root, E.tab); }
  if (t.dataset.act === 'add-member' && t.value) { const h = E.d.hunts[Number(t.dataset.i)]; h.members.push(t.value); return changed(root); }
  if (t.dataset.dest) { const cur = get(t.dataset.dest); set(t.dataset.dest, parseDest(t.value, cur?.num)); return changed(root); }
  if (t.dataset.destnum) { const cur = get(t.dataset.destnum); set(t.dataset.destnum, { ...cur, num: t.value.trim() }); return changed(root); }
  if (t.dataset.p) {
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.type === 'num') v = Math.max(Number(t.min || 0), Math.min(Number(t.max || 99999), Number(v) || 0));
    if (typeof v === 'string') v = v.trim();
    if (t.dataset.type === 'mac') v = macWazo(v);
    set(t.dataset.p, v);
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
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const d = E.d;
  switch (b.dataset.act) {
    case 'rm-member': { const h = d.hunts[Number(b.dataset.i)]; h.members = h.members.filter((n) => n !== b.dataset.n); return changed(root); }
    case 'rm-choice': { d.ivrs[Number(b.dataset.i)].choices.splice(Number(b.dataset.k), 1); return changed(root); }
    case 'add-choice': { const v = d.ivrs[Number(b.dataset.i)]; const used = new Set(v.choices.map((c) => c.key)); const key = '1234567890*#'.split('').find((k) => !used.has(k)); if (!key) return toast('Toutes les touches sont prises.'); v.choices.push({ key, dest: { t: 'none' } }); return changed(root); }
    case 'bulk-users': return bulkUsers(root);
    case 'bulk-dids': return bulkDids(root);
    case 'csv-users': return exportUsers();
    case 'csv-blf': return exportBlf();
    case 'csv-devices': return download(`astrea-3cx-appareils-${base()}.csv`, devicesCsv(d));
    case 'draft-dl': return downloadJson(`astrea-3cx-brouillon-${(E.file || '3cx').replace(/\.xml$/i, '')}.json`, d);
    case 'draft-reset': return confirmModal('<h3>Réinitialiser le brouillon ?</h3><p>Toutes les modifications sont perdues ; le brouillon repart de la sauvegarde 3CX.</p>', () => { clearDraft(d); E.d = buildDraft(E.m, E.file); saveDraft(E.d); E.onReset?.(E.d); renderTab(root, E.tab); E.onChange?.(); }, 'Réinitialiser');
    default:
  }
}
function bulkUsers(root) {
  const d = E.d; const ids = [...E.sel.users];
  const mode = $('xb-mode').value; const ring = Number($('xb-ring').value); const fbk = $('xb-fbk').value; const dv = $('xb-dest').value; const vmset = $('xb-vmset').value;
  const dest = dv === 'keep' ? null : parseDest(dv, $('xb-num').value.trim());
  for (const i of ids) {
    const u = d.users[i];
    if (mode) u.mode = mode;
    if (ring) u.ring = Math.max(5, Math.min(300, ring));
    if (dest) for (const k of fbk === 'all' ? ['noanswer', 'busy', 'fail'] : [fbk]) u.fb[k] = { ...dest };
    if (vmset) u.vm = vmset === '1';
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
  const ctx = $('x3-ctx').value; const incallCtx = $('x3-inctx').value;
  if (!ctx) return toast('Choisissez le contexte interne (tenant Wazo à ouvrir dans le portail).', 6000);
  const needIn = E.d.dids.some((r) => r.import && r.viaCsv && r.dest.t === 'user');
  if (needIn && !incallCtx) return toast('Aucun contexte entrant : décochez « CSV » dans l\'onglet SDA, ou ouvrez le bon tenant.', 6000);
  const pins = Object.fromEntries(E.m.extensions.map((e) => [e.number, e.vm.pin]));
  download(`wazo-import-utilisateurs-${base()}.csv`, usersCsv(E.d, { ctx, incallCtx, pins }));
}
function exportBlf() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['poste', 'nom', 'position_3cx', 'position_wazo', 'type', 'cible', 'cible_nom', 'reprise'].join(';'), ...blfRows(E.d, E.m).map((b) => [b.owner, b.ownerName, b.pos, b.wpos, b.type, b.target, b.targetName, b.status].map(q).join(';'))];
  download(`astrea-3cx-blf-${base()}.csv`, '﻿' + rows.join('\r\n'));
}
function loadDraftFile(input, root) {
  const f = input.files?.[0]; input.value = '';
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try { E.d = acceptDraft(JSON.parse(r.result), E.file, E.d.sourceDate); saveDraft(E.d); E.onReset?.(E.d); toast('Brouillon chargé.'); renderTab(root, E.tab); E.onChange?.(); }
    catch (err) { toast(`Brouillon refusé : ${err.message}`, 7000); }
  };
  r.readAsText(f);
}
