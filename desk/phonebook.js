// Astrea Desk — annuaire du site (0.7.0), page Portal pbx.phonebooks (Services).
// wazo-dird, plugin phonebook, lu dans le code master le 02/11/2026 :
//  - GET|POST /api/dird/0.1/phonebooks (tenant = Wazo-Tenant, recurse=false par
//    défaut), GET|PUT|DELETE /phonebooks/{uuid} ;
//  - contacts : GET|POST /phonebooks/{uuid}/contacts ({items, total}),
//    GET|PUT|DELETE /phonebooks/{uuid}/contacts/{id} ; un contact est un
//    dictionnaire libre (firstname, lastname, number, mobile, email…), « id » =
//    son uuid ;
//  - import : POST /phonebooks/{uuid}/contacts/import, corps CSV (en-tête =
//    noms des champs), charset dans le Content-Type → {created, failed}.
import { S, $, esc, toast, confirmModal, canWrite } from '../admin-tools/common/core.js?v=0.9.2';
import { download, csv } from './report.js?v=0.9.2';

const FIELDS = [['firstname', 'Prénom'], ['lastname', 'Nom'], ['company', 'Société'], ['number', 'Numéro'], ['mobile', 'Mobile'], ['email', 'E-mail']];
const LABEL = Object.fromEntries(FIELDS);
// Obligatoires comme dans le Portal (formulaire « Prénom * », « Numéro primaire * »,
// vu par Brice le 03/11/2026 ; clés firstname / number : contact créé dans le
// Portal et relu par Desk).
const REQUIRED = new Set(['firstname', 'number']);
// Clés techniques jamais affichées ni modifiables : id (uuid du contact, dird),
// phonebook_uuid (ajoutée par le Portal à ses contacts, vu le 03/11/2026).
const HIDDEN = new Set(['id', 'phonebook_uuid', 'tenant_uuid']);
const P = { books: [], cur: null, contacts: [], q: '' };

