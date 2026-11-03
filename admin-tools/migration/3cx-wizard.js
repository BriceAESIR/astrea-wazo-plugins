// Migration Assistant — lot 5 : assistant d'écriture guidé du brouillon 3CX
// dans Wazo (cahier des charges : docs/MIGRATION-ASSISTANT.md, « Lot 5 »).
// Étapes dans l'ordre de la procédure de création de tenant de Brice ; une
// étape n'est ouverte que lorsque les précédentes sont faites (ou faites à la
// main). Chaque étape automatique : prérequis relus dans le tenant, aperçu des
// écritures, confirmation, écriture, journal (dans le brouillon), annulation.
// 5a (03/11/2026) : pays, conservation des données, applications (manuel),
// trunk (manuel), appels sortants, numéros de téléphone, IP publique (manuel).
// Les étapes 5b-5d sont listées, verrouillées « à venir ».
import { S, api, ApiError, esc, toast, canWrite, confirmModal, helpButton, helpBox } from '../common/core.js?v=0.40.29';
import { I, sameTenant } from './inventory.js?v=0.40.29';
import { saveDraft } from './3cx-draft.js?v=0.40.29';

const W = { d: null, m: null, busy: false, plan: {}, msg: {} };
export function setWizard(d, m) { W.d = d; W.m = m; W.plan = {}; W.msg = {}; ensureState(); }

// ---------------------------------------------------------------------------
// État dans le brouillon : d.write = { clientId, clientName, steps: { id: { status, at, log, undo } } }
// ---------------------------------------------------------------------------
function ensureState() {
  const d = W.d;
  if (d.write) return;
  // « 44030 - SCP … » (licence 3CX) → ID client 44030, nom « SCP … » ; modifiables.
  const m = String(d.company || '').match(/^\s*(\d{3,})\s*[-–]\s*(.+)$/);
  d.write = { clientId: m ? m[1] : '', clientName: m ? m[2].trim() : (d.company || ''), cdrDays: 90, recordingDays: 90, steps: {} };
}
const st = (id) => (W.d.write.steps[id] ||= { status: 'todo', log: [] });
const save = () => saveDraft(W.d);

