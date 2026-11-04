// Migration Assistant — import 3CX : annuaire de la société (demande de Brice,
// 04/11/2026). Sans DOM, sauf l'appel à wazo-dird.
//
// Lu dans wazo-dird (master, 04/11/2026) :
//  - carnet : POST /phonebooks {name, description} ; contacts libres (clé →
//    valeur) : POST /phonebooks/{uuid}/contacts, un par contact ;
//  - source de type carnet : POST /backends/phonebook/sources {name,
//    phonebook_uuid, searched_columns, first_matched_columns, format_columns}
//    (BaseSourceSchema) ; sans source, le carnet n'est consulté par personne ;
//  - profil : GET / PUT /profiles/{uuid} {name, display, services: {service:
//    {sources: [{uuid}], options}}} : la source est ajoutée aux services du
//    profil du site (lookup, reverse, favorites, ceux qui existent).
// Supposé : profil du site nommé « default » ; colonnes de la source reprises
// d'une source carnet existante du site, sinon valeurs par défaut ci-dessous ;
// CORS et droits du token du Portal sur dird.
import { S, ApiError } from '../common/core.js?v=0.40.39';

export const CONTACT_FIELDS = [['first', 'firstname', 'Prénom'], ['last', 'lastname', 'Nom'], ['company', 'company', 'Société'], ['number', 'number', 'Numéro'], ['mobile', 'mobile', 'Mobile'], ['email', 'email', 'E-mail']];
export const DEFAULT_COLUMNS = {
  searched_columns: ['firstname', 'lastname', 'company', 'number', 'mobile'],
  first_matched_columns: ['number', 'mobile'],
  format_columns: { name: '{firstname} {lastname}', phone: '{number}', phone_mobile: '{mobile}', email: '{email}', reverse: '{firstname} {lastname}' },
};
export function ensurePhonebook(d, m) {
  if (d.phonebook) return d;
  d.phonebook = { name: '', contacts: (m.phonebook || []).map(({ others, ...p }) => ({ ...p, import: !!(p.first || p.last || p.company) && !!(p.number || p.mobile || p.email) })) };
  return d;
}
export const phonebookName = (d) => d.phonebook?.name || `${d.write?.clientId || '<ID>'} - Annuaire`;
export const toWazoContact = (c) => Object.fromEntries(CONTACT_FIELDS.map(([k, w]) => [w, String(c[k] || '').trim()]).filter(([, v]) => v));
export function phonebookIssues(d) {
  const out = []; const list = (d.phonebook?.contacts || []).filter((c) => c.import);
  for (const [i, c] of list.entries()) {
    const who = [c.first, c.last].filter(Boolean).join(' ') || c.company || `contact ${i + 1}`;
    if (!c.first && !c.last && !c.company) out.push({ sev: 'warn', text: `${who} : ni nom ni société.` });
    if (!c.number && !c.mobile && !c.email) out.push({ sev: 'warn', text: `${who} : aucun numéro ni e-mail.` });
    for (const k of ['number', 'mobile']) if (c[k] && !/^\+?\d{2,}$/.test(c[k])) out.push({ sev: 'warn', text: `${who} : ${k === 'number' ? 'numéro' : 'mobile'} « ${c[k]} » inhabituel.` });
  }
  return out;
}
// Appel à wazo-dird (même en-têtes que confd ; CORS supposé).
export async function dird(method, path, body) {
  if (S.readonly && method !== 'GET') throw new ApiError(0, `Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${S.base}/api/dird/0.1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) { let msg = `dird ${method} ${path} → ${r.status}`; try { msg += ` ${JSON.stringify(await r.json()).slice(0, 300)}`; } catch { /* */ } throw new ApiError(r.status, msg); }
  return r.status === 204 ? null : r.json();
}
