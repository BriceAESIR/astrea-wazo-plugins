// Astrea Desk — pont vers les éditeurs de Call Flow Manager (copie figée
// desk/cf/, générée par tools/sync-callflow.ps1 à chaque publication).
// Call Flow travaille avec un brouillon : chaque éditeur renvoie des valeurs
// (onSave), rangées en entrées { w, before, after } ; write.js relit le
// serveur (prepare), signale ce qui a changé ailleurs (conflictsOf) puis écrit
// (execute). Desk reprend exactement ce cycle, mais écrit dès que l'éditeur
// est validé ; une modification faite ailleurs entre-temps fait tout refuser
// (rien n'est écrasé). Règles d'écriture : voir les commentaires de cf/write.js.
import { S, esc, toast, confirmModal, canWrite } from '../admin-tools/common/core.js?v=0.7.5';
import { M, loadAll, ensureDetail, ensureAllDetails, loadTrunkOperators, assocW, tapi, destLabel, showNum } from './cf/model.js?v=0.7.5';
import { getDest, setDest, sameValue, prepare, conflictsOf, execute } from './cf/write.js?v=0.7.5';
import { openGroupEditor } from './cf/group-editor.js?v=0.7.5';
import { openQueueEditor } from './cf/queue-editor.js?v=0.7.5';
import { openIvrEditor } from './cf/ivr-editor.js?v=0.7.5';
import { openSbEditor } from './cf/sb-editor.js?v=0.7.5';
import { openOutcallEditor } from './cf/outcall-editor.js?v=0.7.5';
import { openScheduleEditor } from './cf/sched-editor.js?v=0.7.5';
import { openIncallEditor, openUserEditor, openVmEditor, openConfEditor, openSchedGenEditor } from './cf/obj-editors.js?v=0.7.5';

export { M, destLabel, showNum };

// Modèle de Call Flow pour le site ouvert (toutes les listes du tenant + détails).
let loading = null, loadedFor = null;
export async function cfModel(force = false) {
  if (!force && loadedFor === S.tenant && M.tenant === S.tenant) return M;
  loading ||= (async () => {
    await loadAll();
    await Promise.all([ensureAllDetails(), loadTrunkOperators().catch(() => {})]);
    loadedFor = S.tenant;
  })().finally(() => { loading = null; });
  await loading;
  return M;
}

const PATH = { user: (o) => `/users/${o.uuid}`, group: (o) => `/groups/${o.uuid}`, queue: (o) => `/queues/${o.id}`, ivr: (o) => `/ivr/${o.id}`, switchboard: (o) => `/switchboards/${o.uuid}`, outcall: (o) => `/outcalls/${o.id}`, incall: (o) => `/incalls/${o.id}`, voicemail: (o) => `/voicemails/${o.id}`, conference: (o) => `/conferences/${o.id}`, schedule: (o) => `/schedules/${o.id}` };
export const objOf = (type, id) => (type === 'group' ? M.groupByUuid?.get(id) : type === 'user' ? M.userByUuid?.get(id) : M.by[type]?.get(String(id)));
const schedUsage = (s) => ['incall', 'user', 'group', 'queue', 'outcall'].reduce((n, t) => n + (M.lists[t] || []).filter((o) => (o.schedules || []).some((x) => String(x.id) === String(s.id))).length, 0);

// Brouillon d'une seule édition (même logique que addDraft de Call Flow).
function session() {
  const d = new Map();
  return {
    add(w, value) {
      const cur = d.get(w.key);
      const before = cur ? cur.before : JSON.parse(JSON.stringify(getDest(w) ?? null));
      setDest(w, value);
      if (sameValue(w, before, value)) d.delete(w.key); else d.set(w.key, { w, before, after: value });
    },
    entries: () => [...d.values()],
    revert() { for (const e of [...d.values()].reverse()) setDest(e.w, e.before); d.clear(); },
  };
}

// Écriture d'une édition : refus si modifié ailleurs, sinon écriture, puis relecture du modèle.
async function commit(s, label, onDone) {
  const entries = s.entries();
  if (!entries.length) { toast('Aucune modification.'); return; }
  try {
    const conflicts = await conflictsOf(entries);
    if (conflicts.length) {
      s.revert(); await cfModel(true); onDone?.();
      confirmModal(`<h3>Rien n'a été écrit</h3><p>${esc(label)} a été modifié ailleurs (Portal, autre poste) depuis l'ouverture : ${esc([...new Set(conflicts.flatMap((c) => c.parts))].join(', '))}.</p><p class="muted small">Rouvrez le réglage : il repart de la version actuelle de Wazo.</p>`, () => true, 'Fermer');
      return;
    }
    const ops = await prepare(entries.map((e) => ({ w: e.w, after: e.after })));
    const res = await execute(ops);
    console.info('[astrea] Desk : écriture', res);
    const bad = res.filter((x) => !x.ok), warns = res.filter((x) => x.warn);
    await cfModel(true); onDone?.();
    if (!bad.length && !warns.length) toast(`${label} : enregistré.`, 4000);
    else confirmModal(`<h3>${bad.length ? 'Écriture partielle' : 'Enregistré, avec des avertissements'}</h3><ul class="small">${bad.map((b) => `<li><code>${esc(b.path)}</code> : ${esc(b.error)}</li>`).join('')}${warns.map((b) => `<li><code>${esc(b.path)}</code> : ${esc(b.warn)}</li>`).join('')}</ul><p class="muted small">Les données affichées ont été relues dans Wazo.</p>`, () => true, 'Fermer');
  } catch (e) {
    s.revert(); await cfModel(true).catch(() => {}); onDone?.();
    toast(`Échec, rien n'a été écrit : ${e.message}`, 9000);
  }
}

