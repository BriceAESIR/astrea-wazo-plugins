// Astrea Desk — socle (lot 1) : connexion avec le compte Portal, droits lus
// dans le Portal (visualization), choix du site, connexion à la stack, menu
// et accueil. Les appels confd passent par common/core.js (api, listAll,
// filtre tenant), avec le token de la stack du site.
import { sdk, S, $, esc, toast, applyTheme, listAll, showCompat } from '../admin-tools/common/core.js?v=0.7.18';
import { renderCallLogs } from './calllogs.js?v=0.7.18';
import { renderStats } from './stats.js?v=0.7.18';
import { renderDashboard, stopDashboard } from './dashboard.js?v=0.7.18';
import { renderModuleList } from './modules.js?v=0.7.18';
import { renderQueues } from './live.js?v=0.7.18';
import { renderSounds, renderMoh, renderRecordings } from './media.js?v=0.7.18';
import { renderPhonebooks } from './phonebook.js?v=0.7.18';
import { P, ST, PortalError, portalLogin, portalResume, remembered, checkScopes, loadVisualization, loadLocations, openSite, stackLogin, logout, closeSite } from './portal.js?v=0.7.18';

const APP_VERSION = '0.7.18';
const TESTED_STACK = ['26.07', '26.10'];
// Droit Portal sans lequel aucune stack n'est accessible (vérifié : contrôlé
// par le Portal avant d'ouvrir un site).
const CRED_SCOPE = 'deployd.instances.*.credentials.*.read';

