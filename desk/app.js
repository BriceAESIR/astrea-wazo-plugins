// Astrea Desk — socle (lot 1) : connexion avec le compte Portal, droits lus
// dans le Portal (visualization), choix du site, connexion à la stack, menu
// et accueil. Les appels confd passent par common/core.js (api, listAll,
// filtre tenant), avec le token de la stack du site.
import { sdk, S, $, esc, toast, applyTheme, listAll, showCompat } from '../admin-tools/common/core.js?v=0.1.0';
import { P, ST, PortalError, portalLogin, checkScopes, loadVisualization, loadLocations, openSite, stackLogin, logout, closeSite } from './portal.js?v=0.1.0';

const APP_VERSION = '0.1.0';
const TESTED_STACK = ['26.07', '26.10'];
// Droit Portal sans lequel aucune stack n'est accessible (vérifié : contrôlé
// par le Portal avant d'ouvrir un site).
const CRED_SCOPE = 'deployd.instances.*.credentials.*.read';

// Modules : `page` = identifiant de la case « Menu de Stack » du Portal
// (vérifié le 29/10/2026). `path` : liste confd lue pour l'accueil et la vue.
const MODULES = [
  { id: 'groups', label: "Groupes d'appels", page: 'pbx.ring-groups', path: '/groups', none: "Aucun groupe d'appels sur ce site.",
    cols: [['Nom', (o) => o.label || o.name], ['Numéro', (o) => exts(o)], ['Membres', (o) => (o.members?.users?.length ?? '') ]] },
  { id: 'queues', label: "Files d'attente", page: 'pbx.queues', path: '/queues', none: "Aucune file d'attente sur ce site.",
    cols: [['Nom', (o) => o.label || o.name], ['Numéro', (o) => exts(o)], ['Agents', (o) => (o.members?.agents?.length ?? '')]] },
  { id: 'switchboards', label: 'POPC', page: 'pbx.switchboards', path: '/switchboards', none: 'Aucun POPC sur ce site.',
    cols: [['Nom', (o) => o.name], ['Opérateurs', (o) => (o.members?.users?.length ?? '')]] },
  { id: 'agents', label: 'Agents', page: 'pbx.agents', path: '/agents', none: 'Aucun agent sur ce site.',
    cols: [['Numéro', (o) => o.number], ['Nom', (o) => [o.firstname, o.lastname].filter(Boolean).join(' ')], ['Files', (o) => (o.queues?.length ?? '')]] },
  { id: 'calllogs', label: "Journal d'appels", page: 'pbx.cdr', lot: 2 },
  { id: 'stats', label: 'Statistiques', page: 'pbx.stats', lot: 3 },
];
const exts = (o) => (o.extensions || []).map((e) => e.exten).filter(Boolean).join(', ');

const D = { counts: {}, lists: {}, view: 'home', warns: [] };
let renewTimer = null;

// Visible si la case est cochée dans le Portal. Pas de liste (compte sans
// restriction, supposé) : tout est visible.
const allowed = (m) => !P.visualization || P.visualization.includes(m.page);

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function init() {
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
    await portalLogin(email, pass);
    $('lg-pass').value = '';
    try { localStorage.setItem('astrea-desk-email', email); } catch { /* */ }
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
  try {
    const sc = await checkScopes([CRED_SCOPE]);
    if (!sc[CRED_SCOPE]) throw new PortalError('scopes', 403, "Votre compte Portal n'a pas accès aux stacks des sites. Demandez à votre revendeur de vous donner l'accès au site.");
  } catch (err) {
    if (err.step === 'scopes' && err.status === 403) throw err;
    // Contrôle indisponible : on continue, l'accès au site dira le reste.
    D.warns.push('Contrôle des droits du Portal indisponible (' + err.message + ').');
  }
  await loadVisualization();
  if (!P.visualization) D.warns.push('Aucune liste de menus dans le Portal pour ce compte : tous les modules sont affichés (compte sans restriction, supposé).');
  const locs = await loadLocations();
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
  const items = [{ id: 'home', label: 'Accueil' }, ...MODULES.filter(allowed)];
  $('nav').innerHTML = items.map((m) => `<button data-view="${m.id}" class="${D.view === m.id ? 'active' : ''}">${esc(m.label)}</button>`).join('');
}
$('nav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) go(b.dataset.view); });
$('view').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });

function go(view) {
  D.view = view;
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
    const sub = m.lot ? `<span class="dk-badge">Bientôt</span>` : n === undefined ? '<span class="dk-s">Lecture…</span>' : n === 0 ? `<span class="dk-s">${esc(m.none)}</span>` : '';
    return `<button class="dk-tile" data-go="${m.id}">${!m.lot && n ? `<span class="dk-n">${n}</span>` : ''}<span class="dk-t">${esc(m.label)}</span>${sub}</button>`;
  };
  $('view').innerHTML = `<div class="phonehead"><div><h2>${esc(ST.site.name)}</h2><div class="muted small">${esc(ST.site.customer || '')}</div></div></div>`
    + (mods.length ? `<div class="dk-tiles">${mods.map(tile).join('')}</div>` : '<p class="dk-empty">Aucun module autorisé pour votre compte dans le Portal (cases « Menu de Stack »).</p>');
  for (const m of mods.filter((x) => x.path && D.counts[x.id] === undefined && !D.lists[x.id])) {
    loadList(m).then(() => { if (D.view === 'home') renderHome(); }).catch((err) => console.warn('[astrea] lecture', m.path, err.status));
  }
}

async function renderModule(m) {
  const head = `<div class="phonehead"><div><h2>${esc(m.label)}</h2><div class="muted small">${esc(ST.site.name)} · lecture seule</div></div></div>`;
  if (m.lot) { $('view').innerHTML = head + `<p class="dk-empty">Ce module arrive avec le lot ${m.lot}.</p>`; return; }
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
    portal: { compte: P.email, tenant: P.tenant, expire: P.expiresAt, droits: P.scopes, sites: P.locations.length },
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
  const t = ST.token, base = ST.base;
  if (t) fetch(`${base}/api/auth/0.1/token/${t}`, { method: 'DELETE', headers: { 'X-Auth-Token': t } }).catch(() => {});
  closeSite();
  S.base = S.token = S.tenant = null;
  try { localStorage.removeItem('astrea-desk-site'); } catch { /* */ }
}

async function doLogout() {
  clearTimeout(renewTimer);
  await logout();
  S.base = S.token = S.tenant = null;
  D.counts = {}; D.lists = {};
  showLogin();
}

init();
