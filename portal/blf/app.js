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
  set('--accent-dark', pal.primary?.dark);
  set('--accent-light', pal.primary?.light);
  // Police : on garde Mulish (--default-font réel du portail) ; le thème
  // transmis peut annoncer la police MUI par défaut (Roboto) sans l'utiliser.
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
  // Autre tenant (ou autre serveur) : tout ce qui est en mémoire appartient à
  // l'ancien (poste ouvert, modèles, cases cochées du déploiement).
  const scope = `${S.base}|${S.tenant}`;
  if (S.scope && S.scope !== scope) {
    if (isDirty()) toast('Changement de client : modifications non enregistrées abandonnées.', 6000);
    S.cur = null; S.sel = null;
    D.templates = null; D.src = null; D.srcLines = 1; D.picked.clear(); D.plan = [];
    $('editor').hidden = true; $('detail').hidden = true;
    $('dp-preview').innerHTML = ''; $('dp-source').value = '';
    if ($('deploy').hidden) $('empty').hidden = false;
  }
  S.scope = scope;
  try {
    const [users, devices] = await Promise.all([listAll('/users'), listAll('/devices').catch(() => [])]);
    S.users = users.sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
    S.byId = new Map(users.map((u) => [u.id, u]));
    S.byUuid = new Map(users.map((u) => [u.uuid, u]));
    S.devices = new Map(devices.map((d) => [d.id, d]));
    S.named = {};
    $('conn').textContent = `${new URL(S.base).host} · ${users.length} utilisateurs`;
    const n = users.filter(listed).length;
    const hid = users.length - n;
    $('count').textContent = `${n} utilisateur${n > 1 ? 's' : ''}${hid ? ` · ${hid} masqué${hid > 1 ? 's' : ''}` : ''}`;
    $('count').title = hid ? 'Masqués : utilisateurs sans ligne, avec seulement un DECT, une ligne analogique ou un poste sans touches.' : '';
    $('main').hidden = false;
    document.body.classList.add('ready');
    renderUserList();
    if (!$('deploy').hidden) openDeploy(); // relit modèles et utilisateurs du nouveau tenant
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

// Touches posées (dans Wazo) sur une position de ligne : elles seraient
// masquées par la tuile « Ligne » puis perdues à l'enregistrement. On les
// décale juste après les lignes (avertissement affiché, à enregistrer).
function shiftLineClashes(slots, orig, lineKeys) {
  const clash = Object.keys(orig).map(Number).filter((p) => p <= lineKeys).sort((a, b) => a - b);
  if (clash.length) {
    const moved = clash.map((p) => slots[p - 1]);
    clash.forEach((p) => { slots[p - 1] = null; });
    slots.splice(lineKeys, 0, ...moved);
  }
  return clash.length;
}
let selectSeq = 0;
async function selectUser(u) {
  const seq = ++selectSeq; // clics rapides : seule la dernière demande s'applique
  const dev = userDevice(u);
  const model = dev?.model || null;
  const prof = vendorOf(dev);
  const lk = prof?.linekeys[model] ?? null;
  const exp = prof?.exp(model) ?? null;
  let data;
  try { data = await api('GET', `/users/${u.uuid}/funckeys`); } catch (e) { if (seq === selectSeq) toast(`${fullName(u)} : ${e.message}`, 6000); return; }
  if (seq !== selectSeq) return;
  S.sel = null;
  const orig = {}, inherited = {};
  for (const [p, k] of Object.entries(data?.keys || {})) (k.inherited ? inherited : orig)[Number(p)] = cleanKey(k);
  const m = (u.userfield || '').match(LK_TOKEN);
  const lineKeys = m ? Number(m[1]) : 1;
  const maxPos = Math.max(0, ...Object.keys(orig).map(Number), ...Object.keys(inherited).map(Number));
  const slots = Array.from({ length: Math.max(maxPos, lineKeys) }, (_, i) => (orig[i + 1] ? structuredClone(orig[i + 1]) : null));
  const clash = shiftLineClashes(slots, orig, lineKeys);
  S.cur = { user: u, dev, prof, model, lk, exp, orig, inherited, lineKeys, origLineKeys: lineKeys, slots, clash, extraModules: 0, extraPages: 0, pagesLeft: 0 };
  renderUserList();
  renderEditor();
}

function isDirty() {
  const c = S.cur;
  if (!c) return false;
  return c.lineKeys !== c.origLineKeys || JSON.stringify(targetKeys()) !== JSON.stringify(normMap(c.orig))
    || (!!c.tpl && (c.tpl.name.trim() !== c.tpl.origName || !c.tpl.id));
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
// Bandeau de recommandation : en grand à l'ouverture, puis réduit à une ligne
// dans la colonne de gauche dès la première action (poste ouvert, menu).
function shrinkAdvice() {
  if ($('advice').hidden) return;
  $('advice').hidden = true;
  $('advice-mini').hidden = false;
}
function renderEditor() {
  shrinkAdvice();
  const c = S.cur;
  $('empty').hidden = true;
  $('editor').hidden = false;
  const isTpl = !!c.tpl;
  $('ed-name').hidden = isTpl;
  $('ed-device').hidden = isTpl;
  $('tpl-head').hidden = !isTpl;
  $('tpl-back').hidden = !isTpl;
  $('resync-wrap').hidden = isTpl;
  $('save').textContent = isTpl ? 'Enregistrer le modèle' : 'Enregistrer';
  if (isTpl) {
    if (document.activeElement !== $('tpl-name')) $('tpl-name').value = c.tpl.name;
    $('tpl-model').value = c.model;
  }
  $('ed-name').textContent = fullName(c.user);
  $('ed-device').textContent = c.dev
    ? `${[c.dev.vendor, c.dev.model].filter(Boolean).join(' ') || 'modèle inconnu'} · ${c.dev.mac || ''}${c.lk ? ` · ${c.lk} touches` : ''}${c.exp ? ` · module ${c.exp}` : ''}`
    : 'Aucun poste associé (les touches restent enregistrées sur l\'utilisateur)';
  $('lk-val').textContent = c.lineKeys;
  // Touches ligne multiples : seulement pour les profils qui les gèrent (et
  // toujours pour un modèle) ; « − » reste actif pour revenir à 1.
  const multi = !!c.prof?.multiLine || isTpl;
  $('lk-plus').disabled = !multi;
  $('lk-minus').disabled = c.lineKeys <= 1;
  $('lk-plus').title = multi ? '' : 'Touches ligne multiples non gérées pour cette marque';

  const cap = capacityInfo();
  const warns = [];
  if (c.dev && !c.prof) warns.push(`Marque ${esc(c.dev.vendor || 'inconnue')} : nombre de touches et modules d'extension non vérifiés, la grille affichée est indicative.`);
  else if (!cap.known && c.dev) warns.push(`Modèle ${esc(c.model)} absent de la table ${esc(c.prof.name)} : capacité non vérifiée.`);
  if (c.dev && !multi && c.lineKeys > 1) warns.push('Touches ligne multiples : non gérées pour cette marque, elles ne seront pas appliquées.');
  if (Object.keys(c.inherited).length) warns.push(`${Object.keys(c.inherited).length} touche(s) héritée(s) d'un modèle de touches partagé : visibles mais non modifiables ici.`);
  if (!isTpl && c.lineKeys !== c.origLineKeys) warns.push('Les touches ligne sont appliquées par le plugin serveur blf-sync à son prochain passage (15 min max).');
  if (isTpl) warns.push(`Modèle : l'aperçu sur ${esc(c.model)} sert seulement à placer les touches ; au déploiement, chaque poste reçoit les mêmes positions. Les touches ligne sont notées dans le nom du modèle Wazo (blf-linekeys=${c.lineKeys}).`);
  if (c.clash) warns.push(`${c.clash} touche(s) étaient placées dans Wazo sur des positions de ligne (masquées par les touches ligne) : elles ont été décalées juste après les lignes. Vérifiez puis enregistrez pour corriger.`);
  $('warnings').innerHTML = warns.map((w) => `<div class="warn">${w}</div>`).join('');

  const used = Math.max(c.slots.length, ...Object.keys(c.inherited).map(Number), c.lineKeys);
  const needMods = cap.per ? Math.max(0, Math.ceil((used - cap.lk) / cap.per)) : 0;
  const mods = Math.min(cap.maxMods, Math.max(needMods, c.extraModules));
  $('addModule').hidden = !cap.per || mods >= cap.maxMods;
  c.modsShown = mods;

  const pages = buildPages(cap, mods);
  $('addPage').hidden = !c.pagesLeft;
  const maxPos = cap.lk + mods * cap.per;
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
  c.pagesLeft = 0;
  c.pageInfo = null;
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
    const real = used > phys ? Math.min(n, Math.ceil(used / per)) : 1; // pages sur le poste
    const shown = Math.min(n, Math.max(real, 1 + c.extraPages));         // pages affichées ici
    c.pagesLeft = n - shown;
    c.pageInfo = { shown, phys, per };
    if (shown === 1) {
      out.push({ group: 'phone', from: 1, to: Math.min(cap.lk, phys), l, r, title: `${name} · page 1/1`, screen: 'Page 1/1' });
    } else {
      for (let i = 0; i < shown; i++) {
        const empty = i >= real;
        // real === 1 : aperçu de la pagination, pas encore effective sur le poste.
        const title = real === 1
          ? `${name} · page ${i + 1} · aperçu (poste encore sur 1 page)`
          : empty ? `${name} · page ${i + 1} · vide, non affichée sur le poste` : `${name} · page ${i + 1}/${real}`;
        out.push({
          group: 'phone', from: i * per + 1, to: Math.min(cap.lk, (i + 1) * per), l, r, pageKey: 'on', inactive: empty,
          remove: i >= 1 ? { kind: 'page', i } : null,
          title,
          screen: `Page ${i + 1}/${shown}`,
        });
      }
      if (real === 1) out[shown - 1].note = `Tant qu'aucune touche après la ${phys} n'est remplie, le poste reste sur une seule page de ${phys} touches : la touche ${phys} reste en page 1 et il n'y a pas de touche de page.`;
    }
  } else {
    out.push({ group: 'phone', title: c.dev ? `Touches du ${name}` : 'Touches', from: 1, to: cap.lk });
  }
  // Modules : une seule carte par module, une page à la fois (sélecteur 1·2·3
  // comme les touches de page physiques de l'EXP).
  const ef = c.prof?.expFace?.[c.exp];
  c.modPage ||= {};
  for (let m = 1; m <= mods; m++) {
    const base = cap.lk + (m - 1) * cap.per;
    const remove = { kind: 'module', m };
    if (ef) {
      const per = ef[0] + ef[1];
      const n = Math.ceil(cap.per / per);
      const cur = Math.min(c.modPage[m] || 0, n - 1);
      const filled = Array.from({ length: n }, (_, i) => c.slots.slice(base + i * per, base + Math.min(cap.per, (i + 1) * per)).some(Boolean));
      out.push({ group: `mod${m}`, title: `Module ${m} (${c.exp})`, from: base + cur * per + 1, to: base + Math.min(cap.per, (cur + 1) * per), l: ef[0], r: ef[1], screen: `${c.exp} · page ${cur + 1}/${n}`, remove, modTabs: { m, n, cur, filled } });
    } else {
      out.push({ group: `mod${m}`, title: `Module ${m} (${c.exp})`, from: base + 1, to: base + cap.per, remove });
    }
  }
  return out;
}
function pageEl(pg) {
  const div = document.createElement('div');
  div.className = `page${pg.inactive ? ' inactive' : ''}`;
  const head = document.createElement('div');
  head.className = 'pagehead';
  head.innerHTML = `<h4>${esc(pg.title)} · positions ${pg.from}–${pg.to}</h4>`;
  if (pg.modTabs) {
    const { m, n, cur, filled } = pg.modTabs;
    head.insertAdjacentHTML('beforeend', `<div class="pagetabs" role="tablist">${Array.from({ length: n }, (_, i) => `<button role="tab" aria-selected="${i === cur}" class="${i === cur ? 'active' : ''}${filled[i] ? ' filled' : ''}" data-act="modpage" data-m="${m}" data-p="${i}" title="Page ${i + 1}${filled[i] ? ' (contient des touches)' : ''}">${i + 1}</button>`).join('')}</div>`);
  }
  if (pg.remove) {
    const what = pg.remove.kind === 'page' ? `la page ${pg.remove.i + 1}` : `le module ${pg.remove.m}`;
    head.insertAdjacentHTML('beforeend', `<button class="icon" data-act="remove" data-kind="${pg.remove.kind}" data-n="${pg.remove.kind === 'page' ? pg.remove.i : pg.remove.m}" title="Retirer ${what}" aria-label="Retirer ${what}">×</button>`);
  }
  div.appendChild(head);
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
// Retirer une page du poste (2e ou suivante) ou un module : ses touches sont
// effacées (après confirmation) et ce qui suit remonte d'un cran, dans les
// limites du poste (pour une page) ou de l'ensemble des modules (pour un
// module). En repassant à une seule page, la touche 10 (T54W) est conservée :
// elle revient en page 1.
function removeBlock(kind, n) {
  const c = S.cur, cap = capacityInfo();
  let from, to, end, label;
  if (kind === 'page') {
    const pi = c.pageInfo;
    if (!pi || pi.shown < 2 || n < 1) return;
    from = pi.shown === 2 ? pi.phys + 1 : n * pi.per + 1;
    to = Math.min(cap.lk, (n + 1) * pi.per);
    end = cap.lk;
    label = `la page ${n + 1}`;
  } else {
    from = cap.lk + (n - 1) * cap.per + 1;
    to = from + cap.per - 1;
    end = cap.lk + c.modsShown * cap.per;
    label = `le module ${n}`;
  }
  const count = to - from + 1;
  const inh = Object.keys(c.inherited).map(Number).filter((p) => p >= from && p <= end);
  if (inh.length) { toast(`Touches ${inh.join(', ')} héritées d'un modèle partagé : à retirer du modèle dans Wazo.`, 6000); return; }
  const lost = [];
  for (let p = from; p <= to; p++) if (c.slots[p - 1]) lost.push(p);
  const moved = c.slots.slice(to, end).some(Boolean);
  const apply = () => {
    while (c.slots.length < end) c.slots.push(null);
    c.slots.splice(from - 1, count);                          // retire le bloc…
    c.slots.splice(end - count, 0, ...Array(count).fill(null)); // …et garde la suite (modules) à sa place
    while (c.slots.length && !c.slots[c.slots.length - 1]) c.slots.pop();
    if (kind === 'page') c.extraPages = Math.max(0, c.pageInfo.shown - 2);
    else { c.extraModules = Math.max(0, c.modsShown - 1); c.modPage = {}; }
    S.sel = null;
    renderEditor();
  };
  if (!lost.length) return apply();
  confirmModal(`<h3>Retirer ${label}</h3><p>Ces touches seront effacées :</p><ul>${lost.map((p) => `<li>${p} · ${describe(c.slots[p - 1])}</li>`).join('')}</ul>${moved ? '<p>Les touches suivantes remontent d\'un cran.</p>' : ''}<p class="muted small">Rien n'est écrit tant que vous n'enregistrez pas.</p>`, apply, 'Retirer');
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
    el.innerHTML += `<div class="lbl">Ligne</div><div class="dst">${c.tpl ? 'ligne de l\'utilisateur' : esc(userExten(c.user) || 'compte 1')}</div>`;
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
  el.dataset.pos = p; // case éditable : cible de glisser-déposer
  if (k) { el.draggable = true; el.title = 'Glisser pour déplacer'; }
  el.onclick = () => { S.sel = p; $('dt-type').dataset.pending = ''; renderEditor(); };
  return el;
}

// Glisser-déposer : sur une case vide, la touche y est déplacée ; sur une
// autre touche, les deux sont échangées. Lignes, touches héritées et touche
// de page ne sont ni déplaçables ni des cibles (pas de data-pos).
let dragFrom = null;
function wireDragDrop() {
  const host = $('pages');
  const target = (e) => e.target.closest?.('.tile[data-pos]');
  host.addEventListener('dragstart', (e) => {
    const t = target(e);
    if (!t || !t.draggable) return;
    dragFrom = Number(t.dataset.pos);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
    requestAnimationFrame(() => t.classList.add('dragging'));
  });
  host.addEventListener('dragover', (e) => {
    const t = target(e);
    if (dragFrom == null || !t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    host.querySelectorAll('.dropover').forEach((x) => x !== t && x.classList.remove('dropover'));
    t.classList.add('dropover', S.cur.slots[Number(t.dataset.pos) - 1] ? 'swap' : 'move');
  });
  host.addEventListener('dragleave', (e) => { const t = target(e); if (t && !t.contains(e.relatedTarget)) t.classList.remove('dropover', 'swap', 'move'); });
  host.addEventListener('drop', (e) => {
    const t = target(e);
    if (dragFrom == null || !t) return;
    e.preventDefault();
    moveKey(dragFrom, Number(t.dataset.pos));
    dragFrom = null;
  });
  host.addEventListener('dragend', () => {
    dragFrom = null;
    host.querySelectorAll('.dragging, .dropover').forEach((x) => x.classList.remove('dragging', 'dropover', 'swap', 'move'));
  });
}
function moveKey(from, to) {
  const c = S.cur;
  if (from === to || to <= c.lineKeys || c.inherited[to]) return;
  while (c.slots.length < Math.max(from, to)) c.slots.push(null);
  [c.slots[from - 1], c.slots[to - 1]] = [c.slots[to - 1], c.slots[from - 1]];
  while (c.slots.length && !c.slots[c.slots.length - 1]) c.slots.pop();
  S.sel = to;
  renderEditor();
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
  $('dt-delete').onclick = () => shiftInBlock(S.sel, -1);
  $('dt-insert').onclick = () => shiftInBlock(S.sel, +1);
  $('dt-left').onclick = () => move(-1);
  $('dt-right').onclick = () => move(1);
}
// Supprimer (dir -1 : les suivantes remontent) / Insérer avant (dir +1 : elles
// reculent), sans sortir du bloc de la touche : le poste, ou son module
// d'extension. Les touches héritées ne bougent pas : refus si le bloc en a.
function shiftInBlock(p, dir) {
  const c = S.cur, cap = capacityInfo();
  const end = p <= cap.lk || !cap.per ? cap.lk : cap.lk + Math.ceil((p - cap.lk) / cap.per) * cap.per;
  const inh = Object.keys(c.inherited).map(Number).filter((x) => x >= p && x <= end);
  if (inh.length) { toast(`Impossible : touche(s) ${inh.join(', ')} héritée(s) d'un modèle partagé dans la suite du bloc.`, 6000); return; }
  while (c.slots.length < end) c.slots.push(null);
  if (dir < 0) {
    c.slots.splice(p - 1, 1);
    c.slots.splice(end - 1, 0, null);
  } else {
    if (c.slots[end - 1]) { toast(`Plus de place : la touche ${end} (dernière ${end === cap.lk ? 'du poste' : 'du module'}) serait perdue. Videz-la d'abord.`, 6000); while (c.slots.length && !c.slots[c.slots.length - 1]) c.slots.pop(); return; }
    c.slots.splice(end - 1, 1);
    c.slots.splice(p - 1, 0, null);
  }
  while (c.slots.length && !c.slots[c.slots.length - 1]) c.slots.pop();
  renderEditor();
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
// Jeton blf-linekeys=N dans le userfield (lu par astrea/blf-sync).
async function setUserLineKeys(u, n) {
  const before = (u.userfield || '').trim();
  let uf = before.replace(LK_TOKEN, '').trim();
  if (n > 1) uf = `${uf} blf-linekeys=${n}`.trim();
  if (uf === before) return false;
  if (uf.length > 128) throw new Error(`${fullName(u)} : userfield trop long (128 caractères max)`);
  await api('PUT', `/users/${u.uuid}`, { userfield: uf || null });
  u.userfield = uf;
  return true;
}
function save() {
  const c = S.cur;
  if (c.tpl) return saveTemplate();
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
      if (lkChanged) await setUserLineKeys(c.user, c.lineKeys);
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
// Déploiement en masse
// ---------------------------------------------------------------------------
// Source : un modèle de touches Wazo (/funckeys/templates) ou les touches
// propres d'un utilisateur. Écrit dans les touches privées de chaque cible
// (pas de rattachement au modèle partagé, qui mettrait à chacun sa propre
// touche). Tuiles : la touche vers le propriétaire est retirée et les
// suivantes remontent ; les cases vides entre deux touches sont gardées ;
// le bloc commence après les touches ligne de chaque utilisateur.
const D = { templates: null, src: null, srcLines: 1, picked: new Set(), plan: [] };
const lineKeysOf = (u) => { const m = (u.userfield || '').match(LK_TOKEN); return m ? Number(m[1]) : 1; };
// Modèle Wazo : le nombre de touches ligne est noté dans le nom avec le même
// jeton que le userfield (« Commerciaux blf-linekeys=2 ») ; sans jeton = 1.
const tplLines = (t) => { const m = (t?.name || '').match(LK_TOKEN); return m ? Number(m[1]) : 1; };
const tplName = (t) => (t?.name || '').replace(LK_TOKEN, '').trim();
const tplLabel = (t) => `${tplName(t) || `Modèle ${t.id}`}${tplLines(t) > 1 ? ` · ${tplLines(t)} lignes` : ''}`;

// Éditeur de modèle : réutilise l'éditeur de poste avec un poste fictif
// (aperçu sur un modèle Yealink au choix) et un utilisateur fictif.
async function openTemplate(id) {
  let tpl = { id: null, name: '', keys: {} };
  if (id) {
    try { tpl = await api('GET', `/funckeys/templates/${id}`); } catch (e) { toast(e.message, 6000); return; }
  }
  const lineKeys = tplLines(tpl);
  const orig = {};
  for (const [p, k] of Object.entries(tpl.keys || {})) orig[Number(p)] = cleanKey(k);
  await Promise.all([...new Set(Object.values(orig).map((k) => k.destination.type))].map(ensureNamed));
  const maxPos = Math.max(0, ...Object.keys(orig).map(Number));
  const slots = Array.from({ length: Math.max(maxPos, lineKeys) }, (_, i) => (orig[i + 1] ? structuredClone(orig[i + 1]) : null));
  const clash = shiftLineClashes(slots, orig, lineKeys);
  const model = $('tpl-model').value || 'T54W';
  const prof = VENDORS.yealink;
  S.sel = null;
  S.cur = {
    tpl: { id: tpl.id, name: tplName(tpl), origName: tplName(tpl) }, clash,
    user: { uuid: '__modele__', id: -1, firstname: tplName(tpl) || 'Nouveau modèle', lines: [] },
    dev: { vendor: 'Yealink', model, mac: '', plugin: 'wazo-yealink' }, prof, model, lk: prof.linekeys[model], exp: prof.exp(model),
    orig, inherited: {}, lineKeys, origLineKeys: lineKeys, slots, extraModules: 0, extraPages: 0, pagesLeft: 0,
  };
  $('deploy').hidden = true;
  renderEditor();
}
function setTemplateModel(model) {
  const c = S.cur;
  if (!c?.tpl) return;
  c.model = model;
  c.dev.model = model;
  c.lk = c.prof.linekeys[model];
  c.exp = c.prof.exp(model);
  c.extraPages = 0;
  c.extraModules = 0;
  renderEditor();
}
async function saveTemplate() {
  const c = S.cur;
  const name = c.tpl.name.trim();
  if (!name) { toast('Donnez un nom au modèle.'); $('tpl-name').focus(); return; }
  const body = { name: c.lineKeys > 1 ? `${name} blf-linekeys=${c.lineKeys}` : name, keys: targetKeys() };
  try {
    let id = c.tpl.id;
    if (id) await api('PUT', `/funckeys/templates/${id}`, body);
    else id = (await api('POST', '/funckeys/templates', body))?.id;
    toast(`Modèle « ${name} » enregistré dans Wazo`);
    D.templates = null; // relu à l'ouverture du déploiement
    backToDeploy(id ? `t:${id}` : '');
  } catch (e) { toast(e.message, 8000); }
}
async function backToDeploy(source) {
  S.cur = null;
  S.sel = null;
  $('editor').hidden = true;
  $('detail').hidden = true;
  await openDeploy();
  if (source !== undefined) { $('dp-source').value = source; await loadSource(); }
}
const destSig = (k) => JSON.stringify(cleanDest(k.destination || {}));
function capOf(u) {
  const dev = userDevice(u), prof = vendorOf(dev);
  const lk = prof?.linekeys[dev?.model];
  if (lk == null) return null;
  const [per, maxMods] = EXP[prof.exp(dev.model)] || [0, 0];
  return lk + per * maxMods;
}

async function openDeploy() {
  $('editor').hidden = true; $('empty').hidden = true; $('detail').hidden = true; $('deploy').hidden = false;
  layout();
  if (!D.templates) {
    // Format supposé identique aux touches utilisateur ({keys: {pos: {...}}}) — à vérifier en réel.
    try { D.templates = await listAll('/funckeys/templates'); } catch (e) { D.templates = []; toast(`Lecture des modèles de touches impossible : ${e.message}`, 6000); }
  }
  const cur = $('dp-source').value;
  $('dp-source').innerHTML = '<option value="">— choisir —</option>'
    + (D.templates.length ? `<optgroup label="Modèles de touches Wazo">${D.templates.map((t) => `<option value="t:${t.id}">${esc(tplLabel(t))}</option>`).join('')}</optgroup>` : '')
    + `<optgroup label="Copier les touches d'un utilisateur">${S.users.filter(listed).map((u) => `<option value="u:${u.uuid}">${esc(fullName(u))} · ${esc(userExten(u))}</option>`).join('')}</optgroup>`;
  $('dp-source').value = cur;
  renderDeployUsers();
}
function closeDeploy() {
  $('deploy').hidden = true;
  if (S.cur) selectUser(S.cur.user); // relit l'utilisateur : le déploiement a pu le modifier
  else $('empty').hidden = false;
  layout();
}
async function loadSource() {
  const v = $('dp-source').value;
  D.src = null;
  D.srcLines = 1;
  $('dp-preview').innerHTML = '';
  $('dp-edit').disabled = !v.startsWith('t:');
  if (v) {
    try {
      let keys = {};
      if (v.startsWith('t:')) {
        const t = await api('GET', `/funckeys/templates/${v.slice(2)}`);
        keys = t?.keys || {};
        D.srcLines = tplLines(t);
      } else {
        for (const [p, k] of Object.entries((await api('GET', `/users/${v.slice(2)}/funckeys`))?.keys || {})) if (!k.inherited) keys[p] = k;
        D.srcLines = lineKeysOf(S.byUuid.get(v.slice(2)) || {});
      }
      D.src = {};
      for (const [p, k] of Object.entries(keys)) D.src[Number(p)] = cleanKey(k);
      await Promise.all([...new Set(Object.values(D.src).map((k) => k.destination.type))].map(ensureNamed));
      const ps = Object.keys(D.src).map(Number).sort((a, b) => a - b);
      $('dp-preview').innerHTML = `<p><strong>Touches ligne : ${D.srcLines}</strong> <span class="muted small">(appliquées en mode « Remplacer »)</span></p>` + (ps.length
        ? `<table class="diff"><tr><th>Pos.</th><th>Touche</th><th>BLF</th></tr>${ps.map((p) => `<tr><td>${p}</td><td>${describe(D.src[p])}</td><td>${D.src[p].blf ? '●' : ''}</td></tr>`).join('')}</table>
           <p class="muted small">Les touches gardent leur position ; en mode « Ajouter », le bloc vient après les touches existantes de chacun. Les cases vides entre deux touches sont conservées.</p>`
        : '<p class="muted">Aucune touche de fonction dans cette source.</p>');
    } catch (e) { toast(e.message, 6000); }
  }
  updateDeployBtn();
}
function renderDeployUsers() {
  const q = $('dp-search').value.trim().toLowerCase();
  const ul = $('dp-users');
  ul.innerHTML = '';
  for (const u of S.users.filter(listed)) {
    const d = userDevice(u);
    if (q && !`${fullName(u)} ${u.username || ''} ${userExten(u)} ${d?.model || ''}`.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.innerHTML = `<label class="inline"><input type="checkbox" data-uuid="${u.uuid}" ${D.picked.has(u.uuid) ? 'checked' : ''}> ${esc(fullName(u))}</label><span class="sub">${esc(userExten(u))}${d ? ' · ' + esc(d.model || '') : ''}</span>`;
    ul.appendChild(li);
  }
  updateDeployBtn();
}
function updateDeployBtn() {
  $('dp-count').textContent = `${D.picked.size} sélectionné${D.picked.size > 1 ? 's' : ''}`;
  $('dp-go').disabled = !D.src || (!Object.keys(D.src).length && D.srcLines <= 1) || !D.picked.size;
}
// Remplacer : nombre de touches ligne de la source, touches à leurs positions.
// Ajouter : touches ligne de l'utilisateur inchangées, bloc après ses touches.
// Marque sans touches ligne multiples : le nombre de lignes n'est pas modifié,
// les touches gardent leurs positions (les positions de ligne restent vides).
function deployKeysFor(u, current, mode) {
  const own = lineKeysOf(u);
  const multiOk = !!vendorOf(userDevice(u))?.multiLine;
  const lines = mode === 'append' || !multiOk ? own : D.srcLines; // à écrire dans le userfield
  const base = mode === 'append' ? own : D.srcLines;               // les touches commencent après
  const ps = Object.keys(D.src).map(Number).sort((a, b) => a - b);
  const seq = [];
  if (ps.length) for (let p = Math.min(ps[0], D.srcLines + 1); p <= ps[ps.length - 1]; p++) seq.push(D.src[p] || null);
  let selfRemoved = false;
  const existing = new Set(Object.values(current).map(destSig));
  const kept = seq.filter((k) => {
    if (k && k.destination.type === 'user' && k.destination.user_id === u.id) { selfRemoved = true; return false; }
    return !(k && mode === 'append' && existing.has(destSig(k))); // pas de doublon en ajout
  });
  const out = mode === 'append' ? { ...current } : {};
  const start = (mode === 'append' ? Math.max(base, ...Object.keys(current).map(Number)) : base) + 1;
  kept.forEach((k, i) => { if (k) out[start + i] = structuredClone(k); });
  return { keys: out, selfRemoved, lines, linesSkipped: mode !== 'append' && !multiOk && D.srcLines > own };
}
async function previewDeploy() {
  const mode = document.querySelector('input[name="dp-mode"]:checked').value;
  const users = [...D.picked].map((id) => S.byUuid.get(id)).filter(Boolean);
  const btn = $('dp-go');
  btn.disabled = true;
  D.plan = [];
  const rows = [];
  for (const [i, u] of users.entries()) {
    btn.textContent = `Lecture ${i + 1}/${users.length}…`;
    try {
      const data = await api('GET', `/users/${u.uuid}/funckeys`);
      const cur = {};
      let inh = 0;
      for (const [p, k] of Object.entries(data?.keys || {})) if (k.inherited) inh++; else cur[Number(p)] = cleanKey(k);
      const { keys, selfRemoved, lines, linesSkipped } = deployKeysFor(u, cur, mode);
      const keysChanged = JSON.stringify(normMap(keys)) !== JSON.stringify(normMap(cur));
      const linesChanged = lines !== lineKeysOf(u);
      const changed = keysChanged || linesChanged;
      const cap = capOf(u);
      const over = cap ? Object.keys(keys).map(Number).filter((p) => p > cap) : [];
      D.plan.push({ u, keys, lines, keysChanged, linesChanged, changed });
      const notes = [
        linesChanged && `touches ligne ${lineKeysOf(u)} → ${lines}`,
        linesSkipped && `<span class="error">touches ligne multiples non gérées pour cette marque : ${lineKeysOf(u) + 1 === D.srcLines ? `position ${D.srcLines} laissée vide` : `positions ${lineKeysOf(u) + 1}–${D.srcLines} laissées vides`}</span>`,
        selfRemoved && 'sa propre touche retirée', inh && `${inh} héritée(s) inchangée(s)`,
        over.length && `<span class="error">hors capacité : ${over.join(', ')}</span>`,
      ].filter(Boolean);
      rows.push(`<tr><td>${esc(fullName(u))}</td><td>${Object.keys(cur).length}</td><td>${Object.keys(keys).length}</td><td>${changed ? 'oui' : '<span class="muted">identique</span>'}</td><td>${notes.join(' · ')}</td></tr>`);
    } catch (e) { rows.push(`<tr><td>${esc(fullName(u))}</td><td colspan="4" class="error">${esc(e.message)}</td></tr>`); }
  }
  btn.textContent = 'Prévisualiser le déploiement';
  updateDeployBtn();
  const n = D.plan.filter((x) => x.changed).length;
  confirmModal(`<h3>Déploiement : ${n} utilisateur${n > 1 ? 's' : ''} à modifier</h3>
    <p class="muted small">Mode : ${mode === 'append' ? 'ajout à la suite des touches existantes (sans doublon), touches ligne inchangées' : `remplacement de toutes les touches, ${D.srcLines} touche(s) ligne`}. Nombre de touches de fonction avant → après. Les touches ligne au-delà de la 1re sont appliquées sur le poste par le plugin serveur astrea/blf-sync.</p>
    <table class="diff"><tr><th>Utilisateur</th><th>Avant</th><th>Après</th><th>Modifié</th><th>Remarques</th></tr>${rows.join('')}</table>`,
  applyDeploy, `Déployer (${n})`);
}
async function applyDeploy() {
  const todo = D.plan.filter((x) => x.changed);
  let ok = 0, ko = 0;
  for (const [i, x] of todo.entries()) {
    toast(`Déploiement ${i + 1}/${todo.length}…`, 60000);
    try {
      if (x.keysChanged) await api('PUT', `/users/${x.u.uuid}/funckeys`, { keys: x.keys });
      if (x.linesChanged) await setUserLineKeys(x.u, x.lines);
      ok++;
      const dev = userDevice(x.u);
      if ($('dp-resync').checked && dev) { try { await api('GET', `/devices/${dev.id}/synchronize`); } catch { /* resynchro facultative */ } }
    } catch (e) { ko++; console.error(fullName(x.u), e); }
  }
  toast(`Déploiement terminé : ${ok} utilisateur${ok > 1 ? 's' : ''} mis à jour${ko ? `, ${ko} en erreur (détail dans la console)` : ''}.`, 8000);
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
  const side = b.dataset.side;
  shrinkAdvice();
  const go = () => {
    const wasDeploy = !$('deploy').hidden || !!S.cur?.tpl;
    if (S.cur?.tpl) { S.cur = null; S.sel = null; $('editor').hidden = true; $('detail').hidden = true; }
    document.querySelectorAll('[data-side]').forEach((x) => x.classList.toggle('active', x === b));
    $('userlist').hidden = side !== 'users';
    $('labelsPane').hidden = side !== 'labels';
    $('deployPane').hidden = side !== 'deploy';
    $('search').hidden = side !== 'users';
    $('count').hidden = side !== 'users';
    if (side === 'deploy') openDeploy();
    else if (wasDeploy) closeDeploy();
  };
  if (side === 'deploy' || S.cur?.tpl) guardUnsaved(go); else go();
}));
$('dp-new').onclick = () => openTemplate(null);
$('dp-edit').onclick = () => { const v = $('dp-source').value; if (v.startsWith('t:')) openTemplate(v.slice(2)); };
$('tpl-model').innerHTML = Object.keys(YEALINK_LINEKEYS).map((m) => `<option value="${m}">Yealink ${m}</option>`).join('');
$('tpl-model').value = 'T54W';
$('tpl-model').onchange = () => setTemplateModel($('tpl-model').value);
$('tpl-name').oninput = () => { if (S.cur?.tpl) { S.cur.tpl.name = $('tpl-name').value; $('save').disabled = !isDirty(); } };
$('tpl-back').onclick = () => guardUnsaved(() => backToDeploy(S.cur?.tpl?.id ? `t:${S.cur.tpl.id}` : undefined));
$('dp-source').onchange = loadSource;
$('dp-search').oninput = renderDeployUsers;
$('dp-users').onchange = (e) => {
  const cb = e.target.closest('input[data-uuid]');
  if (!cb) return;
  if (cb.checked) D.picked.add(cb.dataset.uuid); else D.picked.delete(cb.dataset.uuid);
  updateDeployBtn();
};
$('dp-all').onclick = () => { $('dp-users').querySelectorAll('input[data-uuid]').forEach((cb) => { cb.checked = true; D.picked.add(cb.dataset.uuid); }); updateDeployBtn(); };
$('dp-none').onclick = () => { $('dp-users').querySelectorAll('input[data-uuid]').forEach((cb) => { cb.checked = false; D.picked.delete(cb.dataset.uuid); }); updateDeployBtn(); };
$('dp-go').onclick = previewDeploy;
$('scanLabels').onclick = scanLabels;
$('lk-minus').onclick = () => changeLineKeys(-1);
$('lk-plus').onclick = () => changeLineKeys(1);
// « Ajouter » = une page / un module de plus que ce qui est affiché
// (affiché = max(nécessaire, 1 + extraPages) pour les pages, max(nécessaire, extraModules) pour les modules).
$('addModule').onclick = () => { S.cur.extraModules = (S.cur.modsShown || 0) + 1; renderEditor(); };
$('addPage').onclick = () => { S.cur.extraPages = S.cur.pageInfo?.shown || 1; renderEditor(); };
// Boutons des en-têtes de page / module (× et sélecteur de page du module).
$('pages').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !S.cur) return;
  if (b.dataset.act === 'remove') removeBlock(b.dataset.kind, Number(b.dataset.n));
  if (b.dataset.act === 'modpage') { S.cur.modPage[Number(b.dataset.m)] = Number(b.dataset.p); renderEditor(); }
});
$('revert').onclick = () => { if (S.cur?.tpl) openTemplate(S.cur.tpl.id); else if (S.cur) selectUser(S.cur.user); };
$('save').onclick = save;
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
wireDetail();
wireDragDrop();
connect();
