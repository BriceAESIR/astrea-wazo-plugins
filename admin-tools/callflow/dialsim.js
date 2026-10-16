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
import { M, scheduleState, whenOf } from './model.js?v=0.39.0';

// Motif → liste d'éléments { set: chaînes de caractères, size } | { dot } | { bang } ; null si numéro exact.
export function parsePattern(p) {
  p = String(p || '').replace(/-/g, '');
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
      const permIds = new Set([...(o.call_permissions || []), ...((user?.call_permissions) || [])].map((p) => p.id));
      const perms = [...permIds].map((id) => M.by.callpermission?.get(String(id))).filter((p) => p && p.enabled !== false && (p.extensions || []).some((x) => matches(x, n)));
      return { kind: 'outcall', ctx, outcall: o, dp: best.dp, others: cand.slice(1), sent: dialedNumber(n, best.dp), trunks: (o.trunks || []).map((t) => M.by.trunk?.get(String(t.id)) || t), sched, schedState: st, perms };
    }
    for (const inc of c?.contexts || []) { const r = search(inc.name || (M.lists.context || []).find((x) => x.id === inc.id)?.name, depth + 1); if (r) return r; }
    return null;
  };
  const result = search(fromCtx, 0) || { kind: 'none' };
  return { steps, result, number: n };
}
// Contexte d'appel d'un utilisateur : celui de sa première ligne.
export const userContext = (u) => u?.lines?.[0]?.extensions?.[0]?.context || u?.lines?.[0]?.context || null;
export const nowWhen = () => { const d = new Date(); return whenOf(d, d.getHours() * 60 + d.getMinutes()); };
