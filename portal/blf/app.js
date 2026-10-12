// Touches des postes — plugin Portal Wazo (Astrea)
// Lit et écrit les touches de fonction des utilisateurs via wazo-confd, avec
// le token fourni par le portail. Les touches « ligne » supplémentaires sont
// stockées dans le champ `userfield` (jeton blf-linekeys=N) et appliquées
// côté serveur par le stack plugin astrea/blf-sync.
import { App } from './vendor/euc-plugins-sdk/app.js';

// ---------------------------------------------------------------------------
// Profils constructeur
// ---------------------------------------------------------------------------
// Seul Yealink est vérifié : numérotation recopiée du plugin wazo-yealink
// v86/v87, touches ligne multiples appliquées par astrea/blf-sync. Les autres
// marques passent en profil générique : capacité non vérifiée, pas de module,
// une seule touche ligne. Pour en ajouter une : lire son plugin provd
// (wazo-provd-plugins) et compléter VENDORS.
const YEALINK_LINEKEYS = {
  T27G: 21, T31: 2, T31G: 2, T31P: 2, T31W: 2, T33G: 12, T33P: 12, T34W: 12,
  T41S: 15, T41U: 15, T42S: 15, T42U: 15, T43U: 15, T44W: 24, T44U: 24,
  T46S: 27, T46U: 27, T48S: 29, T48U: 29, T53: 21, T53W: 21, T54S: 27, T54W: 27,
  T57W: 29, T58: 27, T58W: 27, T73U: 48, T73W: 48, T74U: 60, T74W: 60,
  T77U: 95, T85W: 72, T87W: 95, T88W: 95, T88V: 95,
};
const EXP = { EXP40: [40, 6], EXP43: [60, 3], EXP50: [60, 3], EXP55: [78, 3] };
function yealinkExp(model) {
  if (!model) return null;
  if (['T27G', 'T46S', 'T48S'].includes(model)) return 'EXP40';
  if (['T43U', 'T46U', 'T48U'].includes(model)) return 'EXP43';
  if (model.startsWith('T5')) return 'EXP50';
  if (model.startsWith('T7') || model.startsWith('T8')) return 'EXP55';
  return null;
}
// Face avant des modèles à pages : [touches à gauche, touches à droite, pages].
// Source : doc Yealink « DSS Keys » (liste des modèles à pages, 3 pages, 4
// pour les T3x, et total de touches) ; touches physiques = total / pages + 1
// (la touche du bas à droite devient touche de page). T33 : une seule colonne,
// disposition supposée. Modèles tactiles (T48, T57W, T58, T7x, T8x) : pas de
// pages, vue étendue → grille simple.
const YEALINK_FACE = {
  T54W: [5, 5, 3], T46S: [5, 5, 3], T46U: [5, 5, 3],
  T53: [4, 4, 3], T53W: [4, 4, 3], T53C: [4, 4, 3], T43U: [4, 4, 3],
  T42S: [3, 3, 3], T42U: [3, 3, 3], T41S: [3, 3, 3],
  T33G: [4, 0, 4], T33P: [4, 0, 4],
};
// Modules : touches par page [gauche, droite], déduites des totaux Wazo
// (EXP40 40 = 2 × 20, EXP43/EXP50 60 = 3 × 20, EXP55 78 = 3 × 26). À vérifier.
const YEALINK_EXP_FACE = { EXP40: [10, 10], EXP43: [10, 10], EXP50: [10, 10], EXP55: [13, 13] };
const VENDORS = {
  yealink: { name: 'Yealink', linekeys: YEALINK_LINEKEYS, exp: yealinkExp, face: YEALINK_FACE, expFace: YEALINK_EXP_FACE, multiLine: true },
};
// Appareils sans touches de fonction : DECT (bases et combinés), passerelles
// analogiques / ATA (lignes RTC), téléphones de conférence. Heuristique sur le
// modèle et la marque, à compléter au fil des parcs clients.
const NO_KEYS = /dect|\bata\b|^w\d|^cp\d|^m\d{2,3}\b|^n\d{3}|^ht\d|^dp\d|^spa\d|^gxw|^ta\d|^dag|^mp\d|^sn4/i;
function hasKeys(dev) {
  if (!dev) return false;
  const prof = vendorOf(dev);
  // Marque vérifiée : seulement les modèles de sa table de touches.
  if (prof) return dev.model in prof.linekeys;
  return !NO_KEYS.test(dev.model || '') && !/gigaset/i.test(dev.vendor || '');
}
// Le device confd porte `vendor` (ex. « Yealink ») et `plugin` (ex. « wazo-yealink-v87 »).
function vendorOf(dev) {
  if (!dev) return null;
  const s = `${dev.vendor || ''} ${dev.plugin || ''}`.toLowerCase();
  return VENDORS[Object.keys(VENDORS).find((k) => s.includes(k))] || null;
}
const DEST_PARAMS = {
  user: ['user_id'], group: ['group_id'], groupmember: ['group_id', 'action'],
  queue: ['queue_id'], conference: ['conference_id'], paging: ['paging_id'],
  service: ['service'], custom: ['exten'], forward: ['forward', 'exten'],
  transfer: ['transfer'], park_position: ['parking_lot_id', 'position'],
  parking: ['parking_lot_id'], bsfilter: ['filter_member_id'],
  agent: ['agent_id', 'action'], onlinerec: [],
};
const NAMED = { group: ['/groups', 'group_id'], queue: ['/queues', 'queue_id'], conference: ['/conferences', 'conference_id'] };
const TYPE_LABEL = { user: 'Collègue', custom: 'Numéro', group: 'Groupe', queue: 'File', conference: 'Conférence' };
const LK_TOKEN = /\s*\bblf-linekeys=(\d+)\b/;

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
const S = {
  base: null, token: null, tenant: null,
  users: [], byId: new Map(), byUuid: new Map(), devices: new Map(), named: {},
  cur: null, sel: null, view: new URLSearchParams(location.search).get('view') || 'overview',
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fullName = (u) => [u?.firstname, u?.lastname].map((x) => (x || '').trim()).filter(Boolean).join(' ') || u?.username || '';
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(method, path, body) {
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${S.base}/api/confd/1.1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) { refreshFromPortal(); throw new ApiError(401, 'Session expirée : rechargez la page du portail.'); }
  if (!r.ok) {
    let msg = `${method} ${path} → ${r.status}`;
    try { const j = await r.json(); msg += ' ' + JSON.stringify(j).slice(0, 300); } catch { /* */ }
    throw new ApiError(r.status, msg);
  }
  if (r.status === 204) return null;
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}
const listAll = async (path) => (await api('GET', `${path}?recurse=true&limit=10000`))?.items || [];

