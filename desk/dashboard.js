// Astrea Desk — tableau de bord (lot 4) : page d'accueil du site, actualisée
// toutes les 30 s tant qu'elle est affichée. Chaque bloc n'apparaît que si la
// case correspondante est cochée dans le Portal. Sources (code lu le
// 02/11/2026, branches master) :
//  - agentd GET /api/agentd/1.0/agents (ACL agentd.agents.read) : tableau
//    [{id, tenant_uuid, number, logged, paused, paused_reason, queues[]}],
//    tenant = Wazo-Tenant sans sous-tenants (recurse=false) ; refiltré ;
//  - calld GET /api/calld/1.0/calls (calld.calls.read) : un élément par canal,
//    filtré par calld sur le tenant (recurse=false) ; pas de tenant_uuid dans
//    la réponse. Un appel = un conversation_id (canaux d'un même appel) ;
//  - calld GET /switchboards/{uuid}/calls/queued et /held : appels en attente
//    et en garde au POPC (POPC lus dans confd, donc du site) ;
//  - call-logd /cdr (aujourd'hui) et /queues/statistics (aujourd'hui).
// Pas d'appelants en attente dans les files en direct : seul amid les donne
// (QueueSummary), et amid est réservé au tenant principal
// (required_master_tenant), donc inaccessible à un admin de site.
import { S, esc, listAll } from '../admin-tools/common/core.js?v=0.7.10';
import { stackedColumns, legend } from './charts.js?v=0.7.10';
import { isService, statusKey, fmtDur, caller } from './calllogs.js?v=0.7.10';
import { pauseLabel } from './live.js?v=0.7.10';

const REFRESH = 30e3;
const SERIES = [
  { key: 'answered', label: 'Répondus', color: 'var(--dk-s1)' },
  { key: 'unknown', label: 'Non répondus', color: 'var(--dk-s2)' },
  { key: 'voicemail', label: 'Messagerie', color: 'var(--dk-s3)' },
  { key: 'blocked', label: 'Bloqués', color: 'var(--dk-s4)' },
];
const B = { site: null, timer: null, names: null, switchboards: null, data: {}, at: null, busy: false };

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return [d, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)]; };
const sameTenant = (x) => !x.tenant_uuid || x.tenant_uuid === S.tenant;