// Appels API avec garde de tenant (le portail change de tenant tout de suite).
async function tapi(method, path, body) {
  if (!sameTenant(I.tenant)) throw new Error('Le tenant a changé dans le portail : opération arrêtée, rien n\'est envoyé vers le nouveau tenant.');
  return api(method, path, body);
}
// call-logd (conservation des données). En-tête Wazo-Tenant envoyé comme pour
// confd : accepté par call-logd (Tenant.autodetect) ; CORS supposé (Astrea Desk
// l'utilise pour ses statistiques).
async function logd(method, path, body) {
  if (!sameTenant(I.tenant)) throw new Error('Le tenant a changé dans le portail : opération arrêtée.');
  if (S.readonly && method !== 'GET') throw new ApiError(0, `Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${S.base}/api/call-logd/1.0${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) { let m = `call-logd ${method} ${path} → ${r.status}`; try { m += ' ' + JSON.stringify(await r.json()).slice(0, 300); } catch { /* */ } throw new ApiError(r.status, m); }
  return r.status === 204 ? null : r.json();
}
// Même règle que l'inventaire (ownTenant) : objets du tenant courant seulement.
const own = (x) => !I.tenant || !x?.tenant_uuid || x.tenant_uuid === I.tenant;
const e164 = (n) => { const s = String(n || '').replace(/[^\d+]/g, ''); return s.startsWith('+') ? s : s.startsWith('00') ? `+${s.slice(2)}` : s.startsWith('0') ? `+33${s.slice(1)}` : s; };

// ---------------------------------------------------------------------------
// Catalogue des étapes (ordre de la procédure de Brice)
// plan() : lit le tenant, renvoie { blockers, items (textes), ops (écritures) }
// op = { label, run: async () => ({ undo?: op inverse, created?: texte }) }
// ---------------------------------------------------------------------------
const MANUAL = 'manual'; const AUTO = 'auto'; const LATER = 'later';
const STEPS = [
  { id: 'country', n: 1, title: 'Mon organisation : pays France', kind: AUTO,
    help: 'Pays du tenant (confd PUT /localization, champ country au format ISO à 2 lettres, vérifié). Il sert aux formats de numéros.',
    async plan() {
      const cur = await tapi('GET', '/localization');
      if (cur?.country === 'FR') return { items: ['Pays déjà réglé sur France.'], ops: [] };
      return { items: [`Pays : ${cur?.country || 'aucun'} → FR`], ops: [{ label: 'PUT /localization {country: "FR"}', run: async () => { await tapi('PUT', '/localization', { country: 'FR' }); return { undo: { method: 'PUT', path: '/localization', body: { country: cur?.country ?? null } } }; } }] };
    } },
  { id: 'retention', n: 2, title: 'Conservation des données : journal et enregistrements', kind: AUTO,
    help: 'Durées de conservation du tenant (call-logd PUT /retention, vérifié). Ce PUT n\'est pas partiel : un champ absent repasse au défaut du serveur, donc les trois durées sont relues puis renvoyées (exports inchangés).',
    form: () => `<div class="ms-tools"><label>Journal d'appels (jours) <input type="number" min="0" max="3650" data-w="cdrDays" value="${esc(W.d.write.cdrDays)}" class="x3-short"></label><label>Enregistrements (jours) <input type="number" min="0" max="3650" data-w="recordingDays" value="${esc(W.d.write.recordingDays)}" class="x3-short"></label></div>`,
    async plan() {
      const cur = await logd('GET', '/retention');
      const want = { cdr_days: Number(W.d.write.cdrDays), recording_days: Number(W.d.write.recordingDays), export_days: cur?.export_days ?? null };
      const fmt = (v, def) => (v == null ? `défaut (${def ?? '?'})` : `${v} j`);
      if (cur?.cdr_days === want.cdr_days && cur?.recording_days === want.recording_days) return { items: ['Durées déjà réglées.'], ops: [] };
      return { items: [`Journal d'appels : ${fmt(cur?.cdr_days, cur?.default_cdr_days)} → ${want.cdr_days} j`, `Enregistrements : ${fmt(cur?.recording_days, cur?.default_recording_days)} → ${want.recording_days} j`, `Exports : inchangé (${fmt(cur?.export_days, cur?.default_export_days)})`],
        ops: [{ label: `PUT /retention ${JSON.stringify(want)}`, run: async () => { await logd('PUT', '/retention', want); return { undo: { api: 'logd', method: 'PUT', path: '/retention', body: { cdr_days: cur?.cdr_days ?? null, recording_days: cur?.recording_days ?? null, export_days: cur?.export_days ?? null } } }; } }] };
    } },
  { id: 'apps', n: 3, title: 'Applications de l\'organisation', kind: MANUAL,
    help: 'Réglage du Portal (Paramètres, Applications), hors de la stack : à faire à la main.',
    todo: () => ['Portal : Paramètres > Applications.', 'Cocher / décocher les fonctionnalités nécessaires au client, puis Enregistrer.'] },
  { id: 'moh', n: 4, title: 'Sons et musiques (Attente, Prédécroché)', kind: LATER, help: 'Lot 5d : fichiers fournis depuis votre poste, convertis en WAV 8 kHz 16 bits mono, listes « ID client - Attente » et « ID client - Prédécroché ».' },
  { id: 'trunk', n: 5, title: 'Interconnexion (trunk opérateur)', kind: MANUAL,
    help: 'À créer dans le Portal avec le modèle de l\'opérateur (décision de Brice : pas d\'automatisation sans lire le code du Portal). Les valeurs ci-dessous viennent de la sauvegarde 3CX et de la procédure. L\'étape suivante relit les trunks du tenant.',
    todo: () => {
      const t = W.m?.trunks?.[0];
      return [
        'Portal : Gestion des appels > Interconnexions > Créer, choisir l\'opérateur (généralement Unyc, paramètres sur Atlas).',
        `Nom affiché : « ${W.d.write.clientName || '<client>'} - Trunk ${t ? t.name.charAt(0).toUpperCase() + t.name.slice(1) : 'Unyc'} »`,
        'Serveur proxy : pbx.eqinoxe.com',
        'Nom d\'utilisateur et mot de passe du trunk : ceux d\'Atlas. Si le trunk sert encore à l\'ancien système (3CX), fausser son mot de passe d\'un côté pour éviter un double enregistrement.',
        `Numéro principal du trunk : ${t?.mainNumber || '?'}`,
        'Créer.',
      ];
    },
    async verify() { const n = (await tapi('GET', '/trunks?recurse=false'))?.items?.length || 0; return n ? `${n} trunk(s) dans le tenant.` : null; } },
  { id: 'outcall', n: 6, title: 'Appels sortants', kind: AUTO,
    help: 'Règle sortante « <client> - Appels sortants » vers le trunk, motif _X. (tous les numéros). Création comme Call Flow Manager (audité le 21/10/2026) : POST /outcalls {name}, extension _X. dans le contexte sortant, PUT /outcalls/{id}/extensions/{ext} (strip_digits 0, sans préfixe), PUT /outcalls/{id}/trunks.',
    form: () => {
      const trunks = (I.lists.trunk || []);
      return `<label>Trunk <select data-w="trunkId">${trunks.map((t) => `<option value="${t.id}" ${String(W.d.write.trunkId) === String(t.id) ? 'selected' : ''}>${esc(t.endpoint_sip?.label || t.endpoint_sip?.name || `Trunk ${t.id}`)}</option>`).join('') || '<option value="">aucun trunk : relire le tenant après l\'étape 5</option>'}</select></label>`;
    },
    async plan() {
      const name = `${W.d.write.clientName || 'Client'} - Appels sortants`;
      const trunks = (await tapi('GET', '/trunks'))?.items?.filter(own) || [];
      const trunkId = Number(W.d.write.trunkId || trunks[0]?.id);
      const blockers = [];
      if (!trunks.length) blockers.push('Aucun trunk dans le tenant : faire l\'étape 5, puis « Relire le tenant ».');
      const ctxs = (await tapi('GET', '/contexts'))?.items?.filter(own) || [];
      const out = ctxs.find((c) => c.type === 'outcall');
      if (!out) blockers.push('Aucun contexte sortant (type outcall) dans le tenant.');
      const outs = (await tapi('GET', '/outcalls'))?.items?.filter(own) || [];
      if (outs.some((o) => o.name === name)) return { items: [`Règle « ${name} » déjà présente.`], ops: [] };
      const catchAll = outs.find((o) => (o.extensions || []).some((e) => e.exten === '_X.'));
      if (catchAll) blockers.push(`Une règle prend déjà tous les numéros (_X.) : « ${catchAll.name} ». Vérifier avant d'en créer une autre.`);
      const internal = ctxs.filter((c) => c.type === 'internal');
      const notIncl = out ? internal.filter((c) => !(c.contexts || []).some((x) => x.name === out.name)) : [];
      const items = [`Créer la règle « ${name} »`, `Motif _X. dans le contexte ${out ? `${out.label} (${out.name})` : '?'}`, `Trunk : ${trunks.find((t) => t.id === trunkId)?.endpoint_sip?.label || trunkId}`];
      if (outs.length) items.push(`Règles sortantes déjà présentes dans le tenant : ${outs.map((o) => `« ${o.name || o.label} » (${(o.extensions || []).map((e) => e.exten).join(', ') || 'sans motif'})`).join(' ; ')}. Asterisk prend le motif le plus précis.`);
      if (notIncl.length) items.push(`Attention : contexte(s) interne(s) n'incluant pas le sortant (appels sortants impossibles depuis eux) : ${notIncl.map((c) => c.label).join(', ')}.`);
      if (blockers.length) return { blockers, items, ops: [] };
      return { items, ops: [{ label: `POST /outcalls « ${name} », extension _X., trunk ${trunkId}`, run: async () => {
        const o = await tapi('POST', '/outcalls', { name });
        let ext = null;
        try {
          ext = await tapi('POST', '/extensions', { exten: '_X.', context: out.name });
          await tapi('PUT', `/outcalls/${o.id}/extensions/${ext.id}`, { strip_digits: 0, external_prefix: null, prefix: null, caller_id: null });
          await tapi('PUT', `/outcalls/${o.id}/trunks`, { trunks: [{ id: trunkId }] });
        } catch (e) {
          // Retour arrière : rien de partiel ne reste.
          try { if (ext) { await tapi('DELETE', `/outcalls/${o.id}/extensions/${ext.id}`).catch(() => {}); await tapi('DELETE', `/extensions/${ext.id}`); } } catch { /* */ }
          try { await tapi('DELETE', `/outcalls/${o.id}`); } catch { /* */ }
          throw e;
        }
        return { created: `règle ${o.id}, extension ${ext.id}`, undo: { seq: [{ method: 'DELETE', path: `/outcalls/${o.id}/extensions/${ext.id}` }, { method: 'DELETE', path: `/extensions/${ext.id}` }, { method: 'DELETE', path: `/outcalls/${o.id}` }] } };
      } }] };
    } },
  { id: 'numbers', n: 7, title: 'Numéros de téléphone (+33) et numéro principal', kind: AUTO,
    help: 'Numéros publics du tenant (confd POST /phone-numbers, format +chiffres, vérifié), un par un car les SDA 3CX ne sont pas contiguës ; puis PUT /phone-numbers/main pour le numéro principal du trunk 3CX. Les numéros déjà présents sont laissés tels quels.',
    async plan() {
      const nums = [...new Set((W.d.dids || []).map((r) => e164(r.did)).filter((n) => /^\+\d{6,}$/.test(n)))];
      const main = e164(W.m?.trunks?.[0]?.mainNumber);
      let cur;
      try { cur = (await tapi('GET', '/phone-numbers'))?.items?.filter(own) || []; }
      catch (e) { return { blockers: [`API des numéros de téléphone indisponible (${e.message}) : stack trop ancienne ?`], items: [], ops: [] }; }
      const have = new Map(cur.map((p) => [p.number, p]));
      const todo = nums.filter((n) => !have.has(n));
      const items = [`${nums.length} numéro(s) dans le brouillon ; ${todo.length} à créer, ${nums.length - todo.length} déjà présent(s).`, todo.length ? `À créer : ${todo.join(', ')}` : '', main ? `Numéro principal : ${main}${have.get(main)?.main ? ' (déjà principal)' : ''}` : 'Aucun numéro principal dans la sauvegarde.'].filter(Boolean);
      const ops = todo.map((n) => ({ label: `POST /phone-numbers ${n}`, run: async () => { const p = await tapi('POST', '/phone-numbers', { number: n }); return { created: `${n} (${p.uuid})`, undo: { method: 'DELETE', path: `/phone-numbers/${p.uuid}` } }; } }));
      if (main && !have.get(main)?.main) ops.push({ label: `PUT /phone-numbers/main ${main}`, run: async () => {
        const list = (await tapi('GET', '/phone-numbers'))?.items || [];
        const p = list.find((x) => x.number === main && own(x));
        if (!p) throw new Error(`numéro principal ${main} introuvable après création`);
        const before = (await tapi('GET', '/phone-numbers/main').catch(() => null));
        await tapi('PUT', '/phone-numbers/main', { phone_number_uuid: p.uuid });
        return { created: `principal ${main}`, undo: before?.uuid ? { method: 'PUT', path: '/phone-numbers/main', body: { phone_number_uuid: before.uuid } } : null };
      } });
      return { items, ops };
    } },
  { id: 'vm', n: 8, title: 'Messageries vocales communes', kind: LATER, help: 'Lot 5b.' },
  { id: 'devices', n: 9, title: 'Périphériques (MAC pré-assignées)', kind: LATER, help: 'Lot 5b.' },
  { id: 'users', n: 10, title: 'Utilisateurs (objet par objet)', kind: LATER, help: 'Lot 5b : création comme user_import/creators.py, puis compte des applications et association des appareils.' },
  { id: 'funckeys', n: 11, title: 'Touches de fonction', kind: LATER, help: 'Lot 5c.' },
  { id: 'hunts', n: 12, title: 'Groupes, files, SVI, horaires', kind: LATER, help: 'Lot 5c.' },
  { id: 'incalls', n: 13, title: 'Appels entrants (SDA)', kind: LATER, help: 'Lot 5c.' },
  { id: 'dests', n: 14, title: 'Destinations (deuxième passe)', kind: LATER, help: 'Lot 5c.' },
  { id: 'phonebook', n: 15, title: 'Annuaire', kind: LATER, help: 'Lot 5d.' },
  { id: 'publicip', n: 16, title: 'IP publique du client (postes fixes)', kind: MANUAL,
    help: 'Réglage des paramètres globaux de la stack (tenant principal), hors de ce tenant.',
    todo: () => ['Si le client a des téléphones fixes : autoriser son IP publique dans les paramètres globaux de la stack (Portal, pbx.access-features).'] },
];

