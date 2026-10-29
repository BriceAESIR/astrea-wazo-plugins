// Astrea Desk — accès au Portal Wazo puis à la stack du site, comme le fait
// le Portal lui-même. API non documentée : relevée le 29/10/2026 dans le
// navigateur (compte de Brice et compte d'admin de site de test) et dans le
// code du Portal (chunk async 302, fonctions getInstanceCredentials,
// decorateGetOne des sites et des instances, connexion à la stack). Détail et
// statut vérifié / supposé : docs/ASTREA-DESK.md.
//
// Aucun secret (mot de passe, token, identifiants de stack) n'est écrit dans
// la console, dans le stockage du navigateur ou dans le diagnostic.

export const PORTAL = 'https://portal.wazo.io';

export class PortalError extends Error {
  constructor(step, status, msg) { super(msg); this.step = step; this.status = status; }
}

// Session en mémoire uniquement.
export const P = {
  token: null, expiresAt: null, userUuid: null, tenant: null, email: null,
  visualization: null, scopes: {}, locations: [],
};
export const ST = { site: null, host: null, port: null, base: null, tenant: null, token: null, expiresAt: null, version: null, _cred: null };

const json = async (r) => { const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch { return null; } };
const unwrap = (j) => (j && typeof j === 'object' && j.data && !Array.isArray(j.data) ? j.data : j);

async function portal(method, path, { tenant, body, step } = {}) {
  const headers = { Accept: 'application/json', 'X-Auth-Token': P.token };
  if (tenant) headers['Wazo-Tenant'] = tenant;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${PORTAL}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) throw new PortalError(step, 401, 'Session Portal expirée : reconnectez-vous.');
  if (!r.ok) throw new PortalError(step, r.status, `Portal ${method} ${path.replace(/[0-9a-f-]{36}/g, '<uuid>')} → ${r.status}`);
  return r.status === 204 ? null : json(r);
}