async function get(path, params = {}) {
  const r = await fetch(`${S.base}/api/${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`, { headers: { 'X-Auth-Token': S.token, Accept: 'application/json', 'Wazo-Tenant': S.tenant } });
  if (r.status === 401 || r.status === 403) throw new Error(`accès refusé (${r.status})`);
  if (!r.ok) throw new Error(`erreur ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Lectures (chacune isolée : un bloc en erreur n'empêche pas les autres)
// ---------------------------------------------------------------------------
async function loadAgents() {
  const list = await get('agentd/1.0/agents');
  return (Array.isArray(list) ? list : list?.items || []).filter(sameTenant);
}

async function loadCalls() {
  const j = await get('calld/1.0/calls');
  const conv = new Map();
  for (const c of j?.items || []) {
    const k = c.conversation_id || c.call_id;
    const o = conv.get(k) || { up: false, start: c.creation_time, who: '' };
    if (c.status === 'Up') o.up = true;
    if (c.creation_time && (!o.start || c.creation_time < o.start)) o.start = c.creation_time;
    o.who ||= [c.caller_id_name || c.caller_id_number, c.peer_caller_id_name || c.peer_caller_id_number].filter(Boolean).join(' → ');
    conv.set(k, o);
  }
  const all = [...conv.values()];
  return { total: all.length, talking: all.filter((c) => c.up).length, ringing: all.filter((c) => !c.up).length };
}

async function loadSwitchboards() {
  B.switchboards ||= await listAll('/switchboards').catch(() => []);
  return Promise.all(B.switchboards.map(async (sb) => {
    const [q, h] = await Promise.all([get(`calld/1.0/switchboards/${sb.uuid}/calls/queued`), get(`calld/1.0/switchboards/${sb.uuid}/calls/held`)].map((p) => p.then((j) => j?.items || []).catch(() => null)));
    return { name: sb.name, queued: q, held: h };
  }));
}

async function loadToday() {
  const [from, until] = today();
  const items = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const j = await get('call-logd/1.0/cdr', { from: from.toISOString(), until: until.toISOString(), order: 'start', direction: 'desc', limit: 1000, offset });
    const page = j?.items || [];
    items.push(...page.filter(sameTenant));
    if (page.length < 1000) break;
  }
  const calls = items.filter((c) => !isService(c));
  const st = { answered: 0, unknown: 0, voicemail: 0, blocked: 0 };
  const dir = { inbound: 0, outbound: 0, internal: 0 };
  const buckets = Array.from({ length: 24 }, (_, h) => ({ label: `${h}h`, tip: `${h}h-${h + 1}h`, values: { answered: 0, unknown: 0, voicemail: 0, blocked: 0 } }));
  for (const c of calls) {
    const k = statusKey(c);
    st[k]++;
    if (c.call_direction in dir) dir[c.call_direction]++;
    const d = new Date(c.start);
    if (!isNaN(d)) buckets[d.getHours()].values[k]++;
  }
  // Derniers appels entrants non répondus (hors messagerie), à rappeler.
  const missed = calls.filter((c) => c.call_direction === 'inbound' && statusKey(c) === 'unknown').slice(0, 6);
  return { total: calls.length, st, dir, buckets, missed, rate: calls.length ? Math.round((st.answered / calls.length) * 100) : 0 };
}

async function loadQueuesToday() {
  const [from, until] = today();
  let tz = 'Europe/Paris';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch { /* */ }
  const j = await get('call-logd/1.0/queues/statistics', { from: localIso(from), until: localIso(until), timezone: tz });
  // Ces statistiques incluent les sous-tenants : refiltrées (règle de base).
  const qs = (j?.items || []).filter(sameTenant);
  const sum = (k) => qs.reduce((a, q) => a + (q[k] || 0), 0);
  let w = 0, n = 0;
  for (const q of qs) { const k = (q.answered || 0) + (q.abandoned || 0) + (q.not_answered || 0); if (q.average_waiting_time != null && k) { w += q.average_waiting_time * k; n += k; } }
  return { received: sum('received'), answered: sum('answered'), lost: sum('abandoned') + sum('not_answered') + sum('blocked') + sum('saturated'), wait: n ? w / n : null };
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
// Heures affichées : 8 h-19 h au moins, élargies aux heures qui ont des appels.
function hourSpan(buckets) {
  const used = buckets.map((b, h) => (Object.values(b.values).some(Boolean) ? h : null)).filter((h) => h != null);
  return [Math.min(8, ...used), Math.max(19, ...used) + 1];
}
const kpi = (label, value, sub = '') => `<div class="dk-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
const fail = (title, err) => `<section class="dk-panel"><h3>${esc(title)}</h3><p class="muted small">Indisponible : ${esc(err.message)}.</p></section>`;

function blockNow(show) {
  const D = B.data;
  let kpis = '';
  if (show.calls) kpis += D.calls instanceof Error ? kpi('Appels en cours', '—', 'indisponible') : D.calls ? kpi('Appels en cours', D.calls.total, D.calls.ringing ? `dont ${D.calls.ringing} en sonnerie` : 'en conversation') : '';
  if (show.agents && D.agents && !(D.agents instanceof Error)) {
    const logged = D.agents.filter((a) => a.logged), paused = logged.filter((a) => a.paused);
    kpis += kpi('Agents connectés', `${logged.length} / ${D.agents.length}`) + kpi('Agents en pause', paused.length);
  }
  if (show.switchboards && Array.isArray(D.switchboards)) {
    const q = D.switchboards.reduce((a, s) => a + (s.queued?.length || 0), 0), h = D.switchboards.reduce((a, s) => a + (s.held?.length || 0), 0);
    if (D.switchboards.length) kpis += kpi('En attente au POPC', q) + kpi('En garde au POPC', h);
  }
  let out = kpis ? `<div class="dk-kpis">${kpis}</div>` : '';
  if (show.agents) {
    if (D.agents instanceof Error) out += fail('Agents', D.agents);
    else if (D.agents?.length) {
      const name = (a) => B.names?.get(a.id) || `Agent ${a.number}`;
      const rows = [...D.agents].sort((a, b) => (b.logged - a.logged) || (a.paused - b.paused) || name(a).localeCompare(name(b), 'fr'));
      out += `<section class="dk-panel"><h3>Agents</h3><div class="dk-scroll"><table class="dk-table"><thead><tr><th>Agent</th><th>État</th><th>Files</th></tr></thead><tbody>${rows.map((a) => {
        const st = !a.logged ? ['off', 'Déconnecté'] : a.paused ? ['pause', `En pause${a.paused_reason ? ` (${pauseLabel(a.paused_reason)})` : ''}`] : ['on', 'Connecté'];
        const qs = (a.queues || []).filter((q) => q.logged !== false).map((q) => q.display_name || q.name).join(', ');
        return `<tr><td class="nowrap">${esc(name(a))} <span class="muted small">${esc(a.number || '')}</span></td><td><span class="dk-ag dk-ag-${st[0]}">${esc(st[1])}</span></td><td class="muted small">${esc(qs)}</td></tr>`;
      }).join('')}</tbody></table></div></section>`;
    }
  }
  if (show.switchboards && Array.isArray(D.switchboards) && D.switchboards.length > 1) {
    out += `<section class="dk-panel"><h3>POPC</h3><table class="dk-table"><thead><tr><th>POPC</th><th class="num">En attente</th><th class="num">En garde</th></tr></thead><tbody>${D.switchboards.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.queued ? s.queued.length : '—'}</td><td class="num">${s.held ? s.held.length : '—'}</td></tr>`).join('')}</tbody></table></section>`;
  }
  return out;
}

function blockToday(show) {
  const D = B.data;
  let out = '';
  if (show.cdr) {
    if (D.today instanceof Error) out += fail("Appels d'aujourd'hui", D.today);
    else if (D.today) {
      const t = D.today;
      const series = SERIES.filter((s) => s.key !== 'blocked' || t.st.blocked);
      out += `<div class="dk-kpis">${kpi('Appels', t.total, `${t.dir.inbound} entrants · ${t.dir.outbound} sortants · ${t.dir.internal} internes`)}${kpi('Répondus', `${t.st.answered} (${t.rate} %)`)}${kpi('Non répondus', t.st.unknown)}${kpi('Messagerie', t.st.voicemail)}</div>`
        + `<section class="dk-panel"><h3>Appels par heure</h3>${t.total ? legend(series) + stackedColumns(t.buckets.slice(...hourSpan(t.buckets)), series, { height: 160 }) : '<p class="muted small">Aucun appel aujourd\'hui.</p>'}</section>`
        + `<section class="dk-panel"><h3>Derniers appels manqués</h3>${t.missed.length ? `<ul class="dk-missed">${t.missed.map((c) => `<li><span class="nowrap">${esc(hhmm(new Date(c.start)))}</span><span>${esc(caller(c))}</span></li>`).join('')}</ul>` : '<p class="muted small">Aucun appel entrant manqué aujourd\'hui.</p>'}<button class="dk-text" data-go="calllogs">Ouvrir le journal d'appels</button></section>`;
    }
  }
  if (show.queues) {
    if (D.queues instanceof Error) out += fail("Files d'attente aujourd'hui", D.queues);
    else if (D.queues && D.queues.received) {
      const q = D.queues;
      out += `<h3 class="dk-sub">Files d'attente</h3><div class="dk-kpis">${kpi('Reçus en file', q.received)}${kpi('Répondus', `${q.answered}${q.received ? ` (${Math.round((q.answered / q.received) * 100)} %)` : ''}`)}${kpi('Perdus', q.lost)}${kpi('Attente moyenne', q.wait == null ? '—' : fmtDur(q.wait))}</div>`;
    }
  }
  return out;
}