async function dird(method, path, body, type = 'application/json') {
  if (S.readonly && method !== 'GET') throw new Error(`Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, 'Wazo-Tenant': S.tenant, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = type;
  const r = await fetch(`${S.base}/api/dird/0.1${path}`, { method, headers, body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body });
  // Client final : phrase simple à l'écran, réponse brute en console.
  if (!r.ok) {
    let m = ''; try { const j = await r.json(); m = j?.message || j?.reason?.join?.(' ') || ''; } catch { /* */ }
    console.warn('[astrea] annuaire', method, path, r.status, m);
    throw new Error(r.status === 400 ? 'données refusées par le serveur' : r.status === 403 ? "votre compte n'a pas le droit de faire cette action" : r.status === 404 ? 'introuvable, actualisez la page' : r.status === 409 ? 'ce nom existe déjà' : 'serveur indisponible pour le moment');
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}
const mine = (x) => !x?.tenant_uuid || x.tenant_uuid === S.tenant;
const name = (c) => [c.firstname, c.lastname].filter(Boolean).join(' ') || c.company || c.name || '(sans nom)';

export async function renderPhonebooks(view, site) {
  view.innerHTML = '<p class="dk-empty">Lecture…</p>';
  const loadBooks = async () => { P.books = ((await dird('GET', '/phonebooks?limit=1000'))?.items || []).filter(mine); if (!P.books.some((b) => b.uuid === P.cur)) P.cur = P.books[0]?.uuid || null; };
  const loadContacts = async () => { P.contacts = P.cur ? ((await dird('GET', `/phonebooks/${P.cur}/contacts?limit=100000`))?.items || []) : []; };
  try { await loadBooks(); await loadContacts(); } catch (e) { view.innerHTML = `<p class="error">Annuaire indisponible : ${esc(e.message)}.</p>`; return; }
  const ro = !!S.readonly;
  // Colonnes : champs habituels présents, puis les autres champs trouvés.
  const cols = () => { const keys = new Set(P.contacts.flatMap((c) => Object.keys(c))); for (const k of HIDDEN) keys.delete(k); return [...FIELDS.map(([k]) => k).filter((k) => keys.has(k)), ...[...keys].filter((k) => !LABEL[k]).sort()]; };
  const draw = () => {
    const book = P.books.find((b) => b.uuid === P.cur);
    const q = P.q.trim().toLowerCase();
    const rows = (q ? P.contacts.filter((c) => Object.values(c).join(' ').toLowerCase().includes(q)) : P.contacts).sort((a, b) => name(a).localeCompare(name(b), 'fr'));
    const cs = cols();
    view.innerHTML = `<div class="phonehead"><div><h2>Annuaire</h2><div class="muted small">${esc(site.name)} · contacts partagés, visibles dans l'appli et sur les postes</div></div>
        <div class="btnrow"><input id="pb-q" class="dk-search" type="search" placeholder="Rechercher" value="${esc(P.q)}">${ro ? '' : '<button id="pb-new">Nouvel annuaire</button>'}</div></div>`
      + (P.books.length ? `<div class="dk-tabs">${P.books.map((b) => `<button class="${b.uuid === P.cur ? 'active' : ''}" data-book="${b.uuid}">${esc(b.name)}</button>`).join('')}</div>` : `<p class="dk-empty">Aucun annuaire sur ce site.${ro ? '' : ' Créez-en un avec « Nouvel annuaire ».'}</p>`)
      + (book ? `<section class="dk-panel"><div class="dk-panhead"><h3>${esc(book.name)} <span class="muted small">${P.contacts.length} contact${P.contacts.length > 1 ? 's' : ''}${book.description ? ` · ${esc(book.description)}` : ''}</span></h3>
          <span class="btnrow">${ro ? '' : '<button class="dk-text" id="pb-add">Ajouter un contact</button><button class="dk-text" id="pb-import">Importer un CSV…</button>'}<button class="dk-text" id="pb-export">Exporter en CSV</button>${ro ? '' : '<button class="dk-text" id="pb-edit">Renommer</button><button class="dk-text" id="pb-del">Supprimer l\'annuaire</button>'}</span></div>`
        + (rows.length ? `<div class="dk-scroll"><table class="dk-table"><thead><tr>${cs.map((k) => `<th>${esc(LABEL[k] || k)}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((c) => `<tr>${cs.map((k) => `<td>${esc(c[k] ?? '')}</td>`).join('')}<td class="dk-acts">${ro ? '' : `<button class="dk-text" data-ced="${esc(c.id)}">Modifier</button> <button class="dk-text" data-cdel="${esc(c.id)}">Supprimer</button>`}</td></tr>`).join('')}</tbody></table></div>`
          : `<p class="muted small">${q ? 'Aucun résultat.' : 'Aucun contact.'}</p>`) + '</section>' : '');
    $('pb-q').oninput = (e) => { P.q = e.target.value; const pos = e.target.selectionStart; draw(); const i = $('pb-q'); i.focus(); i.setSelectionRange(pos, pos); };
  };
  const refresh = async (books = false) => { if (books) await loadBooks(); await loadContacts(); draw(); };
  // Fiche contact : champs habituels + champs déjà présents sur le contact.
  const contactForm = (c) => {
    if (!canWrite()) return;
    const keys = [...FIELDS.map(([k]) => k), ...Object.keys(c || {}).filter((k) => !HIDDEN.has(k) && !LABEL[k])];
    confirmModal(`<div class="dk-ed"><h3>${c ? esc(name(c)) : 'Nouveau contact'}</h3><div class="dk-ed-3">${keys.map((k) => `<label>${esc(LABEL[k] || k)}${REQUIRED.has(k) ? ' *' : ''}<input data-k="${esc(k)}" value="${esc(c?.[k] ?? '')}"${k === 'email' ? ' type="email"' : ''}${REQUIRED.has(k) ? ' required' : ''}></label>`).join('')}</div><p class="muted small">* obligatoire</p><p id="pb-err" class="error small"></p></div>`, async () => {
      // Clés techniques (phonebook_uuid…) gardées telles quelles : dird remplace tout le contact au PUT.
      // Nouveau contact : phonebook_uuid posé comme le fait le Portal (son usage côté Portal n'est pas connu).
      const body = c ? {} : { phonebook_uuid: P.cur }; for (const [k, v] of Object.entries(c || {})) if (HIDDEN.has(k) && k !== 'id' && v != null) body[k] = v;
      for (const i of $('modal-body').querySelectorAll('[data-k]')) { const v = i.value.trim(); if (v) body[i.dataset.k] = v; }
      const miss = [...REQUIRED].filter((k) => !body[k]).map((k) => LABEL[k]);
      if (miss.length) { $('pb-err').textContent = `Obligatoire : ${miss.join(', ')}.`; return false; }
      try { if (c) await dird('PUT', `/phonebooks/${P.cur}/contacts/${c.id}`, body); else await dird('POST', `/phonebooks/${P.cur}/contacts`, body); }
      catch (e) { $('pb-err').textContent = `Échec : ${e.message}`; return false; }
      toast(c ? 'Contact modifié.' : 'Contact ajouté.'); refresh(); return true;
    }, c ? 'Enregistrer' : 'Ajouter');
  };
  const bookForm = (b) => {
    if (!canWrite()) return;
    confirmModal(`<div class="dk-ed"><h3>${b ? 'Renommer l\'annuaire' : 'Nouvel annuaire'}</h3><label>Nom<input id="pb-name" value="${esc(b?.name || '')}" maxlength="255"></label><label>Description<input id="pb-desc" value="${esc(b?.description || '')}"></label><p id="pb-berr" class="error small"></p></div>`, async () => {
      const body = { name: $('pb-name').value.trim(), description: $('pb-desc').value.trim() || null };
      if (!body.name) { $('pb-berr').textContent = 'Nom obligatoire.'; return false; }
      try { const r = b ? await dird('PUT', `/phonebooks/${b.uuid}`, body) : await dird('POST', '/phonebooks', body); if (!b && r?.uuid) P.cur = r.uuid; }
      catch (e) { $('pb-berr').textContent = `Échec : ${e.message}`; return false; }
      toast('Annuaire enregistré.'); refresh(true); return true;
    }, b ? 'Enregistrer' : 'Créer');
  };
  view.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const book = P.books.find((x) => x.uuid === P.cur);
    if (b.dataset.book) { P.cur = b.dataset.book; P.q = ''; await refresh(); }
    else if (b.id === 'pb-new') bookForm(null);
    else if (b.id === 'pb-edit') bookForm(book);
    else if (b.id === 'pb-add') contactForm(null);
    else if (b.dataset.ced) contactForm(P.contacts.find((c) => String(c.id) === b.dataset.ced));
    else if (b.dataset.cdel) {
      const c = P.contacts.find((x) => String(x.id) === b.dataset.cdel);
      if (canWrite()) confirmModal(`<p>Supprimer le contact <strong>${esc(name(c))}</strong> ?</p>`, async () => { try { await dird('DELETE', `/phonebooks/${P.cur}/contacts/${c.id}`); toast('Contact supprimé.'); } catch (x) { toast(`Échec : ${x.message}`, 8000); } refresh(); return true; }, 'Supprimer');
    } else if (b.id === 'pb-del') {
      if (canWrite()) confirmModal(`<p>Supprimer l'annuaire <strong>${esc(book.name)}</strong> ${P.contacts.length ? `et ${P.contacts.length > 1 ? `ses ${P.contacts.length} contacts` : 'son contact'}` : '(vide)'} ?</p><p class="muted small">Définitif. Pensez à l'exporter en CSV avant.</p>`, async () => { try { await dird('DELETE', `/phonebooks/${book.uuid}`); toast('Annuaire supprimé.'); } catch (x) { toast(`Échec : ${x.message}`, 8000); } refresh(true); return true; }, 'Supprimer');
    } else if (b.id === 'pb-export') {
      // Colonnes usuelles toujours présentes : l'export sert aussi de modèle pour l'import.
      const cs = [...new Set([...FIELDS.map(([k]) => k), ...cols()])];
      download(`annuaire_${(book.name || 'site').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-')}.csv`, csv(cs, P.contacts.map((c) => cs.map((k) => c[k] ?? ''))), 'text/csv;charset=utf-8');
    } else if (b.id === 'pb-import') {
      if (!canWrite()) return;
      confirmModal(`<div class="dk-ed"><h3>Importer des contacts dans « ${esc(book.name)} »</h3>
        <p class="small">Le plus simple : <strong>exportez</strong> l'annuaire en CSV, complétez-le dans Excel en gardant la première ligne, puis importez-le ici. Les contacts sont <strong>ajoutés</strong> à ceux déjà présents.</p>
        <div class="dk-ed-row"><button type="button" id="pb-file">Choisir le fichier…</button><span id="pb-finfo" class="muted small">aucun fichier</span></div><p id="pb-ierr" class="error small"></p></div>`, async () => {
        if (!text) { $('pb-ierr').textContent = 'Choisissez un fichier.'; return false; }
        try {
          const r = await dird('POST', `/phonebooks/${P.cur}/contacts/import`, text, 'text/csv; charset=utf-8');
          const ok = r?.created?.length ?? 0, ko = r?.failed?.length ?? 0;
          toast(`${ok} contact${ok > 1 ? 's' : ''} importé${ok > 1 ? 's' : ''}${ko ? `, ${ko} refusé${ko > 1 ? 's' : ''}` : ''}.`, 7000);
        } catch (x) { $('pb-ierr').textContent = `Import refusé : ${x.message}`; return false; }
        refresh(); return true;
      }, 'Importer');
      let text = '';
      $('pb-file').onclick = () => {
        const i = document.createElement('input'); i.type = 'file'; i.accept = '.csv,text/csv';
        i.onchange = async () => {
          const f = i.files?.[0]; if (!f) return;
          let t = (await f.text()).replace(/^﻿/, '');
          // Export Excel français (« ; ») → virgules, attendues par dird (csv.DictReader).
          const first = t.split(/\r?\n/)[0] || '';
          if (first.includes(';') && !first.includes(',')) t = t.split(/\r?\n/).map((l) => l.split(';').map((v) => (/[",]/.test(v) && !/^".*"$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n');
          text = t.replace(/\r\n/g, '\n');
          $('pb-finfo').textContent = `${f.name} · ${Math.max(0, text.trim().split('\n').length - 1)} ligne(s)`;
        };
        i.click();
      };
    }
  };
  draw();
}
