// Astrea Admin Tools — socle commun des modules (connexion au portail ou
// autonome, appels confd, thème, notifications, dialogue de confirmation).
// Repris de blf/app.js (validé en réel) ; BLF Manager l'utilisera à terme.
// Chaque page de module contient les éléments #conn, #standalone (sa-*),
// #main, #modal (modal-body / modal-ok / modal-cancel) et #toast.
import { App } from './vendor/euc-plugins-sdk/app.js';

export const sdk = new App();
window.__astreaSdk = sdk; // diagnostic : __astreaSdk.getContext() dans la console
export const S = { base: null, token: null, tenant: null, readonly: null, compatWarns: [] };
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fullName = (u) => [u?.firstname, u?.lastname].map((x) => (x || '').trim()).filter(Boolean).join(' ') || u?.username || '';
export function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }

// ---------------------------------------------------------------------------
// API confd
// ---------------------------------------------------------------------------
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export async function api(method, path, body) {
  // Lecture seule (auto-contrôle en échec) : aucune écriture.
  if (S.readonly && method !== 'GET') throw new ApiError(0, `Lecture seule : ${S.readonly}`);
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
// Lecture sur un autre service Wazo (ex. calldGet('/lines')) : même token et tenant.
export async function calldGet(path) {
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  const r = await fetch(`${S.base}/api/calld/1.0${path}`, { headers });
  if (r.status === 401) { refreshFromPortal(); throw new ApiError(401, 'Session expirée : rechargez la page du portail.'); }
  if (!r.ok) throw new ApiError(r.status, `calld GET ${path} → ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// API provd (options libres des appareils, validé en réel avec BLF Manager)
// ---------------------------------------------------------------------------
const PROVD_TYPE = 'application/vnd.proformatique.provd+json';
export async function provd(method, path, body) {
  if (S.readonly && method !== 'GET') throw new ApiError(0, `Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, Accept: PROVD_TYPE };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  if (body !== undefined) headers['Content-Type'] = PROVD_TYPE;
  const r = await fetch(`${S.base}/api/provd/0.2${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) { refreshFromPortal(); throw new ApiError(401, 'Session expirée : rechargez la page du portail.'); }
  if (!r.ok) {
    let msg = `provd ${method} ${path} → ${r.status}`;
    try { msg += ' ' + (await r.text()).slice(0, 300); } catch { /* */ }
    throw new ApiError(r.status, msg);
  }
  const txt = r.status === 204 ? '' : await r.text();
  return txt ? JSON.parse(txt) : null;
}
// Document provd d'un appareil (id provd = id du device confd).
export async function provdDevice(id) {
  const d = (await provd('GET', `/dev_mgr/devices/${id}`))?.device;
  if (!d) throw new Error(`appareil ${id} introuvable dans provd`);
  return d;
}
// Modifie les options provd d'un appareil (relues juste avant), puis régénère
// son fichier. `mutate(options)` modifie l'objet ; rien n'est écrit s'il est
// inchangé. Renvoie true si quelque chose a été écrit.
export async function updateProvdOptions(id, mutate) {
  const d = await provdDevice(id);
  const before = JSON.stringify(d.options || {});
  const options = JSON.parse(before);
  mutate(options);
  if (JSON.stringify(options) === before) return false;
  d.options = options;
  await provd('PUT', `/dev_mgr/devices/${id}`, { device: d });
  await provd('POST', '/dev_mgr/reconfigure', { id });
  return true;
}
// Télécharge un fichier JSON (sauvegarde avant écriture en masse).
export function downloadJson(name, data) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { console.warn('téléchargement', e); }
}
// RÈGLE DE BASE (skill wazo-plugins) : seulement le tenant courant. recurse=true
// ramène aussi les sous-tenants : sans filtre, l'appli proposerait des objets
// d'autres clients. confd refuse le plus souvent une référence hors tenant
// (400 ; vérifié pour les touches de fonction, sauf filtrage patron-secrétaire),
// mais pas toutes les écritures n'ont été vérifiées : on ne propose que le
// tenant courant. Objet sans tenant_uuid (sons…) : gardé. Tenant inconnu
// (S.tenant vide) : pas de filtre.
// Lecture de tous les tenants : listAll(path, { allTenants: true }), à justifier.
export const tenantOnly = (items, t = S.tenant) => (items || []).filter((o) => !t || !o?.tenant_uuid || o.tenant_uuid === t);
export const listAll = async (path, { allTenants = false } = {}) => {
  const items = (await api('GET', `${path}${path.includes('?') ? '&' : '?'}recurse=true&limit=10000`))?.items || [];
  return allTenants ? items : tenantOnly(items);
};

// ---------------------------------------------------------------------------
// Lecture seule / bandeau de compatibilité (élément #compat)
// ---------------------------------------------------------------------------
export function canWrite() {
  if (!S.readonly) return true;
  toast(`Lecture seule : ${S.readonly}. Rien n'a été modifié.`, 8000);
  return false;
}
export function setReadonly(reason) {
  if (S.readonly) return;
  S.readonly = reason;
  document.body.classList.add('readonly');
  showCompat();
}
export function showCompat() {
  const box = $('compat');
  if (!box) return;
  const parts = [];
  if (S.readonly) parts.push(`<strong>Lecture seule : incompatibilité détectée.</strong> ${esc(S.readonly)}. Aucune modification ne sera écrite. Prévenez le support Astrea avec ce message et la console du navigateur.`);
  for (const w of S.compatWarns || []) parts.push(esc(w));
  box.innerHTML = parts.map((p) => `<div>${p}</div>`).join('');
  box.classList.toggle('blocking', !!S.readonly);
  box.hidden = !parts.length;
}
export function stackVersion() { try { return sdk.getContext()?.app?.extra?.stack?.version || null; } catch { return null; } }

// ---------------------------------------------------------------------------
// Dialogue de confirmation (le contenu peut porter des champs : les lire
// dans onOk, le DOM reste en place après fermeture).
// ---------------------------------------------------------------------------
export function confirmModal(html, onOk, okText = 'Confirmer') {
  $('modal-body').innerHTML = html;
  $('modal-ok').textContent = okText;
  $('modal').hidden = false;
  $('modal-cancel').onclick = () => ($('modal').hidden = true);
  $('modal-ok').disabled = false;
  $('modal-ok').onclick = async () => {
    $('modal-ok').disabled = true; // pas de double envoi pendant les écritures
    try { if ((await onOk()) === false) return; $('modal').hidden = true; } finally { $('modal-ok').disabled = false; }
  };
}

// ---------------------------------------------------------------------------
// Thème du portail (palette MUI) : clair sauf si le portail dit « dark »
// ---------------------------------------------------------------------------
export function applyTheme(theme) {
  const root = document.documentElement;
  const pal = (theme && typeof theme === 'object' && (theme.palette || theme)) || {};
  root.dataset.theme = (pal.mode || pal.type) === 'dark' ? 'dark' : 'light';
  if (!theme || typeof theme !== 'object') return;
  const set = (v, x) => { if (typeof x === 'string' && x) root.style.setProperty(v, x); };
  set('--accent', pal.primary?.main); set('--accent-ink', pal.primary?.contrastText);
  set('--bg', pal.background?.default); set('--panel', pal.background?.paper);
  set('--ink', pal.text?.primary); set('--muted', pal.text?.secondary); set('--line', pal.divider);
  set('--danger', pal.error?.main); set('--warn', pal.warning?.main); set('--ok', pal.success?.main);
  set('--accent-dark', pal.primary?.dark); set('--accent-light', pal.primary?.light);
  const r = theme.shape?.borderRadius;
  if (typeof r === 'number') root.style.setProperty('--radius', `${r}px`); else set('--radius', r);
}

// ---------------------------------------------------------------------------
// Connexion : portail (token de la stack ouverte) ou autonome (tests)
// ---------------------------------------------------------------------------
function stackFromContext() {
  const st = sdk.getContext()?.app?.extra?.stack || {};
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
export function refreshFromPortal() { try { applyStack(stackFromContext()); } catch { /* hors portail */ } }

// `boot` est appelé à chaque connexion (et changement de tenant / stack).
export async function connect(boot) {
  if (window.parent !== window) {
    try {
      await Promise.race([sdk.initialize(), new Promise((_, ko) => setTimeout(() => ko(new Error('pas de réponse du portail')), 15000))]);
      document.body.classList.add('in-portal');
      try { applyTheme(sdk.getContext()?.app?.theme); } catch (e) { console.warn('thème', e); }
      sdk.onSwitchTenant = (uuid) => { S.tenant = uuid; boot(); };
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
      if (applyStack(stackFromContext())) return boot();
      $('conn').textContent = 'Aucun serveur sélectionné dans le portail.';
      document.body.classList.add('idle');
      return;
    } catch (e) { console.warn('SDK', e); }
  }
  showStandalone(boot);
}
function showStandalone(boot) {
  $('conn').textContent = 'Hors portail';
  document.documentElement.classList.remove('framed');
  $('standalone').hidden = false;
  $('sa-go').onclick = async () => {
    $('sa-err').textContent = '';
    let host = $('sa-host').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(host)) host = `https://${host}`;
    S.base = host;
    try {
      if ($('sa-token').value.trim()) S.token = $('sa-token').value.trim();
      else {
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
// Fin de chargement réussie / en erreur (pilote l'indicateur de chargement).
export function loaded() { document.body.classList.add('ready'); $('main').hidden = false; }
export function loadFailed(e) {
  $('conn').textContent = `Erreur de chargement : ${e.message}`;
  document.body.classList.add('idle');
  toast(e.message, 8000);
  console.error(e);
}

// ---------------------------------------------------------------------------
// Aide contextuelle (norme Astrea, skill wazo-plugins) : bouton rond « ? » à
// côté du titre, qui déplie un encadré .helpbox ; le même texte sert
// d'infobulle (title) sur les listes, colonnes et cases. Ouverture par
// délégation sur [data-help-toggle] (BLF Manager garde son propre bouton).
// ---------------------------------------------------------------------------
export const helpButton = (boxId, title = 'Aide') => `<button type="button" class="helpbtn" data-help-toggle="${boxId}" aria-expanded="false" aria-controls="${boxId}" title="${esc(title)}">?</button>`;
export const helpBox = (boxId, text) => `<p id="${boxId}" class="helpbox small" hidden>${esc(text)}</p>`;
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-help-toggle]');
  const h = b && document.getElementById(b.dataset.helpToggle);
  if (!h) return;
  h.hidden = !h.hidden;
  b.setAttribute('aria-expanded', String(!h.hidden));
});