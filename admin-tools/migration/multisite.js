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
import { S, api, ApiError } from '../common/core.js?v=0.40.50';
import { I, sameTenant, membersOf, objLabel } from './inventory.js?v=0.40.50';
import { patternMatch, allDests } from './checks.js?v=0.40.50';
import { worldOf, route, siteSlug } from './3cx-sites.js?v=0.40.50';
import { userContext } from '../callflow/dialsim.js?v=0.40.50';

// ---------------------------------------------------------------------------
// Jeu de contextes par site et cloisonnement (demande de Brice, 06/11/2026)
// ---------------------------------------------------------------------------
// Nommage de l'import 3CX : <ID client>-<site>-internal / to-extern / from-extern.
// Les inclusions sont suivies en cascade par Asterisk (un contexte inclus apporte
// ses propres inclusions) : si le commun inclut les sites et que chaque site
// inclut le commun, tous les sites se joignent par le commun. D'où :
//  - mesh : tous les sites s'appellent ; le commun inclut les sites (références
//    numéro@commun et utilisateurs restés dans le commun : tout reste joignable) ;
//  - pairs / isolated : le commun n'inclut PAS les sites (sinon le cloisonnement
//    fuit par lui) ; chaque site inclut les sites liés, puis le commun (groupes,
//    files, utilisateurs restés). Les références numéro@commun vers un numéro
//    déplacé cassent : relevées avant écriture (réécriture : lot suivant).
export const PARTITIONS = { mesh: 'Tous les sites s\'appellent', pairs: 'Liens choisis entre sites', isolated: 'Sites isolés (aucun appel interne entre sites)' };
export const linkKey = (a, b) => [a, b].sort().join('|');
export const partitionOf = (ms) => (PARTITIONS[ms.partition] ? ms.partition : 'mesh');
export const linked = (ms, a, b) => a !== b && (partitionOf(ms) === 'mesh' || (partitionOf(ms) === 'pairs' && (ms.links || []).includes(linkKey(a, b))));
export const commonIncludesSites = (ms) => partitionOf(ms) === 'mesh';
export function siteNames(ms, s) {
  const id = String(ms.clientId || '').trim() || '<ID>'; const slug = siteSlug(s.label);
  return { ctx: s.ctxLabel || `${id}-${slug}-internal`, out: s.outLabel || `${id}-${slug}-to-extern`, inc: s.incLabel || `${id}-${slug}-from-extern` };
}

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
// ms = { source, clientId, partition, links: [« a|b »], sites: [{ key, label, rangesText, ctxLabel?, outLabel?, incLabel? }], assign: Map(extId → siteKey) }
const EMERGENCY = ['15', '17', '18', '112', '114'];
// Inclusions d'un site, dans l'ordre : son sortant, les sites liés, le commun.
const siteIncludes = (ms, sites, s, idOf) => [idOf(s, 'out'), ...sites.filter((x) => linked(ms, s.key, x.key)).map((x) => idOf(x, 'ctx')), idOf(null, 'common')];
export function buildPlan(ms) {
  const problems = [];
  const err = (t) => problems.push({ sev: 'error', text: t });
  const warn = (t) => problems.push({ sev: 'warn', text: t });
  const common = I.by.context?.get(String(ms.source));
  if (!common) { err('Contexte commun introuvable : relisez l\'inventaire.'); return { problems, steps: [], sites: [] }; }
  const exts = movableExtensions(ms.source);
  const extById = new Map(exts.map((e) => [e.id, e]));
  const labels = new Set((I.lists.context || []).map((c) => String(c.label || '').trim().toLowerCase()));
  if (!String(ms.clientId || '').trim()) err('ID client manquant : il sert au nom des contextes (<ID client>-<site>-internal…).');
  const seen = new Set();
  const sites = ms.sites.map((s) => {
    const label = String(s.label || '').trim();
    const { ranges, errors } = parseRanges(s.rangesText);
    const moved = [...ms.assign].filter(([, k]) => k === s.key).map(([id]) => extById.get(id)).filter(Boolean);
    const names = siteNames(ms, { ...s, label });
    if (!label) err('Un site n\'a pas de nom.');
    for (const n of Object.values(names)) {
      if (seen.has(n.toLowerCase())) err(`Deux contextes s'appelleraient « ${n} ».`);
      else if (labels.has(n.toLowerCase())) warn(`Un contexte « ${n} » existe déjà : le nouveau aura le même libellé (Wazo l'accepte, le nom technique diffère), source de confusion.`);
      seen.add(n.toLowerCase());
    }
    for (const e of errors) err(`Site « ${label || '?'} » : ${e}.`);
    if (!ranges.length && !errors.length) err(`Site « ${label || '?'} » : aucune plage de numéros (confd refusera tout numéro).`);
    const out = moved.filter((e) => !inRanges(e.exten, ranges));
    if (out.length) err(`Site « ${label} » : ${out.map((e) => e.exten).join(', ')} hors de ses plages. Ajoutez-les aux plages, ou utilisez « Calculer les plages ».`);
    if (!moved.length) warn(`Site « ${label || '?'} » : aucun numéro affecté ; ses contextes seront créés vides.`);
    return { ...s, label, ranges, moved, names };
  });
  if (!sites.length) err('Ajoutez au moins un site.');
  // Plages qui se chevauchent entre sites : accepté par Wazo, mais confus.
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    if (sites[i].ranges.some((a) => sites[j].ranges.some((b) => a.start.length === b.start.length && Number(a.start) <= Number(b.end) && Number(b.start) <= Number(a.end)))) warn(`Les plages de « ${sites[i].label} » et « ${sites[j].label} » se chevauchent.`);
  }
  const sim = simulate(ms, sites, common);
  problems.push(...sim.issues);
  // Écritures, dans l'ordre d'exécution.
  const steps = [];
  for (const s of sites) steps.push({ phase: 'ctx', site: s.key, text: `Créer les contextes « ${s.names.ctx} » (interne, plages ${rangesText(s.ranges) || 'aucune'}), « ${s.names.out} » (sortant, vide : il sort par le commun tant qu'il n'a pas de règle) et « ${s.names.inc} » (entrant, vide)` });
  const lbl = (s, k) => (k === 'common' ? `commun « ${common.label || common.name} »` : k === 'out' ? `« ${s.names.out} »` : `« ${s.names.ctx} »`);
  for (const s of sites) steps.push({ phase: 'inc', site: s.key, text: `Inclusions de « ${s.names.ctx} » : ${siteIncludes(ms, sites, s, lbl).join(', ')}` });
  if (commonIncludesSites(ms)) steps.push({ phase: 'common', text: `Inclusions du commun « ${common.label || common.name} » : ${sites.map((s) => `« ${s.names.ctx} »`).join(', ')} en tête, puis ${(common.contexts || []).map((c) => `« ${c.label || c.name} »`).join(', ') || 'rien'} (inchangées)` });
  for (const s of sites) for (const e of s.moved) steps.push({ phase: 'move', site: s.key, extId: e.id, exten: e.exten, text: `${e.exten} (${e.label}) → « ${s.names.ctx} »` });
  const moves = steps.filter((x) => x.phase === 'move').length;
  return { problems, steps, sites, common, moves, sim, ok: !problems.some((p) => p.sev === 'error') && moves > 0 };
}

