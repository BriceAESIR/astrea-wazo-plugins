// User Manager — création d'utilisateur (vierge ou à partir d'un utilisateur
// existant) et import des contacts personnels.
//
// Création : même flux que le portail (code du portail lu le 21/10/2026,
// pbx.users parseRequestBody / fetchExtraData, Wazo >= 23.04) :
//  1. POST /users (confd) avec les lignes imbriquées ; confd crée utilisateur,
//     lignes, endpoints et numéros dans la même requête (UserMiddleWare.create) ;
//  2. POST /api/auth/0.1/users : compte des applications (uuid de l'utilisateur,
//     username = identifiant saisi ou e-mail, password, email_address = e-mail,
//     adresse confirmée d'office par wazo-auth, enabled true) ;
//  3. associations (boîte vocale, groupes, droits, horaire, renvois…).
// Si le compte ne peut pas être créé, l'utilisateur est supprimé
// (DELETE /users/{uuid}?recursive=true, comme la suppression du portail) :
// pas d'utilisateur à moitié créé.
// Règles du portail reprises : e-mail et mot de passe obligatoires en licences
// Communication unifiée (1) et Relation client (3) ; pas de WebRTC en Voix ;
// identifiant 2-254 caractères `^[a-zA-Z0-9-._~!$&'()*+,;=%@]+$` ; mot de
// passe 4-64 caractères `^[a-zA-Z0-9-._~!$&'()*+,;=%]+$`.
// Non testé en réel.
import { S, $, esc, toast, api, fullName, canWrite, confirmModal, helpButton, helpBox } from '../common/core.js?v=0.40.49';
import { settingById, same, LANG, SUBS, subLabel, authApi, IDX, readLines, newLineBody, normDest, LINES } from './settings.js?v=0.40.49';

