// Astrea Desk — écrans des modules de gestion (0.6.0) : une liste claire par
// type d'objet, recherche, et « Modifier » qui ouvre le réglage complet de
// Call Flow Manager (desk/cfbridge.js). Données : modèle Call Flow du site
// (toutes les listes confd du tenant, refiltrées sur le tenant par model.js).
import { S, $, esc, fullName } from '../admin-tools/common/core.js?v=0.7.2';
import { cfModel, edit, M, destLabel, showNum } from './cfbridge.js?v=0.7.2';
import { STRATEGY, periodText } from './cf/model.js?v=0.7.2';
import { loadPresences, phoneBadge } from './live.js?v=0.7.2';

const exts = (o) => (o.extensions || []).map((e) => showNum(e.exten)).filter(Boolean).join(', ');
const userExts = (u) => (u.lines || []).flatMap((l) => (l.extensions || []).map((e) => e.exten)).filter(Boolean).join(', ');
const schedName = (o) => (o.schedules || []).map((s) => M.by.schedule?.get(String(s.id))?.name || s.name).filter(Boolean).join(', ');
const yes = (b, off = 'Désactivé') => (b === false ? `<span class="dk-off">${off}</span>` : '');
const h = (html) => ({ html });
// Membres les uns sous les autres, dans un bloc repliable (retour de Brice,
// 02/11/2026). Ouvert d'office s'il y a peu de lignes, replié sinon ; le
// résumé donne le nombre et qui est en appel.
let FEW = true;
function memberList(members, { phone = true, ordered = false } = {}) {
  if (!members.length) return h('<span class="muted">aucun</span>');
  const st = members.map((m) => PRES.get(m.uuid)?.line_state);
  const busy = st.filter((s) => s === 'talking' || s === 'holding').length, free = st.filter((s) => s === 'available').length;
  const sum = [`${members.length} membre${members.length > 1 ? 's' : ''}`, phone && busy ? `${busy} en appel` : '', phone && free ? `${free} disponible${free > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
  const tag = ordered ? 'ol' : 'ul';
  return h(`<details class="dk-members"${FEW ? ' open' : ''}><summary>${esc(sum)}</summary><${tag}>${members.map((m) => `<li><span>${esc(fullName(M.userByUuid?.get(m.uuid) || m) || m.uuid)}</span>${phone ? phoneBadge(PRES.get(m.uuid)) : ''}</li>`).join('')}</${tag}></details>`);
}
const byPriority = (l) => [...(l || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

// Description des modules : liste M.lists[type], clé d'édition, colonnes.
// Une colonne renvoie du texte (échappé) ou { html }.
const SPECS = {
  users: { type: 'user', title: 'Utilisateurs', none: 'Aucun utilisateur.', key: (o) => o.uuid, presence: true,
    help: 'Réglage : durée de sonnerie, appels simultanés, ne pas déranger, filtrage, renvois. Le reste de la fiche se règle dans le Portal.',
    search: (o) => `${fullName(o)} ${userExts(o)} ${o.email || ''}`,
    cols: [['Nom', (o) => h(`${esc(fullName(o) || o.username || o.uuid)} ${yes(o.enabled)}`)], ['Numéro', userExts], ['Téléphone', (o) => h(phoneBadge(PRES.get(o.uuid)))], ['Sonnerie', (o) => (o.ring_seconds != null ? `${o.ring_seconds} s` : '')], ['E-mail', (o) => o.email || '']] },
  groups: { type: 'group', title: "Groupes d'appels", none: "Aucun groupe d'appels.", key: (o) => o.uuid, presence: true,
    help: 'Membres enregistrés, avec l\'état de leur téléphone. Les entrées / sorties faites depuis un poste (*735…) ne sont pas visibles : Wazo ne les expose qu\'au compte principal du serveur.',
    search: (o) => `${o.label} ${exts(o)}`,
    cols: [['Nom', (o) => h(`${esc(o.label || o.name)} ${yes(o.enabled)}`)], ['Numéro', exts], ['Sonnerie', (o) => STRATEGY[o.ring_strategy] || o.ring_strategy || ''],
      ['Membres', (o) => memberList(byPriority(o.members?.users), { ordered: o.ring_strategy === 'linear' })],
      ['Si pas de réponse', (o) => destLabel(o.fallbacks?.noanswer_destination)], ['Horaire', schedName]] },
  voicemails: { type: 'voicemail', title: 'Messageries vocales', none: 'Aucune messagerie vocale.', key: (o) => o.id,
    help: 'Réglage complet : nom, numéro, utilisateurs, messages d\'accueil (écoute, envoi d\'un fichier), e-mail, code, langue, fuseau.',
    search: (o) => `${o.name} ${o.number} ${o.email || ''} ${(o.users || []).map(fullName).join(' ')}`,
    cols: [['Nom', (o) => h(`${esc(o.name)} ${yes(o.enabled, 'Désactivée')}`)], ['Numéro', (o) => o.number], ['Utilisateurs', (o) => ((o.users || []).length ? memberList(o.users, { phone: false }) : (o.accesstype === 'global' ? 'partagée' : '—'))], ['E-mail', (o) => o.email || '—']] },
  incalls: { type: 'incall', title: 'Appels entrants', none: 'Aucun appel entrant (SDA).', key: (o) => o.id,
    help: 'Numéros publics (SDA) : destination, horaire, nom affiché, message d\'accueil.',
    search: (o) => `${exts(o)} ${(o.extensions || []).map((e) => e.exten).join(' ')} ${o.description || ''} ${destLabel(o.destination)}`,
    cols: [['Numéro', exts], ['Description', (o) => o.description || ''], ['Destination', (o) => destLabel(o.destination)], ['Horaire', schedName]] },
  outcalls: { type: 'outcall', title: 'Appels sortants', none: 'Aucune règle d\'appels sortants.', key: (o) => o.id,
    help: 'Règles de sortie : motifs composés, interconnexions utilisées, horaire.',
    search: (o) => `${o.name} ${o.label || ''}`,
    cols: [['Nom', (o) => h(`${esc(o.label || o.name)} ${yes(o.enabled, 'Désactivée')}`)], ['Motifs', (o) => (o.extensions || []).map((e) => e.exten).join(', ')], ['Interconnexions', (o) => (o.trunks || []).map((t) => M.by.trunk?.get(String(t.id))?.label || t.name || `#${t.id}`).join(', ')], ['Horaire', schedName]] },
  schedules: { type: 'schedule', title: 'Plages horaires', none: 'Aucune plage horaire.', key: (o) => o.id, hours: true,
    help: '« Modifier » : heures d\'ouverture (grille de la semaine, tirer pour sélectionner), destination si fermé, fermetures exceptionnelles et jours fériés. Nom, fuseau horaire et activation : lien sous le nom.',
    search: (o) => o.name,
    cols: [['Nom', (o) => h(`${esc(o.name)} ${yes(o.enabled, 'Désactivée')}${S.readonly ? '' : `<br><button class="dk-link-sm" data-ed="${esc(o.id)}" data-gen="1">Nom, fuseau, activation</button>`}`)], ['Ouvert', (o) => (o.open_periods || []).map(periodText).join(' ; ') || 'jamais (toujours fermé)'], ['Si fermé', (o) => destLabel(o.closed_destination)],
      ['Fermetures', (o) => { const n = (o.exceptional_periods || []).reduce((a, p) => a + Math.max(1, (p.month_days?.length || 1) * (p.months?.length || 1)), 0); return n ? `${n} jour${n > 1 ? 's' : ''}` : '—'; }],
      ['Utilisée par', (o) => { const u = schedUsers(o); return u.length ? h(`<span class="dk-usage" title="${esc(u.join('\n'))}">${u.length} objet${u.length > 1 ? 's' : ''}</span>`) : '—'; }]] },
  ivr: { type: 'ivr', title: 'SVI', none: 'Aucun serveur vocal interactif.', key: (o) => o.id,
    help: 'Message, touches et leurs destinations, cas sans saisie ou invalide.',
    search: (o) => `${o.name} ${o.description || ''}`,
    cols: [['Nom', (o) => o.name], ['Touches', (o) => (o.choices || []).map((c) => `${c.exten} → ${destLabel(c.destination)}`).join(' · ') || '—'], ['Sans saisie', (o) => destLabel(o.timeout_destination)]] },
  conferences: { type: 'conference', title: 'Conférences', none: 'Aucune salle de conférence.', key: (o) => o.id,
    help: 'Nom, participants maximum, codes, annonces, enregistrement.',
    search: (o) => `${o.name} ${exts(o)}`,
    cols: [['Nom', (o) => o.name], ['Numéro', exts], ['Participants max.', (o) => o.max_users || 'sans limite'], ['Code', (o) => (o.pin ? 'oui' : 'non')]] },
  switchboards: { type: 'switchboard', title: 'POPC', none: 'Aucun POPC.', key: (o) => o.uuid, presence: true,
    help: 'Opérateurs, délai avant débordement, musique d\'attente, destination si pas de réponse.',
    search: (o) => `${o.name} ${exts(o)}`,
    cols: [['Nom', (o) => o.name], ['Numéro', exts], ['Opérateurs', (o) => memberList(o.members?.users || [])], ['Si pas de réponse', (o) => destLabel(o.fallbacks?.noanswer_destination)]] },
};
// Objets qui utilisent une plage horaire (affichés au survol de « n objets »).
const SCHED_OWNERS = [['incall', 'SDA', (o) => exts(o) || o.description], ['user', 'Utilisateur', (o) => fullName(o)], ['group', 'Groupe', (o) => o.label || o.name], ['queue', 'File', (o) => o.label || o.name], ['outcall', 'Sortant', (o) => o.label || o.name]];
const schedUsers = (s) => SCHED_OWNERS.flatMap(([t, l, n]) => (M.lists[t] || []).filter((o) => (o.schedules || []).some((x) => String(x.id) === String(s.id))).map((o) => `${l} ${n(o)}`));
const LIST = { users: 'user', groups: 'group', voicemails: 'voicemail', incalls: 'incall', outcalls: 'outcall', schedules: 'schedule', ivr: 'ivr', conferences: 'conference', switchboards: 'switchboard' };
let PRES = new Map();
const Q = {}; // recherche gardée par module

export async function renderModuleList(id, view, site) {
  const sp = SPECS[id];
  view.innerHTML = `<div class="phonehead"><div><h2>${esc(sp.title)}</h2><div class="muted small">${esc(site.name)}</div></div></div><p class="dk-empty">Lecture…</p>`;
  await Promise.all([cfModel(), sp.presence ? loadPresences().then((p) => { PRES = p; }) : null]);
  if (!view.isConnected) return;
  const ro = !!S.readonly;
  const draw = () => {
    const list = [...(M.lists[LIST[id]] || [])].sort((a, b) => String(sp.search(a)).localeCompare(String(sp.search(b)), 'fr', { numeric: true }));
    const q = (Q[id] || '').trim().toLowerCase();
    const rows = q ? list.filter((o) => sp.search(o).toLowerCase().includes(q)) : list;
    const cell = (v) => (v && typeof v === 'object' ? v.html : esc(v ?? ''));
    // Peu de lignes : membres dépliés d'office ; beaucoup : repliés (pas de défilement interminable).
    FEW = rows.length <= 4;
    const btns = (o) => (ro ? '' : `<button class="dk-text" data-ed="${esc(sp.key(o))}">Modifier</button>`);
    $('mod-out').innerHTML = (rows.length
      ? `<div class="dk-scroll"><table class="dk-table"><thead><tr>${sp.cols.map(([t]) => `<th>${esc(t)}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((o) => `<tr>${sp.cols.map(([, f]) => `<td>${cell(f(o))}</td>`).join('')}<td class="dk-acts">${btns(o)}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="dk-empty">${esc(q ? 'Aucun résultat.' : sp.none)}</p>`)
      + `<p class="muted small">${list.length} au total${q ? ` · ${rows.length} affiché${rows.length > 1 ? 's' : ''}` : ''}.</p>`;
  };
  view.innerHTML = `<div class="phonehead"><div><h2>${esc(sp.title)}</h2><div class="muted small">${esc(site.name)}${ro ? ' · lecture seule' : ''}</div></div>
      <div class="btnrow"><input id="mod-q" class="dk-search" type="search" placeholder="Rechercher" value="${esc(Q[id] || '')}"><button id="mod-reload" title="Relire depuis Wazo">Actualiser</button></div></div>
    ${sp.help ? `<p class="muted small">${esc(sp.help)}</p>` : ''}<div id="mod-out"></div>`;
  $('mod-q').oninput = (e) => { Q[id] = e.target.value; draw(); };
  $('mod-reload').onclick = async () => { await Promise.all([cfModel(true), sp.presence ? loadPresences().then((p) => { PRES = p; }) : null]); draw(); };
  view.onclick = (e) => {
    const b = e.target.closest('[data-ed]'); if (!b) return;
    // Plage horaire : « Modifier » ouvre les heures ; le lien sous le nom, nom / fuseau / activation.
    edit(sp.type, b.dataset.ed, () => { if ($('mod-out')) draw(); }, { hours: !!sp.hours && !b.dataset.gen });
  };
  draw();
}
export const MODULE_IDS = Object.keys(SPECS);