function paint(view, show) {
  const box = view.querySelector('#db-live');
  if (!box) return;
  const now = blockNow(show), day = blockToday(show);
  box.innerHTML = (now ? `<h2 class="dk-h">En ce moment</h2>${now}` : '')
    + (day ? `<h2 class="dk-h">Aujourd'hui</h2>${day}${show.queues && B.data.queues && !(B.data.queues instanceof Error) ? '<p class="muted small">Files : chiffres calculés périodiquement par Wazo, les dernières heures peuvent manquer.</p>' : ''}` : '')
    || '';
  const at = view.querySelector('#db-at');
  if (at) at.textContent = B.at ? `Actualisé à ${hhmm(B.at)}:${pad(B.at.getSeconds())}` : 'Lecture…';
}

async function refresh(view, show) {
  if (B.busy) return;
  B.busy = true;
  const keep = (p) => p.catch((e) => { console.warn('[astrea] tableau de bord', e.message); return e; });
  try {
    if (show.agents && !B.names) B.names = new Map((await listAll('/agents').catch(() => [])).map((a) => [a.id, [a.firstname, a.lastname].filter(Boolean).join(' ')]).filter(([, n]) => n));
    const [agents, calls, switchboards, todayData, queues] = await Promise.all([
      show.agents ? keep(loadAgents()) : null,
      show.calls ? keep(loadCalls()) : null,
      show.switchboards ? keep(loadSwitchboards()) : null,
      show.cdr ? keep(loadToday()) : null,
      show.queues ? keep(loadQueuesToday()) : null,
    ]);
    B.data = { agents, calls, switchboards, today: todayData, queues };
    B.at = new Date();
    paint(view, show);
  } finally { B.busy = false; }
}

// show : { calls, agents, switchboards, cdr, queues } selon les cases du Portal.
export function renderDashboard(view, site, show) {
  if (B.site !== site.uuid) Object.assign(B, { site: site.uuid, names: null, switchboards: null, data: {}, at: null });
  stopDashboard();
  paint(view, show);
  refresh(view, show);
  B.timer = setInterval(() => {
    if (!view.querySelector('#db-live')) return stopDashboard();
    if (document.visibilityState === 'visible') refresh(view, show);
  }, REFRESH);
  view.querySelector('#db-refresh')?.addEventListener('click', () => refresh(view, show));
}

export function stopDashboard() { clearInterval(B.timer); B.timer = null; }
