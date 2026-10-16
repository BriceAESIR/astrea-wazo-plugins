// Call Flow Manager — « Restaurer une sauvegarde… » (demande de Brice,
// 16/10/2026). Lit une sauvegarde JSON (format 2 : une ligne par écriture, avec
// méthode, état d'avant et contenu envoyé) et défait ces écritures, de la
// dernière à la première : chaque champ envoyé reprend sa valeur d'avant.
// Les codes (messagerie, conférence) ne sont pas dans la sauvegarde (« *** ») :
// encart d'avertissement et réinitialisation possible avec de nouveaux codes,
// montrés une seule fois (jamais enregistrés dans un fichier).
// Non restauré automatiquement : un numéro interne changé (risque de collision
// si le numéro a été réattribué) — signalé.
import { S, $, esc, api, toast, confirmModal, downloadJson, fullName } from '../common/core.js?v=0.39.2';
import { M } from './model.js?v=0.39.2';
import { cleanDest } from './write.js?v=0.39.2';
import { redact } from './ed-ui.js?v=0.39.2';

const HIDDEN = '***';
const newCode = (n = 4) => { const a = new Uint32Array(n); crypto.getRandomValues(a); return [...a].map((x) => x % 10).join(''); };
const all = (a, n) => (Array.isArray(a) && a.length ? [...a].sort((x, y) => x - y) : Array.from({ length: n }, (_, i) => i + 1));
const period = (p, dest) => { const x = { hours_start: p.hours_start, hours_end: p.hours_end, week_days: all(p.week_days, 7), month_days: all(p.month_days, 31), months: all(p.months, 12) }; if (dest) x.destination = cleanDest(p.destination) || { type: 'none' }; return x; };