const opts = (items, sel) => items.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(t)}</option>`).join('');
const $v = (id) => document.getElementById(id)?.value ?? '';
const USERNAME_RE = /^[a-zA-Z0-9-._~!$&'()*+,;=%@]{2,254}$/;
const PASSWORD_RE = /^[a-zA-Z0-9-._~!$&'()*+,;=%]{4,64}$/;

// Réglages copiés depuis l'utilisateur modèle (« à partir de cet utilisateur »).
// Champs simples : envoyés dans le POST /users. Les autres : écrits ensuite par
// le même code que la fiche (settings.js), groupes en fin de liste des membres.
const COPY = [
  { k: 'base', label: 'Langue, fuseau, musique d\'attente, sonnerie, appels simultanés', def: true, fields: ['language', 'timezone', 'music_on_hold', 'ring_seconds', 'simultaneous_calls'] },
  { k: 'services', label: 'Ne pas déranger, filtrage', def: false, ids: ['dnd', 'incallfilter'] },
  { k: 'fwd', label: 'Renvois d\'appel (utilisateur)', def: false, ids: ['fwd_busy', 'fwd_unconditional', 'fwd_noanswer'] },
  { k: 'fb', label: 'Renvois par défaut (sa propre messagerie devient celle du nouvel utilisateur)', def: true, ids: ['fb_busy', 'fb_congestion', 'fb_fail', 'fb_noanswer'] },
  { k: 'cid', label: 'Numéro présenté (sauf SDA du modèle)', def: true, ids: ['outgoing_caller_id'] },
  { k: 'perms', label: 'Droits d\'appel', def: true, ids: ['call_permissions'] },
  { k: 'groups', label: 'Groupes d\'appel (ajouté en fin de liste)', def: true, ids: ['groups'] },
  { k: 'sched', label: 'Horaire', def: true, ids: ['schedule'] },
];

// deps : { A, ctx, reload, report(html) }
export function openCreate(src, deps) {
  if (!canWrite()) return;
  const { A, ctx } = deps;
  A_users = () => A.users;
  const c = ctx();
  const ictx = LINES.internalCtx(c);
  const srcLines = src ? readLines(src) : [];
  const types = new Set(srcLines.map((l) => l.type));
  const lt = types.has('sip') && types.has('webrtc') ? 'both' : types.has('webrtc') ? 'webrtc' : 'sip';
  const cx0 = srcLines.find((l) => l.context)?.context || LINES.defaultCtx(c);
  const num0 = (cx) => LINES.nextFree(cx, LINES.defaultStart(cx), 1)[0] || '';
  const freeVm = [...A.vms.values()].filter((v) => v.accesstype !== 'global' && !A.users.some((u) => u.voicemail?.id === v.id))
    .sort((a, b) => String(a.number).localeCompare(String(b.number), 'fr', { numeric: true }));
  const help = 'Crée l\'utilisateur comme le portail : utilisateur et lignes en une requête, puis compte des applications, puis associations. Si le compte des applications ne peut pas être créé, l\'utilisateur est supprimé (rien à moitié créé). Les boîtes vocales se créent dans Messageries vocales : ici, seulement l\'association à une boîte libre.';
  confirmModal(`<div class="titlerow"><h3>${src ? `Nouvel utilisateur à partir de ${esc(fullName(src))}` : 'Nouvel utilisateur'}</h3>${helpButton('m-help', 'Que fait cette création ?')}</div>${helpBox('m-help', help)}
    <div id="m-form" class="createform">
      <section class="csec"><div class="cgrid">
        <label class="span2">Modèle (utilisateur de référence) <select id="c-src">${opts([['', 'Aucun'], ...A.users.map((u) => [u.uuid, fullName(u) + (readLines(u)[0]?.exten ? ` (${readLines(u)[0].exten})` : '')])], src?.uuid || '')}</select></label>
      </div><p class="muted small">Avec un modèle : licence, type de ligne et contexte repris ; réglages à copier au choix plus bas.</p></section>
      <section class="csec"><h4>Utilisateur</h4><div class="cgrid">
        <label>Prénom <input id="c-fn" maxlength="128"></label>
        <label>Nom <input id="c-ln" maxlength="128"></label>
        <label>E-mail (annuaire) <input id="c-mail" maxlength="254" spellcheck="false"></label>
        <label>Licence <select id="c-sub">${opts(Object.entries(SUBS), src?.subscription_type ?? 1)}</select></label>
      </div></section>
      <section class="csec"><h4>Ligne et messagerie</h4><div class="cgrid">
        <label class="span2">Type de ligne <select id="c-lt">${opts([['', 'Aucune (pas d\'appel ni de groupe possible)'], ...LINES.LTYPES_NEW], lt)}</select></label>
        <label data-cl>Contexte <select id="c-cx">${opts(ictx.map((x) => [x.name, LINES.ctxText(x)]), cx0)}</select></label>
        <label data-cl>Numéro <input id="c-num" inputmode="numeric" value="${esc(num0(cx0))}"></label>
        <label data-cl>Appareil (ligne SIP) <select id="c-dev">${opts([['', 'Aucun'], ...LINES.freeDevices().map((d) => [d.id, [d.vendor, d.model].filter(Boolean).join(' ') + (d.mac ? ` · ${d.mac}` : '')])], '')}</select></label>
        <label>Boîte vocale <select id="c-vm">${opts([['', 'Aucune'], ...freeVm.map((v) => [v.id, `${v.number}${v.name ? ` (${v.name})` : ''}`])], '')}</select></label>
      </div><p class="muted small">Boîtes vocales proposées : non globales, associées à personne.</p></section>
      <section class="csec"><h4>Compte des applications</h4>
        <div data-acct><div class="cgrid">
          <label>Identifiant de connexion <input id="c-login" maxlength="254" spellcheck="false" placeholder="par défaut : l'e-mail"></label>
          <label>Mot de passe <span class="pwrow"><input id="c-pw" maxlength="64" spellcheck="false" autocomplete="new-password"><button type="button" id="c-pwgen">Générer</button></span></label>
        </div>
        <label class="inline cline"><input type="checkbox" id="c-en" checked> Autorisé à utiliser les applications</label></div>
        <p class="muted small" data-noacct>Licence Voix : pas d'accès aux applications Wazo, rien à saisir. Le compte est créé fermé, comme le portail le fait pour chaque utilisateur : il servira si la licence change.</p>
      </section>
      ${src ? `<section class="csec"><h4>Copier depuis ${esc(fullName(src))}</h4><div class="clist">${COPY.map((x) => `<label class="inline cline"><input type="checkbox" id="c-cp-${x.k}"${x.def ? ' checked' : ''}> ${esc(x.label)}</label>`).join('')}</div>
        <p class="muted small">Jamais copiés : nom, e-mail, numéro, appareil, boîte vocale, compte, SDA.</p></section>` : ''}
      <section class="csec" data-acct><h4>Contacts personnels (facultatif)</h4>
        <label>Fichier CSV au format d'import Wazo (ex. Migration Assistant) <input type="file" id="c-csv" accept=".csv,text/csv"></label>
        <p class="muted small">Importés juste après la création avec le mot de passe ci-dessus (jeton de l'utilisateur, révoqué ensuite ; rien n'est stocké).</p></section>
      <section class="csec"><h4>Ensuite</h4>
        <label class="inline cline"><input type="checkbox" id="c-next" checked> Ouvrir l'assistant pour régler les autres paramètres (services, renvois, débordements, numéro présenté, droits, groupes, horaire…)</label></section>
    </div>
    <div id="m-prev" class="mprev"></div>`, async () => {
    let spec;
    try { spec = await readForm(); } catch (e) { toast(e.message, 7000); return false; }
    await runCreate(spec, src, deps);
  }, 'Créer');
  $('c-pw').value = randomPw();
  $('c-pwgen').onclick = () => { $('c-pw').value = randomPw(); };
  const showLine = () => { document.querySelectorAll('[data-cl]').forEach((x) => (x.hidden = !$v('c-lt'))); };
  $('c-lt').onchange = showLine; showLine();
  // Licence Voix : ni accès aux applications ni contacts (connexion refusée par les applications).
  const showAcct = () => { const voix = $v('c-sub') === '0'; document.querySelectorAll('[data-acct]').forEach((x) => (x.hidden = voix)); document.querySelector('[data-noacct]').hidden = !voix; };
  $('c-sub').addEventListener('change', showAcct); showAcct();
  $('c-cx').onchange = () => { $('c-num').value = num0($v('c-cx')); };
  // Changer de modèle : dialogue rouvert avec ce modèle, saisie gardée.
  $('c-src').onchange = () => {
    const keep = Object.fromEntries(['c-fn', 'c-ln', 'c-mail', 'c-login', 'c-pw'].map((id) => [id, $v(id)]));
    openCreate(A.users.find((u) => u.uuid === $v('c-src')) || null, deps);
    for (const [id, v] of Object.entries(keep)) if (v) document.getElementById(id).value = v;
  };
}

const randomPw = () => {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint32Array(14); crypto.getRandomValues(b);
  return [...b].map((x) => cs[x % cs.length]).join('');
};

async function readForm() {
  const fn = $v('c-fn').trim(), ln = $v('c-ln').trim(), mail = $v('c-mail').trim();
  const sub = Number($v('c-sub')), lt = $v('c-lt'), cx = $v('c-cx'), num = $v('c-num').trim();
  const voix = Number($v('c-sub')) === 0;
  // Voix : compte fermé, identifiant = e-mail (sinon uuid, comme le portail), mot de passe aléatoire non affiché.
  const login = voix ? mail : $v('c-login').trim() || mail, pw = voix ? randomPw() : $v('c-pw');
  if (!fn) throw new Error('Prénom obligatoire.');
  if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('E-mail (annuaire) invalide.');
  if ((sub === 1 || sub === 3) && !mail) throw new Error(`E-mail obligatoire pour la licence ${subLabel(sub)} (règle du portail).`);
  if (sub === 0 && (lt === 'webrtc' || lt === 'both')) throw new Error('Licence Voix : pas de ligne WebRTC (règle du portail).');
  if (!voix && !login) throw new Error('Identifiant de connexion obligatoire (ou un e-mail).');
  if (login && !USERNAME_RE.test(login)) throw new Error('Identifiant : 2 à 254 caractères, lettres, chiffres et - . _ ~ ! $ & \' ( ) * + , ; = % @.');
  if (!PASSWORD_RE.test(pw)) throw new Error('Mot de passe : 4 à 64 caractères, lettres, chiffres et - . _ ~ ! $ & \' ( ) * + , ; = %.');
  if (login && A_users().some((u) => u._auth?.username?.toLowerCase() === login.toLowerCase())) throw new Error(`Identifiant ${login} déjà utilisé.`);
  if (mail && A_users().some((u) => (u.email || '').toLowerCase() === mail.toLowerCase())) throw new Error(`E-mail ${mail} déjà utilisé par un autre utilisateur du tenant (unique sur tout le serveur).`);
  const lines = [];
  if (lt) {
    const cxo = IDX.contexts.find((x) => x.name === cx);
    if (!cxo) throw new Error('Aucun contexte interne.');
    if (!/^\d{1,40}$/.test(num)) throw new Error('Numéro de la ligne : chiffres seulement.');
    if (!LINES.inRange(cxo, num)) throw new Error(`Numéro ${num} hors des plages du contexte ${LINES.ctxText(cxo)}.`);
    const t = LINES.takenBy({ lines: [] }, num, cx);
    if (t) throw new Error(t.replace(/^./, (x) => x.toUpperCase()) + '.');
    for (const ty of lt === 'both' ? ['sip', 'webrtc'] : [lt]) {
      if (!IDX.tpl.global || (ty === 'webrtc' && !IDX.tpl.webrtc)) throw new Error(`Modèle SIP « ${ty === 'webrtc' ? 'webrtc' : 'global'} » du tenant introuvable.`);
      lines.push({ type: ty, exten: num, context: cx });
    }
  }
  const f = document.getElementById('c-csv')?.files?.[0];
  const csv = f && !voix ? await f.text() : '';
  const copy = Object.fromEntries(COPY.map((x) => [x.k, document.getElementById(`c-cp-${x.k}`)?.checked === true]));
  return { next: document.getElementById('c-next')?.checked === true, fn, ln, mail, sub, lines, dev: $v('c-dev') || null, vm: Number($v('c-vm')) || null, login, pw, enabled: !voix && document.getElementById('c-en').checked, voix, copy, csv, csvName: f?.name || '' };
}
let A_users = () => [];

async function runCreate(spec, src, { A, reload, report, after }) {
  const steps = [], warn = [];
  // 1. Utilisateur + lignes (une requête).
  const body = { firstname: spec.fn, lastname: spec.ln || null, email: spec.mail || null, subscription_type: spec.sub, outgoing_caller_id: 'default' };
  if (src && spec.copy.base) for (const k of COPY[0].fields) if (src[k] != null) body[k] = src[k];
  if (spec.lines.length) body.lines = spec.lines.map((l) => ({ ...newLineBody(l), ...(l.type === 'sip' && spec.dev ? { device_id: spec.dev } : {}) }));
  let user;
  try {
    toast('Création de l\'utilisateur…', 60000);
    user = await api('POST', '/users', body);
    steps.push(`utilisateur et ${spec.lines.length ? `ligne(s) ${spec.lines.map((l) => `${LINES.LTYPE[l.type]} ${l.exten}`).join(', ')}` : 'aucune ligne'}`);
  } catch (e) { report(`<div class="massres bad"><strong>Création refusée</strong> : ${esc(e.message)}. Rien n'a été créé.<button class="icon" data-close title="Fermer">×</button></div>`); toast('Création refusée.', 6000); return; }
  // 2. Compte des applications (comme le portail : createAuthUser).
  try {
    await authApi('POST', '/users', { uuid: user.uuid, firstname: spec.fn, lastname: spec.ln || null, username: spec.login || user.uuid, password: spec.pw, email_address: spec.mail || null, enabled: spec.enabled, emails: [] });
    steps.push(spec.voix ? 'compte des applications fermé (licence Voix)' : `compte des applications (identifiant ${spec.login})`);
  } catch (e) {
    let undo = '';
    try { await api('DELETE', `/users/${user.uuid}?recursive=true`); undo = 'L\'utilisateur créé a été supprimé : rien n\'est resté.'; } catch (e2) { undo = `ATTENTION : l'utilisateur ${esc(fullName(user))} est resté sans compte (suppression impossible : ${esc(e2.message)}).`; }
    report(`<div class="massres bad"><strong>Compte des applications refusé</strong> : ${esc(e.message)}. ${undo}<button class="icon" data-close title="Fermer">×</button></div>`);
    toast('Création annulée.', 6000);
    try { await reload(); } catch { /* */ }
    return;
  }
  // 3. Associations.
  const fresh = async () => api('GET', `/users/${user.uuid}`);
  if (spec.vm) { try { await api('PUT', `/users/${user.uuid}/voicemails/${spec.vm}`); steps.push('boîte vocale associée'); } catch (e) { warn.push(`boîte vocale : ${e.message}`); } }
  if (src) {
    let u = await fresh();
    u._auth = null;
    for (const x of COPY.slice(1)) {
      if (!spec.copy[x.k]) continue;
      for (const id of x.ids) {
        const s = settingById(id);
        if (!s) continue;
        let v = s.read(src);
        // Sa propre messagerie → celle du nouvel utilisateur (ou rien s'il n'en a pas).
        if (id.startsWith('fb_') && v?.type === 'voicemail' && src.voicemail && v.voicemail_id === src.voicemail.id) v = u.voicemail ? normDest({ ...v, voicemail_id: u.voicemail.id }) : null;
        if (id === 'outgoing_caller_id' && v && v !== 'default' && v !== 'anonymous' && (src.incalls || []).some((i) => (i.extensions || []).some((e) => String(v).includes(String(e.exten).replace(/^_/, ''))))) { warn.push('numéro présenté : SDA du modèle, non copiée'); continue; }
        if (id === 'groups' && v?.length && !(u.lines || []).length) { warn.push('groupes : pas de ligne, non copiés'); continue; }
        const cur = s.read(u);
        if (v == null && cur == null) continue;
        if (same(cur, v)) continue;
        const err = s.check?.(u, v);
        if (err) { warn.push(`${s.label} : ${err}`); continue; }
        try { await s.write(u, v, cur); if (id === 'groups' || id === 'call_permissions') u = await fresh(); } catch (e) { warn.push(`${s.label} : ${e.message}`); }
      }
      steps.push(x.label.replace(/ \(.*\)$/, '').toLowerCase());
    }
  }
  // 4. Contacts personnels (jeton de l'utilisateur).
  if (spec.csv) {
    try { const r = await importPersonal(spec.login, spec.pw, spec.csv); steps.push(`${r.created} contact(s) personnel(s)${r.failed ? `, ${r.failed} refusé(s)` : ''}`); } catch (e) { warn.push(`contacts personnels : ${e.message}`); }
  }
  report(`<div class="massres${warn.length ? ' bad' : ''}"><strong>${esc(fullName(user))}</strong> créé : ${esc(steps.join(', '))}.
    ${spec.enabled ? `<div class="small">Identifiant <strong>${esc(spec.login)}</strong>, mot de passe <strong>${esc(spec.pw)}</strong> (à noter maintenant : il ne sera plus affiché).</div>` : ''}
    ${warn.map((w) => `<div class="small error">${esc(w)}</div>`).join('')}<button class="icon" data-close title="Fermer">×</button></div>`);
  toast('Utilisateur créé.', 5000);
  try { await reload(); } catch (e) { toast(e.message, 8000); }
  const nid = A.users.find((x) => x.uuid === user.uuid)?.id;
  A.sel = nid ?? A.sel;
  if (spec.next && nid != null && after) setTimeout(() => after(nid), 0); // le dialogue se ferme d'abord
}