// Ouvre le réglage complet d'un objet ; onDone : rafraîchir l'écran appelant.
export async function edit(type, id, onDone, { hours = false } = {}) {
  if (!canWrite()) return;
  await cfModel();
  const o = objOf(type, id);
  if (!o) { toast('Objet introuvable : la liste a peut-être changé, elle est relue.'); await cfModel(true); onDone?.(); return; }
  // Relire l'objet avant d'ouvrir (comme Call Flow) : l'éditeur part de l'état actuel.
  try { const fresh = await tapi('GET', PATH[type](o)); if (fresh) Object.assign(o, fresh); } catch (e) { console.warn('[astrea] relecture', e.message); }
  await ensureDetail(type, o);
  // Fenêtre vierge : les éditeurs de Call Flow posent des écouteurs sur
  // #modal-body sans les retirer ; ceux d'un éditeur précédent (SVI…)
  // planteraient sur le contenu du suivant (constaté le 02/11/2026).
  const mb = document.getElementById('modal-body'); mb.replaceWith(mb.cloneNode(false));
  const s = session();
  const name = o.label || o.name || o.description || [o.firstname, o.lastname].filter(Boolean).join(' ') || '';
  const done = (label) => setTimeout(() => commit(s, label, onDone), 0);
  const w = (k, key, f = 'cfg') => ({ k, id: key, f, key: `${k}:${key}:${f}` });
  const sched = (owner, v) => s.add(assocW(owner), v ? { type: 'schedule', schedule_id: v } : null);
  switch (type) {
    case 'group': return openGroupEditor(o, (r) => {
      s.add(w('group_cfg', o.uuid), r.cfg);
      for (const f of ['noanswer', 'congestion']) s.add(w('group_fb', o.uuid, f), r[f]);
      sched(`group:${o.id}`, r.schedule); done(`Groupe « ${name} »`);
    });
    case 'queue': return openQueueEditor(o, (r) => {
      s.add(w('queue_cfg', o.id), r.cfg);
      for (const f of ['noanswer', 'busy', 'congestion', 'fail']) s.add(w('queue_fb', o.id, f), r.fb[f]);
      s.add(w('queue', o.id, 'wait_time_destination'), r.wait.time);
      s.add(w('queue', o.id, 'wait_ratio_destination'), r.wait.ratio);
      sched(`queue:${o.id}`, r.schedule); done(`File « ${name} »`);
    });
    case 'ivr': return openIvrEditor(o, (cfg) => { s.add(w('ivr_cfg', o.id), cfg); done(`SVI « ${name} »`); });
    case 'switchboard': return openSbEditor(o, (r) => { s.add(w('sb_cfg', o.uuid), r.cfg); s.add(w('sb_fb', o.uuid, 'noanswer'), r.noanswer); done(`POPC « ${name} »`); });
    case 'outcall': return openOutcallEditor(o, (r) => { s.add(w('outcall_cfg', o.id), r.cfg); sched(`outcall:${o.id}`, r.schedule); done(`Appel sortant « ${name} »`); });
    case 'incall': {
      const num = showNum(o.extensions?.[0]?.exten) || name;
      return openIncallEditor(o, num, (r) => {
        s.add(w('incall_cfg', o.id), r.cfg);
        s.add(w('incall', o.id, 'destination'), r.destination);
        sched(`incall:${o.id}`, r.schedule); done(`Appel entrant ${num}`);
      });
    }
    case 'user': return openUserEditor(o, (v) => { s.add(w('user_cfg', o.uuid), v); done(`Utilisateur « ${name} »`); });
    case 'voicemail': return openVmEditor(o, (v) => { s.add(w('vm_cfg', o.id), v); done(`Messagerie « ${name} »`); });
    case 'conference': return openConfEditor(o, (v) => { s.add(w('conf_cfg', o.id), v); done(`Conférence « ${name} »`); });
    case 'schedule':
      // Heures (grille de la semaine, si fermé, fermetures, fériés) ou réglages généraux.
      if (hours) return openScheduleEditor(o, (v) => { s.add(w('sched_periods', o.id, 'periods'), v); done(`Plage horaire « ${name} »`); });
      return openSchedGenEditor(o, schedUsage(o), (v) => { s.add(w('schedgen_cfg', o.id), v); done(`Plage horaire « ${name} »`); }, () => { document.getElementById('modal').hidden = true; edit('schedule', id, onDone, { hours: true }); });
    default: toast('Réglage non disponible pour ce type.');
  }
}
export { schedUsage };