// Menu calqué sur celui du Portal : sections et libellés relevés dans son code
// (chunk 302 : parent common.layout.pbxMenu.<section> de chaque page, et
// traductions françaises, 02/11/2026), dans l'ordre des sections du Portal.
// `page` = case « Menu de Stack » (champ visualization). `path` : liste confd
// comptée sur le Dashboard. `render` : écran du module.
// Icônes Material (comme le Portal), en SVG intégré.
const svg = (d) => `<svg class="dk-nicon" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  dashboard: svg('M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z'),
  userManagement: svg('M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z'),
  reporting: svg('M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z'),
  callManagement: svg('M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z'),
  services: svg('M18 17H6v-2h12v2zm2-5H4V7c0-1.1.9-2 2-2h12c1.1 0 2 .9 2 2v5zM2 20h20v-2H2v2z'),
  soundsAndGreetings: svg('M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 5h-3v5.5c0 1.38-1.12 2.5-2.5 2.5S10 13.88 10 12.5s1.12-2.5 2.5-2.5c.57 0 1.08.19 1.5.51V5h4v2zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z'),
  callCenter: svg('M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h4v1h-7v2h6c1.66 0 3-1.34 3-3V10c0-4.97-4.03-9-9-9z'),
};
let NAV_CLOSED = new Set();
try { NAV_CLOSED = new Set(JSON.parse(localStorage.getItem('astrea-desk-nav') || '[]')); } catch { /* stockage indisponible */ }
const SECTIONS = [['userManagement', 'Gestion utilisateurs'], ['reporting', 'Rapports'], ['callManagement', 'Gestion des appels'], ['services', 'Services'], ['soundsAndGreetings', 'Sons & Musiques'], ['callCenter', "Centre d'appel"]];
const list = (id) => (view, site) => renderModuleList(id, view, site);
const MODULES = [
  { id: 'users', section: 'userManagement', label: 'Utilisateurs', page: 'pbx.users', path: '/users', none: 'Aucun utilisateur.', render: list('users') },
  { id: 'groups', section: 'userManagement', label: "Groupes d'appels", page: 'pbx.ring-groups', path: '/groups', none: "Aucun groupe d'appels.", render: list('groups') },
  { id: 'voicemails', section: 'userManagement', label: 'Messageries vocales', page: 'pbx.voicemails', path: '/voicemails', none: 'Aucune messagerie vocale.', render: list('voicemails') },
  { id: 'calllogs', section: 'reporting', label: "Journaux d'appels", page: ['pbx.cdr', 'pbx.cdr-insights'], render: renderCallLogs, sub: 'Filtres, graphiques, exports' },
  { id: 'incalls', section: 'callManagement', label: 'Appels entrants', page: 'pbx.incalls', path: '/incalls', none: 'Aucun appel entrant.', render: list('incalls') },
  { id: 'outcalls', section: 'callManagement', label: 'Appels sortants', page: 'pbx.outcalls', path: '/outcalls', none: 'Aucune règle sortante.', render: list('outcalls') },
  { id: 'schedules', section: 'callManagement', label: 'Plages horaires', page: 'pbx.schedules', path: '/schedules', none: 'Aucune plage horaire.', render: list('schedules') },
  { id: 'ivr', section: 'services', label: 'SVI', page: 'pbx.ivr', path: '/ivr', none: 'Aucun SVI.', render: list('ivr') },
  { id: 'conferences', section: 'services', label: 'Conférences', page: 'pbx.conference', path: '/conferences', none: 'Aucune conférence.', render: list('conferences') },
  { id: 'switchboards', section: 'services', label: 'POPC', page: 'pbx.switchboards', path: '/switchboards', none: 'Aucun POPC.', render: list('switchboards') },
  { id: 'phonebooks', section: 'services', label: 'Annuaire', page: ['pbx.phonebooks', 'pbx.phonebooks-contacts'], render: renderPhonebooks, sub: 'Contacts partagés, import / export CSV' },
  { id: 'sounds', section: 'soundsAndGreetings', label: 'Sons', page: 'pbx.sounds', render: renderSounds, sub: 'Écoute, envoi, remplacement' },
  { id: 'moh', section: 'soundsAndGreetings', label: 'Musiques', page: 'pbx.moh', path: '/moh', none: "Aucune musique d'attente.", render: renderMoh },
  { id: 'recordings', section: 'soundsAndGreetings', label: 'Enregistrements', page: 'pbx.recordings', render: renderRecordings, sub: 'Tons de début et de fin' },
  // Pas de menu Agents (décision de Brice, 02/11/2026) : les agents ne se gèrent
  // pas dans Desk ; on connecte / déconnecte ceux déjà inscrits, depuis les files.
  { id: 'queues', section: 'callCenter', label: "Files d'attente", page: ['pbx.queues', 'pbx.agents'], path: '/queues', none: "Aucune file d'attente.", render: renderQueues },
  { id: 'stats', section: 'callCenter', label: 'Statistiques', page: ['pbx.stats', 'pbx.stats-agents', 'pbx.stats-queues'], render: renderStats, sub: "Files d'attente et agents" },
];

const D = { counts: {}, lists: {}, view: 'home', warns: [] };
let renewTimer = null;

// Visible si la case est cochée dans le Portal. Pas de liste (compte sans
// restriction, supposé) : tout est visible.
const allowed = (m) => !P.visualization || [].concat(m.page).some((p) => P.visualization.includes(p));

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
// Version en ligne plus récente que celle chargée (cache de l'appli et de
// GitHub Pages, max-age 600 ; vécu le 02/11/2026 : 0.6.x affichée alors que la
// 0.7.0 était en ligne et poussée) : rechargement sur la nouvelle version.
// L'URL ?v= est nouvelle, donc lue sans cache, et ses imports aussi. Une seule
// tentative par version (pas de boucle si le CDN sert encore l'ancienne).
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function checkVersion() {
  try {
    const v = (await (await fetch(`./manifest.json?t=${Date.now()}`, { cache: 'no-store' })).json())?.version;
    if (!v || !newer(v, APP_VERSION)) return false;
    const key = `astrea-desk-reload-${v}`;
    if (sessionStorage.getItem(key)) { console.warn('[astrea] version en ligne', v, 'mais', APP_VERSION, 'chargée après rechargement'); return false; }
    sessionStorage.setItem(key, '1');
    console.info('[astrea] nouvelle version', v, 'au lieu de', APP_VERSION, ': rechargement');
    $('conn').textContent = `Mise à jour vers la version ${v}…`;
    location.replace(`./index.html?v=${v}&t=${Date.now()}`);
    return true;
  } catch (e) { console.warn('[astrea] contrôle de version', e.message); return false; }
}

// Liens externes (Portal, g711.org) : lien classique target=_blank. Constaté en
// réel (Brice, 02/11/2026) : sdk.openLink ouvre la page DANS l'appli Wazo, où
// elle fonctionne mal ; il n'est donc pas utilisé. Un bouton « Copier
// l'adresse » est proposé à côté des liens importants, en secours.

async function init() {
  if (await checkVersion()) return;
  if (window.parent !== window) {
    try {
      await Promise.race([sdk.initialize(), new Promise((_, ko) => setTimeout(() => ko(new Error('pas de réponse de l\'appli')), 15000))]);
      document.body.classList.add('in-app');
      try { applyTheme(sdk.getContext()?.app?.theme); } catch (e) { console.warn('[astrea] thème', e); }
      sdk.onLogout = () => { doLogout(); };
    } catch (e) { console.warn('[astrea] SDK', e); }
  }
  $('conn').textContent = '';
  try { $('lg-email').value = localStorage.getItem('astrea-desk-email') || ''; } catch { /* stockage indisponible */ }
  // « Rester connecté » : reprise sans mot de passe.
  if (remembered()) {
    $('conn').textContent = 'Reconnexion au Portal…';
    try { await portalResume(); await afterLogin(); return; }
    catch (err) { console.warn('[astrea] reconnexion', err.step, err.status); $('conn').textContent = ''; return showLogin(err.message); }
  }
  showLogin();
}

function showOnly(id) {
  for (const s of ['login', 'sites', 'main']) $(s).hidden = s !== id;
  document.body.classList.toggle('ready', id === 'main');
  document.documentElement.classList.remove('framed');
}
function showLogin(msg = '') {
  showOnly('login');
  $('lg-err').textContent = msg;
  $('lg-pass').value = '';
  ($('lg-email').value ? $('lg-pass') : $('lg-email')).focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('lg-email').value.trim();
  const pass = $('lg-pass').value;
  $('lg-err').textContent = '';
  $('lg-go').disabled = true;
  $('lg-go').textContent = 'Connexion…';
  try {
    const keep = $('lg-keep').checked;
    const { kept } = await portalLogin(email, pass, { keep });
    $('lg-pass').value = '';
    try { localStorage.setItem('astrea-desk-email', email); } catch { /* */ }
    if (keep && !kept) toast("Le Portal n'a pas fourni de jeton de reconnexion : le mot de passe sera redemandé au prochain démarrage.", 8000);
    await afterLogin();
  } catch (err) {
    console.warn('[astrea] connexion', err.step, err.status);
    $('lg-err').textContent = err.message;
  } finally {
    $('lg-go').disabled = false;
    $('lg-go').textContent = 'Se connecter';
  }
});

async function afterLogin() {
  D.warns = [];
  // Droits, menus et sites lus en même temps (reconnexion plus rapide).
  const [sc, , locs] = await Promise.all([checkScopes([CRED_SCOPE]).catch((err) => err), loadVisualization(), loadLocations()]);
  if (sc instanceof Error) {
    // Contrôle indisponible : on continue, l'accès au site dira le reste.
    D.warns.push('Contrôle des droits du Portal indisponible (' + sc.message + ').');
  } else if (!sc[CRED_SCOPE]) throw new PortalError('scopes', 403, "Votre compte Portal n'a pas accès aux stacks des sites. Demandez à votre revendeur de vous donner l'accès au site.");
  if (!P.visualization) D.warns.push('Aucune liste de menus dans le Portal pour ce compte : tous les modules sont affichés (compte sans restriction, supposé).');
  if (!locs.length) throw new PortalError('locations', 0, 'Aucun site accessible avec ce compte Portal.');
  if (locs.length === 1) return enterSite(locs[0]);
  let last = null;
  try { last = localStorage.getItem('astrea-desk-site'); } catch { /* */ }
  const prev = locs.find((l) => l.uuid === last);
  if (prev) return enterSite(prev);
  showSites();
}

// ---------------------------------------------------------------------------
// Choix du site
// ---------------------------------------------------------------------------
function showSites() {
  showOnly('sites');
  $('sites-sub').textContent = `${P.locations.length} sites accessibles avec ${P.email}.`;
  $('sites-q').value = '';
  renderSites();
  $('sites-q').focus();
}
function renderSites() {
  const q = $('sites-q').value.trim().toLowerCase();
  const list = P.locations.filter((l) => !q || `${l.name} ${l.customer}`.toLowerCase().includes(q));
  $('sites-list').innerHTML = list.map((l) => `<li data-loc="${esc(l.uuid)}"><span>${esc(l.name)}</span><span class="sub">${esc(l.customer)}</span></li>`).join('')
    || '<li class="muted">Aucun site ne correspond.</li>';
}
$('sites-q').addEventListener('input', renderSites);
$('sites-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-loc]');
  const loc = li && P.locations.find((l) => l.uuid === li.dataset.loc);
  if (loc) enterSite(loc).catch((err) => { toast(err.message, 8000); console.warn('[astrea] site', err.step, err.status); });
});
$('sites-logout').onclick = () => doLogout();

async function enterSite(loc) {
  $('conn').textContent = `Ouverture de ${loc.name}…`;
  await openSite(loc);
  try { localStorage.setItem('astrea-desk-site', loc.uuid); } catch { /* */ }
  S.base = ST.base; S.token = ST.token; S.tenant = ST.tenant; S.readonly = null;
  scheduleRenew();
  selfCheck();
  D.counts = {}; D.lists = {};
  $('ft-site').textContent = loc.name;
  $('ft-stack').textContent = `${ST.host}${ST.version ? ' · ' + ST.version : ''}`;
  $('ft-change').hidden = P.locations.length < 2;
  showOnly('main');
  go('home');
}

// Le token de stack dure 1 h : renouvelé 5 min avant, avec les identifiants
// du site gardés en mémoire (comme le Portal).
function scheduleRenew() {
  clearTimeout(renewTimer);
  const exp = Date.parse(ST.expiresAt ? (ST.expiresAt.endsWith('Z') ? ST.expiresAt : ST.expiresAt + 'Z') : '');
  const wait = Number.isFinite(exp) ? Math.max(60e3, exp - Date.now() - 5 * 60e3) : 50 * 60e3;
  renewTimer = setTimeout(async () => {
    try { await stackLogin(); S.token = ST.token; scheduleRenew(); }
    catch (err) { console.warn('[astrea] renouvellement', err.status); toast('Session du site expirée : reconnectez-vous.', 8000); doLogout(); }
  }, wait);
}

// Auto-contrôle (convention Astrea) : en cas d'écart, lecture seule. Le lot 1
// n'écrit rien, mais les modules suivants s'appuient sur S.readonly.
function selfCheck() {
  const res = { stack: ST.version, tenant: !!ST.tenant, visualization: P.visualization ? P.visualization.length : null };
  S.compatWarns = [...D.warns];
  if (!ST.tenant) S.readonly = "le Portal n'a pas donné le tenant du site";
  if (ST.version && !TESTED_STACK.some((v) => ST.version.startsWith(v))) S.compatWarns.push(`Version de stack ${ST.version} non testée avec Astrea Desk (testées : ${TESTED_STACK.join(', ')}).`);
  console.info('[astrea] auto-contrôle', res, S.readonly || 'ok');
  showCompat();
}

// ---------------------------------------------------------------------------
// Menu et vues
// ---------------------------------------------------------------------------
function renderNav() {
  // Présentation du Portal (retour de Brice, 02/11/2026) : colonne bleue,
  // une icône par section, sections repliables, sous-menus en retrait.
  const btn = (m) => `<button data-view="${m.id}" class="dk-ni${D.view === m.id ? ' active' : ''}">${esc(m.label)}</button>`;
  const mods = MODULES.filter(allowed);
  $('nav').innerHTML = `<button data-view="home" class="dk-ntop${D.view === 'home' ? ' active' : ''}">${ICON.dashboard}<span>Dashboard</span></button>` + SECTIONS.map(([k, l]) => {
    const ms = mods.filter((m) => m.section === k);
    if (!ms.length) return '';
    const open = !NAV_CLOSED.has(k) || ms.some((m) => m.id === D.view);
    return `<div class="dk-nsec${open ? ' open' : ''}"><button class="dk-nsec-h" data-sec="${k}" aria-expanded="${open}">${ICON[k]}<span>${esc(l)}</span><svg class="dk-chev" viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></button><div class="dk-nsec-items">${ms.map(btn).join('')}</div></div>`;
  }).join('');
}
$('nav').addEventListener('click', (e) => {
  const h = e.target.closest('[data-sec]');
  if (h) { // section repliée / dépliée, mémorisée sur le poste
    const k = h.dataset.sec;
    if (NAV_CLOSED.has(k)) NAV_CLOSED.delete(k); else NAV_CLOSED.add(k);
    try { localStorage.setItem('astrea-desk-nav', JSON.stringify([...NAV_CLOSED])); } catch { /* */ }
    renderNav(); return;
  }
  const b = e.target.closest('[data-view]'); if (b) go(b.dataset.view);
});
$('view').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });

function go(view) {
  D.view = view;
  if (view !== 'home') stopDashboard();
  renderNav();
  if (view === 'home') return renderHome();
  if (view === 'diag') return renderDiag();
  const m = MODULES.find((x) => x.id === view);
  if (m && allowed(m)) renderModule(m);
}

async function loadList(m) {
  if (!m.path) return null;
  // Sans tenant, listAll ne filtrerait rien : jamais d'objets d'autres clients.
  if (!S.tenant) throw new Error("Tenant du site inconnu : lecture refusée.");
  // Une seule lecture par module, même si l'accueil et la vue la demandent ensemble.
  D.lists[m.id] ||= listAll(m.path).catch((err) => { delete D.lists[m.id]; throw err; });
  const items = await D.lists[m.id];
  D.counts[m.id] = items.length;
  return items;
}

function renderHome() {
  const mods = MODULES.filter(allowed);
  const tile = (m) => {
    const n = D.counts[m.id];
    const sub = m.lot ? `<span class="dk-badge">Bientôt</span>` : m.sub ? `<span class="dk-s">${esc(m.sub)}</span>` : n === undefined ? '<span class="dk-s">Lecture…</span>' : n === 0 ? `<span class="dk-s">${esc(m.none)}</span>` : '';
    return `<button class="dk-tile" data-go="${m.id}">${!m.lot && n ? `<span class="dk-n">${n}</span>` : ''}<span class="dk-t">${esc(m.label)}</span>${sub}</button>`;
  };
  // Blocs du tableau de bord : seulement ce que les cases du Portal autorisent.
  const can = (page) => !P.visualization || P.visualization.includes(page);
  const show = { calls: can('pbx.cdr'), cdr: can('pbx.cdr'), agents: can('pbx.agents') || can('pbx.queues'), switchboards: can('pbx.switchboards'), queues: can('pbx.stats') || can('pbx.queues') };
  const live = Object.values(show).some(Boolean);
  $('view').innerHTML = `<div class="phonehead"><div><h2>${esc(ST.site.name)}</h2><div class="muted small">${esc(ST.site.customer || '')}</div></div>`
    + (live ? `<div class="btnrow"><span id="db-at" class="muted small"></span><button id="db-refresh">Actualiser</button></div>` : '') + '</div>'
    + (live ? '<div id="db-live"></div>' : '')
    + (mods.length ? `<h2 class="dk-h">Modules</h2><div class="dk-tiles" id="db-tiles">${mods.map(tile).join('')}</div>` : '<p class="dk-empty">Aucun module autorisé pour votre compte dans le Portal (cases « Menu de Stack »).</p>')
    + '<div id="dk-tip" class="dk-tip" hidden></div>';
  if (live) renderDashboard($('view'), ST.site, show);
  for (const m of mods.filter((x) => x.path && D.counts[x.id] === undefined && !D.lists[x.id])) {
    loadList(m).then(() => { if (D.view === 'home') renderTiles(); }).catch((err) => console.warn('[astrea] lecture', m.path, err.status));
  }
  function renderTiles() { const t = $('db-tiles'); if (t) t.innerHTML = mods.map(tile).join(''); }
}

async function renderModule(m) {
  const head = `<div class="phonehead"><div><h2>${esc(m.label)}</h2><div class="muted small">${esc(ST.site.name)} · lecture seule</div></div></div>`;
  if (m.lot) { $('view').innerHTML = head + `<p class="dk-empty">Ce module arrive avec le lot ${m.lot}.</p>`; return; }
  if (m.render) {
    $('view').onclick = null; // gestionnaire posé par l'écran précédent (files, agents)
    try { await m.render($('view'), ST.site); } catch (err) { $('view').innerHTML = head + `<p class="error">${esc(err.message)}</p>`; }
    return;
  }
  $('view').innerHTML = head + '<p class="dk-empty">Lecture…</p>';
  try {
    const items = await loadList(m);
    if (D.view !== m.id) return;
    $('view').innerHTML = head + (items.length
      ? `<table class="dk-table"><thead><tr>${m.cols.map(([h]) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${items.map((o) => `<tr>${m.cols.map(([, f]) => `<td>${esc(f(o))}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : `<p class="dk-empty">${esc(m.none)}</p>`);
  } catch (err) {
    $('view').innerHTML = head + `<p class="error">${esc(err.message)}</p>`;
  }
}

// Diagnostic sans secret : à copier pour le support.
function diagnostic() {
  return {
    plugin: `Astrea Desk ${APP_VERSION}`,
    contexte: (() => { try { const c = sdk.getContext(); return { host: c?.app?.host || null, locale: c?.app?.locale || null }; } catch { return null; } })(),
    portal: { compte: P.email, tenant: P.tenant, expire: P.expiresAt, droits: P.scopes, sites: P.locations.length, resterConnecte: !!remembered() },
    menus: P.visualization,
    modules: MODULES.map((m) => `${m.id}: ${allowed(m) ? 'affiché' : 'masqué'}`),
    site: ST.site ? { nom: ST.site.name, uuid: ST.site.uuid } : null,
    stack: { hote: ST.host, port: ST.port, version: ST.version, tenant: ST.tenant, expire: ST.expiresAt, acl: ST.acl },
    controle: { lectureSeule: S.readonly, avertissements: S.compatWarns },
  };
}
function renderDiag() {
  const txt = JSON.stringify(diagnostic(), null, 2);
  $('view').innerHTML = `<div class="phonehead"><div><h2>Diagnostic</h2><div class="muted small">Aucun mot de passe ni token. À copier pour le support Astrea.</div></div><div class="btnrow"><button id="dg-copy">Copier</button></div></div><pre class="dk-diag">${esc(txt)}</pre>`;
  $('dg-copy').onclick = async () => { try { await navigator.clipboard.writeText(txt); toast('Diagnostic copié'); } catch { toast('Copie impossible : sélectionnez le texte.'); } };
}

$('ft-diag').onclick = () => { D.view = 'diag'; renderNav(); renderDiag(); };
$('ft-change').onclick = () => { leaveSite(); showSites(); };
$('ft-logout').onclick = () => doLogout();

function leaveSite() {
  clearTimeout(renewTimer);
  stopDashboard();
  const t = ST.token, base = ST.base;
  if (t) fetch(`${base}/api/auth/0.1/token/${t}`, { method: 'DELETE', headers: { 'X-Auth-Token': t } }).catch(() => {});
  closeSite();
  S.base = S.token = S.tenant = null;
  try { localStorage.removeItem('astrea-desk-site'); } catch { /* */ }
}

async function doLogout() {
  clearTimeout(renewTimer);
  stopDashboard();
  await logout();
  S.base = S.token = S.tenant = null;
  D.counts = {}; D.lists = {};
  showLogin();
}

init();
