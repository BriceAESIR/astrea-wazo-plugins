// Migration Assistant — import 3CX : annuaire de la société et contacts
// personnels (demandes de Brice, 04/11/2026). Sans DOM, sauf l'appel à wazo-dird.
//
// 3CX (lu dans deux sauvegardes v20, comparé à la fiche contact de 3CX) : chaque
// contact a FirstName, LastName, CompanyName, PhoneNumber, puis des champs
// numérotés AddressNumberOrData0…N. Vérifié sur une fiche : n° 3 = « Société »
// (numéro du bureau), n° 5 = e-mail. Supposé, même ordre que la fiche : 0 mobile,
// 1 mobile 2, 2 domicile, 4 société 2, 6 autre, 7 fax société, 8 fax domicile,
// 9 bip. PhoneNumber : numéro principal (supposé). Titre, Département : balises
// jamais vues ; toute balise rencontrée est proposée dans la correspondance.
// Contacts personnels : DN > Extension > PhoneBookEntries.
//
// Wazo (wazo-dird, lu le 04/11/2026) : contacts libres (clé → valeur).
//  - carnet de la société : POST /phonebooks, POST /phonebooks/{uuid}/contacts,
//    source POST /backends/phonebook/sources (searched_columns,
//    first_matched_columns, format_columns), ajout au profil GET / PUT /profiles ;
//  - contacts personnels : /personal et POST /personal/import (CSV utf-8, « , »,
//    guillemets, CRLF) agissent sur l'utilisateur du jeton, sans paramètre
//    d'utilisateur : impossible avec le jeton de l'admin. D'où l'export CSV par
//    poste, à importer par l'utilisateur (ou un plugin d'appli Wazo avec son jeton).
// Supposé : profil du site nommé « default » ; colonnes affichées par les postes.
import { S, ApiError } from '../common/core.js?v=0.40.56';

// Champs Wazo proposés (clés des contacts dird).
export const WAZO_FIELDS = {
  firstname: 'Prénom', lastname: 'Nom', company: 'Société', title: 'Titre', department: 'Département',
  number: 'Numéro principal', mobile: 'Mobile', mobile2: 'Mobile 2', home: 'Domicile', business: 'Bureau', business2: 'Bureau 2',
  fax: 'Fax bureau', homefax: 'Fax domicile', other: 'Autre numéro', pager: 'Bip', email: 'E-mail',
};
// Balise 3CX → [libellé 3CX, champ Wazo par défaut, vérifié ?]
const KNOWN = {
  FirstName: ['Prénom', 'firstname', true], LastName: ['Nom', 'lastname', true], CompanyName: ['Société', 'company', true],
  Title: ['Titre', 'title', false], Department: ['Département', 'department', false], PhoneNumber: ['Numéro (PhoneNumber)', 'number', false],
  AddressNumberOrData0: ['Mobile', 'mobile', false], AddressNumberOrData1: ['Mobile 2', 'mobile2', false], AddressNumberOrData2: ['Domicile', 'home', false],
  AddressNumberOrData3: ['Société (n° bureau)', 'business', true], AddressNumberOrData4: ['Société 2', 'business2', false], AddressNumberOrData5: ['E-mail', 'email', true],
  AddressNumberOrData6: ['Autre', 'other', false], AddressNumberOrData7: ['Fax société', 'fax', false], AddressNumberOrData8: ['Fax domicile', 'homefax', false], AddressNumberOrData9: ['Bip', 'pager', false],
};
export const tagLabel = (tag) => KNOWN[tag]?.[0] || tag;
export const tagChecked = (tag) => !!KNOWN[tag]?.[2];
const NUMERIC = new Set(['number', 'mobile', 'mobile2', 'home', 'business', 'business2', 'fax', 'homefax', 'other', 'pager']);
const num = (s) => String(s || '').replace(/[\s.()-]/g, '');