// ---------------------------------------------------------------------------
// Connexion : portail ou autonome
// ---------------------------------------------------------------------------
const sdk = new App();
window.__blfSdk = sdk; // diagnostic : __blfSdk.getContext() dans la console
function stackFromContext() {
  const extra = sdk.getContext()?.app?.extra || {};
  const st = extra.stack || {};
  return { host: st.host, port: st.port, token: st.session?.token, tenant: st.currentTenant || null };
}
function applyStack(st) {
  if (!st.host || !st.token) return false;
  const port = st.port && Number(st.port) !== 443 ? `:${st.port}` : '';
  S.base = `https://${st.host}${port}`;
  S.token = st.token;
  S.tenant = st.tenant;
  return true;
}
function refreshFromPortal() { try { applyStack(stackFromContext()); } catch { /* hors portail */ } }

// Thème du portail : ctx.app.theme est documenté comme « palette Material UI »
// sans plus de détail ; on accepte un thème complet ({palette, typography,
// shape}) ou la palette seule. Diagnostic : __blfSdk.getContext().app.theme
// Dans le portail, on ne suit pas le mode sombre du système : le portail a son
// propre mode (clair par défaut), donc clair sauf si le thème dit « dark ».
function applyTheme(theme) {
  const root = document.documentElement;
  console.info('[astrea] thème du portail', theme);
  const pal = (theme && typeof theme === 'object' && (theme.palette || theme)) || {};
  root.dataset.theme = (pal.mode || pal.type) === 'dark' ? 'dark' : 'light';
  if (!theme || typeof theme !== 'object') return;
  const set = (v, x) => { if (typeof x === 'string' && x) root.style.setProperty(v, x); };
  set('--accent', pal.primary?.main);
  set('--accent-ink', pal.primary?.contrastText);
  set('--bg', pal.background?.default);
  set('--panel', pal.background?.paper);
  set('--ink', pal.text?.primary);
  set('--muted', pal.text?.secondary);
  set('--line', pal.divider);
  set('--danger', pal.error?.main);
  set('--warn', pal.warning?.main);
  set('--ok', pal.success?.main);
  set('--font', theme.typography?.fontFamily);
  const r = theme.shape?.borderRadius;
  if (typeof r === 'number') root.style.setProperty('--radius', `${r}px`);
  else set('--radius', r);
}

async function connect() {
  const inIframe = window.parent !== window;
  if (inIframe) {
    try {
      await sdk.initialize();
      document.body.classList.add('in-portal');
      try { applyTheme(sdk.getContext()?.app?.theme); } catch (e) { console.warn('thème', e); }
      sdk.onSwitchTenant = (uuid) => { S.tenant = uuid; boot(); };
      // La doc ne détaille pas stackSession : on prend ce qu'il contient
      // (host/port/token), sinon on relit le contexte initial.
      sdk.onConnectedToStack = (ss) => {
        const st = { ...stackFromContext() };
        if (ss && typeof ss === 'object') {
          st.host = ss.host || ss.stack?.host || st.host;
          st.port = ss.port || ss.stack?.port || st.port;
          st.token = ss.token || ss.session?.token || ss.stack?.session?.token || st.token;
          st.tenant = ss.currentTenant || ss.tenantUuid || st.tenant;
        }
        if (applyStack(st)) boot();
      };
      sdk.onPluginUnLoaded = () => { S.cur = null; };
      sdk.onRouteChanged = (loc) => { const ref = userRefFrom(loc); if (ref && S.users.length) openUserByRef(ref); };
      if (applyStack(stackFromContext())) return boot();
      $('conn').textContent = 'Aucun serveur sélectionné dans le portail.';
      return;
    } catch (e) { console.warn('SDK', e); }
  }
  showStandalone();
}

function showStandalone() {
  $('conn').textContent = 'Hors portail';
  $('standalone').hidden = false;
  $('sa-go').onclick = async () => {
    $('sa-err').textContent = '';
    let host = $('sa-host').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(host)) host = `https://${host}`;
    S.base = host;
    try {
      if ($('sa-token').value.trim()) {
        S.token = $('sa-token').value.trim();
      } else {
        const r = await fetch(`${host}/api/auth/0.1/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${$('sa-user').value}:${$('sa-pass').value}`) },
          body: JSON.stringify({ expiration: 3600 }),
        });
        if (!r.ok) throw new Error(`authentification refusée (${r.status})`);
        S.token = (await r.json()).data.token;
      }
      $('standalone').hidden = true;
      boot();
    } catch (e) { $('sa-err').textContent = e.message; }
  };
}