// Nom lisible de l'objet d'un chemin (/groups/<uuid>/…, /incalls/12…).
function objLabel(path) {
  const m = path.match(/^\/(\w+)\/([^/]+)/); if (!m) return path;
  const [, t, id] = m;
  const get = {
    incalls: () => M.by.incall?.get(id) && `SDA ${M.by.incall.get(id).extensions?.[0]?.exten || id}`,
    users: () => M.userByUuid?.get(id) && `Utilisateur ${fullName(M.userByUuid.get(id))}`,
    groups: () => M.groupByUuid?.get(id) && `Groupe ${M.groupByUuid.get(id).label}`,
    queues: () => M.by.queue?.get(id) && `File d'attente ${M.by.queue.get(id).label || M.by.queue.get(id).name}`,
    ivr: () => M.by.ivr?.get(id) && `SVI ${M.by.ivr.get(id).name}`,
    schedules: () => M.by.schedule?.get(id) && `Horaire ${M.by.schedule.get(id).name}`,
    switchboards: () => M.by.switchboard?.get(id) && `Standard ${M.by.switchboard.get(id).name}`,
    voicemails: () => M.by.voicemail?.get(id) && `Messagerie ${M.by.voicemail.get(id).name}`,
    conferences: () => M.by.conference?.get(id) && `Conférence ${M.by.conference.get(id).name || id}`,
    outcalls: () => M.by.outcall?.get(id) && `Règle sortante ${M.by.outcall.get(id).name}`,
    extensions: () => `Motif / numéro #${id}`,
  }[t];
  return get?.() || `${t} ${id} (introuvable aujourd'hui)`;
}
const sub = (path) => {
  if (/\/fallbacks$/.test(path)) return 'débordements';
  if (/\/trunks$/.test(path)) return 'trunks';
  if (/^\/outcalls\/\d+\/extensions/.test(path) || /^\/extensions\//.test(path)) return 'motif';
  if (/\/members\//.test(path)) return 'membres';
  if (/\/schedules\/\d+$/.test(path)) return 'horaire associé';
  if (/\/callpermissions\//.test(path)) return 'autorisation d\'appel';
  if (/\/services\//.test(path)) return path.endsWith('dnd') ? 'NPD' : 'filtrage';
  if (/\/forwards\//.test(path)) return 'renvoi';
  if (/\/extensions/.test(path)) return 'numéro interne';
  return 'réglages';
};

// Étapes qui défont une écriture : [{ method, path, body }] ou { skip: raison }.
// secrets : objets dont un code envoyé est masqué dans la sauvegarde.
function undo(e, secrets) {
  const m = e.method || 'PUT', p = e.path, b = e.before;
  if (e.numero) return { skip: /^\/outcalls\//.test(p) || /^\/extensions\//.test(p) ? 'motif de règle sortante ajouté, retiré ou renommé : à remettre à la main' : 'numéro interne changé : à remettre à la main (l\'ancien numéro a pu être réattribué)' };
  if (/^\/(incalls|users|groups|queues)\/[^/]+\/schedules\/\d+$/.test(p) || /\/callpermissions\/\d+$/.test(p)) return [{ method: m === 'DELETE' ? 'PUT' : 'DELETE', path: p }];
  let x;
  if ((x = p.match(/^\/queues\/\d+\/members\/(agents|users)\/([^/]+)$/))) {
    // Retirer, puis remettre tel qu'avant s'il était membre (un PUT seul ne notifie pas Asterisk).
    const list = b?.[x[1]] || [];
    const old = x[1] === 'agents' ? list.find((a) => String(a.id) === x[2]) : list.find((u) => u.uuid === x[2]);
    return [{ method: 'DELETE', path: p }, ...(old ? [{ method: 'PUT', path: p, body: x[1] === 'agents' ? { penalty: old.penalty ?? 0, priority: old.priority ?? 0 } : { priority: old.priority ?? 0 } }] : [])];
  }
  if (/^\/groups\/[^/]+\/members\/users$/.test(p)) return [{ method: 'PUT', path: p, body: { users: (b?.users || []).map((u) => ({ uuid: u.uuid, priority: u.priority ?? 0 })) } }];
  if (/^\/groups\/[^/]+\/members\/extensions$/.test(p)) return [{ method: 'PUT', path: p, body: { extensions: (b?.extensions || []).map((u) => ({ exten: u.exten, context: u.context, priority: u.priority ?? 0 })) } }];
  if (/^\/switchboards\/[^/]+\/members\/users$/.test(p)) return [{ method: 'PUT', path: p, body: { users: (b?.users || []).map((u) => ({ uuid: u.uuid })) } }];
  if (/^\/outcalls\/\d+\/trunks$/.test(p)) return [{ method: 'PUT', path: p, body: { trunks: (b?.trunks || []).map((t) => ({ id: t.id })) } }];
  if ((x = p.match(/^\/outcalls\/\d+\/extensions\/(\d+)$/)) && m === 'PUT') {
    const old = (b?.extensions || []).find((d) => String(d.id) === x[1]);
    return old ? [{ method: 'PUT', path: p, body: { strip_digits: old.strip_digits ?? 0, external_prefix: old.external_prefix || null, prefix: old.prefix || null, caller_id: old.caller_id || null } }] : { skip: 'motif introuvable dans la sauvegarde' };
  }
  if (/\/fallbacks$/.test(p)) { const body = {}; for (const k of Object.keys(e.body || {})) body[k] = cleanDest(b?.[k]); return [{ method: 'PUT', path: p, body }]; }
  if ((x = p.match(/\/services\/(dnd|incallfilter)$/))) return [{ method: 'PUT', path: p, body: { enabled: !!b?.[x[1]]?.enabled } }];
  if ((x = p.match(/\/forwards\/(\w+)$/))) return [{ method: 'PUT', path: p, body: { enabled: !!b?.[x[1]]?.enabled, destination: b?.[x[1]]?.destination ?? null } }];
  if (/^\/(incalls|groups|queues|ivr|schedules|switchboards|voicemails|conferences|users|outcalls)\/[^/]+$/.test(p) && m === 'PUT') {
    const body = {};
    for (const k of Object.keys(e.body || {})) {
      const v = b?.[k];
      if (v === HIDDEN) { secrets.push({ path: p, key: k }); continue; }
      if (k === 'destination') body[k] = cleanDest(v) || { type: 'none' };
      else if (k.endsWith('_destination')) body[k] = k === 'closed_destination' ? cleanDest(v) || { type: 'none' } : cleanDest(v);
      else if (k === 'choices') body[k] = (v || []).map((c) => ({ exten: c.exten, destination: cleanDest(c.destination) }));
      else if (k === 'open_periods') body[k] = (v || []).map((q) => period(q, false));
      else if (k === 'exceptional_periods') body[k] = (v || []).map((q) => period(q, true));
      else body[k] = v ?? null;
    }
    // Groupe : ignore_forward toujours envoyé, sinon confd le remet à false (vérifié).
    if (/^\/groups\//.test(p) && Object.keys(body).length) body.ignore_forward = !!b?.ignore_forward;
    return Object.keys(body).length ? [{ method: 'PUT', path: p, body }] : { skip: 'seulement des codes (voir l\'encart)' };
  }
  return { skip: `écriture non reconnue (${m} ${p})` };
}

export function openRestore(onDone) {
  confirmModal(`<div class="cf-ed">
    <div class="cf-ge-head"><div><h3>Restaurer une sauvegarde</h3><div class="small muted">Sauvegarde JSON téléchargée par « Appliquer… » (Call Flow Manager)</div></div></div>
    <p class="small muted">Chaque écriture de la sauvegarde est défaite, de la dernière à la première : les champs modifiés reprennent leur valeur d'avant. Vous choisissez les lignes à restaurer ; rien n'est écrit avant « Restaurer ».</p>
    <input type="file" id="rs-file" accept=".json,application/json">
    <div id="rs-body"></div><p id="rs-err" class="error small"></p></div>`, async () => {
    const st = $('rs-body')._state; if (!st) { $('rs-err').textContent = 'Choisissez d\'abord un fichier de sauvegarde.'; return false; }
    const chosen = st.steps.filter((s, i) => !s.skip && $(`rs-c${i}`)?.checked);
    const reset = st.secrets.length && $('rs-reset')?.checked;
    if (!chosen.length && !reset) { $('rs-err').textContent = 'Aucune ligne cochée.'; return false; }
    // Sauvegarde de l'état actuel, comme avant toute écriture.
    const bases = [...new Set(chosen.flatMap((s) => s.ops.map((o) => o.path.match(/^\/\w+\/[^/]+/)?.[0])).filter(Boolean))];
    const cur = [];
    for (const path of bases) { try { cur.push({ method: 'GET', path, before: await api('GET', path) }); } catch { /* objet disparu */ } }
    downloadJson(`astrea-callflow-avant-restauration-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, { outil: 'Call Flow Manager', format: 2, serveur: S.base, tenant: S.tenant, date: new Date().toISOString(), note: 'État avant restauration (lecture seule)', codes: 'masqués (***)', etat: redact(cur) });
    const res = [];
    for (const s of chosen) for (const o of s.ops) {
      try { await api(o.method, o.path, o.method === 'DELETE' || !o.body ? undefined : o.body); res.push({ ok: true, path: `${o.method} ${o.path}` }); } catch (e) { res.push({ ok: false, path: `${o.method} ${o.path}`, error: e.message }); }
    }
    // Nouveaux codes : un par objet concerné, montrés une seule fois.
    const codes = [];
    if (reset) {
      const byPath = new Map(); for (const x of st.secrets) { if (!byPath.has(x.path)) byPath.set(x.path, new Set()); byPath.get(x.path).add(x.key); }
      for (const [path, keys] of byPath) {
        const body = {}; for (const k of keys) body[k] = newCode();
        try { await api('PUT', path, body); for (const k of keys) codes.push({ label: objLabel(path), key: k, code: body[k] }); res.push({ ok: true, path: `PUT ${path} (nouveau code)` }); } catch (e) { res.push({ ok: false, path: `PUT ${path} (nouveau code)`, error: e.message }); }
      }
    }
    const bad = res.filter((x) => !x.ok);
    await onDone?.();
    const KEY = { password: 'code de messagerie', pin: 'code participant', admin_pin: 'code animateur' };
    setTimeout(() => confirmModal(`<div class="cf-ed"><h3>Restauration terminée</h3>
      <p>${res.length - bad.length} écriture(s) réussie(s)${bad.length ? `, <strong>${bad.length} en erreur</strong>` : ''}. Le graphe a été relu.</p>
      ${bad.length ? `<ul class="small">${bad.map((x) => `<li><code>${esc(x.path)}</code> : ${esc(x.error)}</li>`).join('')}</ul>` : ''}
      ${codes.length ? `<div class="warn"><span>Nouveaux codes : notez-les maintenant, ils ne sont enregistrés nulle part (ni dans un fichier, ni dans l'historique).</span></div>
        <table class="diff"><thead><tr><th>Objet</th><th>Code</th><th></th></tr></thead><tbody>${codes.map((c, i) => `<tr><td>${esc(c.label)} — ${esc(KEY[c.key] || c.key)}</td><td><span class="cf-secret"><input type="password" readonly value="${esc(c.code)}" id="rs-code${i}"></span></td><td><button type="button" data-show="${i}">Afficher</button></td></tr>`).join('')}</tbody></table>` : ''}</div>`, () => true, 'Fermer'), 0);
    setTimeout(() => { const box = $('modal-body'); if (box) box.onclick = (ev) => { const b2 = ev.target.closest('[data-show]'); if (!b2) return; const i = $(`rs-code${b2.dataset.show}`); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; b2.textContent = show ? 'Masquer' : 'Afficher'; }; }, 50);
    return true;
  }, 'Restaurer');

  $('rs-file').onchange = async (ev) => {
    const file = ev.target.files?.[0]; if (!file) return;
    const out = $('rs-body'); out._state = null; $('rs-err').textContent = '';
    let j; try { j = JSON.parse(await file.text()); } catch { $('rs-err').textContent = 'Fichier illisible (JSON attendu).'; return; }
    if (j.outil !== 'Call Flow Manager') { $('rs-err').textContent = 'Ce fichier ne vient pas de Call Flow Manager.'; return; }
    if (j.format !== 2 || !Array.isArray(j.ecritures)) { $('rs-err').textContent = 'Sauvegarde d\'une version antérieure (sans le détail des écritures) : restauration automatique impossible. Elle reste lisible pour une remise à la main.'; return; }
    if (j.serveur !== S.base || (j.tenant && S.tenant && j.tenant !== S.tenant)) { $('rs-err').textContent = `Cette sauvegarde vient d'un autre serveur ou tenant (${j.serveur || '?'}) : restauration refusée.`; return; }
    const secrets = [];
    const steps = [...j.ecritures].reverse().map((e) => { const r = undo(e, secrets); return Array.isArray(r) ? { e, ops: r } : { e, skip: r.skip }; });
    const uniq = [...new Map(secrets.map((x) => [`${x.path}|${x.key}`, x])).values()];
    out._state = { steps, secrets: uniq };
    const KEY = { password: 'code de messagerie', pin: 'code participant', admin_pin: 'code animateur' };
    out.innerHTML = `<p class="small">Sauvegarde du ${esc(new Date(j.date).toLocaleString('fr'))} : ${j.ecritures.length} écriture(s).</p>
      <div class="cf-diffwrap"><table class="diff"><thead><tr><th></th><th>Objet</th><th>Partie</th><th>Action</th></tr></thead><tbody>${steps.map((s, i) => `<tr class="${s.skip ? 'muted' : ''}"><td>${s.skip ? '' : `<input type="checkbox" id="rs-c${i}" checked>`}</td><td>${esc(objLabel(s.e.path))}</td><td>${esc(sub(s.e.path))}</td><td class="small">${s.skip ? esc(`Non restauré : ${s.skip}`) : esc(s.ops.map((o) => `${o.method === 'DELETE' ? 'retirer' : 'remettre'}`).join(' puis '))}</td></tr>`).join('')}</tbody></table></div>
      ${uniq.length ? `<div class="warn"><span><strong>Attention : les codes ne sont pas dans la sauvegarde.</strong> ${uniq.length} code(s) (${esc([...new Set(uniq.map((x) => objLabel(x.path)))].join(', '))}) resteront inchangés dans Wazo : la restauration ne remet pas l'ancien code.</span></div>
        <label class="cf-ge-b"><input type="checkbox" id="rs-reset"><span><strong>Réinitialiser ces codes</strong><span class="small muted">Un nouveau code de 4 chiffres par code concerné (${esc(uniq.map((x) => KEY[x.key] || x.key).join(', '))}), affiché une seule fois à la fin.</span></span></label>` : ''}`;
  };
}