// Balises présentes dans la sauvegarde (société + personnels), dans l'ordre de KNOWN puis les autres.
export function tagsOf(m) {
  const seen = new Set(); for (const c of [...(m.phonebook || []), ...(m.personal || [])]) for (const k of Object.keys(c.raw || {})) seen.add(k);
  return [...Object.keys(KNOWN).filter((k) => seen.has(k)), ...[...seen].filter((k) => !KNOWN[k]).sort()];
}
export function ensurePhonebook(d, m) {
  // Brouillon d'avant la reprise complète (champs first/last/… sans raw) : refait depuis la sauvegarde.
  if (d.phonebook && d.phonebook.version === 2) return d;
  const map = {}; for (const t of tagsOf(m)) map[t] = KNOWN[t]?.[1] || '';
  const mk = (c) => ({ owner: c.owner, raw: { ...c.raw }, import: true });
  d.phonebook = { version: 2, name: d.phonebook?.name || '', map, includePersonal: false, contacts: (m.phonebook || []).map(mk), personal: (m.personal || []).map(mk) };
  for (const c of [...d.phonebook.contacts, ...d.phonebook.personal]) c.import = hasData(d, c);
  return d;
}
const hasData = (d, c) => { const w = toWazoContact(d, c); return !!(w.firstname || w.lastname || w.company) && !!(w.number || w.mobile || w.email || w.business || w.home); };
export const phonebookName = (d) => d.phonebook?.name || `${d.write?.clientId || '<ID>'} - Annuaire`;
// Contact Wazo d'après la correspondance ; numéro principal à défaut : bureau, domicile, mobile.
export function toWazoContact(d, c) {
  const out = {};
  // Rien n'est perdu (demande de Brice, 04/11/2026) : deux champs 3CX vers le même champ Wazo →
  // le second va dans « champ_2 », « champ_3 »…
  for (const [tag, v] of Object.entries(c.raw || {})) {
    // Balise absente de la correspondance (contact ajouté ou modifié) : champ connu, sinon son nom 3CX.
    const k = tag in d.phonebook.map ? d.phonebook.map[tag] : (KNOWN[tag]?.[1] || tag); if (!k || !v) continue;
    const val = NUMERIC.has(k) ? num(v) : v.trim(); if (!val) continue;
    let key = k; for (let n = 2; out[key] && out[key] !== val; n++) key = `${k}_${n}`;
    out[key] = val;
  }
  // Source « personal » créée par Wazo pour chaque tenant (wazo-dird config_service, lu le
  // 04/11/2026) : recherche sur firstname, lastname, number, mobile, fax ; affichage {number},
  // {mobile} ; identification de l'appelant sur number et mobile. Les champs cherchés vides sont
  // remplis à partir des autres numéros (copie : l'original reste enregistré sous son nom).
  if (!out.number) out.number = out.business || out.home || out.business2 || out.other || '';
  if (!out.mobile) out.mobile = out.mobile2 || '';
  if (!out.fax) out.fax = out.homefax || '';
  for (const k of ['number', 'mobile', 'fax']) if (!out[k]) delete out[k];
  return out;
}
// Colonnes d'une source d'annuaire : celles de la source modèle du site, plus tous les champs
// numéros du carnet, pour que chacun soit cherché et identifié à l'appel.
export function sourceColumns(model) {
  const all = Object.keys(WAZO_FIELDS).filter((k) => NUMERIC.has(k));
  const uniq = (l) => [...new Set(l)];
  return {
    searched_columns: uniq([...(model?.searched_columns || []), ...DEFAULT_COLUMNS.searched_columns, ...all]),
    first_matched_columns: uniq([...(model?.first_matched_columns || []), ...all.filter((k) => !['fax', 'homefax', 'pager'].includes(k))]),
    format_columns: { ...DEFAULT_COLUMNS.format_columns, ...(model?.format_columns || {}) },
  };
}
// Contacts écrits dans le carnet de la société (et personnels si l'option est cochée), sans doublon.
export function companyContacts(d) {
  const pb = d.phonebook; const list = [...pb.contacts, ...(pb.includePersonal ? pb.personal : [])].filter((c) => c.import);
  const seen = new Set(); const out = [];
  for (const c of list) { const w = toWazoContact(d, c); const k = JSON.stringify(w); if (!Object.keys(w).length || seen.has(k)) continue; seen.add(k); out.push(w); }
  return out;
}
export function phonebookIssues(d) {
  const out = [];
  for (const c of companyContacts(d)) {
    const who = [c.firstname, c.lastname].filter(Boolean).join(' ') || c.company || 'contact';
    if (!c.firstname && !c.lastname && !c.company) out.push({ sev: 'warn', text: `${who} : ni nom ni société.` });
    for (const k of Object.keys(c).filter((x) => NUMERIC.has(x))) if (!/^\+?\d{2,}$/.test(c[k])) out.push({ sev: 'warn', text: `${who} : ${WAZO_FIELDS[k]} « ${c[k]} » inhabituel.` });
  }
  const by = {}; for (const [t, k] of Object.entries(d.phonebook.map)) if (k) (by[k] ||= []).push(t);
  for (const [k, tags] of Object.entries(by)) if (tags.length > 1) out.push({ sev: 'warn', text: `${WAZO_FIELDS[k]} reçoit plusieurs champs 3CX (${tags.map(tagLabel).join(', ')}) : les suivants vont dans « ${k}_2 », « ${k}_3 » (rien n'est perdu, mais seuls les champs Wazo habituels sont cherchés).` });
  return out;
}
// Colonnes d'un CSV : champs Wazo connus dans l'ordre, puis les autres (« mobile_2 »…).
// Colonnes du propriétaire (demande de Brice, 04/11/2026) : ID client du brouillon, poste,
// prénom et nom de l'utilisateur à qui appartiennent les contacts. wazo-dird garde toute
// colonne comme champ du contact (contacts libres) : elles restent visibles dans Wazo.
export const OWNER_KEYS = ['id_client', 'proprietaire_poste', 'proprietaire_prenom', 'proprietaire_nom'];
const ownerCols = (d, owner) => {
  const u = (d.users || []).find((x) => x.n === owner);
  return { id_client: d.write?.clientId || '', proprietaire_poste: owner || '', proprietaire_prenom: u?.first || '', proprietaire_nom: u?.last || '' };
};
export const csvKeys = (rows) => { const seen = new Set(rows.flatMap((r) => Object.keys(r))); return [...OWNER_KEYS.filter((k) => seen.has(k)), ...Object.keys(WAZO_FIELDS).filter((k) => seen.has(k)), ...[...seen].filter((k) => !WAZO_FIELDS[k] && !OWNER_KEYS.includes(k)).sort()]; };
// CSV au format de POST /personal/import de wazo-dird : en-tête = clés, « , », guillemets, CRLF.
// owner null : tous les postes (fichier de contrôle, avec BOM pour Excel).
export function personalCsv(d, owner = null, { bom = false } = {}) {
  const rows = d.phonebook.personal.filter((c) => c.import && (owner == null || c.owner === owner)).map((c) => [c, toWazoContact(d, c)]).filter(([, w]) => Object.keys(w).length).map(([c, w]) => ({ ...ownerCols(d, c.owner), ...w }));
  const keys = csvKeys(rows);
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  return (bom ? '﻿' : '') + [keys.join(','), ...rows.map((r) => keys.map((k) => q(r[k])).join(','))].join('\r\n');
}
export const DEFAULT_COLUMNS = {
  searched_columns: ['firstname', 'lastname', 'company', 'number', 'mobile', 'business', 'home'],
  first_matched_columns: ['number', 'mobile', 'mobile2', 'business', 'business2', 'home'],
  format_columns: { name: '{firstname} {lastname}', phone: '{number}', phone_mobile: '{mobile}', email: '{email}', reverse: '{firstname} {lastname}' },
};
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
