// Call Flow Manager — éditeur d'horaire (choix de Brice, 14/10/2026) :
//  1. Ouvert : grille de la semaine à peindre, au quart d'heure ;
//  2. Si fermé : destination de fermeture (closed_destination) ;
//  3. Fermetures exceptionnelles : calendrier annuel cliquable (chaque
//     année), bouton « Jours fériés fixes » (8 nationaux + Alsace-Moselle).
// Règles Wazo (wazo-agid schedule.py, lu) : critères d'une période en ET,
// champ vide = sans restriction, heures (h, min) bornes incluses ; confd exige
// hours_start / hours_end. Conversion :
//  - une case = 15 min [t, t+15[ ; une suite de cases [a, b[ devient
//    hours_start a, hours_end b (borne incluse : 12:00 couvre 12:00, comme les
//    plages saisies dans le portail) ou 23:59 si b = 24:00 ; les jours qui ont
//    les mêmes créneaux sont regroupés (week_days) ;
//  - calendrier : une période par mois (months [m], month_days [jours]),
//    00:00–23:59, sans jour de semaine ;
//  - ce que la grille ou le calendrier ne savent pas représenter (plage
//    limitée à certains jours du mois, fermeture à heures précises ou liée à
//    un jour de semaine, autre destination) est conservé tel quel et listé.
import { $, esc, confirmModal, helpButton, helpBox } from '../common/core.js?v=0.35.0';
import { M, TYPES, listOf, destLabel } from './model.js?v=0.35.0';

