// Migration Assistant — contrôles du paramétrage (lecture seule, sans DOM).
// Chaque contrôle : { id, sev (error|warn|info), title, help, run() → [{ type,
// label, detail }] }. L'aide suit la norme Astrea 3bis : ce que vérifie le
// contrôle, pourquoi c'est un problème, et ce qui est supposé.
// Règles lues dans wazo-confd / xivo-dao (19/10/2026) :
//  - destination commune (helpers/destination.py) : user_id, group_id, queue_id,
//    voicemail_id, ivr_id, conference_id (entiers), switchboard_uuid,
//    outcall_id, application_uuid (application « custom »), extension (exten + context) ;
//  - plage d'un contexte (xivo_dao contextnumbers.in_range) : comparaison
//    numérique, bornes réduites aux did_length derniers chiffres si renseigné ;
//    un numéro commençant par « _ » est un motif, non contrôlé.
import { I, objLabel, membersOf, ctxLabel } from './inventory.js?v=0.40.65';
import { worldOf, route } from './3cx-sites.js?v=0.40.65';
import { matches, callRights, userContext } from '../callflow/dialsim.js?v=0.40.65';

const L = (type, o, detail) => ({ type, label: objLabel(type, o), detail });

// ---------------------------------------------------------------------------
// Recherche d'un numéro comme Asterisk (moteur de l'import 3CX, 3cx-sites.js :
// extensions du contexte, puis règles sortantes du contexte, puis contextes
// inclus dans l'ordre, chacun une fois). Monde construit une fois par contrôle.
// ---------------------------------------------------------------------------
const world = () => worldOf({ contexts: I.lists.context || [], extensions: I.lists.extension || [], outcalls: I.lists.outcall || [] });
const internals = () => (I.lists.context || []).filter((c) => c.type === 'internal').map((c) => c.name);
const short = (l, n = 8) => `${l.slice(0, n).join(', ')}${l.length > n ? ` (+${l.length - n})` : ''}`;
// Numéros internes (exacts) d'un contexte : postes, groupes, files, conférences…
const numsOf = (w, ctx) => [...w.exts.entries()].filter(([, x]) => x.ctx === ctx).map(([k]) => k.slice(0, k.lastIndexOf('@')));
// Règle sortante qui porte ce motif dans ce contexte.
const outcallOf = (ctx, exten) => (I.lists.outcall || []).find((o) => (o.extensions || []).some((e) => e.context === ctx && e.exten === exten)) || null;
// Utilisateurs dont la ligne compose depuis ce contexte.
const usersOf = (ctx) => (I.lists.user || []).filter((u) => userContext(u) === ctx);
// Sons du tenant : chemins des fichiers (GET /sounds : files[].formats[].path, sans extension).
const tenantSoundPaths = () => new Set((I.lists.sound || []).flatMap((c) => (c.files || []).flatMap((f) => (f.formats || []).map((x) => x.path).filter(Boolean))));
// Sons joués : messages des SVI, pré-décroché des SDA, destinations « fichier son ».
function soundRefs() {
  const out = []; const add = (type, obj, slot, path) => { if (path) out.push({ type, obj, slot, path: String(path) }); };
  for (const v of I.lists.ivr || []) for (const [k, l] of [['greeting_sound', 'accueil'], ['menu_sound', 'menu'], ['invalid_sound', 'saisie invalide'], ['abort_sound', 'abandon']]) add('ivr', v, l, v[k]);
  for (const i of I.lists.incall || []) add('incall', i, 'pré-décroché', i.greeting_sound);
  for (const x of allDests()) if (x.dest?.type === 'sound') add(x.type, x.obj, x.slot, x.dest.filename);
  return out;
}
// Ligne WebRTC : compte SIP qui hérite d'un modèle « webrtc » (libellé du modèle du tenant, supposé).
const isWebrtc = (line) => { const e = I.by.endpoint_sip?.get(String(line?.endpoint_sip?.uuid)); return (e?.templates || []).some((t) => /webrtc/i.test(t.label || I.by.sip_template?.get(String(t.uuid))?.label || '')); };

