// Call Flow Manager — simulation d'un numéro composé (demande de Brice,
// 16/10/2026) et lecture des motifs des règles sortantes. Sans DOM.
// Vérifié :
//  - Asterisk (main/pbx.c, ext_cmp, ext_cmp_pattern_pos) : un numéro exact passe
//    avant tout motif ; entre motifs, le plus précis l'emporte, position par
//    position (chiffre < [ensemble] selon sa taille < N (8) < Z (9) < X (10)
//    < « . » < « ! ») ; égalité : plus petits caractères d'abord ; les « - »
//    sont ignorés. pbx_find_extension : extensions du contexte d'abord, puis
//    contextes inclus, dans l'ordre.
//  - wazo-agid (handlers/outgoingfeatures.py) : numéro envoyé = numéro composé,
//    moins strip_digits premiers chiffres, précédé de external_prefix. Le champ
//    « prefix » est lu mais pas appliqué.
// Supposé : effet exact des autorisations d'appels et d'un horaire sur une
// règle sortante (affichés à titre indicatif).
import { M, scheduleState, whenOf, entity, groupMemberList } from './model.js?v=0.40.4';

// Motif → liste d'éléments { set: chaînes de caractères, size } | { dot } | { bang } ; null si numéro exact.
export function parsePattern(p) {
  // « - » ignoré hors des crochets seulement : dedans, c'est un intervalle ([1-5]).
  // Correctif du 16/10/2026 : tous les « - » étaient retirés, [1-5] était lu [15].
  p = String(p || '').replace(/\[[^\]]*\]|-/g, (m) => (m === '-' ? '' : m));
  if (!p.startsWith('_')) return null;
  const out = []; const s = p.slice(1);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[') {
      const j = s.indexOf(']', i); const body = j > i ? s.slice(i + 1, j) : s.slice(i + 1);
      const set = new Set();
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === '-' && body[k + 2]) { for (let x = body.charCodeAt(k); x <= body.charCodeAt(k + 2); x++) set.add(String.fromCharCode(x)); k += 2; } else set.add(body[k]);
      }
      out.push({ set, size: set.size }); i = j > i ? j : s.length;
    } else if (/[xX]/.test(c)) out.push({ set: new Set('0123456789'), size: 10 });
    else if (/[zZ]/.test(c)) out.push({ set: new Set('123456789'), size: 9 });
    else if (/[nN]/.test(c)) out.push({ set: new Set('23456789'), size: 8 });
    else if (c === '.') out.push({ dot: true, size: 1e6 });
    else if (c === '!') out.push({ bang: true, size: 2e6 });
    else out.push({ set: new Set([c]), size: 1 });
  }
  return out;
}
export function matches(pattern, number) {
  const t = parsePattern(pattern);
  const n = String(number).replace(/-/g, '');
  if (!t) return String(pattern).replace(/-/g, '') === n;
  const go = (i, j) => {
    if (j === t.length) return i === n.length;
    const e = t[j];
    if (e.bang) return true;
    if (e.dot) return i < n.length;
    return i < n.length && e.set.has(n[i]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}
// Ordre d'Asterisk : < 0 si a est plus précis que b.
export function comparePatterns(a, b) {
  const ta = parsePattern(a), tb = parsePattern(b);
  if (!ta || !tb) return (ta ? 1 : 0) - (tb ? 1 : 0);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    if (ta[i].size !== tb[i].size) return ta[i].size - tb[i].size;
    const ma = ta[i].set ? [...ta[i].set].sort().join('') : '', mb = tb[i].set ? [...tb[i].set].sort().join('') : '';
    if (ma !== mb) return ma < mb ? -1 : 1;
  }
  return ta.length - tb.length;
}

// Famille courte d'un motif (titre d'une sortie qui regroupe des motifs) :
// « urgences », « fixes », « mobiles », « international », « tout le reste »…
const URG = new Set(['15', '17', '18', '112', '114', '115', '119', '_116XXX']);
const FAM_SHORT = { 'fixe (01 à 05)': 'fixes', 'mobile (06, 07)': 'mobiles', 'mobile (06)': 'mobiles', 'mobile (07)': 'mobiles', 'numéros spéciaux (08)': 'spéciaux (08)', 'non géographique (09)': '09', 'national (10 chiffres)': 'national', 'international (00…)': 'international', 'international (+…)': 'international', 'urgences et services courts (1x, 11x)': 'urgences', 'services 3xxx': 'courts 3xxx' };
export function famLabel(p) {
  if (URG.has(String(p))) return 'urgences';
  const d = describePattern(p); const f = d.includes(' · ') ? d.split(' · ')[0] : '';
  if (f) return FAM_SHORT[f] || f;
  return /^_[XZN]?[.!]$/i.test(String(p)) ? 'tout le reste' : String(p);
}
// Description lisible d'un motif (« 10 chiffres, commence par 01 à 05 »), avec
// les familles françaises courantes reconnues.
export function describePattern(p) {
  const t = parsePattern(p);
  if (!t) return `numéro exact ${p}`;
  const has = (e, chars) => e.set && [...chars].every((c) => e.set.has(c)) && e.set.size === chars.length;
  const fixed = t.every((e) => e.set);
  const len = t.length;
  const fam = (() => {
    if (fixed && len === 10 && has(t[0], '0')) {
      if (has(t[1], '12345')) return 'fixe (01 à 05)';
      if (has(t[1], '67')) return 'mobile (06, 07)';
      if (has(t[1], '6')) return 'mobile (06)';
      if (has(t[1], '7')) return 'mobile (07)';
      if (has(t[1], '8')) return 'numéros spéciaux (08)';
      if (has(t[1], '9')) return 'non géographique (09)';
      if (t[1].size === 10 || t[1].size === 9) return 'national (10 chiffres)';
    }
    if (t[0] && has(t[0], '0') && t[1] && has(t[1], '0') && t.slice(2).some((e) => e.dot || e.bang)) return 'international (00…)';
    if (has(t[0] || {}, '+')) return 'international (+…)';
    if (fixed && len <= 3 && has(t[0], '1')) return 'urgences et services courts (1x, 11x)';
    if (fixed && len === 4 && has(t[0], '3')) return 'services 3xxx';
    return '';
  })();
  // Début fixe : chiffres seuls en tête.
  let lead = ''; for (const e of t) { if (e.set && e.size === 1) lead += [...e.set][0]; else break; }
  const tail = t.some((e) => e.dot) ? 'longueur libre' : t.some((e) => e.bang) ? 'longueur libre (ou rien)' : `${len} chiffre${len > 1 ? 's' : ''}`;
  return [fam, lead ? `${tail}, commence par ${lead}` : tail].filter(Boolean).join(' · ');
}

// Numéro envoyé sur le trunk (vérifié, wazo-agid).
export function dialedNumber(number, dp) {
  let n = String(number);
  if (dp?.strip_digits > 0) n = n.slice(dp.strip_digits);
  if (dp?.external_prefix) n = dp.external_prefix + n;
  return n;
}

// ---------------------------------------------------------------------------
// Autorisations d'appels (demande de Brice, 16/10/2026 : « ce qu'il peut
// bloquer »). Vérifié dans wazo-agid (modules/user_set_call_rights.py,
// call_rights.py, master) :
//  - motif d'une autorisation : « _ » retiré, X → [0-9], Z → [1-9], N → [2-9],
//    « . » → .+, « ! » → .*, + et * littéraux, le reste en expression
//    régulière (ex. [1-5]) ; doit couvrir tout le numéro ;
//  - on ne garde que les autorisations dont un motif correspond au numéro
//    composé ; aucune → appel autorisé ;
//  - puis, dans l'ordre : celles de l'utilisateur, celles des groupes dont il
//    est membre, celles de la règle sortante. Au premier niveau qui en a
//    (activées) : une seule « autoriser » suffit ; sinon refus, avec le code de
//    la dernière lue (le code personnel de l'utilisateur remplace celui de ses
//    autorisations). Aucun niveau concerné → autorisé.
// Supposé : refus avec code = Asterisk demande le code puis laisse passer.
// ---------------------------------------------------------------------------
export function rightMatches(number, pattern) {
  let re = String(pattern || '');
  // Motif saisi par un admin de tenant : seulement les caractères d'un motif (audit, risque de regex piège).
  if (!/^[0-9XZN.!_+*#\[\]-]{1,80}$/.test(re)) return false;
  for (const [k, v] of [['_', ''], ['*', '\\*'], ['+', '\\+'], ['X', '[0-9]'], ['Z', '[1-9]'], ['N', '[2-9]'], ['.', '.+'], ['!', '.*']]) re = re.split(k).join(v);
  try { return new RegExp(`^${re}$`).test(String(number)); } catch { return false; }
}
// Autorisations d'un objet : champ call_permissions de l'objet, ou listes users / groups / outcalls de l'autorisation.
function rightsOf(kind, o) {
  if (!o) return [];
  const ids = new Set((o.call_permissions || []).map((p) => String(p.id)));
  const back = { user: (p) => (p.users || []).some((u) => u.uuid === o.uuid || u.id === o.id), group: (p) => (p.groups || []).some((g) => g.uuid === o.uuid || g.id === o.id), outcall: (p) => (p.outcalls || []).some((x) => x.id === o.id) }[kind];
  return (M.lists.callpermission || []).filter((p) => ids.has(String(p.id)) || back?.(p));
}
// Groupes dont l'utilisateur est membre (membre fixe).
export const groupsOfUser = (u) => (u ? (M.lists.group || []).filter((g) => (g.members?.users || []).some((m) => m.uuid === u.uuid)) : []);
// Autorisations qui s'appliquent à un appel passé par user via outcall, dans
// l'ordre d'évaluation : [{ level, p, via? }] (via = nom du groupe).
export function rightsList(user, outcall) {
  const out = []; const seen = new Set();
  const add = (level, list, via) => { for (const p of list) { const k = `${level}|${p.id}`; if (!seen.has(k)) { seen.add(k); out.push({ level, p, via }); } } };
  if (user) { add('user', rightsOf('user', user)); for (const g of groupsOfUser(user)) add('group', rightsOf('group', g), g.label || g.name); }
  if (outcall) add('outcall', rightsOf('outcall', outcall));
  return out;
}
// → { verdict: 'allow' | 'deny', level: 'user' | 'group' | 'outcall' | null, by: autorisation, code: bool, matched: [autorisations] }
export function callRights(number, user, outcall) {
  const n = String(number || '');
  const matched = (M.lists.callpermission || []).filter((p) => (p.extensions || []).some((x) => rightMatches(n, x)));
  if (!matched.length) return { verdict: 'allow', level: null, matched };
  const ids = new Set(matched.map((p) => String(p.id)));
  const on = (list) => list.filter((p) => ids.has(String(p.id)) && p.enabled !== false);
  const levels = [];
  if (user) {
    levels.push(['user', on(rightsOf('user', user))]);
    levels.push(['group', on(groupsOfUser(user).flatMap((g) => rightsOf('group', g)))]);
  }
  if (outcall) levels.push(['outcall', on(rightsOf('outcall', outcall))]);
  for (const [level, rows] of levels) {
    if (!rows.length) continue;
    const ok = rows.find((p) => p.mode === 'allow');
    if (ok) return { verdict: 'allow', level, by: ok, matched };
    const last = rows[rows.length - 1];
    return { verdict: 'deny', level, by: last, code: !!(last.password || (level === 'user' && user?.call_permission_password)), matched };
  }
  return { verdict: 'allow', level: null, matched };
}

// Où va un numéro composé depuis un contexte.
export function simulate(number, fromCtx, user = null, when = null) {
  const n = String(number || '').replace(/[\s.()-]/g, '');
  const steps = []; const seen = new Set();
  if (!n) return { steps, result: null };
  if (n.startsWith('*')) return { steps, result: { kind: 'feature', note: 'code de service Wazo (*…) : non simulé' } };
  const outcallPatterns = (ctx) => (M.lists.outcall || []).flatMap((o) => (o.extensions || []).filter((e) => e.context === ctx).map((e) => ({ outcall: o, dp: e })));
  const search = (ctx, depth) => {
    if (!ctx || seen.has(ctx)) return null; seen.add(ctx);
    const c = M.by.context?.get(ctx);
    steps.push({ ctx, label: c?.label || ctx, type: c?.type, depth });
    const exact = M.ext.get(`${n}@${ctx}`);
    if (exact) return { kind: exact.startsWith('incall:') ? 'incall' : 'internal', key: exact, ctx };
    // Contexte entrant : la SDA peut être déclarée sur ses derniers chiffres
    // (did_length des plages entrantes ; supposé : seuls ces chiffres comptent).
    if (c?.type === 'incall') {
      // Format international reçu de l'opérateur (+33… / 0033…) : forme nationale 0… essayée aussi (supposé).
      const nat = n.replace(/^(\+|00)33/, '0');
      if (nat !== n && M.ext.get(`${nat}@${ctx}`)) return { kind: 'incall', key: M.ext.get(`${nat}@${ctx}`), ctx, viaDid: nat };
      for (const len of [...new Set((c.incall_ranges || []).map((r) => r.did_length).filter(Boolean))]) {
        const k = n.length > len ? M.ext.get(`${n.slice(-len)}@${ctx}`) : null;
        if (k) return { kind: 'incall', key: k, ctx, viaDid: n.slice(-len) };
      }
    }
    const cand = outcallPatterns(ctx).filter((x) => matches(x.dp.exten, n)).sort((a, b) => comparePatterns(a.dp.exten, b.dp.exten));
    if (cand.length) {
      const best = cand[0]; const o = best.outcall;
      const sched = (o.schedules || [])[0] && M.by.schedule?.get(String(o.schedules[0].id));
      const st = sched && when ? scheduleState(sched, when) : null;
      return { kind: 'outcall', ctx, outcall: o, dp: best.dp, others: cand.slice(1), sent: dialedNumber(n, best.dp), trunks: (o.trunks || []).map((t) => M.by.trunk?.get(String(t.id)) || t), sched, schedState: st, rights: callRights(n, user, o) };
    }
    for (const inc of c?.contexts || []) { const r = search(inc.name || (M.lists.context || []).find((x) => x.id === inc.id)?.name, depth + 1); if (r) return r; }
    return null;
  };
  const result = search(fromCtx, 0) || { kind: 'none' };
  return { steps, result, number: n };
}
// Contextes entrants où un numéro reçu correspond à une SDA (trunk non choisi).
export function findIncall(number) {
  for (const c of (M.lists.context || []).filter((x) => x.type === 'incall')) {
    const r = simulate(number, c.name);
    if (r.result?.kind === 'incall') return r;
  }
  return null;
}

// « Simulation d'appel » dans le graphe affiché (demande de Brice, 16/10/2026 :
// pas de fenêtre en plus, le chemin se voit sur les cartes). On part de la
// carte de départ (choisie à gauche) et on suit, carte par carte, la sortie
// prise si personne ne décroche, en cumulant les durées :
//  - trunk → contexte → la SDA qui correspond au numéro reçu (match) ;
//  - « Numéros composés » : contextes de recherche → numéro interne ou règle
//    sortante → motif retenu → envoi → 1er trunk → opérateur ;
//  - horaire : sortie active au moment w ; utilisateur, groupe, file, standard :
//    « pas de réponse » après leur durée ; SVI : « sans saisie ».
// Vérifié : durées confd (ring_seconds, timeout, user_timeout, retry_delay),
// chaîne group-linear (sonnerie + pause après chaque membre), NPD sauté en
// linéaire. Supposé : ring_time d'une destination remplace la durée de
// l'objet ; utilisateur en NPD → sortie « occupé » ; SVI : délai × essais puis
// « sans saisie » ; sans débordement réglé, l'appel se termine.
// Résultat : { on: Map(clé → {t, dur, what}), ports: Set(« clé|port »),
//   ring: Map(clé → texte), steps: [{key, t, dur, what}], expand: clé repliée
//   à déplier, end: texte de fin }.
const DEFAULT_RING = 30; // ring_seconds par défaut de confd
// blocked : Map(uuid utilisateur → libellé) des utilisateurs qui bloquent l'appelant.
export function simPath(tree, w, match, { blocked = null } = {}) {
  const R = { on: new Map(), ports: new Set(), ring: new Map(), steps: [], expand: null, end: '' };
  // r : résultat de la recherche du numéro en cours ; remplacé quand un renvoi ressort vers l'extérieur.
  let r = match?.result; let twoCh = false;
  const kidOf = (n, p) => { const c = n.kids.find((x) => x.port === p.id); if (c) return c; const x = tree.cross.find((y) => y.from === n.key && y.port === p.id); return x ? tree.nodes.get(x.to) : null; };
  const subtree = (n, f) => { for (const c of n.kids) { f(c); subtree(c, f); } };
  let n = tree.root, t = 0, override = null, memberOf = ''; const seen = new Set();
  for (let i = 0; i < 60 && n; i++) {
    if (seen.has(n.key)) { R.end = 'boucle : l\'appel repasse par les mêmes cartes jusqu\'à ce que l\'appelant raccroche'; break; }
    seen.add(n.key);
    const ports = n.ports || []; const P = (f) => ports.find(f);
    const type = n.info?.type; const { obj: o, owner } = n.leaf ? {} : entity(n.key);
    const st = { key: n.key, t, dur: 0, what: '' };
    let p = null, end = false;
    // Départ « numéro composé » (utilisateur, membre d'un groupe) : vers le contexte de recherche.
    if (tree.root === n && P((x) => x.slot === 'dial_from')) {
      p = P((x) => x.slot === 'dial_from' && x.to); st.what = match?.number ? `compose ${match.number}` : 'compose un numéro';
      if (!r) { end = true; R.end = 'tapez le numéro composé'; }
    } else if (n.leaf) {
      if (type === 'caller') { p = ports[0]; st.what = 'appelle'; }
      else if (type === 'dial') { p = P((x) => x.slot === 'trunk'); st.what = r?.sent ? `envoie ${r.sent}` : 'numéro envoyé'; }
      // Numéro externe (renvoi, destination Numéro) : il ressort par une règle sortante (outEdges, model.js).
      else if (P((x) => x.slot === 'dial_out')) {
        p = P((x) => x.slot === 'dial_out'); r = p.outMatch?.result || r;
        const ext = r?.kind === 'outcall';
        if (ext) twoCh = true;
        st.what = ext ? 'repart vers l\'extérieur : 2 canaux occupés (l\'entrant et le sortant)' : 'numéro interne';
      } else if (P((x) => x.slot === 'dial_none')) { st.what = n.info.title; end = true; R.end = 'aucune règle sortante ne prend ce numéro : le renvoi échoue (supposé)'; }
      else { st.what = n.info.title; end = true; }
    } else switch (type) {
      case 'trunk':
        // Trunk de passage (départ SDA avec appelant) : vers la SDA.
        if (P((x) => x.slot === 'via')) { p = P((x) => x.slot === 'via'); st.what = 'appel reçu de l\'opérateur'; break; }
        if (P((x) => x.slot === 'pstn')) { st.what = twoCh ? 'sort vers l\'opérateur · 2e canal' : 'sort vers l\'opérateur'; end = true; R.end = twoCh ? 'le renvoi quitte Wazo par ce trunk ; l\'appel entrant reste ouvert : 2 canaux occupés pendant l\'appel (autorisations : seules celles de la règle sont simulées, supposé)' : 'l\'appel quitte Wazo par ce trunk'; break; }
        p = P((x) => x.slot === 'context'); st.what = match?.number ? `reçoit ${match.number}` : 'appel reçu';
        if (!r) { end = true; R.end = 'tapez le numéro appelé (SDA)'; }
        break;
      case 'context':
        if (n.depth === 0 || n.viaDial || o?.type === 'incall') {
          if (!r) { end = true; R.end = 'tapez un numéro'; break; }
          if (r.kind === 'incall' && o?.type === 'incall') { p = P((x) => x.slot === 'incall' && x.to?.key === r.key); st.what = r.viaDid ? `SDA reconnue comme ${r.viaDid}` : 'SDA trouvée'; break; }
          if (r.ctx === o?.name && (r.kind === 'internal' || r.kind === 'incall')) { p = P((x) => x.slot === 'internal'); st.what = 'numéro interne trouvé'; break; }
          if (r.ctx === o?.name && r.kind === 'outcall') { p = P((x) => x.slot === 'outcall' && (x.to?.key === `outcall:${r.outcall.id}` || x.to?.key?.endsWith(`@outcall:${r.outcall.id}`))); st.what = 'motif trouvé dans ce contexte'; break; }
          // Pas ici : contexte inclus suivant dans l'ordre de recherche (steps de simulate).
          // Aucune correspondance nulle part : on suit quand même les contextes
          // inclus fouillés, pour montrer où Asterisk a cherché (retour de Brice).
          const idx = (match.steps || []).findIndex((s) => s.ctx === o?.name);
          const next = idx >= 0 ? match.steps[idx + 1] : null;
          const inc = next && r.kind !== 'feature' ? P((x) => x.slot === 'include' && x.to?.key === `context:${next.ctx}`) : null;
          if (inc) { p = inc; st.what = 'rien ici, contexte inclus suivant'; break; }
          end = true;
          if (r.kind === 'none' && o?.type === 'incall') R.end = `aucune SDA ${match.number} : l'opérateur reçoit un refus (numéro non attribué)`;
          else if (r.kind === 'none') {
            // Motifs des règles sortantes rencontrées : pourquoi aucun ne convient.
            const pats = (M.lists.outcall || []).flatMap((oc) => (oc.extensions || []).filter((x) => (match.steps || []).some((s) => s.ctx === x.context)).map((x) => x.exten));
            R.end = `aucune correspondance pour ${match.number} : ni numéro interne, ni motif de règle sortante${pats.length ? ` (motifs disponibles : ${pats.join(', ')})` : ''} ; Asterisk ne trouve pas le numéro, l'appel échoue`;
          } else R.end = r.kind === 'feature' ? r.note : '';
          st.what = 'aucune correspondance';
          break;
        }
        end = true; st.what = 'contexte'; break;
      case 'user':
        // Atteint comme membre d'un groupe ou d'une file : il sonne dans ce cadre ;
        // ses renvois et débordements personnels ne s'appliquent pas (déduit du
        // dialplan, non testé). Le groupe continue s'il ne répond pas.
        if (memberOf) { st.what = `sonne comme membre de ${memberOf}`; end = true; R.end = `${n.info.title} sonne comme membre de ${memberOf} ; s'il ne répond pas, c'est le groupe ou la file qui continue (ses débordements personnels ne s'appliquent pas, déduit)`; break; }
        {
          // Liste de blocage (vérifié : elle existe dans confd ; supposé : appel rejeté, sans sonnerie ni débordement).
          if (blocked?.has(o.uuid)) { st.what = `bloque cet appelant${blocked.get(o.uuid) ? ` (« ${blocked.get(o.uuid)} »)` : ''}`; end = true; R.end = 'numéro dans la liste de blocage de l\'utilisateur : l\'appel est rejeté (supposé)'; break; }
          const f = o.forwards || {};
          if (f.unconditional?.enabled) { p = P((x) => x.slot === 'fwd_unconditional'); st.what = `renvoi immédiat vers ${f.unconditional.destination}`; break; }
          if (o.services?.dnd?.enabled) { p = P((x) => x.slot === 'fwd_busy' && x.to) || P((x) => x.slot === 'busy'); st.what = 'en NPD : ne sonne pas, sortie « occupé » (supposé)'; break; }
          const ring = override || o.ring_seconds || DEFAULT_RING;
          st.dur = ring; st.what = `sonne ${ring} s${override ? ' (durée de la destination)' : ''}`;
          p = P((x) => x.slot === 'fwd_noanswer' && x.to) || P((x) => x.slot === 'noanswer');
        }
        break;
      case 'incall': p = ports[0]; st.what = 'SDA reçue'; break;
      case 'schedule': {
        const s = scheduleState(o, w);
        p = P((x) => (x.when === 'open' && s.open) || (x.when === 'closed' && !s.open && s.exc < 0) || x.when === `exc:${s.exc}`);
        st.what = s.label; break;
      }
      case 'group': case 'queue': case 'switchboard': {
        const tmax = override || o.timeout || 0;
        st.dur = tmax || Infinity;
        st.what = type === 'queue' ? `attente en file${tmax ? ` ${tmax} s` : ', sans limite'}` : type === 'switchboard' ? `présenté au standard${tmax ? ` ${tmax} s` : ', sans limite'}` : `sonne${tmax ? ` ${tmax} s` : ' sans limite'}`;
        // Membres « numéro » externes d'un groupe : chacun appelé vers l'extérieur pendant la sonnerie (supposé : un canal sortant chacun).
        if (type === 'group') { const extN = groupMemberList(o).filter((m) => m.kind === 'ext' && !M.extAny.get(String(m.exten))).length; if (extN) st.what += ` · ${extN} numéro${extN > 1 ? 's' : ''} externe${extN > 1 ? 's' : ''} : un canal sortant chacun pendant la sonnerie (supposé)`; }
        // Membres : toute la branche « sonne » ; en « un par un », créneaux de chacun.
        const mp = P((x) => x.slot === 'members'); const hub = mp && kidOf(n, mp);
        if (mp) R.ports.add(`${n.key}|${mp.id}`);
        if (hub) {
          R.ring.set(hub.key, '');
          const chain = []; subtree(hub, (c) => { R.ring.set(c.key, ''); if (c.info?.member && !c.info.member.dnd) chain.push(c); });
          if (type === 'group' && o.ring_strategy === 'linear' && chain.length) {
            const ut = o.user_timeout ?? 15, rd = o.retry_delay ?? 0, lim = tmax || chain.length * (ut + rd);
            for (let j = 0, s = 0; s < lim && j < 60; j++, s += ut + rd) {
              const c = chain[j % chain.length]; const prev = R.ring.get(c.key);
              R.ring.set(c.key, `${prev ? `${prev}, ` : ''}${t + s} → ${t + Math.min(s + ut, lim)} s`);
            }
          } else for (const c of chain) R.ring.set(c.key, tmax ? `${t} → ${t + tmax} s` : `dès ${t} s`);
        }
        if (tmax) p = P((x) => x.slot === 'noanswer'); else { end = true; R.end = 'sonne sans fin (durée totale vide) jusqu\'à ce que l\'appelant raccroche'; }
        break;
      }
      case 'ivr': { const tries = o.max_tries || 1; st.dur = (o.timeout || 0) * tries; st.what = `menu, attend une touche${o.timeout ? ` ${o.timeout} s × ${tries} (supposé)` : ''}`; p = P((x) => x.slot === 'ivr_timeout'); break; }
      case 'outcall': {
        p = P((x) => x.slot === 'pattern' && (x.pats ? x.pats.includes(r?.dp?.exten) : x.label === r?.dp?.exten));
        // Numéro envoyé sur l'étape de la règle (la carte « Envoi » n'existe plus).
        st.what = r?.dp ? `motif ${r.dp.exten}${r.sent ? ` · envoie ${r.sent}` : ''}` : 'règle sortante';
        if (o?.enabled === false) { st.what += ' · règle désactivée'; st.block = true; end = true; R.end = 'règle sortante désactivée : l\'appel échoue (supposé)'; break; }
        // Horaire de la règle : carte horaire placée devant elle (suivie comme les autres horaires).
        const cr = r?.rights;
        if (cr?.by) {
          const lvl = { user: 'de l\'utilisateur', group: 'd\'un groupe dont il est membre', outcall: 'de la règle' }[cr.level];
          if (cr.verdict === 'allow') st.what += ` · autorisé par « ${cr.by.name} » (${lvl})`;
          else if (cr.code) st.what += ` · code demandé : « ${cr.by.name} » (${lvl})`;
          else { st.what += ` · refusé par « ${cr.by.name} » (${lvl})`; st.block = true; end = true; R.end = `bloqué par l'autorisation d'appel « ${cr.by.name} » (${lvl})`; }
        }
        break;
      }
      case 'voicemail': st.what = 'l\'appelant laisse un message'; end = true; break;
      case 'conference': st.what = 'entre dans la conférence'; end = true; break;
      default: st.what = n.info?.title || ''; end = true;
    }
    // Carte de passage (arrivée vers la carte choisie, entryChains) : une seule
    // sortie, celle qui mène à la carte choisie. Un horaire sur une autre sortie
    // à ce moment = l'appel ne passe pas par là.
    memberOf = '';
    if (n.pass) {
      const pp = ports[0];
      // Les membres sonnent dès l'entrée dans le groupe ou la file : pas de délai avant eux.
      if (pp.slot === 'members') { p = pp; end = false; R.end = ''; st.what = `fait sonner ses membres, ${pp.note}${Number.isFinite(st.dur) && st.dur ? ` (jusqu'à ${st.dur} s)` : ''}`; st.dur = 0; memberOf = n.info.title; }
      else if (!p || p.id !== pp.id) {
        if (type === 'schedule') { end = true; R.end = `${n.info.title} : ${st.what.toLowerCase()} à ce moment, l'appel ne prend pas ce chemin (choisissez un autre moment ou une autre SDA)`; }
        else if (!end) { p = pp; if (type === 'ivr') { st.what = `l'appelant choisit « ${pp.label} »`; st.dur = 0; } }
      }
    }
    R.on.set(n.key, st); R.steps.push(st);
    if (end) break;
    t += Number.isFinite(st.dur) ? st.dur : 0;
    if (!p) { R.end = R.end || 'sortie non réglée : l\'appel se termine (supposé)'; break; }
    R.ports.add(`${n.key}|${p.id}`);
    override = p.dest?.ring_time || null;
    const next = p.to ? kidOf(n, p) : null;
    if (!next) {
      if (p.to && n.folded) R.expand = n.key; // branche repliée : l'appli la déplie et recalcule
      else if (p.self) R.end = 'revient sur la même carte (le menu est rejoué)';
      else if (!p.to) R.end = 'sortie non réglée : l\'appel se termine (supposé)';
      break;
    }
    n = next;
  }
  return R;
}
// Contexte d'appel d'un utilisateur : celui de sa première ligne.
export const userContext = (u) => u?.lines?.[0]?.extensions?.[0]?.context || u?.lines?.[0]?.context || null;
export const nowWhen = () => { const d = new Date(); return whenOf(d, d.getHours() * 60 + d.getMinutes()); };
