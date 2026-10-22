// Migration Assistant — export JSON du tenant (format « astrea-migration », v1).
// Il servira de source à la restauration (lot 3) et de sauvegarde avant la
// bascule multisite (lot 2). Les objets sont gardés tels que confd les renvoie,
// sans transformation : la restauration fera la correspondance des ids et des
// noms de contextes.
import { S, stackVersion } from '../common/core.js?v=0.40.25';
import { I, SOURCES } from './inventory.js?v=0.40.25';

export const FORMAT = 'astrea-migration';
export const FORMAT_VERSION = 1;
const APP_VERSION = new URL(import.meta.url).searchParams.get('v') || 'dev';

// Champs secrets (lus dans les schémas confd) : user.password,
// user.call_permission_password, voicemail.password, callpermission.password,
// conference.pin / admin_pin, agent.passwd ; et dans les listes d'options
// [clé, valeur] des comptes SIP (auth_section_options : password).
const SECRET_KEYS = new Set(['password', 'call_permission_password', 'pin', 'admin_pin', 'passwd', 'secret']);
const SECRET_OPTS = new Set(['password', 'secret', 'md5_cred']);
export const MASK = '***';
export function redact(v) {
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === 'string' && SECRET_OPTS.has(v[0]) && typeof v[1] === 'string') return [v[0], v[1] ? MASK : v[1]];
    return v.map(redact);
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEYS.has(k) && typeof x === 'string' && x ? MASK : redact(x);
    return o;
  }
  return v;
}

export function buildExport({ secrets = false, report = null } = {}) {
  const data = {};
  for (const [key] of SOURCES) data[key] = I.lists[key] || [];
  data.user_funckeys = I.funckeys;
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v || {}).length]));
  const doc = {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    generator: `Astrea Admin Tools ${APP_VERSION} (Migration Assistant)`,
    exported_at: new Date().toISOString(),
    source: { host: S.base ? new URL(S.base).host : null, stack_version: stackVersion(), tenant_uuid: I.tenant || null },
    secrets: secrets ? 'included' : 'masked',
    counts,
    warnings: I.warns,
    data: secrets ? data : redact(data),
  };
  if (report) doc.report = report;
  return doc;
}
export function exportFileName() {
  const host = S.base ? new URL(S.base).hostname.split('.')[0] : 'wazo'; // hostname : pas de « :port » (interdit dans un nom de fichier Windows)
  const t = (I.tenant || 'tenant').slice(0, 8);
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `astrea-export-${host}-${t}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}
