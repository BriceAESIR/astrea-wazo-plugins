// Migration Assistant — lot 2 : bascule monosite → multisite (sans DOM).
// Cadrage et règles lues dans le code : docs/MIGRATION-ASSISTANT.md, « Lot 2 ».
// Résumé :
//  - un seul PUT /extensions/{id} {context} par numéro : la ligne suit (xivo-dao
//    LineFixes), le contexte PJSIP est généré depuis la ligne (confgend) ;
//  - le commun inclut les sites en tête : les références numéro@commun
//    (SDA, destinations, membres de groupe) restent valables sans réécriture ;
//  - live reload coupé pendant toute l'opération, réactivé AVANT le dernier
//    déplacement (une écriture identique ne recharge rien, lu dans le notifier) ;
//  - journal de chaque écriture, annulation depuis le journal.
import { S, api, ApiError } from '../common/core.js?v=0.40.19';
import { I, sameTenant } from './inventory.js?v=0.40.19';
import { patternMatch } from './checks.js?v=0.40.19';

export const JOURNAL_FORMAT = 'astrea-multisite-journal';
const JOURNAL_KEY = 'astrea-migration-ms-journal-v1';
const LR_MARK = 'astrea-migration-lr-off';
const MARK = 'Astrea Migration Assistant';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Lecture : contextes sources et numéros déplaçables
// ---------------------------------------------------------------------------
// Contextes internes qui ont des lignes (candidats « commun »).
export function sourceContexts() {
  const n = new Map();
  for (const l of I.lists.line || []) if (I.by.context?.get(String(l.context))?.type === 'internal') n.set(l.context, (n.get(l.context) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([name, lines]) => ({ name, lines, ctx: I.by.context.get(String(name)) }));
}
// Numéros de poste du contexte source : une ligne par extension (une ligne
// partagée par deux utilisateurs = un seul numéro à déplacer).
export function movableExtensions(source) {
  const lineById = new Map((I.lists.line || []).map((l) => [l.id, l]));
  const userById = new Map((I.lists.user || []).map((u) => [u.id, u]));
  const uName = (u) => [u?.firstname, u?.lastname].filter(Boolean).join(' ') || u?.username || '';
  return (I.lists.extension || []).filter((e) => e.context === source && (e.lines || []).length && /^\d+$/.test(e.exten || ''))
    .map((e) => {
      const lines = (e.lines || []).map((x) => lineById.get(x.id)).filter(Boolean);
      const users = lines.flatMap((l) => (l.users || []).map((x) => userById.get(x.id) || I.userByUuid?.get(x.uuid) || x));
      return { id: e.id, exten: e.exten, context: e.context, lines, users, label: users.map(uName).filter(Boolean).join(', ') || lines.map((l) => l.name).join(', ') };
    })
    .sort((a, b) => Number(a.exten) - Number(b.exten) || a.exten.localeCompare(b.exten));
}

// ---------------------------------------------------------------------------
// Plages
// ---------------------------------------------------------------------------
// « 100-149, 160 » → [{start, end}] ; erreurs en texte.
export function parseRanges(txt) {
  const out = []; const errors = [];
  for (const part of String(txt || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) { errors.push(`« ${part} » n'est pas une plage (ex. 100-149)`); continue; }
    const start = m[1]; const end = m[2] ?? m[1];
    if (start.length !== end.length) { errors.push(`« ${part} » : début et fin doivent avoir le même nombre de chiffres (règle de confd)`); continue; }
    if (Number(start) > Number(end)) { errors.push(`« ${part} » : début après la fin`); continue; }
    out.push({ start, end });
  }
  return { ranges: out, errors };
}
export const rangesText = (r) => (r || []).map((x) => (x.start === x.end ? x.start : `${x.start}-${x.end}`)).join(', ');
// Plages compactes couvrant des numéros (suites consécutives de même longueur).
export function compactRanges(nums) {
  const s = [...new Set(nums)].filter((n) => /^\d+$/.test(n)).sort((a, b) => a.length - b.length || Number(a) - Number(b));
  const out = [];
  for (const n of s) {
    const last = out[out.length - 1];
    if (last && last.end.length === n.length && Number(n) === Number(last.end) + 1) last.end = n; else out.push({ start: n, end: n });
  }
  return out;
}
// Même règle que xivo_dao contextnumbers.in_range (comparaison numérique).
export const inRanges = (exten, ranges) => (ranges || []).some((r) => Number(r.start) <= Number(exten) && Number(exten) <= Number(r.end));

// ---------------------------------------------------------------------------
// Plan (lecture seule) : problèmes, écritures dans l'ordre, rechargements
// ---------------------------------------------------------------------------
// ms = { source, sites: [{ key, label, rangesText }], assign: Map(extId → siteKey), interSite }
const EMERGENCY = ['15', '17', '18', '112', '114'];
export function buildPlan(ms) {
  const problems = [];
  const err = (t) => problems.push({ sev: 'error', text: t });
  const warn = (t) => problems.push({ sev: 'warn', text: t });
  const common = I.by.context?.get(String(ms.source));
  if (!common) { err('Contexte commun introuvable : relisez l\'inventaire.'); return { problems, steps: [], sites: [] }; }
  const exts = movableExtensions(ms.source);
  const extById = new Map(exts.map((e) => [e.id, e]));
  const labels = new Set((I.lists.context || []).map((c) => String(c.label || '').trim().toLowerCase()));
  const seen = new Set();
  const sites = ms.sites.map((s) => {
    const label = String(s.label || '').trim();
    const { ranges, errors } = parseRanges(s.rangesText);
    const moved = [...ms.assign].filter(([, k]) => k === s.key).map(([id]) => extById.get(id)).filter(Boolean);
    if (!label) err('Un site n\'a pas de nom.');
    else if (seen.has(label.toLowerCase())) err(`Deux sites s'appellent « ${label} ».`);
    else if (labels.has(label.toLowerCase())) warn(`Un contexte « ${label} » existe déjà : le nouveau aura le même libellé (Wazo l'accepte, le nom technique diffère), source de confusion.`);
    seen.add(label.toLowerCase());
    for (const e of errors) err(`Site « ${label || '?'} » : ${e}.`);
    if (!ranges.length && !errors.length) err(`Site « ${label || '?'} » : aucune plage de numéros (confd refusera tout numéro).`);
    const out = moved.filter((e) => !inRanges(e.exten, ranges));
    if (out.length) err(`Site « ${label} » : ${out.map((e) => e.exten).join(', ')} hors de ses plages. Ajoutez-les aux plages, ou utilisez « Calculer les plages ».`);
    if (!moved.length) warn(`Site « ${label || '?'} » : aucun numéro affecté ; le contexte sera créé vide.`);
    return { ...s, label, ranges, moved };
  });
  if (!sites.length) err('Ajoutez au moins un site.');
  // Plages qui se chevauchent entre sites : accepté par Wazo, mais confus.
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    if (sites[i].ranges.some((a) => sites[j].ranges.some((b) => a.start.length === b.start.length && Number(a.start) <= Number(b.end) && Number(b.start) <= Number(a.end)))) warn(`Les plages de « ${sites[i].label} » et « ${sites[j].label} » se chevauchent.`);
  }
  // Numéros d'urgence depuis chaque futur contexte de site (inclusions futures).
  const futureIncludes = new Map((I.lists.context || []).map((c) => [c.name, (c.contexts || []).map((x) => x.name)]));
  const siteName = (s) => `@site:${s.key}`;
  futureIncludes.set(ms.source, [...sites.map(siteName), ...(futureIncludes.get(ms.source) || [])]);
  for (const s of sites) futureIncludes.set(siteName(s), [...(ms.interSite ? sites.filter((x) => x !== s).map(siteName) : []), ms.source]);
  const reach = (start) => { const seenC = new Set(); const todo = [start]; while (todo.length) { const n = todo.shift(); if (seenC.has(n)) continue; seenC.add(n); todo.push(...(futureIncludes.get(n) || [])); } return seenC; };
  for (const s of sites) {
    const r = reach(siteName(s));
    const miss = EMERGENCY.filter((n) => !(I.lists.outcall || []).some((o) => (o.extensions || []).some((e) => r.has(e.context) && patternMatch(e.exten, n))));
    if (miss.length) warn(`Depuis « ${s.label} », numéros d'urgence non routés : ${miss.join(', ')} (ils ne le sont pas non plus depuis le commun aujourd'hui ?).`);
  }
  // Écritures, dans l'ordre d'exécution.
  const steps = [];
  for (const s of sites) steps.push({ phase: 'ctx', site: s.key, text: `Créer le contexte interne « ${s.label} » (plages ${rangesText(s.ranges) || 'aucune'})` });
  for (const s of sites) {
    const inc = [...(ms.interSite ? sites.filter((x) => x !== s).map((x) => `« ${x.label} »`) : []), `commun « ${common.label || common.name} »`];
    steps.push({ phase: 'inc', site: s.key, text: `Inclusions de « ${s.label} » : ${inc.join(', ')}` });
  }
  steps.push({ phase: 'common', text: `Inclusions du commun « ${common.label || common.name} » : ${sites.map((s) => `« ${s.label} »`).join(', ')} en tête, puis ${(common.contexts || []).map((c) => `« ${c.label || c.name} »`).join(', ') || 'rien'} (inchangées)` });
  for (const s of sites) for (const e of s.moved) steps.push({ phase: 'move', site: s.key, extId: e.id, exten: e.exten, text: `${e.exten} (${e.label}) → « ${s.label} »` });
  const moves = steps.filter((x) => x.phase === 'move').length;
  return { problems, steps, sites, common, moves, ok: !problems.some((p) => p.sev === 'error') && moves > 0 };
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------
// Refuse tout appel si le portail a changé de tenant (même règle que Call Flow Manager).
async function tapi(method, path, body) {
  if (!sameTenant(I.tenant)) throw Object.assign(new Error('Le tenant a changé dans le portail : opération arrêtée, rien n\'est envoyé vers le nouveau tenant.'), { stale: true });
  return api(method, path, body);
}
// Live reload (règles vérifiées par User Manager, voir users/app.js) : réglage
// commun à tout le serveur, appel sans Wazo-Tenant.
export async function liveReload(method, body) {
  if (S.readonly && method !== 'GET') throw new Error(`Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${S.base}/api/confd/1.1/configuration/live_reload`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new ApiError(r.status, `live reload ${method} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}
export function lrMarkedByUs() { try { return (localStorage.getItem(LR_MARK) || '').startsWith(`${S.base}|`); } catch { return false; } }
function markLr(on) { try { if (on) localStorage.setItem(LR_MARK, `${S.base}|${new Date().toISOString()}`); else localStorage.removeItem(LR_MARK); } catch { /* */ } }
export async function enableLiveReload() {
  let e = null;
  for (let i = 0; i < 3; i++) { try { await liveReload('PUT', { enabled: true }); markLr(false); return true; } catch (x) { e = x; await sleep(1000); } }
  throw e;
}

export function saveJournal(j) { try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(j)); } catch { /* stockage indisponible : le fichier téléchargé fait foi */ } }
export function loadSavedJournal() { try { const j = JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null'); return j?.format === JOURNAL_FORMAT ? j : null; } catch { return null; } }
export function clearSavedJournal() { try { localStorage.removeItem(JOURNAL_KEY); } catch { /* */ } }


// Rechargements regroupés pour toute une opération (lu dans les notifiers de
// confd : contextes et inclusions → dialplan reload ; extension modifiée →
// dialplan + res_pjsip + chan_sccp + app_queue ; écriture identique → rien ;
// live reload coupé → rien, et le réactiver ne recharge rien).
// `body()` fait toutes les écritures sauf la dernière, live reload coupé ;
// `last()` fait la dernière, live reload réactivé : elle déclenche UN rechargement
// complet. Renvoie une note pour le rapport.
async function withGroupedReload(nWrites, body, last) {
  let grouped = false; let note = '';
  if (nWrites > 1) {
    try {
      const st = await liveReload('GET');
      if (st?.enabled) { await liveReload('PUT', { enabled: false }); markLr(true); grouped = true; } else note = 'Live reload déjà désactivé sur le serveur : laissé tel quel, rechargement à faire ensuite.';
    } catch (e) { note = `Regroupement des rechargements impossible (${e.message}) : un rechargement par écriture.`; }
  }
  try { await body(grouped); } catch (e) {
    if (grouped) { try { await enableLiveReload(); } catch { e.message += ' ; ÉCHEC de la réactivation du live reload : bouton du bandeau rouge'; } }
    throw e;
  }
  if (grouped) { await enableLiveReload(); note = 'Rechargements regroupés : un seul rechargement d\'Asterisk, à la dernière écriture.'; }
  await last();
  return note;
}
// Déplace un numéro, relu juste avant (arrêt s'il a changé depuis la lecture).
async function moveOne(m, log) {
  const cur = await tapi('GET', `/extensions/${m.extId}`);
  if (cur?.context === m.to) { log({ op: 'move', ...m, skipped: 'déjà dans le contexte cible' }); return; }
  if (cur?.context !== m.from || cur?.exten !== m.exten) throw new Error(`${m.exten} a changé depuis la lecture (maintenant ${cur?.exten}@${cur?.context}) : arrêt.`);
  await tapi('PUT', `/extensions/${m.extId}`, { context: m.to });
  log({ op: 'move', ...m });
}

export async function executePlan(plan, ms, onProgress = () => {}) {
  if (!plan.ok) throw new Error('Plan non valide');
  const j = {
    format: JOURNAL_FORMAT, version: 1, started_at: new Date().toISOString(), host: S.base, tenant: I.tenant,
    source: { name: plan.common.name, id: plan.common.id, label: plan.common.label },
    common_includes_before: null, created: [], entries: [], status: 'en cours', note: '',
  };
  const log = (e) => { j.entries.push({ at: new Date().toISOString(), ...e }); saveJournal(j); };
  saveJournal(j);
  const byKey = new Map();
  let moves = [];
  const nWrites = plan.sites.length * 2 + 1 + plan.moves;
  try {
    j.note = await withGroupedReload(nWrites, async (grouped) => {
      // 1. Contextes des sites
      for (const s of plan.sites) {
        onProgress(`Création du contexte « ${s.label} »`);
        const c = await tapi('POST', '/contexts', { label: s.label, type: 'internal', user_ranges: s.ranges, description: `Site créé par ${MARK} depuis ${plan.common.label || plan.common.name}` });
        if (!c?.id || !c?.name) throw new Error('POST /contexts : réponse sans id ni nom');
        byKey.set(s.key, c);
        j.created.push({ site: s.key, label: s.label, id: c.id, name: c.name });
        log({ op: 'create_context', id: c.id, name: c.name, label: s.label });
      }
      // 2. Inclusions des sites
      for (const s of plan.sites) {
        const ids = [...(ms.interSite ? plan.sites.filter((x) => x !== s).map((x) => byKey.get(x.key).id) : []), plan.common.id];
        await tapi('PUT', `/contexts/${byKey.get(s.key).id}/contexts`, { contexts: ids.map((id) => ({ id })) });
        log({ op: 'site_includes', id: byKey.get(s.key).id, contexts: ids });
      }
      // 3. Inclusions du commun (relues juste avant)
      const fresh = await tapi('GET', `/contexts/${plan.common.id}`);
      const before = (fresh?.contexts || []).map((c) => c.id);
      j.common_includes_before = before;
      const siteIds = plan.sites.map((s) => byKey.get(s.key).id);
      const after = [...siteIds, ...before.filter((id) => !siteIds.includes(id))];
      await tapi('PUT', `/contexts/${plan.common.id}/contexts`, { contexts: after.map((id) => ({ id })) });
      log({ op: 'common_includes', id: plan.common.id, before, after });
      saveJournal(j);
      // 4. Numéros, sauf le dernier
      moves = plan.steps.filter((x) => x.phase === 'move').map((x) => ({ extId: x.extId, exten: x.exten, from: plan.common.name, to: byKey.get(x.site).name }));
      for (const [i, m] of moves.slice(0, -1).entries()) {
        onProgress(`Déplacement des numéros : ${i + 1} / ${moves.length}`);
        await moveOne(m, log);
        if (!grouped) await sleep(300); // laisse Asterisk souffler entre deux rechargements
      }
    }, async () => {
      onProgress(`Déplacement des numéros : ${moves.length} / ${moves.length}`);
      await moveOne(moves[moves.length - 1], log); // déclenche le rechargement final
    });
    j.status = 'terminé';
  } catch (e) {
    j.status = 'interrompu'; j.error = e.message;
    saveJournal(j);
    throw Object.assign(e, { journal: j });
  }
  j.finished_at = new Date().toISOString();
  saveJournal(j);
  return j;
}

// Annulation depuis le journal : inclusions du commun restaurées, numéros remis
// dans leur contexte d'origine (le dernier déclenche le rechargement), puis
// contextes créés supprimés (refusé par Wazo s'ils contiennent encore un numéro).
export async function undoJournal(j, onProgress = () => {}) {
  if (j?.format !== JOURNAL_FORMAT) throw new Error('Ce fichier n\'est pas un journal de bascule multisite.');
  if (j.host !== S.base || j.tenant !== I.tenant) throw new Error('Ce journal concerne un autre serveur ou un autre tenant.');
  const report = [];
  const log = (e) => report.push(e);
  const back = j.entries.filter((e) => e.op === 'move' && !e.skipped).reverse().map((m) => ({ extId: m.extId, exten: m.exten, from: m.to, to: m.from }));
  const restoreIncludes = async () => {
    if (!Array.isArray(j.common_includes_before)) return;
    onProgress('Inclusions du commun');
    await tapi('PUT', `/contexts/${j.source.id}/contexts`, { contexts: j.common_includes_before.map((id) => ({ id })) });
    log({ op: 'common_includes', restored: j.common_includes_before });
  };
  const nWrites = back.length + (Array.isArray(j.common_includes_before) ? 1 : 0);
  const note = await withGroupedReload(nWrites, async (grouped) => {
    if (back.length) await restoreIncludes();
    for (const [i, m] of back.slice(0, -1).entries()) {
      onProgress(`Retour des numéros : ${i + 1} / ${back.length}`);
      await moveOne(m, log);
      if (!grouped) await sleep(300);
    }
  }, async () => {
    if (back.length) { onProgress(`Retour des numéros : ${back.length} / ${back.length}`); await moveOne(back[back.length - 1], log); } else await restoreIncludes();
  });
  for (const c of [...j.created].reverse()) {
    onProgress(`Suppression du contexte « ${c.label} »`);
    try { await tapi('DELETE', `/contexts/${c.id}`); log({ op: 'delete_context', id: c.id }); }
    catch (e) { log({ op: 'delete_context', id: c.id, label: c.label, error: e.message }); }
  }
  return { report, note };
}