// Connexion au Portal (vérifié : POST /api/auth/0.1/token, en-tête Basic).
// Corps : 42 octets côté Portal, champs exacts non relevés ; on envoie ceux
// de wazo-auth (supposé : le Portal accepte backend et expiration).
export async function portalLogin(email, password) {
  const r = await fetch(`${PORTAL}/api/auth/0.1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(`${email}:${password}`))) },
    body: JSON.stringify({ backend: 'wazo_user', expiration: 3600 }),
  });
  if (r.status === 401 || r.status === 403) throw new PortalError('login', r.status, 'Identifiant ou mot de passe incorrect.');
  if (!r.ok) throw new PortalError('login', r.status, `Connexion au Portal refusée (${r.status}).`);
  const d = unwrap(await json(r)) || {};
  if (!d.token) throw new PortalError('login', r.status, 'Réponse du Portal inattendue (pas de token).');
  P.token = d.token;
  P.expiresAt = d.utc_expires_at || d.expires_at || null;
  P.userUuid = d.metadata?.uuid || d.auth_id || null;
  P.tenant = d.metadata?.tenant_uuid || null;
  P.email = email;
  return d;
}

// Droits du Portal (vérifié : scopes/check, corps {scopes: [...]}). Réponse
// supposée au format wazo-auth : {scopes: {acl: bool}}.
export async function checkScopes(scopes) {
  const j = await portal('POST', `/auth/0.1/token/${P.token}/scopes/check`, { body: { scopes }, step: 'scopes' });
  const res = j?.scopes && typeof j.scopes === 'object' && !Array.isArray(j.scopes) ? j.scopes : {};
  P.scopes = Object.fromEntries(scopes.map((s) => [s, res[s] === true]));
  return P.scopes;
}

// Menus de stack autorisés (vérifié : champ visualization de la fiche Portal
// de l'administrateur = cases « Menu de Stack », case par case).
// Absent : compte sans restriction (supposé, comptes revendeur) → null.
export async function loadVisualization() {
  const u = unwrap(await portal('GET', `/confd/1.0/users/${P.userUuid}`, { tenant: P.tenant, step: 'visualization' }));
  P.visualization = Array.isArray(u?.visualization) ? u.visualization.filter((x) => typeof x === 'string') : null;
  return P.visualization;
}

// Sites (lu dans le code : un site a wazo_tenants[0] = {instance_uuid,
// credential_uuid}). Les sites sans stack sont écartés.
export async function loadLocations() {
  const j = await portal('GET', '/confd/1.0/locations?limit=1000', { tenant: P.tenant, step: 'locations' });
  const items = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
  P.locations = items.filter((l) => l?.uuid && l.wazo_tenants?.[0]?.instance_uuid && l.wazo_tenants[0].credential_uuid)
    .map((l) => ({ uuid: l.uuid, name: l.name || l.uuid, customer: l.customer_name || l.customer?.name || '', wt: l.wazo_tenants[0] }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return P.locations;
}

// Adresse de la stack (lu dans le code : decorateGetOne des instances).
export function instanceAddress(inst) {
  const priv = inst?.preferred_connection === 'private';
  return { host: priv ? inst?.private_host : inst?.public_host, port: priv ? inst?.private_port : inst?.public_port };
}

// Accès à la stack d'un site (lu dans le code : getInstanceCredentials, en-tête
// Wazo-Tenant = uuid du site, puis connexion wazo_user à la stack).
export async function openSite(loc) {
  const cred = unwrap(await portal('GET', `/deployd/0.1/instances/${loc.wt.instance_uuid}/credentials/${loc.wt.credential_uuid}`, { tenant: loc.uuid, step: 'credentials' }));
  const { host, port } = instanceAddress(cred?.instance);
  if (!cred?.username || !cred?.password || !host) throw new PortalError('credentials', 0, 'Accès à la stack incomplet dans la réponse du Portal.');
  ST._cred = { username: cred.username, password: cred.password };
  ST.site = loc;
  ST.host = host;
  ST.port = port;
  ST.base = `https://${host}${port && Number(port) !== 443 ? `:${port}` : ''}`;
  ST.tenant = cred.instance_tenant_uuid || null;
  await stackLogin();
  try {
    const r = await fetch(`${ST.base}/api/confd/1.1/infos`, { headers: { 'X-Auth-Token': ST.token, Accept: 'application/json' } });
    ST.version = r.ok ? (await r.json())?.wazo_version || null : null;
  } catch { ST.version = null; }
  return ST;
}

// Connexion à la stack (lu dans le code : backend wazo_user ; le Portal
// demande 180 s et se reconnecte, on demande 1 h et on renouvelle avant).
export async function stackLogin() {
  if (!ST._cred) throw new PortalError('stack', 0, 'Aucun site ouvert.');
  const r = await fetch(`${ST.base}/api/auth/0.1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(`${ST._cred.username}:${ST._cred.password}`))) },
    body: JSON.stringify({ backend: 'wazo_user', expiration: 3600 }),
  });
  if (!r.ok) throw new PortalError('stack', r.status, `Connexion à la stack refusée (${r.status}).`);
  const d = unwrap(await json(r)) || {};
  if (!d.token) throw new PortalError('stack', r.status, 'Réponse de la stack inattendue (pas de token).');
  ST.token = d.token;
  ST.expiresAt = d.utc_expires_at || d.expires_at || null;
  ST.acl = Array.isArray(d.acl) ? d.acl.length : null;
  return ST;
}

// Déconnexion : révoque les tokens (best effort) et oublie tout.
export async function logout() {
  const del = (base, t) => t && fetch(`${base}/api/auth/0.1/token/${t}`, { method: 'DELETE', headers: { 'X-Auth-Token': t } }).catch(() => {});
  await Promise.all([del(ST.base, ST.token), del(PORTAL, P.token)]);
  closeSite();
  Object.assign(P, { token: null, expiresAt: null, userUuid: null, tenant: null, email: null, visualization: null, scopes: {}, locations: [] });
}
export function closeSite() {
  Object.assign(ST, { site: null, host: null, port: null, base: null, tenant: null, token: null, expiresAt: null, version: null, acl: null, _cred: null });
}