async function boot() {
  $('conn').textContent = 'Chargement…';
  try {
    const [users, devices] = await Promise.all([listAll('/users'), listAll('/devices').catch(() => [])]);
    S.users = users.sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
    S.byId = new Map(users.map((u) => [u.id, u]));
    S.byUuid = new Map(users.map((u) => [u.uuid, u]));
    S.devices = new Map(devices.map((d) => [d.id, d]));
    S.named = {};
    $('conn').textContent = `${new URL(S.base).host} · ${users.length} utilisateurs`;
    const n = users.filter(listed).length;
    $('count').textContent = `${n} utilisateur${n > 1 ? 's' : ''} avec un poste à touches${users.length > n ? ` (${users.length - n} masqué${users.length - n > 1 ? 's' : ''} : sans ligne, DECT ou analogique)` : ''}`;
    $('main').hidden = false;
    document.body.classList.add('ready');
    renderUserList();
    // Comme contactTab reçoit `contact` dans extra, l'onglet pbx.users reçoit
    // peut-être l'utilisateur affiché : on cherche un uuid connu dans extra.
    const ref = userRefFromExtra() || userRefFrom(location) || userRefFrom({ pathname: document.referrer });
    if (S.view === 'user' && ref && openUserByRef(ref)) {
      $('main').classList.add('user-mode');
    }
    layout();
  } catch (e) {
    $('conn').textContent = 'Erreur';
    toast(e.message, 8000);
    console.error(e);
  }
}