// ---------------------------------------------------------------------------
// Contacts personnels (wazo-dird, lu dans le code le 04/11/2026) :
// POST /api/dird/0.1/personal/import (ACL dird.personal.import.create), corps
// CSV `text/csv; charset=utf-8`, en-tête = clés des champs ; réponse 201
// {created, failed}. AUCUNE route ne prend un utilisateur en paramètre :
// elles agissent sur l'utilisateur du jeton (get_user_uuid). Le jeton du
// portail (administrateur) ne peut donc pas écrire les contacts d'un autre.
// Ici : jeton de l'utilisateur obtenu avec son identifiant et son mot de passe
// (POST /api/auth/0.1/token, Basic), 5 minutes, révoqué juste après.
// À vérifier en réel : CORS de /token et de dird depuis le cadre du portail,
// ACL du jeton d'un utilisateur standard, comptes SAML / LDAP (pas de mot de
// passe local : impossible).
// ---------------------------------------------------------------------------
export async function importPersonal(login, password, csv) {
  const b64 = btoa(unescape(encodeURIComponent(`${login}:${password}`)));
  const r = await fetch(`${S.base}/api/auth/0.1/token`, { method: 'POST', headers: { Authorization: `Basic ${b64}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ expiration: 300 }) });
  if (!r.ok) throw new Error(r.status === 401 ? 'identifiant ou mot de passe refusé' : `jeton utilisateur → ${r.status}`);
  const token = (await r.json())?.data?.token;
  if (!token) throw new Error('jeton utilisateur absent de la réponse');
  try {
    const text = String(csv).replace(/^﻿/, '');
    const x = await fetch(`${S.base}/api/dird/0.1/personal/import`, { method: 'POST', headers: { 'X-Auth-Token': token, 'Content-Type': 'text/csv; charset=utf-8', Accept: 'application/json' }, body: text });
    let j = null;
    try { j = await x.json(); } catch { /* */ }
    if (x.status === 201) return { created: (j?.created || []).length, failed: (j?.failed || []).length, errors: j?.failed || [] };
    if (x.status === 400) throw new Error(`aucun contact importé (${(j?.details?.failed || []).length} ligne(s) refusée(s) : ${JSON.stringify(j?.details?.failed || j).slice(0, 200)})`);
    throw new Error(`import → ${x.status}${x.status === 401 || x.status === 403 ? ' (droit refusé au jeton de l\'utilisateur)' : ''}`);
  } finally {
    try { await fetch(`${S.base}/api/auth/0.1/token/${token}`, { method: 'DELETE', headers: { 'X-Auth-Token': token } }); } catch { /* jeton expire seul en 5 min */ }
  }
}

// Fiche : import pour un utilisateur existant (mot de passe à saisir).
export function openPersonalImport(u, { report }) {
  if (!canWrite() || !u?._auth) return;
  const help = 'Les contacts personnels appartiennent à l\'utilisateur : wazo-dird n\'accepte que le jeton de l\'utilisateur lui-même. User Manager en demande un avec son identifiant et son mot de passe, importe, puis le révoque. Rien n\'est stocké. Impossible pour un compte SAML ou LDAP.';
  confirmModal(`<div class="titlerow"><h3>Importer des contacts personnels</h3>${helpButton('m-help', 'Comment ça marche ?')}</div>${helpBox('m-help', help)}
    <p class="muted small">${esc(fullName(u))} · identifiant ${esc(u._auth.username || '—')}</p>
    <label>Fichier CSV (format d'import Wazo, ex. Migration Assistant) <input type="file" id="p-csv" accept=".csv,text/csv"></label>
    <label>Mot de passe de l'utilisateur <input type="password" id="p-pw" autocomplete="off"></label>
    <div class="warn">Les contacts s'ajoutent à ceux de l'utilisateur ; un contact identique est refusé (doublon).</div>`, async () => {
    const f = $('p-csv').files[0], pw = $('p-pw').value;
    if (!f || !pw) { toast('Fichier et mot de passe obligatoires.', 5000); return false; }
    try {
      toast('Import…', 30000);
      const r = await importPersonal(u._auth.username, pw, await f.text());
      report(`<div class="massres${r.failed ? ' bad' : ''}"><strong>${esc(fullName(u))}</strong> : ${r.created} contact(s) personnel(s) importé(s)${r.failed ? `, ${r.failed} refusé(s) : ${esc(JSON.stringify(r.errors).slice(0, 300))}` : ''}.<button class="icon" data-close title="Fermer">×</button></div>`);
      toast('Import terminé.', 5000);
    } catch (e) { toast(`Import impossible : ${e.message}`, 9000); return false; }
  }, 'Importer');
}
