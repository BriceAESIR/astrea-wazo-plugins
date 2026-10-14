// Call Flow Manager — écriture des destinations (lots 2a et 2b). Sans DOM.
// Règles lues dans le code de wazo-confd (master, 14/10/2026) :
//  - destination : schéma commun (helpers/destination.py), champs inconnus
//    ignorés ; type « none » = aucune destination ;
//  - PUT /users/{uuid}/fallbacks, /groups/{uuid}/fallbacks,
//    /queues/{id}/fallbacks, /switchboards/{uuid}/fallbacks : remplacement
//    COMPLET (clé absente ou null = débordement supprimé) → on relit, on
//    modifie la seule clé voulue, on renvoie toutes les clés ;
//  - PUT /incalls/{id}, /queues/{id}, /ivr/{id} : partiels (partial=True) ;
//    la destination d'une SDA est obligatoire (« none » pour la vider) ;
//  - SVI : choices envoyé en entier (supposé : la liste est remplacée).
// Toujours : relire juste avant d'écrire, ne rien écrire si c'est identique,
// une seule écriture par objet.
import { api } from '../common/core.js?v=0.35.0';
import { M } from './model.js?v=0.35.0';

// Champs d'entrée de chaque type de destination (le reste est en lecture seule).
const DEST_KEYS = {
  none: [], user: ['user_id', 'ring_time', 'moh_uuid'], group: ['group_id', 'ring_time'], queue: ['queue_id', 'ring_time', 'skill_rule_id', 'skill_rule_variables'],
  voicemail: ['voicemail_id', 'skip_instructions', 'greeting'], ivr: ['ivr_id'], conference: ['conference_id'], switchboard: ['switchboard_uuid', 'ring_time'],
  outcall: ['outcall_id', 'exten'], extension: ['exten', 'context'], sound: ['filename', 'skip', 'no_answer'], custom: ['command'], hangup: ['cause', 'timeout'],
  application: ['application', 'pin', 'context', 'email', 'application_uuid'],
};
export function cleanDest(d) {
  if (!d || !d.type || d.type === 'none') return null;
  const out = { type: d.type };
  for (const k of DEST_KEYS[d.type] || Object.keys(d)) if (d[k] !== undefined && d[k] !== null && d[k] !== '') out[k] = d[k];
  return out;
}
const canon = (d) => JSON.stringify(cleanDest(d), Object.keys(cleanDest(d) || {}).sort());
export const sameDest = (a, b) => canon(a) === canon(b);

// ---------------------------------------------------------------------------
// Emplacements modifiables. w = { k, id, f, key } (posé par model.js sur les sorties).
//   incall      : /incalls/{id}            champ destination
//   user_fb     : /users/{uuid}/fallbacks  clé <f>_destination
//   group_fb    : /groups/{uuid}/fallbacks
//   queue_fb    : /queues/{id}/fallbacks
//   queue       : /queues/{id}             champ wait_time_destination | wait_ratio_destination
//   sb_fb       : /switchboards/{uuid}/fallbacks
//   ivr         : /ivr/{id}                champ timeout|invalid|abort_destination
//   ivr_choice  : /ivr/{id}                choix de touche f (exten)
//   sched       : /schedules/{id}          closed_destination (lot 2b)
//   sched_exc   : /schedules/{id}          exceptional_periods[f].destination
//   sched_assoc : /{incalls|users|groups|queues}/{id}/schedules/{schedule_id}
//                 id = clé de l'objet (incall:1, user:5…) ; valeur
//                 {type: 'schedule', schedule_id} ou null. Vérifié dans
//                 wazo-confd (user_schedule/validator.py) : un seul horaire
//                 par objet → pour en changer, DELETE de l'ancien puis PUT.
// ---------------------------------------------------------------------------
const ASSOC_PATH = { incall: (o) => `/incalls/${o.id}`, user: (o) => `/users/${o.uuid}`, group: (o) => `/groups/${o.uuid}`, queue: (o) => `/queues/${o.id}` };
const ownerOf = (k) => { const i = k.indexOf(':'); const t = k.slice(0, i); return { t, o: M.by[t]?.get(k.slice(i + 1)) }; };
function holder(w) {
  const fbOf = (o) => { if (!o) return null; o.fallbacks ||= {}; return [o.fallbacks, `${w.f}_destination`]; };
  switch (w.k) {
    case 'incall': return [M.by.incall?.get(String(w.id)), 'destination'];
    case 'user_fb': return fbOf(M.userByUuid?.get(w.id));
    case 'group_fb': return fbOf(M.groupByUuid?.get(w.id));
    case 'queue_fb': return fbOf(M.by.queue?.get(String(w.id)));
    case 'sb_fb': return fbOf(M.by.switchboard?.get(w.id));
    case 'queue': case 'ivr': return [M.by[w.k]?.get(String(w.id)), w.f];
    case 'sched': return [M.by.schedule?.get(String(w.id)), 'closed_destination'];
    case 'sched_exc': return [M.by.schedule?.get(String(w.id))?.exceptional_periods?.[w.f], 'destination'];
    default: return null;
  }
}
// Valeur affichée (copie locale, modifiée par le brouillon).
// Plages d'un horaire (éditeur de conditions) : { open_periods, exceptional_periods }.
// Éditeur d'horaire : plages + destination « si fermé » ensemble.
const periodsOf = (s) => JSON.parse(JSON.stringify({ open_periods: s?.open_periods || [], exceptional_periods: s?.exceptional_periods || [], closed_destination: s?.closed_destination || null }));
// Égalité d'une valeur du brouillon (destination, horaire associé ou plages).
export const sameValue = (w, a, b) => (w.k === 'sched_periods' ? JSON.stringify(a) === JSON.stringify(b) : sameDest(a, b));
export function getDest(w) {
  if (w.k === 'sched_periods') return periodsOf(M.by.schedule?.get(String(w.id)));
  if (w.k === 'ivr_choice') return (M.by.ivr?.get(String(w.id))?.choices || []).find((c) => c.exten === w.f)?.destination || null;
  if (w.k === 'sched_assoc') { const s = ownerOf(w.id).o?.schedules?.[0]; return s ? { type: 'schedule', schedule_id: s.id } : null; }
  const h = holder(w); return h?.[0]?.[h[1]] || null;
}
export function setDest(w, d) {
  if (w.k === 'sched_periods') {
    const s = M.by.schedule?.get(String(w.id)); if (!s || !d) return;
    const v = periodsOf(d); s.open_periods = v.open_periods; s.exceptional_periods = v.exceptional_periods; s.closed_destination = v.closed_destination;
    return;
  }
  if (w.k === 'sched_assoc') {
    const { o } = ownerOf(w.id); if (!o) return;
    const s = d && M.by.schedule?.get(String(d.schedule_id));
    o.schedules = d ? [{ id: d.schedule_id, name: s?.name || '' }] : [];
    return;
  }
  if (w.k === 'ivr_choice') {
    const ivr = M.by.ivr?.get(String(w.id)); if (!ivr) return;
    ivr.choices ||= [];
    const i = ivr.choices.findIndex((c) => c.exten === w.f);
    if (!d) { if (i >= 0) ivr.choices.splice(i, 1); } else if (i >= 0) ivr.choices[i] = { ...ivr.choices[i], destination: d }; else ivr.choices.push({ exten: w.f, destination: d });
    return;
  }
  const h = holder(w); if (h?.[0]) h[0][h[1]] = d || null;
}