// ---------------------------------------------------------------------------
// Destinations de routage
// ---------------------------------------------------------------------------
const FALLBACKS = {
  noanswer_destination: 'pas de réponse', busy_destination: 'occupé',
  congestion_destination: 'encombré', fail_destination: 'indisponible',
};
// Toutes les destinations du tenant : { type, obj, slot, dest }.
export function* allDests() {
  for (const o of I.lists.incall || []) yield { type: 'incall', obj: o, slot: 'destination', dest: o.destination };
  for (const t of ['user', 'group', 'queue', 'switchboard']) {
    for (const o of I.lists[t] || []) for (const [k, l] of Object.entries(FALLBACKS)) if (o.fallbacks?.[k]) yield { type: t, obj: o, slot: `débordement ${l}`, dest: o.fallbacks[k] };
  }
  for (const o of I.lists.queue || []) {
    if (o.wait_time_destination) yield { type: 'queue', obj: o, slot: 'attente trop longue', dest: o.wait_time_destination };
    if (o.wait_ratio_destination) yield { type: 'queue', obj: o, slot: 'trop d\'appels par agent', dest: o.wait_ratio_destination };
  }
  for (const o of I.lists.ivr || []) {
    for (const c of o.choices || []) yield { type: 'ivr', obj: o, slot: `touche ${c.exten}`, dest: c.destination };
    for (const [k, l] of [['timeout_destination', 'sans saisie'], ['invalid_destination', 'saisie invalide'], ['abort_destination', 'trop d\'essais']]) if (o[k]) yield { type: 'ivr', obj: o, slot: l, dest: o[k] };
  }
  for (const o of I.lists.schedule || []) {
    if (o.closed_destination) yield { type: 'schedule', obj: o, slot: 'fermé', dest: o.closed_destination };
    for (const [i, p] of (o.exceptional_periods || []).entries()) if (p.destination) yield { type: 'schedule', obj: o, slot: `fermeture exceptionnelle ${i + 1}`, dest: p.destination };
  }
}
// Cible d'une destination : [type d'inventaire, clé] ou null (son, raccrocher…).
export function destTarget(d) {
  if (!d || typeof d !== 'object') return null;
  switch (d.type) {
    case 'user': return ['user', d.user_id];
    case 'group': return ['group', d.group_id];
    case 'queue': return ['queue', d.queue_id];
    case 'voicemail': return ['voicemail', d.voicemail_id];
    case 'ivr': return ['ivr', d.ivr_id];
    case 'conference': return ['conference', d.conference_id];
    case 'switchboard': return ['switchboard', d.switchboard_uuid];
    case 'outcall': return ['outcall', d.outcall_id];
    case 'application': return d.application === 'custom' ? ['application', d.application_uuid] : null;
    case 'extension': return ['context', d.context];
    default: return null;
  }
}
const TYPE_FR = { user: 'utilisateur', group: 'groupe', queue: 'file d\'attente', voicemail: 'messagerie', ivr: 'SVI', conference: 'conférence', switchboard: 'standard', outcall: 'règle sortante', application: 'application', context: 'contexte' };
const exists = ([t, k]) => I.by[t]?.has(String(k));

// ---------------------------------------------------------------------------
// Plages et motifs Asterisk
// ---------------------------------------------------------------------------
function inRanges(exten, ranges) {
  if (!/^\d+$/.test(exten)) return true; // motif, code de service : non contrôlé
  const n = Number(exten);
  return (ranges || []).some((r) => {
    const cut = (s) => Number(r.did_length ? String(s).slice(-r.did_length) : s);
    const a = cut(r.start); const b = cut(r.end ?? r.start);
    return a === b ? n === a : a <= n && n <= b;
  });
}
// Motif Asterisk (_X Z N [..] . !) contre un numéro composé.
export function patternMatch(pat, num) {
  if (!pat?.startsWith('_')) return pat === num;
  const p = pat.slice(1);
  const rec = (i, j) => {
    if (i === p.length) return j === num.length;
    const c = p[i];
    if (c === '.') { for (let k = j + 1; k <= num.length; k++) if (rec(i + 1, k)) return true; return false; }
    if (c === '!') { for (let k = j; k <= num.length; k++) if (rec(i + 1, k)) return true; return false; }
    if (j >= num.length) return false;
    const d = num[j];
    if (c === '[') {
      const end = p.indexOf(']', i); if (end < 0) return false;
      const set = p.slice(i + 1, end);
      let ok = false;
      for (let k = 0; k < set.length; k++) {
        if (set[k + 1] === '-' && set[k + 2]) { if (d >= set[k] && d <= set[k + 2]) ok = true; k += 2; } else if (set[k] === d) ok = true;
      }
      return ok && rec(end + 1, j + 1);
    }
    const ok = (c === 'X' || c === 'x') ? /\d/.test(d) : (c === 'Z' || c === 'z') ? /[1-9]/.test(d) : (c === 'N' || c === 'n') ? /[2-9]/.test(d) : c === d;
    return ok && rec(i + 1, j + 1);
  };
  return rec(0, 0);
}
// Contextes atteignables depuis un contexte (lui-même puis les inclusions).
export function reachable(name) {
  const seen = new Set(); const todo = [name];
  while (todo.length) {
    const n = todo.shift(); if (seen.has(n)) continue; seen.add(n);
    for (const c of I.by.context?.get(String(n))?.contexts || []) todo.push(c.name);
  }
  return seen;
}
// Règle sortante qui prend ce numéro depuis ce contexte, ou null.
export function outcallFor(ctx, num) {
  const ctxs = reachable(ctx);
  for (const o of I.lists.outcall || []) for (const e of o.extensions || []) if (ctxs.has(e.context) && patternMatch(e.exten, num)) return o;
  return null;
}
// Contextes internes existants où des lignes sont déclarées (un contexte
// inexistant est déjà signalé par « Contexte inexistant »).
const lineContexts = () => [...new Set((I.lists.line || []).map((l) => l.context))].filter((n) => I.by.context?.get(String(n))?.type === 'internal');