// ---------------------------------------------------------------------------
// Simulation avant / après (moteur de l'import 3CX : extensions du contexte,
// ses règles sortantes, puis les contextes inclus dans l'ordre, chacun une fois)
// ---------------------------------------------------------------------------
const vname = (s, k) => `@site:${s.key}:${k}`;
function futureWorld(ms, sites, common) {
  const w = worldOf({ contexts: I.lists.context || [], extensions: I.lists.extension || [], outcalls: I.lists.outcall || [] });
  const f = { ctx: new Map([...w.ctx].map(([k, v]) => [k, { ...v, includes: [...v.includes] }])), exts: new Map(w.exts), outs: new Map([...w.outs].map(([k, v]) => [k, [...v]])) };
  const nm = (s, k) => (k === 'common' ? common.name : vname(s, k));
  for (const s of sites) {
    f.ctx.set(vname(s, 'out'), { name: vname(s, 'out'), label: s.names.out, type: 'outcall', includes: [] });
    f.ctx.set(vname(s, 'inc'), { name: vname(s, 'inc'), label: s.names.inc, type: 'incall', includes: [] });
    f.ctx.set(vname(s, 'ctx'), { name: vname(s, 'ctx'), label: s.names.ctx, type: 'internal', includes: siteIncludes(ms, sites, s, nm) });
    for (const e of s.moved) { const k = `${e.exten}@${common.name}`; const x = f.exts.get(k); f.exts.delete(k); f.exts.set(`${e.exten}@${vname(s, 'ctx')}`, { ...(x || { users: 1 }), ctx: vname(s, 'ctx') }); }
  }
  if (commonIncludesSites(ms)) f.ctx.get(common.name).includes = [...sites.map((s) => vname(s, 'ctx')), ...f.ctx.get(common.name).includes.filter((x) => !x.startsWith('@site:'))];
  return { before: w, after: f };
}
const SIM_EXT = [['15', 'SAMU'], ['112', 'urgences'], ['0240000000', 'fixe'], ['0612345678', 'mobile'], ['0033123456789', 'international']];
// Résultat lisible d'une recherche.
const simText = (w, r) => (r.kind === 'internal' ? `interne · ${w.ctx.get(r.ctx)?.label || r.ctx}` : r.kind === 'out' ? `sortant · règle « ${r.rule} »` : 'non routé');
export function simulate(ms, sites, common) {
  const issues = []; const rows = [];
  if (!sites.length) return { issues, rows, cols: [] };
  const { before, after } = futureWorld(ms, sites, common);
  const cName = common.label || common.name;
  // Une cible par site (son premier numéro), une pour le commun (premier numéro resté), puis l'extérieur.
  const stay = (I.lists.extension || []).filter((e) => e.context === common.name && /^\d+$/.test(e.exten || '') && !sites.some((s) => s.moved.some((m) => m.exten === e.exten)));
  const cols = [
    ...sites.filter((s) => s.moved.length).map((s) => ({ n: s.moved[0].exten, what: `site ${s.label}`, site: s })),
    ...(stay.length ? [{ n: stay[0].exten, what: `commun (${stay[0].group ? 'groupe' : stay[0].queue ? 'file' : 'poste'})`, common: true }] : []),
    ...SIM_EXT.map(([n, what]) => ({ n, what, ext: true })),
  ];
  const froms = [...sites.map((s) => ({ ctx: vname(s, 'ctx'), label: s.names.ctx, site: s })), { ctx: common.name, label: `commun ${cName}`, common: true }];
  for (const fr of froms) {
    const cells = cols.map((c) => {
      // Avant : tout le monde compose depuis le commun.
      const b = route(before, common.name, c.n); const a = route(after, fr.ctx, c.n);
      // Attendu : un site joint son propre numéro, les sites liés, le commun ; le commun joint les sites seulement en « mesh ».
      let want = null;
      if (c.site) want = fr.site ? (fr.site === c.site || linked(ms, fr.site.key, c.site.key)) : commonIncludesSites(ms);
      else if (c.common) want = true;
      const ok = want == null ? a.kind === 'out' || a.kind === b.kind : want ? a.kind === 'internal' && (!c.site || a.ctx === vname(c.site, 'ctx')) : a.kind !== 'internal';
      return { before: simText(before, b), after: simText(after, a), ok, want };
    });
    rows.push({ from: fr.label, cells });
    cells.forEach((x, i) => {
      if (x.ok) return; const c = cols[i];
      if (x.want === false) issues.push({ sev: 'error', text: `Cloisonnement : depuis « ${fr.label} », ${c.n} (${c.what}) reste joignable (${x.after}).` });
      else if (x.want === true) issues.push({ sev: 'error', text: `Depuis « ${fr.label} », ${c.n} (${c.what}) n'est plus joignable en interne : ${x.after}.` });
      // Extérieur : visible dans le tableau ; les urgences ont leur propre contrôle ci-dessous.
    });
  }
  // Urgences depuis chaque site.
  for (const s of sites) { const miss = EMERGENCY.filter((n) => route(after, vname(s, 'ctx'), n).kind !== 'out'); if (miss.length) issues.push({ sev: 'warn', text: `Depuis « ${s.names.ctx} », numéros d'urgence non routés : ${miss.join(', ')}.` }); }
  // Références numéro@contexte vers un numéro déplacé, cherchées depuis leur contexte après la bascule.
  const moved = new Map(sites.flatMap((s) => s.moved.map((m) => [m.exten, s])));
  const refs = [];
  for (const x of allDests()) if (x.dest?.type === 'extension' && moved.has(x.dest.exten)) refs.push({ from: x.dest.context, n: x.dest.exten, what: `${objLabel(x.type, x.obj)}, ${x.slot}` });
  for (const t of ['group', 'queue']) for (const o of I.lists[t] || []) for (const m of membersOf(o).extensions) if (moved.has(m.exten)) refs.push({ from: m.context, n: m.exten, what: `membre ${m.exten} de ${t === 'group' ? 'groupe' : 'file'} ${o.label || o.name}` });
  const ctxOfUser = (u) => { const c = userContext(u); const e = (u.lines?.[0]?.extensions || [])[0]; const s = e && c === common.name ? moved.get(e.exten) : null; return s ? vname(s, 'ctx') : c; };
  for (const u of I.lists.user || []) for (const [pos, k] of Object.entries(I.funckeys?.[u.uuid] || {})) if (k?.destination?.type === 'custom' && moved.has(k.destination.exten)) refs.push({ from: ctxOfUser(u), n: k.destination.exten, what: `touche ${pos} de ${[u.firstname, u.lastname].filter(Boolean).join(' ')}` });
  const broken = refs.filter((r) => r.from && route(after, r.from, r.n).kind !== 'internal');
  if (broken.length) issues.push({ sev: 'error', text: `${broken.length} référence(s) « numéro » vers un numéro déplacé ne le trouveront plus (${broken.slice(0, 5).map((r) => `${r.what} → ${r.n}`).join(' ; ')}${broken.length > 5 ? '…' : ''}). Choisir « Tous les sites s'appellent » (le commun inclut alors les sites), ou attendre la réécriture des références (lot suivant).` });
  return { issues, rows, cols };
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
  const byKey = new Map(); // clé du site → { ctx, out, inc } (contextes créés)
  let moves = [];
  const withCommon = commonIncludesSites(ms);
  const nWrites = plan.sites.length * 4 + (withCommon ? 1 : 0) + plan.moves;
  j.partition = partitionOf(ms);
  try {
    j.note = await withGroupedReload(nWrites, async (grouped) => {
      // 1. Contextes des sites : sortant et entrant d'abord (vides), puis l'interne avec ses plages.
      const desc = `Site créé par ${MARK} depuis ${plan.common.label || plan.common.name}`;
      for (const s of plan.sites) {
        onProgress(`Création des contextes de « ${s.label} »`);
        const made = {};
        for (const [role, body] of [['out', { label: s.names.out, type: 'outcall' }], ['inc', { label: s.names.inc, type: 'incall' }], ['ctx', { label: s.names.ctx, type: 'internal', user_ranges: s.ranges }]]) {
          const c = await tapi('POST', '/contexts', { ...body, description: desc });
          if (!c?.id || !c?.name) throw new Error('POST /contexts : réponse sans id ni nom');
          made[role] = c;
          j.created.push({ site: s.key, role, label: body.label, id: c.id, name: c.name });
          log({ op: 'create_context', role, id: c.id, name: c.name, label: body.label });
        }
        byKey.set(s.key, made);
      }
      // 2. Inclusions de chaque site : son sortant, les sites liés (cloisonnement choisi), le commun.
      const idOf = (s, k) => (k === 'common' ? plan.common.id : byKey.get(s.key)[k].id);
      for (const s of plan.sites) {
        const ids = siteIncludes(ms, plan.sites, s, idOf);
        await tapi('PUT', `/contexts/${byKey.get(s.key).ctx.id}/contexts`, { contexts: ids.map((id) => ({ id })) });
        log({ op: 'site_includes', id: byKey.get(s.key).ctx.id, contexts: ids });
      }
      // 3. Inclusions du commun (relues juste avant), seulement si tous les sites s'appellent :
      //    sinon le commun ouvrirait les sites les uns aux autres.
      if (withCommon) {
        const fresh = await tapi('GET', `/contexts/${plan.common.id}`);
        const before = (fresh?.contexts || []).map((c) => c.id);
        j.common_includes_before = before;
        const siteIds = plan.sites.map((s) => byKey.get(s.key).ctx.id);
        const after = [...siteIds, ...before.filter((id) => !siteIds.includes(id))];
        await tapi('PUT', `/contexts/${plan.common.id}/contexts`, { contexts: after.map((id) => ({ id })) });
        log({ op: 'common_includes', id: plan.common.id, before, after });
      }
      saveJournal(j);
      // 4. Numéros, sauf le dernier
      moves = plan.steps.filter((x) => x.phase === 'move').map((x) => ({ extId: x.extId, exten: x.exten, from: plan.common.name, to: byKey.get(x.site).ctx.name }));
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
  // Contextes créés : interne d'abord (il inclut le sortant), puis sortant et entrant, ordre inverse
  // de la création. Refus de Wazo noté sans arrêter (contexte qui contient encore quelque chose).
  const dels = [...j.created].reverse();
  const del = async (c) => {
    onProgress(`Suppression du contexte « ${c.label} »`);
    try { await tapi('DELETE', `/contexts/${c.id}`); log({ op: 'delete_context', id: c.id }); }
    catch (e) { log({ op: 'delete_context', id: c.id, label: c.label, error: e.message }); }
  };
  // Un seul rechargement : inclusions, numéros sauf le dernier, contextes des autres sites (vides),
  // live reload coupé ; puis le dernier numéro, live reload réactivé (vraie modification : elle
  // recharge à coup sûr, une suppression refusée ne rechargerait rien) ; enfin les contextes de
  // son site, qui ne pouvaient pas être supprimés avant (un rechargement chacun, trois au plus).
  const lastSite = back.length ? j.created.find((c) => c.name === back[back.length - 1].from)?.site : null;
  const early = dels.filter((c) => c.site !== lastSite); const late = dels.filter((c) => c.site === lastSite);
  const nWrites = back.length + (Array.isArray(j.common_includes_before) ? 1 : 0) + early.length;
  const note = await withGroupedReload(nWrites, async (grouped) => {
    if (back.length) await restoreIncludes();
    for (const [i, m] of back.slice(0, -1).entries()) {
      onProgress(`Retour des numéros : ${i + 1} / ${back.length}`);
      await moveOne(m, log);
      if (!grouped) await sleep(300);
    }
    if (back.length) for (const c of early) await del(c);
  }, async () => {
    if (back.length) { onProgress(`Retour des numéros : ${back.length} / ${back.length}`); await moveOne(back[back.length - 1], log); } else await restoreIncludes();
  });
  const after = back.length ? late : dels;
  for (const c of after) await del(c);
  return { report, note: `${note}${after.length ? ` Puis ${after.length} suppression(s) de contexte, un rechargement chacune.` : ''}` };
}