// ---------------------------------------------------------------------------
// Plan d'écriture : une opération par objet confd. entries = [{ w, after }].
// ---------------------------------------------------------------------------
const FB_KEYS = { user_fb: ['noanswer', 'busy', 'congestion', 'fail'], queue_fb: ['noanswer', 'busy', 'congestion', 'fail'], group_fb: ['noanswer', 'congestion'], sb_fb: ['noanswer'] };
const FB_PATH = { user_fb: (id) => `/users/${id}/fallbacks`, group_fb: (id) => `/groups/${id}/fallbacks`, queue_fb: (id) => `/queues/${id}/fallbacks`, sb_fb: (id) => `/switchboards/${id}/fallbacks` };
function opsOf(entries) {
  const by = new Map();
  for (const e of entries) {
    // Champs d'une file et débordements d'une file : deux routes différentes.
    const k = e.w.k === 'ivr_choice' ? 'ivr' : e.w.k === 'sched_exc' || e.w.k === 'sched_periods' ? 'sched' : e.w.k;
    const res = `${k}:${e.w.id}`;
    if (!by.has(res)) by.set(res, { k, id: e.w.id, entries: [] });
    by.get(res).entries.push(e);
  }
  return [...by.values()];
}
// Lit l'état actuel sur le serveur et calcule ce qu'il faut envoyer.
// Renvoie [{ path, before, body, changed }].
export async function prepare(entries) {
  const out = [];
  for (const op of opsOf(entries)) {
    if (FB_KEYS[op.k]) {
      const path = FB_PATH[op.k](op.id);
      const before = (await api('GET', path)) || {};
      const body = {};
      for (const k of FB_KEYS[op.k]) body[`${k}_destination`] = cleanDest(before[`${k}_destination`]);
      for (const e of op.entries) body[`${e.w.f}_destination`] = cleanDest(e.after);
      const changed = FB_KEYS[op.k].some((k) => !sameDest(before[`${k}_destination`], body[`${k}_destination`]));
      out.push({ path, before, body, changed });
    } else if (op.k === 'incall') {
      const path = `/incalls/${op.id}`;
      const before = await api('GET', path);
      const d = cleanDest(op.entries[op.entries.length - 1].after) || { type: 'none' };
      out.push({ path, before, body: { destination: d }, changed: !sameDest(before?.destination, d) });
    } else if (op.k === 'queue') {
      const path = `/queues/${op.id}`;
      const before = await api('GET', path);
      const body = {}; for (const e of op.entries) body[e.w.f] = cleanDest(e.after);
      out.push({ path, before, body, changed: Object.keys(body).some((f) => !sameDest(before?.[f], body[f])) });
    } else if (op.k === 'ivr') {
      const path = `/ivr/${op.id}`;
      const before = await api('GET', path);
      const body = {};
      let choices = (before?.choices || []).map((c) => ({ exten: c.exten, destination: cleanDest(c.destination) }));
      let touched = false;
      for (const e of op.entries) {
        if (e.w.k === 'ivr_choice') {
          touched = true;
          const i = choices.findIndex((c) => c.exten === e.w.f);
          const d = cleanDest(e.after);
          if (!d) { if (i >= 0) choices.splice(i, 1); } else if (i >= 0) choices[i] = { exten: e.w.f, destination: d }; else choices.push({ exten: e.w.f, destination: d });
        } else body[e.w.f] = cleanDest(e.after);
      }
      if (touched) { choices = choices.sort((a, b) => String(a.exten).localeCompare(String(b.exten), 'fr', { numeric: true })); body.choices = choices; }
      const changed = Object.keys(body).some((f) => f === 'choices'
        ? JSON.stringify(body.choices) !== JSON.stringify((before?.choices || []).map((c) => ({ exten: c.exten, destination: cleanDest(c.destination) })).sort((a, b) => String(a.exten).localeCompare(String(b.exten), 'fr', { numeric: true })))
        : !sameDest(before?.[f], body[f]));
      out.push({ path, before, body, changed });
    } else if (op.k === 'sched') {
      // Horaire : PUT partiel, mais périodes envoyées en entier (pas d'id de
      // période ; supposé : la liste envoyée remplace l'ancienne). Les plages
      // d'ouverture sont renvoyées telles quelles.
      const path = `/schedules/${op.id}`;
      const before = await api('GET', path);
      const per = (p, withDest) => { const x = { hours_start: p.hours_start, hours_end: p.hours_end, week_days: p.week_days, month_days: p.month_days, months: p.months }; if (withDest) x.destination = cleanDest(p.destination) || { type: 'none' }; return x; };
      let exc = (before?.exceptional_periods || []).map((p) => per(p, true));
      let open = (before?.open_periods || []).map((p) => per(p, false));
      let closed = cleanDest(before?.closed_destination) || { type: 'none' };
      // Plages d'abord (éditeur), puis destinations par index (l'appli interdit
      // de mélanger les deux sur un même horaire dans un brouillon).
      for (const e of op.entries) if (e.w.k === 'sched_periods') {
        if ('closed_destination' in e.after) closed = cleanDest(e.after.closed_destination) || { type: 'none' };
        open = e.after.open_periods.map((p) => per(p, false));
        exc = e.after.exceptional_periods.map((p) => ({ ...per(p, false), destination: cleanDest(p.destination) || closed }));
      }
      for (const e of op.entries) {
        if (e.w.k === 'sched') closed = cleanDest(e.after) || { type: 'none' };
        else if (e.w.k === 'sched_exc' && exc[e.w.f]) exc[e.w.f].destination = cleanDest(e.after) || { type: 'none' };
      }
      const body = { closed_destination: closed, open_periods: open, exceptional_periods: exc };
      const norm = (b) => JSON.stringify({ o: (b?.open_periods || []).map((p) => per(p, false)), e: (b?.exceptional_periods || []).map((p) => per(p, true)), c: cleanDest(b?.closed_destination) || { type: 'none' } });
      const changed = norm(before) !== norm(body);
      out.push({ path, before, body, changed });
    } else if (op.k === 'sched_assoc') {
      // Association : relire l'objet, retirer l'ancien horaire, associer le nouveau.
      const { t, o } = ownerOf(op.id);
      const base = ASSOC_PATH[t]?.(o); if (!base) continue;
      const before = await api('GET', base);
      const cur = before?.schedules?.[0]?.id ?? null;
      const next = op.entries[op.entries.length - 1].after?.schedule_id ?? null;
      if (cur != null && cur !== next) out.push({ method: 'DELETE', path: `${base}/schedules/${cur}`, before: { schedules: before.schedules }, changed: true });
      if (next != null && cur !== next) out.push({ method: 'PUT', path: `${base}/schedules/${next}`, before: { schedules: before?.schedules || [] }, changed: true });
      if (cur === next) out.push({ path: `${base}/schedules`, before: { schedules: before?.schedules || [] }, changed: false });
    }
  }
  return out;
}
// Écrit les opérations modifiées, une à une, dans l'ordre ; renvoie [{ path, ok, error }].
export async function execute(ops) {
  const res = [];
  for (const op of ops) {
    if (!op.changed) { res.push({ path: op.path, ok: true, skipped: true }); continue; }
    const m = op.method || 'PUT';
    try { await api(m, op.path, m === 'DELETE' || !op.body ? undefined : op.body); res.push({ path: `${m} ${op.path}`, ok: true }); } catch (e) { res.push({ path: `${m} ${op.path}`, ok: false, error: e.message }); }
  }
  return res;
}
