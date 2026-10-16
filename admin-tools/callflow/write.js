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
import { api } from '../common/core.js?v=0.39.0';
import { M } from './model.js?v=0.39.0';
import { groupCfgOf, applyGroupCfg, GROUP_FIELDS } from './group-editor.js?v=0.39.0';
import { queueCfgOf, applyQueueCfg, QUEUE_FIELDS, optionsList } from './queue-editor.js?v=0.39.0';
import { ivrCfgOf, applyIvrCfg, IVR_FIELDS } from './ivr-editor.js?v=0.39.0';
import { sbCfgOf, applySbCfg, SB_FIELDS } from './sb-editor.js?v=0.39.0';
import { incallCfgOf, applyIncallCfg, INCALL_FIELDS, userCfgOf, applyUserCfg, USER_FIELDS, vmCfgOf, applyVmCfg, VM_FIELDS, confCfgOf, applyConfCfg, CONF_FIELDS, schedCfgOf, applySchedCfg, SCHED_FIELDS } from './obj-editors.js?v=0.39.0';
import { outcallCfgOf, applyOutcallCfg, OUTCALL_FIELDS } from './outcall-editor.js?v=0.39.0';

// Réglages « simples » (obj-editors.js) : un PUT partiel des champs modifiés.
const SIMPLE = {
  incall_cfg: { obj: (id) => M.by.incall?.get(String(id)), path: (id) => `/incalls/${id}`, of: incallCfgOf, apply: applyIncallCfg, fields: INCALL_FIELDS },
  vm_cfg: { obj: (id) => M.by.voicemail?.get(String(id)), path: (id) => `/voicemails/${id}`, of: vmCfgOf, apply: applyVmCfg, fields: VM_FIELDS,
    // Vérifié (voicemail/schema.py) : delete_messages exige email et attach_audio dans le même envoi.
    fix: (body, a) => { if (Object.keys(body).length && a.fields.delete_messages) Object.assign(body, { delete_messages: true, email: a.fields.email, attach_audio: a.fields.attach_audio }); } },
  conf_cfg: { obj: (id) => M.by.conference?.get(String(id)), path: (id) => `/conferences/${id}`, of: confCfgOf, apply: applyConfCfg, fields: CONF_FIELDS },
  schedgen_cfg: { obj: (id) => M.by.schedule?.get(String(id)), path: (id) => `/schedules/${id}`, of: schedCfgOf, apply: applySchedCfg, fields: SCHED_FIELDS },
};

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
const ASSOC_PATH = { incall: (o) => `/incalls/${o.id}`, user: (o) => `/users/${o.uuid}`, group: (o) => `/groups/${o.uuid}`, queue: (o) => `/queues/${o.id}`, outcall: (o) => `/outcalls/${o.id}` };
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
const CFG_KINDS = new Set(['sched_periods', 'group_cfg', 'queue_cfg', 'ivr_cfg', 'sb_cfg', 'user_cfg', 'outcall_cfg', ...Object.keys(SIMPLE)]);
// SVI : destinations nettoyées (comparaison et écriture sur les seuls champs d'entrée).
const normIvr = (v) => v && { ...v, timeout_destination: cleanDest(v.timeout_destination), invalid_destination: cleanDest(v.invalid_destination), abort_destination: cleanDest(v.abort_destination), choices: (v.choices || []).map((c) => ({ exten: String(c.exten), destination: cleanDest(c.destination) })) };
export const sameValue = (w, a, b) => (w.k === 'ivr_cfg' ? JSON.stringify(normIvr(a)) === JSON.stringify(normIvr(b)) : CFG_KINDS.has(w.k) ? JSON.stringify(a) === JSON.stringify(b) : sameDest(a, b));
export function getDest(w) {
  // group_cfg (lot 2c) : réglage complet d'un groupe (voir group-editor.js).
  if (w.k === 'group_cfg') return JSON.parse(JSON.stringify(groupCfgOf(M.groupByUuid?.get(w.id) || {})));
  if (w.k === 'queue_cfg') return JSON.parse(JSON.stringify(queueCfgOf(M.by.queue?.get(String(w.id)) || {})));
  if (SIMPLE[w.k]) return JSON.parse(JSON.stringify(SIMPLE[w.k].of(SIMPLE[w.k].obj(w.id) || {})));
  if (w.k === 'outcall_cfg') return JSON.parse(JSON.stringify(outcallCfgOf(M.by.outcall?.get(String(w.id)) || {})));
  if (w.k === 'user_cfg') return JSON.parse(JSON.stringify(userCfgOf(M.userByUuid?.get(w.id) || {})));
  if (w.k === 'sb_cfg') return JSON.parse(JSON.stringify(sbCfgOf(M.by.switchboard?.get(String(w.id)) || {})));
  if (w.k === 'ivr_cfg') return normIvr(JSON.parse(JSON.stringify(ivrCfgOf(M.by.ivr?.get(String(w.id)) || {}))));
  if (w.k === 'sched_periods') return periodsOf(M.by.schedule?.get(String(w.id)));
  if (w.k === 'ivr_choice') return (M.by.ivr?.get(String(w.id))?.choices || []).find((c) => c.exten === w.f)?.destination || null;
  if (w.k === 'sched_assoc') { const s = ownerOf(w.id).o?.schedules?.[0]; return s ? { type: 'schedule', schedule_id: s.id } : null; }
  const h = holder(w); return h?.[0]?.[h[1]] || null;
}
export function setDest(w, d) {
  if (w.k === 'group_cfg') { const g = M.groupByUuid?.get(w.id); if (g && d) applyGroupCfg(g, JSON.parse(JSON.stringify(d))); return; }
  if (w.k === 'queue_cfg') { const q = M.by.queue?.get(String(w.id)); if (q && d) applyQueueCfg(q, JSON.parse(JSON.stringify(d))); return; }
  if (SIMPLE[w.k]) { const o = SIMPLE[w.k].obj(w.id); if (o && d) SIMPLE[w.k].apply(o, JSON.parse(JSON.stringify(d))); return; }
  if (w.k === 'outcall_cfg') { const o = M.by.outcall?.get(String(w.id)); if (o && d) applyOutcallCfg(o, JSON.parse(JSON.stringify(d))); return; }
  if (w.k === 'user_cfg') { const u = M.userByUuid?.get(w.id); if (u && d) applyUserCfg(u, JSON.parse(JSON.stringify(d))); return; }
  if (w.k === 'sb_cfg') { const s = M.by.switchboard?.get(String(w.id)); if (s && d) applySbCfg(s, JSON.parse(JSON.stringify(d))); return; }
  if (w.k === 'ivr_cfg') { const o = M.by.ivr?.get(String(w.id)); if (o && d) applyIvrCfg(o, JSON.parse(JSON.stringify(d))); return; }
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
    const k = e.w.k === 'ivr_choice' || e.w.k === 'ivr_cfg' ? 'ivr' : e.w.k === 'sched_exc' || e.w.k === 'sched_periods' ? 'sched' : e.w.k;
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
      let choices = (before?.choices || []).map((c) => ({ exten: String(c.exten), destination: cleanDest(c.destination) }));
      let touched = false;
      for (const e of op.entries) {
        if (e.w.k === 'ivr_cfg') {
          // Réglage complet (ivr-editor.js) : champs modifiés + destinations + touches en entier.
          const a = normIvr(e.after);
          for (const k of IVR_FIELDS) if (JSON.stringify(before?.[k] ?? null) !== JSON.stringify(a.fields[k] ?? null)) body[k] = a.fields[k];
          for (const k of ['timeout_destination', 'invalid_destination', 'abort_destination']) body[k] = a[k];
          choices = a.choices.map((c) => ({ ...c })); touched = true;
          continue;
        }
        if (e.w.k === 'ivr_choice') {
          touched = true;
          const i = choices.findIndex((c) => c.exten === e.w.f);
          const d = cleanDest(e.after);
          if (!d) { if (i >= 0) choices.splice(i, 1); } else if (i >= 0) choices[i] = { exten: e.w.f, destination: d }; else choices.push({ exten: e.w.f, destination: d });
        } else body[e.w.f] = cleanDest(e.after);
      }
      if (touched) { choices = choices.sort((a, b) => String(a.exten).localeCompare(String(b.exten), 'fr', { numeric: true })); body.choices = choices; }
      const changed = Object.keys(body).some((f) => f === 'choices'
        ? JSON.stringify(body.choices) !== JSON.stringify((before?.choices || []).map((c) => ({ exten: String(c.exten), destination: cleanDest(c.destination) })).sort((a, b) => String(a.exten).localeCompare(String(b.exten), 'fr', { numeric: true })))
        : f.endsWith('_destination') ? !sameDest(before?.[f], body[f]) : JSON.stringify(before?.[f] ?? null) !== JSON.stringify(body[f] ?? null));
      out.push({ path, before, body, changed });
    } else if (op.k === 'sched') {
      // Horaire : PUT partiel, mais périodes envoyées en entier (pas d'id de
      // période ; supposé : la liste envoyée remplace l'ancienne). Les plages
      // d'ouverture sont renvoyées telles quelles.
      const path = `/schedules/${op.id}`;
      const before = await api('GET', path);
      // Constaté en réel (Brice, 14/10/2026) : confd refuse une liste vide
      // (« month_days cannot be empty », « months cannot be empty ») alors que
      // l'agid lit « vide » comme « sans restriction ». « Tous » s'envoie donc
      // en liste complète : jours 1-31, mois 1-12, jours de semaine 1-7.
      const all = (a, n) => (Array.isArray(a) && a.length ? [...a].sort((x, y) => x - y) : Array.from({ length: n }, (_, i) => i + 1));
      const per = (p, withDest) => { const x = { hours_start: p.hours_start, hours_end: p.hours_end, week_days: all(p.week_days, 7), month_days: all(p.month_days, 31), months: all(p.months, 12) }; if (withDest) x.destination = cleanDest(p.destination) || { type: 'none' }; return x; };
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
    } else if (op.k === 'group_cfg') {
      // Réglage complet d'un groupe (lot 2c) : relire, puis une écriture par partie modifiée.
      const base = `/groups/${op.id}`;
      const before = await api('GET', base);
      const b = groupCfgOf(before || {}), a = op.entries[op.entries.length - 1].after;
      const nn = (x) => (x === undefined ? null : x);
      const mine = [];
      const changedF = GROUP_FIELDS.filter((k) => JSON.stringify(nn(b.fields[k])) !== JSON.stringify(nn(a.fields[k])));
      // ignore_forward toujours envoyé : sinon confd le remet à false (vérifié, post_load du schéma).
      if (changedF.length) mine.push({ path: base, before, body: { ...Object.fromEntries(changedF.map((k) => [k, a.fields[k]])), ignore_forward: !!a.fields.ignore_forward }, changed: true });
      if (JSON.stringify(b.users) !== JSON.stringify(a.users)) mine.push({ path: `${base}/members/users`, before: before?.members, body: { users: a.users.map((m, i) => ({ uuid: m.uuid, priority: i })) }, changed: true });
      if (JSON.stringify(b.exts) !== JSON.stringify(a.exts)) mine.push({ path: `${base}/members/extensions`, before: before?.members, body: { extensions: a.exts.map((m, i) => ({ exten: m.exten, context: m.context, priority: i })) }, changed: true });
      if (JSON.stringify(b.extension) !== JSON.stringify(a.extension)) {
        const old = before?.extensions?.[0];
        mine.push({ path: `${base}/extensions`, before: { extensions: before?.extensions }, body: { extension: a.extension }, changed: true,
          // Une seule extension par groupe (vérifié) : créer la nouvelle, dissocier
          // l'ancienne, associer la nouvelle ; en cas d'échec, réassocier l'ancienne
          // et supprimer la nouvelle. L'ancienne extension reste libre dans Wazo.
          run: async () => {
            const created = a.extension ? await api('POST', '/extensions', { exten: a.extension.exten, context: a.extension.context }) : null;
            if (old) await api('DELETE', `${base}/extensions/${old.id}`);
            if (!created) return;
            try { await api('PUT', `${base}/extensions/${created.id}`); } catch (e) {
              if (old) { try { await api('PUT', `${base}/extensions/${old.id}`); } catch { /* */ } }
              try { await api('DELETE', `/extensions/${created.id}`); } catch { /* */ }
              throw e;
            }
          } });
      }
      for (const id of a.perms.filter((x) => !b.perms.includes(x))) mine.push({ method: 'PUT', path: `${base}/callpermissions/${id}`, before: { call_permissions: before?.call_permissions }, changed: true });
      for (const id of b.perms.filter((x) => !a.perms.includes(x))) mine.push({ method: 'DELETE', path: `${base}/callpermissions/${id}`, before: { call_permissions: before?.call_permissions }, changed: true });
      out.push(...(mine.length ? mine : [{ path: base, before, changed: false }]));
    } else if (SIMPLE[op.k]) {
      const S = SIMPLE[op.k]; const path = S.path(op.id);
      const before = await api('GET', path);
      const b = S.of(before || {}), a = op.entries[op.entries.length - 1].after;
      const body = {}; for (const k of S.fields) if (JSON.stringify(b.fields[k] ?? null) !== JSON.stringify(a.fields[k] ?? null)) body[k] = a.fields[k];
      S.fix?.(body, a);
      out.push({ path, before, body, changed: Object.keys(body).length > 0 });
    } else if (op.k === 'outcall_cfg') {
      // Règle sortante (outcall-editor.js) : relire, puis une écriture par partie modifiée.
      const base = `/outcalls/${op.id}`;
      const before = await api('GET', base);
      const b = outcallCfgOf(before || {}), a = op.entries[op.entries.length - 1].after;
      const mine = [];
      const body = {}; for (const k of OUTCALL_FIELDS) if (JSON.stringify(b.fields[k] ?? null) !== JSON.stringify(a.fields[k] ?? null)) body[k] = a.fields[k];
      if (Object.keys(body).length) mine.push({ path: base, before, body, changed: true });
      const opts = (p) => ({ strip_digits: p.strip_digits ?? 0, external_prefix: p.external_prefix || null, prefix: p.prefix || null, caller_id: p.caller_id || null });
      const bi = new Map(b.patterns.map((p) => [p.id, p]));
      const keep = new Set(a.patterns.filter((p) => p.id != null).map((p) => p.id));
      // Motif retiré : dissocié puis supprimé (l'extension n'a pas d'autre usage).
      for (const p of b.patterns) if (!keep.has(p.id)) mine.push({ method: 'DELETE', path: `${base}/extensions/${p.id}`, before, body: { exten: p.exten }, changed: true, run: async () => { await api('DELETE', `${base}/extensions/${p.id}`); try { await api('DELETE', `/extensions/${p.id}`); } catch { /* déjà libre */ } } });
      for (const p of a.patterns) {
        const old = p.id != null ? bi.get(p.id) : null;
        if (!old) {
          // Nouveau motif : extension créée dans le contexte sortant, puis associée avec ses options.
          mine.push({ method: 'POST', path: `${base}/extensions`, before, body: { exten: p.exten, context: p.context, ...opts(p) }, changed: true, run: async () => {
            const created = await api('POST', '/extensions', { exten: p.exten, context: p.context });
            try { await api('PUT', `${base}/extensions/${created.id}`, opts(p)); } catch (e) { try { await api('DELETE', `/extensions/${created.id}`); } catch { /* */ } throw e; }
          } });
          continue;
        }
        if (old.exten !== p.exten) mine.push({ path: `/extensions/${p.id}`, before, body: { exten: p.exten }, changed: true, run: async () => api('PUT', `/extensions/${p.id}`, { exten: p.exten, context: p.context }) });
        if (JSON.stringify(opts(old)) !== JSON.stringify(opts(p))) mine.push({ path: `${base}/extensions/${p.id}`, before, body: opts(p), changed: true });
      }
      if (JSON.stringify(b.trunks) !== JSON.stringify(a.trunks)) mine.push({ path: `${base}/trunks`, before, body: { trunks: a.trunks.map((id) => ({ id })) }, changed: true });
      for (const id of a.perms.filter((x) => !b.perms.includes(x))) mine.push({ method: 'PUT', path: `${base}/callpermissions/${id}`, before: { call_permissions: before?.call_permissions }, changed: true });
      for (const id of b.perms.filter((x) => !a.perms.includes(x))) mine.push({ method: 'DELETE', path: `${base}/callpermissions/${id}`, before: { call_permissions: before?.call_permissions }, changed: true });
      out.push(...(mine.length ? mine : [{ path: base, before, changed: false }]));
    } else if (op.k === 'user_cfg') {
      // Utilisateur (routage) : champs (PUT partiel), services et renvois par leurs routes.
      const base = `/users/${op.id}`;
      const before = await api('GET', base);
      const b = userCfgOf(before || {}), a = op.entries[op.entries.length - 1].after;
      const mine = [];
      const body = {}; for (const k of USER_FIELDS) if (JSON.stringify(b.fields[k] ?? null) !== JSON.stringify(a.fields[k] ?? null)) body[k] = a.fields[k];
      if (Object.keys(body).length) mine.push({ path: base, before, body, changed: true });
      for (const s of ['dnd', 'incallfilter']) if (b[s] !== a[s]) mine.push({ path: `${base}/services/${s}`, before: before?.services, body: { enabled: a[s] }, changed: true });
      for (const k of ['unconditional', 'busy', 'noanswer']) if (JSON.stringify(b.forwards[k]) !== JSON.stringify(a.forwards[k])) mine.push({ path: `${base}/forwards/${k}`, before: before?.forwards, body: a.forwards[k], changed: true });
      out.push(...(mine.length ? mine : [{ path: base, before, changed: false }]));
    } else if (op.k === 'sb_cfg') {
      // Standard (sb-editor.js) : PUT partiel des champs modifiés, opérateurs en entier.
      const base = `/switchboards/${op.id}`;
      const before = await api('GET', base);
      const b = sbCfgOf(before || {}), a = op.entries[op.entries.length - 1].after;
      const mine = [];
      const body = {}; for (const k of SB_FIELDS) if (JSON.stringify(b.fields[k] ?? null) !== JSON.stringify(a.fields[k] ?? null)) body[k] = a.fields[k];
      if (Object.keys(body).length) mine.push({ path: base, before, body, changed: true });
      if (JSON.stringify(b.users) !== JSON.stringify(a.users)) mine.push({ path: `${base}/members/users`, before: before?.members, body: { users: a.users.map((m) => ({ uuid: m.uuid })) }, changed: true });
      out.push(...(mine.length ? mine : [{ path: base, before, changed: false }]));
    } else if (op.k === 'queue_cfg') {
      // Réglage complet d'une file (queue-editor.js) : relire, puis une écriture par partie modifiée.
      const base = `/queues/${op.id}`;
      const before = await api('GET', base);
      const b = queueCfgOf(before || {}), a = op.entries[op.entries.length - 1].after;
      const nn = (x) => (x === undefined ? null : x);
      const mine = [];
      const body = {};
      for (const k of QUEUE_FIELDS) if (JSON.stringify(nn(b.fields[k])) !== JSON.stringify(nn(a.fields[k]))) body[k] = a.fields[k];
      // options : confd remplace TOUTE la liste (vérifié, xivo-dao) → liste complète.
      const ol = (o) => JSON.stringify(optionsList(o).sort((x, y) => x[0].localeCompare(y[0])));
      if (ol(b.opts) !== ol(a.opts)) body.options = optionsList(a.opts);
      if (Object.keys(body).length) mine.push({ path: base, before, body, changed: true });
      // Membres un par un. Membre déjà présent dont l'ordre ou la pénalité change :
      // retiré puis rajouté (un PUT seul ne notifie pas Asterisk, vérifié).
      const memberOps = (kind, bl, al, idOf, bodyOf) => {
        const bi = new Map(bl.map((m, i) => [String(idOf(m)), { m, i }]));
        const ai = new Map(al.map((m, i) => [String(idOf(m)), { m, i }]));
        for (const [id] of bi) if (!ai.has(id)) mine.push({ method: 'DELETE', path: `${base}/members/${kind}/${id}`, before: before?.members, changed: true });
        for (const [id, { m, i }] of ai) {
          const old = bi.get(id);
          const same = old && JSON.stringify(bodyOf(old.m, old.i)) === JSON.stringify(bodyOf(m, i));
          if (same) continue;
          if (old) mine.push({ method: 'DELETE', path: `${base}/members/${kind}/${id}`, before: before?.members, changed: true });
          mine.push({ path: `${base}/members/${kind}/${id}`, before: before?.members, body: bodyOf(m, i), changed: true });
        }
      };
      memberOps('agents', b.agents, a.agents, (m) => m.id, (m, i) => ({ penalty: m.penalty ?? 0, priority: i }));
      memberOps('users', b.users, a.users, (m) => m.uuid, (m, i) => ({ priority: i }));
      if (JSON.stringify(b.extension) !== JSON.stringify(a.extension)) {
        const old = before?.extensions?.[0];
        mine.push({ path: `${base}/extensions`, before: { extensions: before?.extensions }, body: { extension: a.extension }, changed: true,
          // Une seule extension par file (vérifié, queue_extension/validator.py) : comme pour un groupe.
          run: async () => {
            const created = a.extension ? await api('POST', '/extensions', { exten: a.extension.exten, context: a.extension.context }) : null;
            if (old) await api('DELETE', `${base}/extensions/${old.id}`);
            if (!created) return;
            try { await api('PUT', `${base}/extensions/${created.id}`); } catch (e) {
              if (old) { try { await api('PUT', `${base}/extensions/${old.id}`); } catch { /* */ } }
              try { await api('DELETE', `/extensions/${created.id}`); } catch { /* */ }
              throw e;
            }
          } });
      }
      out.push(...(mine.length ? mine : [{ path: base, before, changed: false }]));
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
    try {
      if (op.run) await op.run(); else await api(m, op.path, m === 'DELETE' || !op.body ? undefined : op.body);
      res.push({ path: `${m} ${op.path}`, ok: true });
    } catch (e) { res.push({ path: `${m} ${op.path}`, ok: false, error: e.message }); }
  }
  return res;
}