const SLOT = 15, N = 96;
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MDAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // 29 février possible (chaque année où il existe)
// Jours fériés français à date fixe (les fériés mobiles — Pâques, Ascension, Pentecôte — sont exclus).
const HOLIDAYS = [
  [1, 1, 'Jour de l\'an', true], [5, 1, 'Fête du travail', true], [5, 8, 'Victoire 1945', true], [7, 14, 'Fête nationale', true],
  [8, 15, 'Assomption', true], [11, 1, 'Toussaint', true], [11, 11, 'Armistice 1918', true], [12, 25, 'Noël', true],
  [12, 26, 'Saint-Étienne (Alsace-Moselle)', false],
];
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const hm = (s) => { const [h, m] = String(s || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
const partial = (a, full) => Array.isArray(a) && a.length > 0 && a.length < full;
const sameD = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------
function gridFromPeriods(open) {
  const grid = Array.from({ length: 7 }, () => new Array(N).fill(0));
  const kept = []; let rounded = false;
  for (const p of open || []) {
    if (partial(p.month_days, 31) || partial(p.months, 12)) { kept.push(p); continue; }
    const s = hm(p.hours_start), e0 = hm(p.hours_end);
    if (s == null || e0 == null) { kept.push(p); continue; }
    const e = e0 >= 1439 ? 1440 : e0;
    if (s % SLOT || (e % SLOT && e !== 1440)) rounded = true;
    const days = p.week_days?.length ? p.week_days : [1, 2, 3, 4, 5, 6, 7];
    for (const d of days) for (let i = 0; i < N; i++) { const t = i * SLOT; if (t >= s && t < e) grid[d - 1][i] = 1; }
  }
  return { grid, kept, rounded };
}
const segmentsOf = (row) => { const out = []; for (let i = 0; i < N; i++) { if (!row[i]) continue; let j = i; while (j + 1 < N && row[j + 1]) j++; out.push([i * SLOT, (j + 1) * SLOT]); i = j; } return out; };
function periodsFromGrid(grid) {
  const groups = new Map();
  grid.forEach((row, d) => { const segs = segmentsOf(row); if (!segs.length) return; const k = JSON.stringify(segs); if (!groups.has(k)) groups.set(k, { segs, days: [] }); groups.get(k).days.push(d + 1); });
  const out = [];
  for (const { segs, days } of groups.values()) for (const [a, b] of segs) out.push({ hours_start: hhmm(a), hours_end: b === 1440 ? '23:59' : hhmm(b), week_days: days.length === 7 ? [] : days, month_days: [], months: [] });
  return out;
}
function calFromExc(exc, closedDest) {
  const days = new Set(); const kept = []; let dest = null;
  for (const p of exc || []) {
    const allDay = hm(p.hours_start) === 0 && hm(p.hours_end) >= 1439;
    const simple = allDay && !partial(p.week_days, 7) && partial(p.months, 12);
    if (!simple || (dest && !sameD(dest, p.destination))) { kept.push(p); continue; }
    dest = dest || p.destination;
    for (const m of p.months) { const md = partial(p.month_days, 31) ? p.month_days : Array.from({ length: MDAYS[m - 1] }, (_, i) => i + 1); for (const d of md) if (d <= MDAYS[m - 1]) days.add(`${m}-${d}`); }
  }
  return { days, kept, dest: dest || closedDest || null };
}
function excFromCal(days, dest) {
  const by = new Map();
  for (const k of days) { const [m, d] = k.split('-').map(Number); if (!by.has(m)) by.set(m, []); by.get(m).push(d); }
  return [...by.keys()].sort((a, b) => a - b).map((m) => ({ hours_start: '00:00', hours_end: '23:59', week_days: [], month_days: by.get(m).sort((a, b) => a - b), months: [m], destination: dest || { type: 'none' } }));
}

// ---------------------------------------------------------------------------
// Choix d'une destination (réutilisé pour « Si fermé » et les fermetures)
// ---------------------------------------------------------------------------
const DTYPES = [['voicemail', 'Messagerie'], ['user', 'Utilisateur'], ['group', 'Groupe'], ['queue', 'File d\'attente'], ['ivr', 'SVI'], ['switchboard', 'Standard'], ['conference', 'Conférence'], ['hangup', 'Raccrocher'], ['sound', 'Message'], ['extension', 'Numéro'], ['none', 'Aucune']];
const IDF = { user: 'user_id', group: 'group_id', queue: 'queue_id', ivr: 'ivr_id', voicemail: 'voicemail_id', conference: 'conference_id', switchboard: 'switchboard_uuid' };
function pickerHtml(id, cur) {
  const t = cur?.type || 'none';
  return `<span class="cf-dp" id="${id}"><select data-dt>${DTYPES.map(([k, l]) => `<option value="${k}"${k === t ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><span data-dx>${pickerExtra(t, cur)}</span></span>`;
}
function pickerExtra(t, cur) {
  if (IDF[t]) {
    const sel = cur?.type === t ? String(cur[IDF[t]]) : '';
    return `<select data-do>${listOf(t).map((x) => { const id = x.key.slice(x.key.indexOf(':') + 1); return `<option value="${esc(id)}"${id === sel ? ' selected' : ''}>${esc(x.title)}${x.sub ? ` — ${esc(x.sub)}` : ''}</option>`; }).join('')}</select>`;
  }
  if (t === 'hangup') return `<select data-dc><option value="normal">normale</option><option value="busy"${cur?.cause === 'busy' ? ' selected' : ''}>occupé</option><option value="congestion"${cur?.cause === 'congestion' ? ' selected' : ''}>encombré</option></select>`;
  if (t === 'sound') return `<input data-df value="${esc(cur?.type === 'sound' ? cur.filename || '' : '')}" placeholder="fichier son">`;
  if (t === 'extension') return `<input data-de value="${esc(cur?.type === 'extension' ? cur.exten || '' : '')}" placeholder="numéro"><select data-dctx>${(M.lists.context || []).filter((c) => c.type !== 'incall').map((c) => `<option value="${esc(c.name)}"${cur?.context === c.name ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('')}</select>`;
  return '';
}
function bindPicker(id) { const el = $(id); el.querySelector('[data-dt]').onchange = (e) => { el.querySelector('[data-dx]').innerHTML = pickerExtra(e.target.value, null); }; }
function readPicker(id) {
  const el = $(id); const t = el.querySelector('[data-dt]').value;
  if (t === 'none') return null;
  if (IDF[t]) { const v = el.querySelector('[data-do]')?.value; if (!v) throw new Error('Choisissez un objet pour la destination.'); return { type: t, [IDF[t]]: t === 'switchboard' ? v : Number(v) }; }
  if (t === 'hangup') return { type: t, cause: el.querySelector('[data-dc]').value };
  if (t === 'sound') { const f = el.querySelector('[data-df]').value.trim(); if (!f) throw new Error('Indiquez le fichier son.'); return { type: t, filename: f }; }
  if (t === 'extension') { const x = el.querySelector('[data-de]').value.trim(); if (!/^[0-9*#]+$/.test(x)) throw new Error('Numéro : chiffres, * et #.'); return { type: t, exten: x, context: el.querySelector('[data-dctx]').value }; }
  return null;
}

// ---------------------------------------------------------------------------
// Éditeur
// ---------------------------------------------------------------------------
// s : horaire (copie locale, brouillon compris) ; onSave(value) avec
// value = { open_periods, exceptional_periods, closed_destination }.
export function openScheduleEditor(s, onSave) {
  const G = gridFromPeriods(s.open_periods);
  const X = calFromExc(s.exceptional_periods, s.closed_destination);
  let keptExc = [...X.kept];
  const cell = (d, i) => `<i data-d="${d}" data-i="${i}" class="${G.grid[d][i] ? 'on' : ''}${i % 4 === 0 ? ' h' : ''}"></i>`;
  const gridHtml = () => `<div class="cf-wg"><div class="cf-wg-h"><span></span><div>${Array.from({ length: 9 }, (_, k) => `<b style="left:${(k * 3 / 24) * 100}%">${k * 3} h</b>`).join('')}</div><span></span></div>
    ${G.grid.map((row, d) => `<div class="cf-wg-r"><span class="cf-wg-d">${DAYS[d]}</span><div class="cf-wg-c" data-row="${d}">${row.map((_, i) => cell(d, i)).join('')}</div><span class="cf-wg-s" id="wg-s${d}"></span></div>`).join('')}</div>`;
  const monthHtml = (m) => `<div class="cf-cm"><div class="cf-cm-t">${MONTHS[m - 1]}</div><div class="cf-cm-g">${Array.from({ length: MDAYS[m - 1] }, (_, i) => `<i data-md="${m}-${i + 1}" class="${X.days.has(`${m}-${i + 1}`) ? 'on' : ''}${HOLIDAYS.some(([hm2, hd]) => hm2 === m && hd === i + 1) ? ' hol' : ''}">${i + 1}</i>`).join('')}</div></div>`;
  const keptHtml = () => keptExc.length ? `<ul class="cf-kept">${keptExc.map((p, i) => `<li>${esc(periodTxt(p))} → ${esc(destLabel(p.destination))} <button class="icon" data-delkept="${i}" title="Supprimer cette fermeture">×</button></li>`).join('')}</ul>` : '';
  const help = `Ouvert : glissez dans la grille pour peindre les créneaux ouverts (au quart d'heure), ou partez d'une case déjà ouverte pour gommer. Les jours qui ont les mêmes créneaux sont regroupés à l'enregistrement, et une plage 09:00–12:00 couvre 12:00 (bornes incluses, comme dans Wazo). Si fermé : où part l'appel hors des plages d'ouverture. Fermetures exceptionnelles : cliquez ou glissez sur les jours du calendrier pour les fermer chaque année (en rouge) — attention, Wazo ne gère pas l'année : une fermeture ponctuelle oubliée se rejoue l'année suivante ; elles sont vérifiées AVANT les plages d'ouverture et partent vers leur propre destination. « Jours fériés fixes » ajoute les fériés français à date fixe (pas Pâques, l'Ascension ni la Pentecôte, dont la date change). Fuseau : ${s.timezone || '?'}. Rien n'est écrit avant « Appliquer… ».`;
  confirmModal(`<div class="cf-sched-ed">
    <div class="titlerow"><h3>Horaire « ${esc(s.name)} »</h3>${helpButton('se-hb', 'Aide')}</div>${helpBox('se-hb', help)}
    <h4 class="cf-per-t">1. Ouvert</h4>
    <div class="btnrow cf-se-tools"><button data-tool="copy" title="Recopie les créneaux du lundi sur mardi à vendredi">Lundi → mar–ven</button><button data-tool="office" title="9h–12h et 14h–18h du lundi au vendredi">Bureau 9h-12h / 14h-18h</button><button data-tool="all" title="Ouvert tout le temps">24 h/24</button><button data-tool="clear">Tout effacer</button></div>
    <div id="se-grid">${gridHtml()}</div>
    ${G.rounded ? '<p class="warn small">Certaines heures n\'étaient pas au quart d\'heure : elles sont arrondies dans la grille.</p>' : ''}
    ${G.kept.length ? `<p class="small muted">Plages particulières conservées telles quelles (limitées à certains jours du mois ou mois) : ${esc(G.kept.map(periodTxt).join(' ; '))}</p>` : ''}
    <h4 class="cf-per-t">2. Si fermé</h4>
    <div>L'appel part vers ${pickerHtml('se-closed', s.closed_destination)}</div>
    <h4 class="cf-per-t">3. Fermetures exceptionnelles (chaque année)</h4>
    <div class="warn small"><span>Wazo ne connaît pas l'année : un jour fermé ici l'est <strong>chaque année</strong>. Une fermeture ponctuelle (pont, congés, inventaire…) oubliée se rejouera l'année suivante à la même date : pensez à la retirer une fois passée, et relisez ce calendrier régulièrement.</span></div>
    <div class="btnrow cf-se-tools"><button data-tool="holidays">Jours fériés fixes…</button><button data-tool="calclear">Tout rouvrir</button><span class="small muted" id="se-count"></span></div>
    <div id="se-hol" class="cf-hol" hidden>${HOLIDAYS.map(([m, d, l, on], i) => `<label class="inline"><input type="checkbox" data-hol="${i}"${on ? ' checked' : ''}> ${d} ${MONTHS[m - 1]} — ${esc(l)}</label>`).join('')}<div class="btnrow"><button data-tool="holadd" class="primary">Fermer ces jours</button></div></div>
    <div class="cf-cal">${Array.from({ length: 12 }, (_, k) => monthHtml(k + 1)).join('')}</div>
    <div>Ces jours partent vers ${pickerHtml('se-xdest', X.dest)}</div>
    <div id="se-kept">${keptExc.length ? '<p class="small muted">Autres fermetures exceptionnelles conservées (heures précises, jour de semaine ou autre destination) :</p>' : ''}${keptHtml()}</div>
    <p id="se-err" class="error small"></p></div>`, () => {
    try {
      const closed = readPicker('se-closed');
      const xdest = readPicker('se-xdest') || closed;
      onSave({
        open_periods: [...periodsFromGrid(G.grid), ...G.kept],
        exceptional_periods: [...excFromCal(X.days, xdest), ...keptExc],
        closed_destination: closed,
      });
      return true;
    } catch (e) { $('se-err').textContent = e.message; return false; }
  }, 'Ajouter au brouillon');
  bindPicker('se-closed'); bindPicker('se-xdest');
  const summary = () => {
    G.grid.forEach((row, d) => { const segs = segmentsOf(row); $(`wg-s${d}`).textContent = segs.length ? segs.map(([a, b]) => `${hhmm(a)}–${b === 1440 ? '24:00' : hhmm(b)}`).join(' · ') : 'fermé'; });
    $('se-count').textContent = `${X.days.size} jour${X.days.size > 1 ? 's' : ''} fermé${X.days.size > 1 ? 's' : ''}`;
  };
  const redrawGrid = () => { $('se-grid').innerHTML = gridHtml(); summary(); };
  summary();
  // Peinture (grille et calendrier) : pointeur enfoncé, le mode (ouvrir / effacer) est fixé par la première case.
  let paint = null;
  const box = $('modal-body');
  box.onpointerdown = (e) => {
    const c = e.target.closest('.cf-wg-c i'); const k = e.target.closest('.cf-cm-g i');
    if (c) { e.preventDefault(); const d = +c.dataset.d, i = +c.dataset.i; paint = { kind: 'g', on: G.grid[d][i] ? 0 : 1 }; setG(c); }
    else if (k) { e.preventDefault(); paint = { kind: 'c', on: !X.days.has(k.dataset.md) }; setC(k); }
  };
  box.onpointerover = (e) => {
    if (!paint) return;
    if (paint.kind === 'g') { const c = e.target.closest('.cf-wg-c i'); if (c) setG(c); }
    else { const k = e.target.closest('.cf-cm-g i'); if (k) setC(k); }
  };
  const stop = () => { paint = null; };
  window.addEventListener('pointerup', stop);
  function setG(c) { const d = +c.dataset.d, i = +c.dataset.i; G.grid[d][i] = paint.on; c.classList.toggle('on', !!paint.on); summary(); }
  function setC(k) { if (paint.on) X.days.add(k.dataset.md); else X.days.delete(k.dataset.md); k.classList.toggle('on', paint.on); summary(); }
  box.onclick = (e) => {
    const t = e.target.closest('[data-tool]')?.dataset.tool;
    const dk = e.target.closest('[data-delkept]');
    if (dk) { keptExc.splice(+dk.dataset.delkept, 1); $('se-kept').innerHTML = keptHtml(); return; }
    if (!t) return;
    if (t === 'copy') { for (let d = 1; d < 5; d++) G.grid[d] = [...G.grid[0]]; redrawGrid(); }
    if (t === 'office') { G.grid.forEach((row, d) => { for (let i = 0; i < N; i++) { const m = i * SLOT; row[i] = d < 5 && ((m >= 540 && m < 720) || (m >= 840 && m < 1080)) ? 1 : 0; } }); redrawGrid(); }
    if (t === 'all') { G.grid.forEach((row) => row.fill(1)); redrawGrid(); }
    if (t === 'clear') { G.grid.forEach((row) => row.fill(0)); redrawGrid(); }
    if (t === 'calclear') { X.days.clear(); for (const k of box.querySelectorAll('.cf-cm-g i.on')) k.classList.remove('on'); summary(); }
    if (t === 'holidays') $('se-hol').hidden = !$('se-hol').hidden;
    if (t === 'holadd') {
      for (const cb of box.querySelectorAll('[data-hol]:checked')) { const [m, d] = HOLIDAYS[+cb.dataset.hol]; X.days.add(`${m}-${d}`); box.querySelector(`[data-md="${m}-${d}"]`)?.classList.add('on'); }
      $('se-hol').hidden = true; summary();
    }
  };
}
function periodTxt(p) {
  const wd = (p.week_days || []).length && p.week_days.length < 7 ? p.week_days.map((d) => DAYS[d - 1]).join(', ') + ' ' : '';
  const md = partial(p.month_days, 31) ? `le ${p.month_days.join(', ')} ` : '';
  const mo = partial(p.months, 12) ? p.months.map((m) => MONTHS[m - 1]).join(', ') + ' ' : '';
  return `${wd}${md}${mo}${p.hours_start}–${p.hours_end}`.trim();
}