// Onglet de fiche utilisateur : retrouver l'utilisateur affiché par le portail.
// Le mécanisme n'est pas documenté : on cherche un uuid ou /users/<id> dans
// l'URL (query, chemin, ancre). À défaut, la liste reste affichée.
function userRefFrom(loc) {
  const s = [loc?.search, loc?.pathname, loc?.hash].filter(Boolean).join(' ');
  const q = new URLSearchParams(loc?.search || '');
  for (const k of ['uuid', 'user_uuid', 'userUuid', 'id', 'user_id', 'userId', 'entityId']) if (q.get(k)) return q.get(k);
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0];
  const n = s.match(/users\/(\d+)/);
  return n ? n[1] : null;
}
function userRefFromExtra() {
  let extra;
  try { extra = sdk.getContext()?.app?.extra; } catch { return null; }
  if (!extra) return null;
  const skip = new Set(['stack', 'portal', 'administrator']);
  const seen = new Set();
  const walk = (v, depth) => {
    if (v == null || depth > 5 || seen.has(v)) return null;
    if (typeof v === 'string') return S.byUuid.has(v) ? v : null;
    if (typeof v === 'number') return null;
    if (typeof v !== 'object') return null;
    seen.add(v);
    for (const [k, x] of Object.entries(v)) {
      if (depth === 0 && skip.has(k)) continue;
      const r = walk(x, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(extra, 0);
}
function openUserByRef(ref) {
  const u = S.byUuid.get(ref) || S.byId.get(Number(ref));
  if (!u) return false;
  selectUser(u);
  return true;
}

// ---------------------------------------------------------------------------
// Liste des utilisateurs
// ---------------------------------------------------------------------------
// Poste de l'utilisateur : le premier poste à touches parmi ses lignes (un
// utilisateur peut avoir un DECT et un poste de bureau), sinon le premier poste.
function userDevice(u) {
  const devs = (u.lines || []).map((l) => l.device_id && S.devices.get(l.device_id)).filter(Boolean);
  return devs.find(hasKeys) || devs[0] || null;
}
// Liste : seulement les utilisateurs qui ont un poste à touches (pas les
// utilisateurs sans ligne, ni ceux qui n'ont qu'un DECT ou une ligne analogique).
const listed = (u) => hasKeys(userDevice(u));
function userExten(u) {
  for (const l of u.lines || []) for (const e of l.extensions || []) if (e.exten) return e.exten;
  return '';
}
function renderUserList() {
  const q = $('search').value.trim().toLowerCase();
  const ul = $('userlist');
  ul.innerHTML = '';
  for (const u of S.users) {
    if (!listed(u)) continue;
    const hay = `${fullName(u)} ${u.username || ''} ${userExten(u)}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const d = userDevice(u);
    const li = document.createElement('li');
    li.className = S.cur?.user.uuid === u.uuid ? 'sel' : '';
    li.innerHTML = `<span>${esc(fullName(u))}</span><span class="sub">${esc(userExten(u))}${d ? ' · ' + esc(d.model || '?') : ''}</span>`;
    li.onclick = () => guardUnsaved(() => selectUser(u));
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Modèle d'un poste en cours d'édition
// ---------------------------------------------------------------------------
function cleanDest(d) {
  const out = { type: d.type };
  for (const p of DEST_PARAMS[d.type] || []) if (d[p] !== undefined && d[p] !== null) out[p] = d[p];
  return out;
}
function cleanKey(k) { return { blf: !!k.blf, label: k.label || null, destination: cleanDest(k.destination || {}) }; }
const keySig = (k) => (k ? JSON.stringify(cleanKey(k)) : 'null');

async function selectUser(u) {
  S.sel = null;
  const dev = userDevice(u);
  const model = dev?.model || null;
  const prof = vendorOf(dev);
  const lk = prof?.linekeys[model] ?? null;
  const exp = prof?.exp(model) ?? null;
  const data = await api('GET', `/users/${u.uuid}/funckeys`);
  const orig = {}, inherited = {};
  for (const [p, k] of Object.entries(data?.keys || {})) (k.inherited ? inherited : orig)[Number(p)] = cleanKey(k);
  const m = (u.userfield || '').match(LK_TOKEN);
  const lineKeys = m ? Number(m[1]) : 1;
  const maxPos = Math.max(0, ...Object.keys(orig).map(Number), ...Object.keys(inherited).map(Number));
  const slots = Array.from({ length: Math.max(maxPos, lineKeys) }, (_, i) => (orig[i + 1] ? structuredClone(orig[i + 1]) : null));
  S.cur = { user: u, dev, prof, model, lk, exp, orig, inherited, lineKeys, origLineKeys: lineKeys, slots, extraModules: 0 };
  renderUserList();
  renderEditor();
}

function isDirty() {
  const c = S.cur;
  if (!c) return false;
  return c.lineKeys !== c.origLineKeys || JSON.stringify(targetKeys()) !== JSON.stringify(normMap(c.orig));
}
function normMap(m) { const o = {}; for (const p of Object.keys(m).map(Number).sort((a, b) => a - b)) o[p] = cleanKey(m[p]); return o; }
function targetKeys() {
  const c = S.cur, o = {};
  c.slots.forEach((k, i) => { if (k && i + 1 > c.lineKeys) o[i + 1] = cleanKey(k); });
  return o;
}
function guardUnsaved(fn) {
  if (!isDirty()) return fn();
  confirmModal('<p>Des modifications ne sont pas enregistrées sur ce poste. Les abandonner ?</p>', fn, 'Abandonner');
}

// ---------------------------------------------------------------------------
// Rendu de l'atelier
// ---------------------------------------------------------------------------
function destText(k) {
  const d = k.destination;
  if (d.type === 'user') { const t = S.byId.get(d.user_id); return t ? `${fullName(t)} · ${userExten(t)}` : 'utilisateur supprimé'; }
  if (d.type === 'custom') return `Numéro ${d.exten}`;
  if (NAMED[d.type]) { const it = (S.named[d.type] || []).find((x) => x.id === d[NAMED[d.type][1]]); return `${TYPE_LABEL[d.type]} ${it ? it.label || it.name : '#' + d[NAMED[d.type][1]]}`; }
  return d.type;
}
function capacityInfo() {
  const c = S.cur;
  if (c.lk == null) return { lk: Math.max(c.slots.length + 4, 12), per: 0, maxMods: 0, known: false };
  const [per, maxMods] = EXP[c.exp] || [0, 0];
  return { lk: c.lk, per, maxMods, known: true };
}
function renderEditor() {
  const c = S.cur;
  $('empty').hidden = true;
  $('editor').hidden = false;
  $('ed-name').textContent = fullName(c.user);
  $('ed-device').textContent = c.dev
    ? `${[c.dev.vendor, c.dev.model].filter(Boolean).join(' ') || 'modèle inconnu'} · ${c.dev.mac || ''}${c.lk ? ` · ${c.lk} touches` : ''}${c.exp ? ` · module ${c.exp}` : ''}`
    : 'Aucun poste associé (les touches restent enregistrées sur l\'utilisateur)';
  $('lk-val').textContent = c.lineKeys;
  // Touches ligne multiples : seulement pour les profils qui les gèrent ; on
  // laisse « − » actif pour pouvoir revenir à 1 si un jeton traîne.
  const multi = !!c.prof?.multiLine;
  $('lk-plus').disabled = !multi;
  $('lk-minus').disabled = c.lineKeys <= 1;
  $('lk-plus').title = multi ? '' : 'Touches ligne multiples non gérées pour cette marque';

  const cap = capacityInfo();
  const warns = [];
  if (c.dev && !c.prof) warns.push(`Marque ${esc(c.dev.vendor || 'inconnue')} : nombre de touches et modules d'extension non vérifiés, la grille affichée est indicative.`);
  else if (!cap.known && c.dev) warns.push(`Modèle ${esc(c.model)} absent de la table ${esc(c.prof.name)} : capacité non vérifiée.`);
  if (c.dev && !multi && c.lineKeys > 1) warns.push('Touches ligne multiples : non gérées pour cette marque, elles ne seront pas appliquées.');
  if (Object.keys(c.inherited).length) warns.push(`${Object.keys(c.inherited).length} touche(s) héritée(s) d'un modèle de touches partagé : visibles mais non modifiables ici.`);
  if (c.lineKeys !== c.origLineKeys) warns.push('Les touches ligne sont appliquées par le plugin serveur blf-sync à son prochain passage (15 min max).');
  $('warnings').innerHTML = warns.map((w) => `<div class="warn">${w}</div>`).join('');

  const used = Math.max(c.slots.length, ...Object.keys(c.inherited).map(Number), c.lineKeys);
  const needMods = cap.per ? Math.max(0, Math.ceil((used - cap.lk) / cap.per)) : 0;
  const mods = Math.min(cap.maxMods, Math.max(needMods, c.extraModules));
  $('addModule').hidden = !cap.per || mods >= cap.maxMods;

  const pages = buildPages(cap, mods);
  const maxPos = pages[pages.length - 1].to;
  const host = $('pages');
  host.innerHTML = '';
  let group = null;
  for (const pg of pages) {
    // Les pages d'un même appareil (poste ou module) côte à côte.
    if (!group || group.dataset.key !== pg.group) {
      group = document.createElement('div');
      group.className = 'faces';
      group.dataset.key = pg.group;
      host.appendChild(group);
    }
    group.appendChild(pageEl(pg));
    if (pg.note) host.insertAdjacentHTML('beforeend', `<p class="muted small facenote">${pg.note}</p>`);
  }
  const overflow = c.slots.map((k, i) => (k ? i + 1 : 0)).filter((p) => p > maxPos);
  if (overflow.length) $('warnings').insertAdjacentHTML('beforeend', `<div class="warn">Positions ${overflow.join(', ')} au-delà de la capacité affichée : elles ne seront pas visibles sur le téléphone.</div>`);

  $('save').disabled = !isDirty();
  renderDetail();
  layout();
}
// Découpage en pages comme sur le téléphone. Modèle à pages connu : chaque
// page montre `gauche + droite` touches physiques, la dernière (en bas à
// droite) servant de touche de page. Sinon (tactile, marque non vérifiée) :
// une seule grille.
function buildPages(cap, mods) {
  const c = S.cur;
  const name = c.dev ? [c.dev.vendor, c.model].filter(Boolean).join(' ') || 'poste' : '';
  const out = [];
  const face = cap.known && c.prof?.face?.[c.model];
  if (face) {
    // Comportement Yealink (T54W : 10 emplacements) :
    // - jusqu'à 10 touches utilisées, une seule page de 10 touches ;
    // - dès la 11e, l'emplacement du bas à droite devient la touche de page et
    //   les pages font 9 touches (la touche 10 passe en tête de la page 2) ;
    // - une page vide n'apparaît pas sur le poste ; ici elle reste éditable, en grisé.
    const [l, r, maxPages] = face;
    const phys = l + r;
    const per = phys - 1;
    const n = Math.min(maxPages, Math.ceil(cap.lk / per));
    const used = Math.min(cap.lk, Math.max(c.lineKeys, ...c.slots.map((k, i) => (k ? i + 1 : 0)), ...Object.keys(c.inherited).map(Number)));
    const paging = used > phys;
    const shown = paging ? Math.min(n, Math.ceil(used / per)) : 1;
    for (let i = 0; i < n; i++) {
      const active = i < shown;
      const pg = {
        group: 'phone', from: i * per + 1, to: Math.min(cap.lk, (i + 1) * per), l, r,
        title: active ? `${name} · page ${i + 1}/${shown}` : `${name} · page ${i + 1} · non affichée (vide)`,
        pageKey: paging && active ? 'on' : 'off', inactive: !active,
        screen: active ? `Page ${i + 1}/${shown}` : 'Page masquée',
      };
      if (!paging && i === 0) { pg.to = Math.min(cap.lk, phys); pg.pageKey = null; }
      // Sans pagination, la touche 10 est en page 1 : sur la page 2 grisée, on
      // indique seulement qu'elle viendra là.
      if (!paging && i === 1) pg.ghost = pg.from;
      out.push(pg);
    }
    if (n > 1) out[n - 1].note = `Sur le poste : jusqu'à ${phys} touches, une seule page. Dès qu'une touche ${phys + 1} ou suivante est utilisée, l'emplacement ${phys} devient la touche de page et la touche ${phys} passe en tête de la page 2. Une page vide ne s'affiche pas.`;
  } else {
    out.push({ group: 'phone', title: c.dev ? `Touches du ${name}` : 'Touches', from: 1, to: cap.lk });
  }
  const ef = c.prof?.expFace?.[c.exp];
  for (let m = 1; m <= mods; m++) {
    const base = cap.lk + (m - 1) * cap.per;
    if (ef) {
      const per = ef[0] + ef[1];
      const n = Math.ceil(cap.per / per);
      for (let i = 0; i < n; i++) out.push({ group: `mod${m}`, title: `Module ${m} (${c.exp}) · page ${i + 1}/${n}`, from: base + i * per + 1, to: base + Math.min(cap.per, (i + 1) * per), l: ef[0], r: ef[1], screen: `${c.exp} · ${i + 1}/${n}` });
    } else {
      out.push({ group: `mod${m}`, title: `Module ${m} (${c.exp})`, from: base + 1, to: base + cap.per });
    }
  }
  return out;
}
function pageEl(pg) {
  const div = document.createElement('div');
  div.className = `page${pg.inactive ? ' inactive' : ''}`;
  div.innerHTML = `<h4>${esc(pg.title)} · positions ${pg.ghost ? pg.ghost + 1 : pg.from}–${pg.to}</h4>`;
  if (!pg.l) {
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (let p = pg.from; p <= pg.to; p++) grid.appendChild(tileEl(p));
    div.appendChild(grid);
    return div;
  }
  // Ordre Yealink : colonne de gauche de haut en bas, puis colonne de droite.
  const slots = pg.l + pg.r;
  const cells = [];
  for (let k = 0; k < slots; k++) {
    if (pg.pageKey === 'on' && k === slots - 1) cells.push(staticTile('pagekey', '⇆', 'Page'));
    else if (pg.pageKey === 'off' && k === slots - 1) cells.push(staticTile('pagekey off', '', 'Page', 'Touche de page : apparaît dès que la page 2 est utilisée'));
    else if (pg.ghost && k === 0) cells.push(staticTile('none ghost', String(pg.ghost), `↳ touche ${pg.ghost}`, `La touche ${pg.ghost} vient ici dès que la page 2 est utilisée`));
    else if (pg.from + k <= pg.to) cells.push(tileEl(pg.from + k));
    else cells.push(staticTile('none', '', '—'));
  }
  const face = document.createElement('div');
  face.className = `face${pg.r ? '' : ' one'}`;
  const col = (list) => { const d = document.createElement('div'); d.className = 'col'; list.forEach((x) => d.appendChild(x)); return d; };
  const screen = document.createElement('div');
  screen.className = 'screen';
  screen.textContent = pg.screen;
  face.append(col(cells.slice(0, pg.l)), screen);
  if (pg.r) face.appendChild(col(cells.slice(pg.l)));
  div.appendChild(face);
  return div;
}
function staticTile(cls, pos, lbl, title = '') {
  const el = document.createElement('div');
  el.className = `tile ${cls}`;
  if (title) el.title = title;
  el.innerHTML = `<span class="pos">${esc(pos)}</span><div class="lbl">${esc(lbl)}</div>`;
  return el;
}
function tileEl(p) {
  const c = S.cur;
  const el = document.createElement('div');
  const k = c.slots[p - 1];
  const inh = c.inherited[p];
  el.innerHTML = `<span class="pos">${p}</span>`;
  if (p <= c.lineKeys) {
    el.className = 'tile line';
    el.innerHTML += `<div class="lbl">Ligne</div><div class="dst">${esc(userExten(c.user) || 'compte 1')}</div>`;
    return el;
  }
  if (k) {
    const vacant = k.destination.type === 'user' && !S.byId.has(k.destination.user_id);
    el.className = `tile key${vacant ? ' vacant' : ''}`;
    el.innerHTML += `<div class="lbl">${esc(k.label || '(sans libellé)')}</div><div class="dst">${k.blf ? '● ' : ''}${esc(destText(k))}</div>`;
  } else if (inh) {
    el.className = 'tile inherited';
    el.innerHTML += `<div class="lbl">${esc(inh.label || '')}</div><div class="dst">héritée · ${esc(destText(inh))}</div>`;
    return el;
  } else {
    el.className = 'tile empty';
    el.innerHTML += '<div class="lbl">+</div>';
  }
  if (keySig(k) !== keySig(c.orig[p])) el.classList.add('changed');
  if (S.sel === p) el.classList.add('sel');
  el.onclick = () => { S.sel = p; $('dt-type').dataset.pending = ''; renderEditor(); };
  return el;
}
function layout() {
  const main = $('main');
  main.classList.toggle('no-detail', $('detail').hidden);
}

// ---------------------------------------------------------------------------
// Panneau de détail d'une touche
// ---------------------------------------------------------------------------
function autoLabel(k) {
  if (!k) return '';
  const d = k.destination;
  if (d.type === 'user') return fullName(S.byId.get(d.user_id));
  if (d.type === 'custom') return d.exten || '';
  if (NAMED[d.type]) { const it = (S.named[d.type] || []).find((x) => x.id === d[NAMED[d.type][1]]); return it ? it.label || it.name : ''; }
  return '';
}
async function ensureNamed(type) {
  if (!NAMED[type] || S.named[type]) return;
  try { S.named[type] = await listAll(NAMED[type][0]); } catch (e) { S.named[type] = []; toast(`Lecture des ${TYPE_LABEL[type].toLowerCase()}s impossible : ${e.message}`, 5000); }
}
function setKey(p, k) {
  const c = S.cur;
  while (c.slots.length < p) c.slots.push(null);
  c.slots[p - 1] = k;
}
function renderDetail() {
  const c = S.cur;
  const p = S.sel;
  const det = $('detail');
  if (!c || !p || p <= c.lineKeys) { det.hidden = true; layout(); return; }
  det.hidden = false;
  const k = c.slots[p - 1];
  $('dt-title').textContent = `Touche ${p}`;
  const type = k?.destination.type || $('dt-type').dataset.pending || 'user';
  $('dt-type').value = TYPE_LABEL[type] ? type : 'custom';
  $('dt-type').disabled = !!k && !TYPE_LABEL[type];
  $('dt-label').value = k?.label || '';
  $('dt-label').disabled = !k;
  $('dt-blf').checked = !!k?.blf;
  $('dt-blf').disabled = !k;
  for (const id of ['dt-left', 'dt-right', 'dt-clear', 'dt-delete']) $(id).disabled = !k && id !== 'dt-delete';
  $('dt-left').disabled = p - 1 <= c.lineKeys;
  renderValueField(type, k);
}
function renderValueField(type, k) {
  const c = S.cur, p = S.sel, wrap = $('dt-valuewrap');
  wrap.innerHTML = '';
  if (k && !TYPE_LABEL[type]) { wrap.innerHTML = `<p class="muted small">Type « ${esc(type)} » : modifiable dans l'interface Wazo.</p>`; return; }
  if (type === 'user') {
    const cur = k?.destination.type === 'user' ? S.byId.get(k.destination.user_id) : null;
    wrap.innerHTML = `<label>Collègue <input id="dt-user" placeholder="Nom, identifiant ou extension" value="${esc(cur ? fullName(cur) : '')}"></label><ul id="dt-sugg" class="suggest" hidden></ul>`;
    const inp = $('dt-user'), sugg = $('dt-sugg');
    const show = () => {
      const q = inp.value.trim().toLowerCase();
      // Jamais le propriétaire du poste : se superviser soi-même gâche une touche.
      const list = S.users.filter((u) => u.uuid !== c.user.uuid && (!q || `${fullName(u)} ${u.username || ''} ${userExten(u)}`.toLowerCase().includes(q))).slice(0, 30);
      sugg.innerHTML = list.map((u) => `<li data-id="${u.id}">${esc(fullName(u))} <span class="muted">${esc(userExten(u))}</span></li>`).join('') || '<li class="muted">Aucun résultat</li>';
      sugg.hidden = false;
    };
    inp.onfocus = show; inp.oninput = show;
    sugg.onclick = (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const u = S.byId.get(Number(li.dataset.id));
      const old = c.slots[p - 1];
      const keepLabel = old && old.label && old.label !== autoLabel(old);
      setKey(p, { blf: old ? old.blf : true, label: keepLabel ? old.label : fullName(u), destination: { type: 'user', user_id: u.id } });
      renderEditor();
    };
  } else if (type === 'custom') {
    wrap.innerHTML = `<label>Numéro <input id="dt-exten" inputmode="tel" value="${esc(k?.destination.exten || '')}"></label>`;
    $('dt-exten').onchange = () => {
      const v = $('dt-exten').value.trim();
      if (!v) return;
      const old = c.slots[p - 1];
      const keepLabel = old && old.label && old.label !== autoLabel(old);
      setKey(p, { blf: old?.destination.type === 'custom' ? old.blf : false, label: keepLabel ? old.label : v, destination: { type: 'custom', exten: v } });
      renderEditor();
    };
  } else {
    const [, param] = NAMED[type];
    wrap.innerHTML = '<p class="muted small">Chargement…</p>';
    ensureNamed(type).then(() => {
      if (S.sel !== p) return;
      const items = S.named[type] || [];
      const curId = k?.destination.type === type ? k.destination[param] : '';
      wrap.innerHTML = `<label>${TYPE_LABEL[type]} <select id="dt-named"><option value="">—</option>${items.map((it) => `<option value="${it.id}" ${it.id === curId ? 'selected' : ''}>${esc(it.label || it.name)}</option>`).join('')}</select></label>`;
      $('dt-named').onchange = () => {
        const id = Number($('dt-named').value);
        if (!id) return;
        const old = c.slots[p - 1];
        const keepLabel = old && old.label && old.label !== autoLabel(old);
        const it = items.find((x) => x.id === id);
        setKey(p, { blf: false, label: keepLabel ? old.label : it.label || it.name, destination: { type, [param]: id } });
        renderEditor();
      };
    });
  }
}

function wireDetail() {
  $('dt-type').onchange = () => {
    const t = $('dt-type').value;
    const k = S.cur.slots[S.sel - 1];
    $('dt-type').dataset.pending = t;
    if (k && k.destination.type !== t) {
      // on garde la touche actuelle tant qu'une nouvelle valeur n'est pas choisie
      renderValueField(t, null);
    } else renderValueField(t, k);
  };
  $('dt-label').oninput = () => { const k = S.cur.slots[S.sel - 1]; if (k) { k.label = $('dt-label').value || null; refreshTileOnly(); } };
  $('dt-blf').onchange = () => { const k = S.cur.slots[S.sel - 1]; if (k) { k.blf = $('dt-blf').checked; renderEditor(); } };
  $('dt-clear').onclick = () => { setKey(S.sel, null); renderEditor(); };
  $('dt-delete').onclick = () => { const c = S.cur; if (S.sel - 1 < c.slots.length) c.slots.splice(S.sel - 1, 1); renderEditor(); };
  $('dt-insert').onclick = () => { const c = S.cur; while (c.slots.length < S.sel - 1) c.slots.push(null); c.slots.splice(S.sel - 1, 0, null); renderEditor(); };
  $('dt-left').onclick = () => move(-1);
  $('dt-right').onclick = () => move(1);
}
function move(delta) {
  const c = S.cur, i = S.sel - 1, j = i + delta;
  if (j < c.lineKeys) return;
  while (c.slots.length <= Math.max(i, j)) c.slots.push(null);
  [c.slots[i], c.slots[j]] = [c.slots[j], c.slots[i]];
  S.sel = j + 1;
  renderEditor();
}
function refreshTileOnly() { $('save').disabled = !isDirty(); const keep = document.activeElement; renderEditorKeepFocus(keep); }
function renderEditorKeepFocus(el) {
  const id = el?.id, pos = el?.selectionStart;
  renderEditor();
  if (id && $(id)) { $(id).focus(); try { $(id).setSelectionRange(pos, pos); } catch { /* */ } }
}

// ---------------------------------------------------------------------------
// Touches ligne
// ---------------------------------------------------------------------------
function changeLineKeys(delta) {
  const c = S.cur;
  const max = c.lk ?? 12;
  const n = c.lineKeys + delta;
  if (n < 1 || n > max || (delta > 0 && !c.prof?.multiLine)) return;
  // Les touches suivent : +1 ligne = toutes les touches reculent d'une case.
  while (c.slots.length < c.lineKeys) c.slots.push(null);
  if (delta > 0) c.slots.splice(c.lineKeys, 0, null);
  else c.slots.splice(n, 1);
  c.lineKeys = n;
  if (S.sel && S.sel <= n) S.sel = null;
  renderEditor();
}

// ---------------------------------------------------------------------------
// Enregistrement
// ---------------------------------------------------------------------------
function describe(k) { return k ? `${esc(k.label || '')} <span class="muted">(${esc(destText(k))})</span>` : '<span class="muted">vide</span>'; }
function save() {
  const c = S.cur;
  const target = targetKeys();
  const orig = normMap(c.orig);
  const rows = [];
  const positions = [...new Set([...Object.keys(target), ...Object.keys(orig)].map(Number))].sort((a, b) => a - b);
  for (const p of positions) if (keySig(target[p]) !== keySig(orig[p])) rows.push(`<tr><td>${p}</td><td>${describe(orig[p])}</td><td>${describe(target[p])}</td></tr>`);
  const lkChanged = c.lineKeys !== c.origLineKeys;
  const html = `<h3>Enregistrer ${esc(fullName(c.user))}</h3>
    ${lkChanged ? `<p>Touches ligne : ${c.origLineKeys} → <strong>${c.lineKeys}</strong> (appliqué par le plugin serveur).</p>` : ''}
    ${rows.length ? `<table class="diff"><tr><th>Pos.</th><th>Avant</th><th>Après</th></tr>${rows.join('')}</table>` : '<p class="muted">Aucune touche de fonction modifiée.</p>'}`;
  confirmModal(html, async () => {
    try {
      if (rows.length) await api('PUT', `/users/${c.user.uuid}/funckeys`, { keys: target });
      if (lkChanged) {
        let uf = (c.user.userfield || '').replace(LK_TOKEN, '').trim();
        if (c.lineKeys > 1) uf = `${uf} blf-linekeys=${c.lineKeys}`.trim();
        if (uf.length > 128) throw new Error('userfield trop long (128 caractères max)');
        await api('PUT', `/users/${c.user.uuid}`, { userfield: uf || null });
        c.user.userfield = uf;
      }
      if ($('resync').checked && c.dev && (rows.length || lkChanged)) {
        try { await api('GET', `/devices/${c.dev.id}/synchronize`); } catch (e) { toast(`Enregistré, mais resynchro impossible : ${e.message}`, 6000); }
      }
      toast('Enregistré');
      await selectUser(c.user);
    } catch (e) { toast(e.message, 8000); }
  }, 'Enregistrer');
}

// ---------------------------------------------------------------------------
// Harmonisation des libellés (renommages)
// ---------------------------------------------------------------------------
async function scanLabels() {
  const out = $('labelsResult');
  out.innerHTML = '<p class="muted small">Analyse…</p>';
  const found = [];
  const owners = S.users.filter(listed);
  let done = 0;
  for (const u of owners) {
    try {
      const data = await api('GET', `/users/${u.uuid}/funckeys`);
      for (const [p, k] of Object.entries(data?.keys || {})) {
        if (k.inherited || k.destination?.type !== 'user') continue;
        const t = S.byId.get(k.destination.user_id);
        if (!t) continue;
        const want = fullName(t);
        if ((k.label || '').trim() && k.label.trim() !== want) found.push({ owner: u, pos: Number(p), from: k.label, to: want });
      }
    } catch { /* ignoré */ }
    if (++done % 10 === 0) out.innerHTML = `<p class="muted small">Analyse… ${done}/${owners.length}</p>`;
  }
  if (!found.length) { out.innerHTML = '<p class="muted small">Tous les libellés correspondent aux noms actuels.</p>'; return; }
  out.innerHTML = `<p class="small">${found.length} libellé(s) différent(s) du nom actuel :</p>
    <ul class="list">${found.map((f, i) => `<li><label class="inline"><input type="checkbox" data-i="${i}"> <span><strong>${esc(fullName(f.owner))}</strong> #${f.pos}<br><span class="muted">${esc(f.from)} → ${esc(f.to)}</span></span></label></li>`).join('')}</ul>
    <div class="btnrow"><button id="lbl-all">Tout cocher</button><button id="lbl-apply" class="primary">Mettre à jour</button></div>`;
  $('lbl-all').onclick = () => out.querySelectorAll('input[type=checkbox]').forEach((x) => (x.checked = true));
  $('lbl-apply').onclick = async () => {
    const picked = [...out.querySelectorAll('input:checked')].map((x) => found[Number(x.dataset.i)]);
    const byOwner = new Map();
    for (const f of picked) (byOwner.get(f.owner.uuid) || byOwner.set(f.owner.uuid, []).get(f.owner.uuid)).push(f);
    let ok = 0;
    for (const [uuid, list] of byOwner) {
      try {
        const data = await api('GET', `/users/${uuid}/funckeys`);
        const keys = {};
        for (const [p, k] of Object.entries(data?.keys || {})) if (!k.inherited) keys[p] = cleanKey(k);
        for (const f of list) if (keys[f.pos] && keys[f.pos].label === f.from) keys[f.pos].label = f.to;
        await api('PUT', `/users/${uuid}/funckeys`, { keys });
        ok += list.length;
      } catch (e) { toast(e.message, 6000); }
    }
    toast(`${ok} libellé(s) mis à jour`);
    scanLabels();
  };
}

// ---------------------------------------------------------------------------
// Modale
// ---------------------------------------------------------------------------
function confirmModal(html, onOk, okText = 'Confirmer') {
  $('modal-body').innerHTML = html;
  $('modal-ok').textContent = okText;
  $('modal').hidden = false;
  $('modal-cancel').onclick = () => ($('modal').hidden = true);
  $('modal-ok').onclick = () => { $('modal').hidden = true; onOk(); };
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
$('search').oninput = renderUserList;
document.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('[data-side]').forEach((x) => x.classList.toggle('active', x === b));
  $('userlist').hidden = b.dataset.side !== 'users';
  $('labelsPane').hidden = b.dataset.side !== 'labels';
}));
$('scanLabels').onclick = scanLabels;
$('lk-minus').onclick = () => changeLineKeys(-1);
$('lk-plus').onclick = () => changeLineKeys(1);
$('addModule').onclick = () => { S.cur.extraModules++; renderEditor(); };
$('revert').onclick = () => S.cur && selectUser(S.cur.user);
$('save').onclick = save;
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
wireDetail();
connect();