// Une étape est ouverte si toutes les précédentes (hors « à venir ») sont faites ou passées.
const done = (id) => ['done', 'manual', 'skipped'].includes(st(id).status);
function unlocked(i) { return STEPS.slice(0, i).every((s) => s.kind === LATER || done(s.id)); }

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
const STATUS = { todo: 'À faire', done: 'Écrite', manual: 'Faite à la main', skipped: 'Passée', error: 'Erreur' };
export function wizardTab() {
  const d = W.d; const w = d.write;
  const head = `<div class="titlerow"><h3>Écriture dans Wazo, étape par étape</h3>${helpButton('x3w-h', 'Aide : écriture guidée')}</div>
    ${helpBox('x3w-h', 'Ordre de la procédure de création de tenant : une étape s\'ouvre quand les précédentes sont faites (écrites, faites à la main ou passées). Étape automatique : « Préparer » relit le tenant et montre ce qui sera écrit ; « Écrire » demande confirmation ; « Annuler cette étape » défait ce qu\'elle a écrit (journal gardé dans le brouillon). Étape manuelle : valeurs à reporter dans le Portal, puis « Fait ». Tenant visé : celui ouvert dans le portail.')}
    <div class="card mg-card wide"><div class="ms-tools"><label>ID client <input data-w="clientId" value="${esc(w.clientId)}" class="x3-short" placeholder="44150"></label><label>Nom du client <input data-w="clientName" value="${esc(w.clientName)}" placeholder="D'CLIC ELEC" class="x3-mail"></label><span class="muted small">Tenant : ${esc(S.base ? new URL(S.base).host : '?')} · ${esc(I.tenant || 'hors portail')}</span></div>
    <p class="small muted">Noms produits : « ${esc(w.clientName || '<client>')} - Appels sortants », « ${esc(w.clientId || '<ID>')} - Attente », « ${esc(w.clientId || '<ID>')} - Prédécroché ».</p></div>`;
  const rows = STEPS.map((s, i) => stepCard(s, i)).join('');
  return head + `<div class="x3w-steps">${rows}</div>`;
}
function stepCard(s, i) {
  const state = st(s.id);
  const open = unlocked(i);
  const cls = s.kind === LATER ? 'later' : done(s.id) ? 'ok' : open ? 'open' : 'locked';
  const badge = s.kind === LATER ? 'À venir' : !open && !done(s.id) ? 'Verrouillée' : STATUS[state.status];
  let body = '';
  if (s.kind !== LATER && (open || done(s.id))) {
    body += `<p class="small muted">${esc(s.help)}</p>`;
    if (s.form && !done(s.id)) body += s.form();
    if (s.kind === MANUAL) {
      body += `<ol class="small x3w-todo">${s.todo().map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`;
      if (!done(s.id)) body += `<div class="btnrow"><button data-wact="manual" data-s="${s.id}" class="primary">Fait</button></div>`;
    }
    if (s.kind === AUTO) {
      const p = W.plan[s.id];
      if (p) {
        body += (p.blockers || []).map((b) => `<div class="compat blocking">${esc(b)}</div>`).join('');
        body += `<ul class="small x3w-plan">${p.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
        if (p.ops.length) body += `<details class="small"><summary>${p.ops.length} écriture(s)</summary><ol>${p.ops.map((o) => `<li><code>${esc(o.label)}</code></li>`).join('')}</ol></details>`;
      }
      if (W.msg[s.id]) body += `<div class="${W.msg[s.id].bad ? 'compat blocking' : 'mg-allok'}">${esc(W.msg[s.id].text)}</div>`;
      if (!done(s.id)) body += `<div class="btnrow"><button data-wact="plan" data-s="${s.id}" ${W.busy ? 'disabled' : ''}>Préparer</button>${p && !(p.blockers || []).length ? `<button data-wact="run" data-s="${s.id}" class="primary" ${W.busy ? 'disabled' : ''}>${p.ops.length ? `Écrire (${p.ops.length})` : 'Rien à écrire : marquer faite'}</button>` : ''}<button data-wact="skip" data-s="${s.id}">Déjà fait (passer)</button></div>`;
    }
    if (done(s.id)) {
      if (state.log.length) body += `<details class="small"><summary>Journal (${state.log.length})</summary><ul>${state.log.map((l) => `<li>${esc(new Date(l.at).toLocaleString('fr-FR'))} · ${esc(l.text)}</li>`).join('')}</ul></details>`;
      body += `<div class="btnrow">${state.undo?.length ? `<button data-wact="undo" data-s="${s.id}" class="danger" ${W.busy ? 'disabled' : ''}>Annuler cette étape</button>` : ''}<button data-wact="reopen" data-s="${s.id}">Rouvrir</button></div>`;
    }
  } else if (s.kind === LATER) body = `<p class="small muted">${esc(s.help)}</p>`;
  return `<div class="card x3w-step ${cls}"><div class="x3w-head"><span class="x3w-n">${s.n}</span><strong>${esc(s.title)}</strong><span class="spacer"></span><span class="x3w-badge ${cls}">${esc(badge)}</span>${s.kind === AUTO ? '<span class="muted small">auto</span>' : s.kind === MANUAL ? '<span class="muted small">manuel</span>' : ''}</div>${body}</div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export async function wizardChange(t) {
  if (!t.dataset.w) return false;
  W.d.write[t.dataset.w] = t.type === 'number' ? Number(t.value) : t.value.trim();
  for (const k of Object.keys(W.plan)) delete W.plan[k]; // l'aperçu dépend de ces valeurs
  save();
  return true;
}
async function runUndoOp(u) {
  if (!u) return;
  if (u.seq) { for (const x of u.seq) { try { await runUndoOp(x); } catch (e) { if (e.status !== 404) throw e; } } return; }
  if (u.api === 'logd') return logd(u.method, u.path, u.body);
  return tapi(u.method, u.path, u.body);
}
export async function wizardClick(b, rerender) {
  const id = b.dataset.s; const s = STEPS.find((x) => x.id === id); if (!s) return;
  const state = st(id);
  const log = (text) => state.log.push({ at: new Date().toISOString(), text });
  switch (b.dataset.wact) {
    case 'manual': {
      let v = null;
      try { v = s.verify ? await s.verify() : null; } catch { /* lecture impossible : la case suffit */ }
      if (s.verify && !v) { toast('Rien trouvé dans le tenant pour cette étape : vérifiez dans le Portal, puis relisez le tenant.', 7000); return rerender(); }
      state.status = 'manual'; state.at = new Date().toISOString(); log(`faite à la main${v ? ` (${v})` : ''}`); save(); return rerender();
    }
    case 'skip': state.status = 'skipped'; log('passée (déjà faite)'); save(); return rerender();
    case 'reopen': state.status = 'todo'; delete W.plan[id]; delete W.msg[id]; log('rouverte'); save(); return rerender();
    case 'plan': {
      W.busy = true; rerender();
      try { W.plan[id] = await s.plan(); delete W.msg[id]; } catch (e) { W.msg[id] = { bad: true, text: `Lecture impossible : ${e.message}` }; }
      W.busy = false; return rerender();
    }
    case 'run': {
      if (!canWrite()) return;
      const p = W.plan[id]; if (!p) return;
      if (!p.ops.length) { state.status = 'done'; log('rien à écrire (déjà conforme)'); save(); return rerender(); }
      return confirmModal(`<h3>Étape ${s.n} : ${esc(s.title)}</h3><ol class="small">${p.ops.map((o) => `<li><code>${esc(o.label)}</code></li>`).join('')}</ol><p class="small">Tenant : ${esc(I.tenant || '?')}. Chaque écriture est notée dans le journal de l'étape et peut être annulée.</p>`, async () => {
        W.busy = true; rerender();
        state.undo = state.undo || [];
        let n = 0;
        try {
          for (const o of p.ops) {
            const r = await o.run();
            n++;
            if (r?.undo) state.undo.push(r.undo);
            log(`${o.label}${r?.created ? ` → ${r.created}` : ''}`);
            save();
          }
          state.status = 'done'; state.at = new Date().toISOString();
          W.msg[id] = { text: `${n} écriture(s) faite(s).` };
        } catch (e) {
          state.status = 'error'; log(`ERREUR après ${n} écriture(s) : ${e.message}`);
          W.msg[id] = { bad: true, text: `Arrêt après ${n} écriture(s) sur ${p.ops.length} : ${e.message}. Les écritures faites sont dans le journal et annulables.` };
        }
        delete W.plan[id]; W.busy = false; save(); rerender();
      }, 'Écrire');
    }
    case 'undo': {
      if (!canWrite()) return;
      return confirmModal(`<h3>Annuler l'étape ${s.n} ?</h3><p class="small">${state.undo.length} écriture(s) défaite(s), dans l'ordre inverse.</p>`, async () => {
        W.busy = true; rerender();
        try {
          for (const u of [...state.undo].reverse()) { await runUndoOp(u); state.undo.pop(); save(); }
          state.status = 'todo'; log('annulée'); W.msg[id] = { text: 'Étape annulée.' };
        } catch (e) { log(`ERREUR à l'annulation : ${e.message}`); W.msg[id] = { bad: true, text: `Annulation interrompue : ${e.message}` }; }
        W.busy = false; save(); rerender();
      }, 'Annuler l\'étape');
    }
    default:
  }
}
export const wizardDone = () => STEPS.filter((s) => s.kind !== LATER && done(s.id)).length;
export const wizardTotal = () => STEPS.filter((s) => s.kind !== LATER).length;