// Numéros d'urgence en France (supposé : à adapter pour un autre pays).
const EMERGENCY = [['15', 'SAMU'], ['17', 'Police'], ['18', 'Pompiers'], ['112', 'Urgence européen'], ['114', 'Urgence sourds et malentendants']];

// ---------------------------------------------------------------------------
// Catalogue des contrôles
// ---------------------------------------------------------------------------
export const CHECKS = [
  {
    id: 'dest_missing', sev: 'error', title: 'Destination vers un objet introuvable',
    help: 'Une SDA, un débordement, une touche de SVI ou une sortie d\'horaire pointe vers un objet qui n\'existe plus dans le tenant (supprimé, ou d\'un autre tenant). L\'appel qui passe par là est perdu. À corriger dans Call Flow Manager. Destinations « numéro » : seul le contexte est contrôlé.',
    run() {
      const out = [];
      for (const x of allDests()) {
        const t = destTarget(x.dest);
        if (t && !exists(t)) out.push(L(x.type, x.obj, `${x.slot} → ${TYPE_FR[t[0]]} ${t[1]} introuvable`));
      }
      return out;
    },
  },
  {
    id: 'ctx_missing', sev: 'error', title: 'Contexte inexistant',
    help: 'Une ligne, un trunk, un numéro ou une messagerie est rattaché à un contexte qui n\'existe pas dans le tenant. Les appels de ou vers cet objet échouent. Les contextes sont référencés par leur nom technique (ex. ctx-xxx-internal-…), pas par leur libellé.',
    run() {
      const has = (n) => I.by.context?.has(String(n));
      const out = [];
      for (const l of I.lists.line || []) if (l.context && !has(l.context)) out.push(L('line', l, `contexte ${l.context}`));
      for (const t of I.lists.trunk || []) if (t.context && !has(t.context)) out.push(L('trunk', t, `contexte ${t.context}`));
      for (const e of I.lists.extension || []) if (e.context && !has(e.context)) out.push(L('extension', e, `contexte ${e.context}`));
      for (const v of I.lists.voicemail || []) if (v.context && !has(v.context)) out.push(L('voicemail', v, `contexte ${v.context}`));
      return out;
    },
  },
  {
    id: 'emergency', sev: 'error', title: 'Numéros d\'urgence non routés',
    help: 'Pour chaque contexte interne qui a des lignes, vérifie qu\'une règle sortante prend le 15, le 17, le 18, le 112 et le 114, dans le contexte lui-même ou dans un contexte inclus. Un numéro d\'urgence non routé est une obligation légale non respectée. Les droits d\'appel et les horaires des règles ne sont pas pris en compte (supposé : une règle d\'urgence n\'en a pas). Liste française.',
    run() {
      const out = [];
      for (const ctx of lineContexts()) {
        const miss = EMERGENCY.filter(([n]) => !outcallFor(ctx, n));
        if (miss.length) out.push({ type: 'context', label: ctxLabel(ctx), detail: `non routés : ${miss.map(([n, l]) => `${n} (${l})`).join(', ')}` });
      }
      return out;
    },
  },
  {
    id: 'ext_range', sev: 'warn', title: 'Numéro hors des plages de son contexte',
    help: 'Le numéro d\'un poste, d\'un groupe, d\'une file ou d\'une conférence n\'est pas dans les plages déclarées de son contexte (plages modifiées après coup). Il fonctionne, mais confd refusera toute modification de ce numéro tant que la plage ne le couvre pas. À régler avant une bascule multisite.',
    run() {
      const out = [];
      for (const e of I.lists.extension || []) {
        const c = I.by.context?.get(String(e.context)); if (!c || e.exten?.startsWith('_')) continue;
        const [what, ranges] = e.lines?.length ? ['poste', c.user_ranges] : e.group ? ['groupe', c.group_ranges] : e.queue ? ['file', c.queue_ranges] : e.conference ? ['conférence', c.conference_room_ranges] : [null];
        if (what && !inRanges(e.exten, ranges)) out.push(L('extension', e, `${what} hors des plages ${what === 'poste' ? 'utilisateurs' : what === 'groupe' ? 'groupes' : what === 'file' ? 'files' : 'conférences'} de ${ctxLabel(e.context)}`));
      }
      return out;
    },
  },
  {
    id: 'ctx_no_out', sev: 'warn', title: 'Contexte interne sans sortie vers l\'extérieur',
    help: 'Contexte interne qui a des lignes mais n\'atteint aucune règle sortante, ni directement ni par ses inclusions : ses utilisateurs ne peuvent pas appeler l\'extérieur. Normal seulement pour un contexte volontairement restreint.',
    run() {
      return lineContexts().filter((ctx) => { const r = reachable(ctx); return !(I.lists.outcall || []).some((o) => (o.extensions || []).some((e) => r.has(e.context))); })
        .map((ctx) => ({ type: 'context', label: ctxLabel(ctx), detail: `${(I.lists.line || []).filter((l) => l.context === ctx).length} ligne(s)` }));
    },
  },
  // ----- Multi-site : plusieurs contextes internes (demande de Brice, 06/11/2026) -----
  {
    id: 'ms_include_order', sev: 'error', title: 'Multi-site : appels internes captés par une règle sortante',
    help: 'Depuis un contexte interne, chaque numéro d\'un autre site joignable par les inclusions est cherché comme Asterisk : extensions du contexte, puis ses règles sortantes, puis les contextes inclus dans l\'ordre. Si une règle sortante (souvent un attrape-tout _X.) est trouvée avant le site qui a ce numéro, l\'appel interne part vers le trunk. Corriger l\'ordre des inclusions (sites avant le sortant) ou le motif. Même moteur que l\'import 3CX et la simulation de Call Flow ; droits d\'appel et horaires non pris en compte.',
    run() {
      const w = world(); const out = new Map(); const mine = new Set(internals());
      for (const from of lineContexts()) for (const c of reachable(from)) {
        if (c === from || !mine.has(c)) continue;
        for (const n of numsOf(w, c)) {
          const r = route(w, from, n); if (r.kind !== 'out') continue;
          const k = `${from}|${c}|${r.rule}`; if (!out.has(k)) out.set(k, { from, c, rule: r.rule, nums: [] }); out.get(k).nums.push(n);
        }
      }
      return [...out.values()].map((x) => ({ type: 'context', label: ctxLabel(x.from), detail: `${x.nums.length} numéro(s) de ${ctxLabel(x.c)} partent vers la règle « ${x.rule} » : ${short(x.nums)}` }));
    },
  },
  {
    id: 'ms_dup_number', sev: 'warn', title: 'Multi-site : même numéro dans deux sites joignables',
    help: 'Un numéro existe dans deux contextes internes qu\'un même contexte peut joindre. Asterisk prend le premier trouvé (le contexte lui-même, puis les inclusions dans l\'ordre) : l\'autre n\'est jamais joignable depuis ce contexte. Normal entre deux sites qui ne s\'appellent pas ; à corriger s\'ils doivent s\'appeler (préfixe de site, renumérotation). Signale aussi les plages de postes qui se chevauchent entre sites qui s\'incluent.',
    run() {
      const w = world(); const mine = new Set(internals()); const by = new Map();
      for (const [k, x] of w.exts) if (mine.has(x.ctx)) { const n = k.slice(0, k.lastIndexOf('@')); if (!by.has(n)) by.set(n, []); by.get(n).push(x.ctx); }
      const out = new Map();
      for (const from of lineContexts()) {
        const reach = reachable(from);
        for (const [n, ctxs] of by) {
          const seen = ctxs.filter((c) => reach.has(c)); if (seen.length < 2) continue;
          const r = route(w, from, n); if (r.kind !== 'internal') continue;
          const lost = seen.filter((c) => c !== r.ctx);
          const k = `${from}|${r.ctx}|${lost.join(',')}`; if (!out.has(k)) out.set(k, { from, win: r.ctx, lost, nums: [] }); out.get(k).nums.push(n);
        }
      }
      const items = [...out.values()].map((x) => ({ type: 'context', label: ctxLabel(x.from), detail: `${x.nums.length} numéro(s) en double : ${short(x.nums)} répondent dans ${ctxLabel(x.win)}, jamais dans ${x.lost.map(ctxLabel).join(', ')}` }));
      // Plages de postes qui se chevauchent entre deux sites dont l'un joint l'autre.
      const ctxs = (I.lists.context || []).filter((c) => c.type === 'internal');
      for (let i = 0; i < ctxs.length; i++) for (let j = i + 1; j < ctxs.length; j++) {
        const a = ctxs[i]; const b = ctxs[j];
        if (!reachable(a.name).has(b.name) && !reachable(b.name).has(a.name)) continue;
        for (const ra of a.user_ranges || []) for (const rb of b.user_ranges || []) {
          const [as, ae, bs, be] = [ra.start, ra.end ?? ra.start, rb.start, rb.end ?? rb.start];
          if (String(as).length === String(bs).length && Number(as) <= Number(be) && Number(bs) <= Number(ae)) items.push({ type: 'context', label: ctxLabel(a.name), detail: `plage de postes ${as}-${ae} chevauche ${bs}-${be} de ${ctxLabel(b.name)}` });
        }
      }
      return items;
    },
  },
  {
    id: 'ms_include_odd', sev: 'warn', title: 'Multi-site : inclusions incohérentes',
    help: 'Trois cas : un site en joint un autre (inclusion) sans que l\'autre le joigne (appels à sens unique, normal pour un contexte commun sans ligne) ; un contexte interne inclut un contexte entrant (ses SDA deviennent composables en interne, rarement voulu) ; un contexte interne sans ligne qu\'aucun contexte n\'inclut (reste d\'une ancienne configuration). Seuls les sites qui ont des lignes sont comparés.',
    run() {
      const out = []; const lc = new Set(lineContexts()); const byName = (n) => I.by.context?.get(String(n));
      const sites = [...lc];
      for (const a of sites) for (const b of sites) if (a < b) {
        const ab = reachable(a).has(b); const ba = reachable(b).has(a);
        if (ab !== ba) out.push({ type: 'context', label: ctxLabel(ab ? a : b), detail: `joint ${ctxLabel(ab ? b : a)}, qui ne le joint pas (appels à sens unique)` });
      }
      for (const c of (I.lists.context || []).filter((x) => x.type === 'internal')) {
        for (const x of c.contexts || []) { const t = byName(x.name) || (I.lists.context || []).find((y) => y.id === x.id); if (t?.type === 'incall') out.push({ type: 'context', label: ctxLabel(c.name), detail: `inclut le contexte entrant ${ctxLabel(t.name)}` }); }
      }
      const included = new Set((I.lists.context || []).flatMap((c) => (c.contexts || []).map((x) => x.name || (I.lists.context || []).find((y) => y.id === x.id)?.name)));
      const usedBy = new Set([...(I.lists.extension || []).map((e) => e.context), ...(I.lists.voicemail || []).map((v) => v.context), ...(I.lists.trunk || []).map((t) => t.context)]);
      for (const c of (I.lists.context || []).filter((x) => x.type === 'internal' && !lc.has(x.name) && !included.has(x.name) && !usedBy.has(x.name))) out.push({ type: 'context', label: ctxLabel(c.name), detail: 'aucune ligne, aucun numéro, inclus par aucun contexte' });
      return out;
    },
  },
  {
    id: 'unreachable_number', sev: 'warn', title: 'Numéro injoignable depuis le contexte de l\'appel',
    help: 'Destination « numéro » (SDA, débordement, SVI, horaire), numérotation rapide d\'une touche de fonction, ou renvoi vers un numéro court : le numéro est cherché comme Asterisk depuis le contexte de l\'appel (celui de la destination, ou celui de la ligne de l\'utilisateur). Aucun numéro ni règle sortante ne le prend : l\'appel échoue. Fréquent après une bascule multisite (numéro resté dans l\'ancien contexte).',
    run() {
      const w = world(); const out = []; const has = (n) => I.by.context?.has(String(n));
      for (const x of allDests()) {
        const d = x.dest; if (d?.type !== 'extension' || !d.exten || !has(d.context)) continue;
        if (route(w, d.context, d.exten).kind === 'none') out.push(L(x.type, x.obj, `${x.slot} → ${d.exten} introuvable depuis ${ctxLabel(d.context)}`));
      }
      for (const u of I.lists.user || []) {
        const ctx = userContext(u); if (!ctx || !has(ctx)) continue;
        for (const [pos, k] of Object.entries(I.funckeys[u.uuid] || {})) {
          const d = k?.destination; if (d?.type !== 'custom' || !/^\+?\d+$/.test(d.exten || '')) continue;
          if (route(w, ctx, d.exten).kind === 'none') out.push(L('user', u, `touche ${pos}${k.label ? ` « ${k.label} »` : ''} → ${d.exten} introuvable depuis ${ctxLabel(ctx)}`));
        }
        for (const kf of ['unconditional', 'busy', 'noanswer']) {
          const f = u.forwards?.[kf]; if (!f?.enabled || !/^\d{1,6}$/.test(f.destination || '')) continue;
          if (route(w, ctx, f.destination).kind === 'none') out.push(L('user', u, `renvoi ${kf === 'unconditional' ? 'immédiat' : kf === 'busy' ? 'si occupé' : 'si pas de réponse'} vers ${f.destination}, introuvable depuis ${ctxLabel(ctx)}`));
        }
      }
      return out;
    },
  },
  {
    id: 'incall_ctx_orphan', sev: 'warn', title: 'SDA dans un contexte qu\'aucun trunk ne dessert',
    help: 'Un appel entrant arrive dans le contexte de son trunk, puis y cherche la SDA. Une SDA déclarée dans un contexte entrant qu\'aucun trunk n\'utilise ne peut donc pas être appelée de l\'extérieur.',
    run() {
      const served = new Set((I.lists.trunk || []).map((t) => t.context).filter(Boolean));
      const out = [];
      for (const i of I.lists.incall || []) for (const e of i.extensions || []) if (!served.has(e.context)) out.push(L('incall', i, `contexte ${ctxLabel(e.context)} sans trunk`));
      return out;
    },
  },
  {
    id: 'incall_no_dest', sev: 'warn', title: 'SDA sans destination',
    help: 'SDA dont la destination est « aucune » : l\'appel est rejeté. Normal pour un numéro réservé, sinon à corriger dans Call Flow Manager.',
    run: () => (I.lists.incall || []).filter((i) => !i.destination || i.destination.type === 'none').map((i) => L('incall', i, 'destination : aucune')),
  },
  {
    id: 'outcall_no_trunk', sev: 'warn', title: 'Règle sortante sans trunk',
    help: 'Règle d\'appel sortant sans aucun trunk : les numéros qu\'elle prend ne partent nulle part (l\'appel échoue au lieu de passer par une autre règle).',
    run: () => (I.lists.outcall || []).filter((o) => !(o.trunks || []).length).map((o) => L('outcall', o, `${(o.extensions || []).length} motif(s)`)),
  },
  // ----- Fraude (demande de Brice, 06/11/2026) -----
  {
    id: 'fraud_open', sev: 'warn', title: 'Numéros surtaxés ou internationaux non bloqués',
    help: 'Pour chaque contexte interne qui a des lignes, des numéros types sont cherchés comme Asterisk : 0899 et 0897 (surtaxés), 118 712 (renseignements), 00225 (Côte d\'Ivoire) et 00881 (satellite), destinations classiques de la fraude. Si une règle sortante les prend, les droits d\'appel sont évalués comme wazo-agid (utilisateur, ses groupes, puis la règle ; lu dans call_rights.py) pour chaque utilisateur du contexte. Signalé quand au moins un utilisateur peut les composer. Numéros d\'exemple : une règle plus fine que ces familles peut donner un faux résultat.',
    run() {
      const w = world(); const out = [];
      const SAMPLES = [['0899123456', 'surtaxé 0899'], ['0897123456', 'surtaxé 0897'], ['118712', 'renseignements 118'], ['0022512345678', 'international 00225'], ['00881612345678', 'satellite 00881']];
      for (const ctx of lineContexts()) {
        const users = usersOf(ctx);
        const open = [];
        for (const [n, what] of SAMPLES) {
          const r = route(w, ctx, n); if (r.kind !== 'out') continue;
          const o = outcallOf(r.ctx, r.exten);
          const free = (users.length ? users : [null]).filter((u) => callRights(n, u, o, I.lists).verdict === 'allow');
          if (free.length) open.push(`${what} (règle « ${r.rule} »${users.length ? `, ${free.length}/${users.length} utilisateur(s)` : ''})`);
        }
        if (open.length) out.push({ type: 'context', label: ctxLabel(ctx), detail: `composables : ${open.join(' ; ')}` });
      }
      return out;
    },
  },
  {
    id: 'outcall_catchall', sev: 'warn', title: 'Règle sortante qui prend tout',
    help: 'Motif qui accepte presque n\'importe quel numéro (_X., _., _!…) : tout numéro que les autres motifs ne prennent pas, international compris, part vers le trunk. Pratique, mais il ouvre la porte à la fraude et capte les numéros internes mal inclus (voir « appels internes captés »). Préférer les familles de l\'assistant France de Call Flow Manager.',
    run() {
      const out = [];
      for (const o of I.lists.outcall || []) for (const e of o.extensions || []) {
        if (String(e.exten).startsWith('_') && ['12', '0022512345678', '3631'].every((n) => matches(e.exten, n))) out.push(L('outcall', o, `motif ${e.exten} dans ${ctxLabel(e.context)}`));
      }
      return out;
    },
  },
  // ----- Licences (règles du portail, vérifiées par User Manager) -----
  {
    id: 'lic_webrtc_voice', sev: 'error', title: 'Ligne WebRTC sur une licence Voix',
    help: 'Utilisateur en licence Voix (subscription_type 0) avec une ligne WebRTC : le portail le refuse, et les applications Wazo refusent la connexion en licence Voix (vérifié par User Manager). La ligne ne sert pas. Ligne WebRTC reconnue au modèle SIP « webrtc » de son compte (supposé : libellé du modèle).',
    run() {
      const out = [];
      for (const u of (I.lists.user || []).filter((x) => x.subscription_type === 0)) for (const l of u.lines || []) {
        const line = I.by.line?.get(String(l.id)) || l;
        if (isWebrtc(line)) out.push(L('user', u, `licence Voix, ligne WebRTC ${line.name || line.id}`));
      }
      return out;
    },
  },
  {
    id: 'lic_email', sev: 'warn', title: 'E-mail manquant ou en double',
    help: 'Licence Communication unifiée ou Relation client sans e-mail : le portail l\'exige (règle reprise par User Manager). E-mail utilisé par deux utilisateurs du tenant : Wazo l\'exige unique sur tout le serveur, une création ou une modification sera refusée. Seul le tenant ouvert est comparé.',
    run() {
      const out = []; const by = new Map();
      for (const u of I.lists.user || []) {
        const m = String(u.email || '').trim().toLowerCase();
        if (!m && (u.subscription_type === 1 || u.subscription_type === 3)) out.push(L('user', u, `licence ${u.subscription_type === 1 ? 'Communication unifiée' : 'Relation client'} sans e-mail`));
        if (m) { if (!by.has(m)) by.set(m, []); by.get(m).push(u); }
      }
      for (const [m, l] of by) if (l.length > 1) for (const u of l) out.push(L('user', u, `e-mail ${m} aussi pris par ${l.filter((x) => x !== u).map((x) => objLabel('user', x)).join(', ')}`));
      return out;
    },
  },
  {
    id: 'empty_members', sev: 'warn', title: 'Groupe ou file sans membre',
    help: 'Groupe d\'appel ou file d\'attente sans membre fixe : il ne fait sonner personne et part directement en débordement. Les membres inscrits par la touche « bascule » (*50) ne sont connus que d\'Asterisk et ne sont pas comptés ici : un groupe vide peut donc être normal s\'il fonctionne par inscription.',
    run() {
      const out = [];
      for (const t of ['group', 'queue']) for (const o of I.lists[t] || []) {
        const m = membersOf(o);
        if (!m.users.length && !m.extensions.length && !m.agents.length) out.push(L(t, o, t === 'group' ? 'groupe vide' : 'file vide'));
      }
      return out;
    },
  },
  {
    id: 'line_ctx_mismatch', sev: 'warn', title: 'Ligne et numéro dans des contextes différents',
    help: 'Le contexte de la ligne (d\'où l\'utilisateur compose) diffère de celui de son numéro (où on le joint). Wazo l\'accepte, mais c\'est souvent le reste d\'une modification partielle. À régler avant une bascule multisite, qui change les deux ensemble.',
    run() {
      const out = [];
      for (const l of I.lists.line || []) for (const e of l.extensions || []) if (e.context && l.context && e.context !== l.context) out.push(L('line', l, `ligne : ${ctxLabel(l.context)} ; numéro ${e.exten} : ${ctxLabel(e.context)}`));
      return out;
    },
  },
  {
    id: 'fwd_intl', sev: 'warn', title: 'Renvoi actif vers l\'international',
    help: 'Renvoi d\'appel actif vers un numéro hors de France (00 ou + suivi d\'un autre indicatif que 33). Un renvoi vers l\'international est un vecteur classique de fraude (compte piraté qui renvoie vers un numéro surtaxé). Vérifier qu\'il est voulu.',
    run() {
      const out = [];
      const intl = (n) => /^(00|\+)/.test(n || '') && !/^(0033|\+33)/.test(n);
      for (const u of I.lists.user || []) for (const k of ['unconditional', 'busy', 'noanswer']) {
        const f = u.forwards?.[k];
        if (f?.enabled && intl(f.destination)) out.push(L('user', u, `renvoi ${k === 'unconditional' ? 'immédiat' : k === 'busy' ? 'si occupé' : 'si pas de réponse'} vers ${f.destination}`));
      }
      return out;
    },
  },
  {
    id: 'fk_missing', sev: 'warn', title: 'Touche de fonction vers un objet introuvable',
    help: 'Touche de fonction (BLF, numérotation rapide…) dont la cible n\'existe plus : la touche reste affichée sur le poste mais ne fonctionne pas. À corriger dans BLF Manager.',
    run() {
      const out = [];
      for (const u of I.lists.user || []) for (const [pos, k] of Object.entries(I.funckeys[u.uuid] || {})) {
        const t = destTarget(k?.destination);
        if (t && !exists(t)) out.push(L('user', u, `touche ${pos}${k.label ? ` « ${k.label} »` : ''} → ${TYPE_FR[t[0]]} ${t[1]} introuvable`));
      }
      return out;
    },
  },
  {
    id: 'user_no_line', sev: 'info', title: 'Utilisateur sans ligne',
    help: 'Utilisateur sans ligne téléphonique : il ne peut ni appeler ni être appelé (sauf comptes d\'application ou de supervision). Souvent un départ non nettoyé ou une création incomplète.',
    run: () => (I.lists.user || []).filter((u) => !(u.lines || []).length).map((u) => L('user', u, u.enabled === false ? 'compte désactivé' : 'aucune ligne')),
  },
  {
    id: 'device_unused', sev: 'info', title: 'Appareil sans ligne',
    help: 'Appareil du tenant qu\'aucune ligne n\'utilise : poste en stock, remplacé ou oublié. Il reste en provisionnement automatique.',
    run() {
      const used = new Set((I.lists.line || []).map((l) => l.device_id).filter(Boolean));
      return (I.lists.device || []).filter((d) => !used.has(d.id)).map((d) => L('device', d, d.status ? `état ${d.status}` : ''));
    },
  },
  {
    id: 'sched_unused', sev: 'info', title: 'Horaire jamais utilisé',
    help: 'Horaire associé à aucun objet (SDA, utilisateur, groupe, file, règle sortante). Sans effet : reste d\'une ancienne configuration, ou horaire préparé mais pas encore associé.',
    run: () => (I.lists.schedule || []).filter((s) => !['incalls', 'users', 'groups', 'queues', 'outcalls'].some((k) => (s[k] || []).length)).map((s) => L('schedule', s, 'aucune association')),
  },
  {
    id: 'vm_orphan', sev: 'info', title: 'Messagerie orpheline',
    help: 'Boîte vocale associée à aucun utilisateur et visée par aucune destination : personne ne peut y laisser de message. Elle peut contenir d\'anciens messages.',
    run() {
      const targeted = new Set();
      for (const x of allDests()) if (x.dest?.type === 'voicemail') targeted.add(String(x.dest.voicemail_id));
      return (I.lists.voicemail || []).filter((v) => !(v.users || []).length && !targeted.has(String(v.id))).map((v) => L('voicemail', v, 'aucun utilisateur, aucune destination'));
    },
  },
  // ----- Restes (demande de Brice, 06/11/2026) -----
  {
    id: 'sound_missing', sev: 'warn', title: 'Son introuvable',
    help: 'Message d\'un SVI (accueil, menu, saisie invalide, abandon), pré-décroché d\'une SDA, ou destination « fichier son », qui désigne un fichier du tenant absent de ses catégories de sons : l\'appelant n\'entend rien (le menu d\'un SVI muet perd l\'appel). Lu dans confd : un son du tenant se désigne par son chemin sans extension (/var/lib/wazo/sounds/tenants/…), donné par GET /sounds. Les sons d\'Asterisk (désignés par leur nom) ne sont pas contrôlés.',
    run() {
      const out = []; const have = tenantSoundPaths();
      for (const r of soundRefs()) if (r.path.startsWith('/var/lib/wazo/sounds/tenants/') && !have.has(r.path)) out.push(L(r.type, r.obj, `${r.slot} : ${r.path.split('/').slice(-2).join('/')} introuvable`));
      return out;
    },
  },
  {
    id: 'line_no_device', sev: 'info', title: 'Ligne SIP sans appareil',
    help: 'Ligne SIP (hors WebRTC) associée à aucun appareil : personne ne l\'utilise, sauf un softphone tiers configuré à la main. Souvent un poste remplacé ou une création incomplète. Ligne WebRTC reconnue au modèle SIP « webrtc » (supposé).',
    run: () => (I.lists.line || []).filter((l) => l.endpoint_sip && !l.device_id && !isWebrtc(l)).map((l) => L('line', l, `${(l.users || []).length ? `utilisateur ${objLabel('user', I.by.user?.get(String(l.users[0].id)) || l.users[0])}` : 'aucun utilisateur'}`)),
  },
  {
    id: 'sound_unused', sev: 'info', title: 'Son jamais utilisé',
    help: 'Fichier d\'une catégorie de sons du tenant qu\'aucun SVI, aucune SDA (pré-décroché) ni aucune destination « fichier son » ne joue. Il peut servir ailleurs (annonce d\'une file, réglage hors de l\'API) : à vérifier avant de le supprimer.',
    run() {
      const used = new Set(soundRefs().map((r) => r.path)); const out = [];
      for (const c of I.lists.sound || []) for (const f of c.files || []) {
        const paths = (f.formats || []).map((x) => x.path).filter(Boolean);
        if (paths.length && !paths.some((p) => used.has(p))) out.push({ type: 'sound', label: `${c.name}/${f.name}`, detail: `${(f.formats || []).map((x) => x.language).filter(Boolean).join(', ') || 'sans langue'}` });
      }
      return out;
    },
  },
  {
    id: 'ext_disabled', sev: 'info', title: 'Numéro désactivé',
    help: 'Numéro (extension) marqué désactivé : il n\'est plus joignable, mais reste réservé dans son contexte.',
    run: () => (I.lists.extension || []).filter((e) => e.enabled === false).map((e) => L('extension', e, 'désactivé')),
  },
];
export const SEV = { error: 'Erreur', warn: 'Avertissement', info: 'Information' };

export function runChecks() {
  return CHECKS.map((c) => {
    try { return { ...c, items: c.run() }; }
    catch (e) { console.error('[astrea] contrôle', c.id, e); return { ...c, items: [], failed: e.message }; }
  });
}
