// Call Flow Manager — éditeur d'horaire (choix et retours de Brice, 14/10/2026) :
//  1. Ouvert : grille de la semaine au quart d'heure, sélection EN BLOC
//     (on tire un rectangle jours × heures, aperçu, puis tout s'ouvre ou se
//     ferme d'un coup) ;
//  2. Si fermé : destination de fermeture (closed_destination), avec menu
//     des fichiers son ;
//  3. Fermetures exceptionnelles : liste « le … (jusqu'au …), toute la
//     journée ou de … à …, → destination » ; option à cocher « jours fériés
//     français à date fixe » (+ 26 décembre Alsace-Moselle en option).
// Règles Wazo (wazo-agid schedule.py, lu) : critères d'une période en ET,
// champ vide = sans restriction, heures (h, min) bornes incluses ; confd exige
// hours_start / hours_end. Conversions :
//  - grille : une case = 15 min [t, t+15[ ; une suite [a, b[ devient
//    hours_start a, hours_end b (12:00 couvre 12:00, comme une saisie du
//    portail) ou 23:59 si b = 24:00 ; jours aux créneaux identiques regroupés ;
//  - fermetures : chaque jour d'une ligne (période « du … au … » comprise,
//    même à cheval sur deux mois) est regroupé par mois, heures et
//    destination : { months: [m], month_days: [...], week_days: [] } ;
//  - plage d'ouverture limitée à certains mois / jours du mois : section
//    « Plages saisonnières » (cases mois et jours, jours du mois, heures),
//    modifiable (15/10/2026) ;
//  - fermeture liée à un jour de semaine ou valable tous les mois : conservée
//    telle quelle et listée (supprimable).
import { $, esc, confirmModal, helpButton, helpBox } from '../common/core.js?v=0.40.6';
import { M, listOf, destLabel, loadSounds, soundName } from './model.js?v=0.40.6';
import { attachPlay } from './sound-play.js?v=0.40.6';

const SLOT = 15, N = 96;
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MDAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Jours fériés français à date fixe (les fériés mobiles — Pâques, Ascension, Pentecôte — sont exclus).
const HOL = [[1, 1], [5, 1], [5, 8], [7, 14], [8, 15], [11, 1], [11, 11], [12, 25]];
const ALSACE = [12, 26];
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const hm = (s) => { const [h, m] = String(s || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
const partial = (a, full) => Array.isArray(a) && a.length > 0 && a.length < full;
const sameD = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
// « 1-5, 7 » ↔ [1,2,3,4,5,7] ; null si la saisie est invalide.
const toList = (s) => { const out = []; for (const part of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) { const m = part.match(/^(\d+)\s*-\s*(\d+)$/); if (m) { if (+m[1] > 31 || +m[2] > 31) return null; for (let i = +m[1]; i <= +m[2]; i++) out.push(i); } /* bornes 1-31 avant la boucle (audit : « 1-999999999 » figeait l'onglet) */ else if (/^\d+$/.test(part)) out.push(+part); else return null; } return [...new Set(out)].sort((a, b) => a - b); };
const fromList = (a) => { const v = [...(a || [])].sort((x, y) => x - y); const out = []; for (let i = 0; i < v.length; i++) { let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++; out.push(j > i ? `${v[i]}-${v[j]}` : `${v[i]}`); i = j; } return out.join(', '); };

// ---------------------------------------------------------------------------
// Grille ↔ plages d'ouverture
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

// ---------------------------------------------------------------------------
// Fermetures exceptionnelles ↔ lignes { m1, d1, m2, d2, all, hs, he, dest }
// ---------------------------------------------------------------------------
const nextDay = (m, d) => (d < MDAYS[m - 1] ? [m, d + 1] : [m === 12 ? 1 : m + 1, 1]);
function rowsFromExc(exc) {
  const rows = []; const kept = [];
  for (const p of exc || []) {
    if (partial(p.week_days, 7) || !partial(p.months, 12)) { kept.push(p); continue; }
    const s = hm(p.hours_start) ?? 0, e = hm(p.hours_end) ?? 1439;
    const all = s === 0 && e >= 1439;
    for (const m of [...p.months].sort((a, b) => a - b)) {
      const days = (partial(p.month_days, 31) ? [...p.month_days] : Array.from({ length: MDAYS[m - 1] }, (_, i) => i + 1)).filter((d) => d <= MDAYS[m - 1]).sort((a, b) => a - b);
      for (let i = 0; i < days.length; i++) { let j = i; while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++; rows.push({ m1: m, d1: days[i], m2: m, d2: days[j], all, hs: hhmm(s), he: hhmm(Math.min(e, 1439)), dest: p.destination || null }); i = j; }
    }
  }
  // Fusion d'une période à cheval sur deux mois (ex. 24 déc → 2 janv).
  rows.sort((a, b) => a.m1 - b.m1 || a.d1 - b.d1);
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < rows.length; j++) {
    const a = rows[i], b = rows[j]; if (!a || !b || a === b) continue;
    const [nm, nd] = nextDay(a.m2, a.d2);
    if (a.d2 === MDAYS[a.m2 - 1] && nm === b.m1 && nd === b.d1 && a.all === b.all && a.hs === b.hs && a.he === b.he && sameD(a.dest, b.dest)) { a.m2 = b.m2; a.d2 = b.d2; rows[j] = null; }
  }
  return { rows: rows.filter(Boolean), kept };
}
// Fériés fixes déjà présents (journée entière, même destination) → option cochée, lignes retirées.
// Les 8 dates présentes (journée entière) → option cochée, avec la destination
// la plus fréquente ; un férié à une autre destination reste une ligne (il
// l'emporte, comme à la saisie) : l'aller-retour est exact.
function extractHolidays(rows) {
  const single = (r, [m, d]) => r.all && r.m1 === m && r.d1 === d && r.m2 === m && r.d2 === d;
  const found = HOL.map((h) => rows.find((r) => single(r, h)));
  const on = found.every(Boolean);
  let dest = null;
  if (on) { const cnt = new Map(); for (const r of found) { const k = JSON.stringify(r.dest); cnt.set(k, (cnt.get(k) || 0) + 1); } dest = JSON.parse([...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0]); }
  let rest = on ? rows.filter((r) => !(found.includes(r) && sameD(r.dest, dest))) : rows;
  const als = on && rest.find((r) => single(r, ALSACE) && sameD(r.dest, dest));
  if (als) rest = rest.filter((r) => r !== als);
  return { on, alsace: !!als, dest, rows: rest };
}
function excFromRows(rows, hol) {
  const groups = new Map(); const explicit = new Set();
  const add = (m, d, hs, he, dest) => { const k = `${m}|${hs}|${he}|${JSON.stringify(dest)}`; if (!groups.has(k)) groups.set(k, { m, hs, he, dest, days: new Set() }); groups.get(k).days.add(d); };
  for (const r of rows) {
    const hs = r.all ? '00:00' : r.hs, he = r.all ? '23:59' : r.he;
    let m = r.m1, d = r.d1;
    for (let n = 0; n < 367; n++) { add(m, d, hs, he, r.dest); explicit.add(`${m}-${d}`); if (m === r.m2 && d === r.d2) break; [m, d] = nextDay(m, d); }
  }
  // Fériés : une ligne explicite le même jour l'emporte (sinon Wazo prendrait la première période trouvée).
  if (hol.on) for (const [m, d] of [...HOL, ...(hol.alsace ? [ALSACE] : [])]) if (!explicit.has(`${m}-${d}`)) add(m, d, '00:00', '23:59', hol.dest);
  return [...groups.values()].sort((a, b) => a.m - b.m || a.hs.localeCompare(b.hs))
    .map((g) => ({ hours_start: g.hs, hours_end: g.he, week_days: [], month_days: [...g.days].sort((a, b) => a - b), months: [g.m], destination: g.dest || { type: 'none' } }));
}

// ---------------------------------------------------------------------------
// Choix d'une destination (« Si fermé », chaque fermeture, fériés)
// ---------------------------------------------------------------------------
const DTYPES = [['voicemail', 'Messagerie'], ['sound', 'Fichier son'], ['hangup', 'Raccrocher'], ['user', 'Utilisateur'], ['group', 'Groupe'], ['queue', 'File d\'attente'], ['ivr', 'SVI'], ['switchboard', 'Standard'], ['conference', 'Conférence'], ['extension', 'Numéro'], ['none', 'Aucune']];
const IDF = { user: 'user_id', group: 'group_id', queue: 'queue_id', ivr: 'ivr_id', voicemail: 'voicemail_id', conference: 'conference_id', switchboard: 'switchboard_uuid' };
// La destination d'origine est gardée (data-orig) : un type que ce menu ne
// propose pas (application, commande, règle sortante…) reste « inchangé », et
// les réglages qu'il ne montre pas (durée de sonnerie, accueil de messagerie,
// options d'un son) sont conservés si l'objet visé ne change pas.
export function pickerHtml(id, cur) {
  const known = !cur?.type || DTYPES.some(([k]) => k === cur.type);
  const t = known ? cur?.type || 'none' : 'keep';
  return `<span class="cf-dp" id="${id}" data-orig="${esc(cur ? JSON.stringify(cur) : '')}"><select data-dt>${known ? '' : `<option value="keep" selected>Inchangée : ${esc(destLabel(cur))}</option>`}${DTYPES.map(([k, l]) => `<option value="${k}"${k === t ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><span data-dx>${pickerExtra(t, cur)}</span></span>`;
}
function pickerExtra(t, cur) {
  if (IDF[t]) {
    const sel = cur?.type === t ? String(cur[IDF[t]]) : '';
    return `<select data-do>${listOf(t).map((x) => { const id = x.key.slice(x.key.indexOf(':') + 1); return `<option value="${esc(id)}"${id === sel ? ' selected' : ''}>${esc(x.title)}${x.sub ? ` — ${esc(x.sub)}` : ''}</option>`; }).join('')}</select>`;
  }
  if (t === 'hangup') return `<select data-dc><option value="normal">tonalité normale</option><option value="busy"${cur?.cause === 'busy' ? ' selected' : ''}>occupé</option><option value="congestion"${cur?.cause === 'congestion' ? ' selected' : ''}>encombré</option></select>`;
  if (t === 'sound') return `<select data-df data-cur="${esc(cur?.type === 'sound' ? cur.filename || '' : '')}"><option value="">Chargement des sons…</option></select>`;
  if (t === 'extension') return `<input data-de value="${esc(cur?.type === 'extension' ? cur.exten || '' : '')}" placeholder="numéro"><select data-dctx>${(M.lists.context || []).filter((c) => c.type !== 'incall').map((c) => `<option value="${esc(c.name)}"${cur?.context === c.name ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('')}</select>`;
  return '';
}
// Menu des fichiers son (sons du tenant par catégorie, puis sons système).
export async function fillSoundSelect(sel, current) {
  if (!sel) return;
  const cats = await loadSounds();
  const cur = current || '';
  const known = cats.some((c) => c.files.some((f) => f.value === cur));
  sel.innerHTML = `${cur && !known ? `<option value="${esc(cur)}" selected>${esc(soundName(cur))} (actuel)</option>` : ''}${!cats.length ? '<option value="">Aucun son lisible (droit confd.sounds.read ?)</option>' : '<option value="">— Choisir un son —</option>'}`
    + cats.map((c) => `<optgroup label="${esc(c.system ? 'Sons système (Asterisk)' : `Sons du tenant · ${c.category}`)}">${c.files.map((f) => `<option value="${esc(f.value)}"${f.value === cur ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}</optgroup>`).join('');
  attachPlay(sel);
  sel.dispatchEvent(new Event('change'));
}
// Accroche posée par create.js : « Créer … » sur la liste d'objets (sans import circulaire).
let objSelectHook = null;
export const setObjSelectHook = (fn) => { objSelectHook = fn; };
export function bindPicker(id) {
  const el = $(id); if (!el) return;
  const fill = () => { const s = el.querySelector('[data-df]'); if (s) fillSoundSelect(s, s.dataset.cur); const o = el.querySelector('[data-do]'); if (o) objSelectHook?.(o, el.querySelector('[data-dt]').value); };
  el.querySelector('[data-dt]').onchange = (e) => { el.querySelector('[data-dx]').innerHTML = pickerExtra(e.target.value, null); el.parentElement?.querySelectorAll(':scope > .cf-sch-new').forEach((b) => b.remove()); fill(); };
  fill();
}
export function readPicker(id) {
  const el = $(id); const t = el.querySelector('[data-dt]').value;
  let orig = null; try { orig = el.dataset.orig ? JSON.parse(el.dataset.orig) : null; } catch { /* */ }
  if (t === 'keep') return orig;
  if (t === 'none') return null;
  let d = null;
  if (IDF[t]) { const v = el.querySelector('[data-do]')?.value; if (!v || v === 'new') throw new Error('Choisissez un objet pour la destination.'); d = { type: t, [IDF[t]]: t === 'switchboard' ? v : Number(v) }; }
  if (t === 'hangup') d = { type: t, cause: el.querySelector('[data-dc]').value };
  if (t === 'sound') { const f = el.querySelector('[data-df]').value; if (!f) throw new Error('Choisissez un fichier son.'); d = { type: t, filename: f }; }
  if (t === 'extension') { const x = el.querySelector('[data-de]').value.trim(); if (!/^[0-9*#]+$/.test(x)) throw new Error('Numéro : chiffres, * et #.'); d = { type: t, exten: x, context: el.querySelector('[data-dctx]').value }; }
  // Même type et même objet : on garde les réglages d'origine non affichés.
  if (d && orig?.type === t && (!IDF[t] || String(orig[IDF[t]]) === String(d[IDF[t]]))) return { ...orig, ...d };
  return d;
}

// ---------------------------------------------------------------------------
// Éditeur. s : horaire (copie locale, brouillon compris) ; onSave(value)
// avec value = { open_periods, exceptional_periods, closed_destination }.
// ---------------------------------------------------------------------------
export function openScheduleEditor(s, onSave) {
  const G = gridFromPeriods(s.open_periods);
  const R = rowsFromExc(s.exceptional_periods);
  const H = extractHolidays(R.rows);
  let rows = H.rows;
  let keptExc = [...R.kept];
  const defDest = () => s.closed_destination || null;
  // Plages saisonnières (demande de Brice, 15/10/2026) : plages limitées à
  // certains mois / jours du mois, que la grille (semaine type) ne sait pas
  // représenter. Toutes deviennent des lignes modifiables :
  // { months: [..], wd: [..], md: '1-15' | '', hs, he }.
  let seas = G.kept.map((p) => ({
    months: partial(p.months, 12) ? [...p.months] : Array.from({ length: 12 }, (_, i) => i + 1),
    wd: partial(p.week_days, 7) ? [...p.week_days] : [1, 2, 3, 4, 5, 6, 7],
    md: partial(p.month_days, 31) ? fromList(p.month_days) : '', hs: p.hours_start || '09:00', he: p.hours_end || '12:00',
  }));
  const MSHORT = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
  const chip = (attr, v, label, on, title) => `<label class="cf-ck" title="${esc(title || label)}"><input type="checkbox" ${attr}="${v}"${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  // Même découpage qu'une plage Wazo (heures, jours de semaine, jours du mois,
  // mois), libellés explicites, et la plage relue en clair sous la ligne.
  const WDL = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  const listFr = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} et ${a[a.length - 1]}`);
  const runs = (v) => { const out = []; for (let i = 0; i < v.length; i++) { let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++; out.push([v[i], v[j]]); i = j; } return out; };
  const seasText = (r) => {
    const wd = r.wd.length === 7 ? 'tous les jours' : listFr(runs([...r.wd].sort((a, b) => a - b)).map(([a, b]) => (b - a >= 2 ? `du ${WDL[a - 1]} au ${WDL[b - 1]}` : a === b ? `le ${WDL[a - 1]}` : `le ${WDL[a - 1]} et le ${WDL[b - 1]}`)));
    const mo = r.months.length === 12 ? 'tous les mois' : listFr(runs([...r.months].sort((a, b) => a - b)).map(([a, b]) => (b - a >= 2 ? `de ${MONTHS[a - 1]} à ${MONTHS[b - 1]}` : a === b ? `en ${MONTHS[a - 1]}` : `en ${MONTHS[a - 1]} et ${MONTHS[b - 1]}`)));
    const md = r.md ? `, les jours ${r.md} du mois` : '';
    return r.months.length && r.wd.length ? `Ouvert de ${r.hs} à ${r.he}, ${wd}${md}, ${mo}.` : 'Plage incomplète : cochez au moins un jour et un mois.';
  };
  const seasHtml = (r, i) => `<div class="cf-sr" data-s="${i}">
      <div class="cf-sr-f"><span class="cf-sr-k">Heures</span><span>de <input type="time" data-shs value="${esc(r.hs)}"> à <input type="time" data-she value="${esc(r.he)}"></span></div>
      <div class="cf-sr-f"><span class="cf-sr-k">Jours</span><span class="cf-cks">${DAYS.map((d, k) => chip('data-swd', k + 1, d, r.wd.includes(k + 1), WDL[k])).join('')}</span></div>
      <div class="cf-sr-f"><span class="cf-sr-k">Mois</span><span class="cf-cks">${MSHORT.map((m, k) => chip('data-smo', k + 1, m, r.months.includes(k + 1), MONTHS[k])).join('')}</span></div>
      <div class="cf-sr-f"><span class="cf-sr-k" title="Facultatif : ex. 1-15 ou 1, 15 ; vide = tous les jours du mois">Jours du mois</span><input data-smd value="${esc(r.md)}" placeholder="tous"></div>
      <div class="cf-sr-txt" data-stxt>${esc(seasText(r))}</div>
      <button class="icon cf-sr-x" data-delseas title="Supprimer cette plage">×</button></div>`;
  function readSeas(validate) {
    return [...$('se-slist').querySelectorAll('.cf-sr')].map((el, i) => {
      const r = { months: [...el.querySelectorAll('[data-smo]:checked')].map((c) => +c.dataset.smo), wd: [...el.querySelectorAll('[data-swd]:checked')].map((c) => +c.dataset.swd), md: el.querySelector('[data-smd]').value.trim(), hs: el.querySelector('[data-shs]').value, he: el.querySelector('[data-she]').value };
      if (validate) {
        if (!r.months.length) throw new Error(`Plage limitée ${i + 1} : cochez au moins un mois.`);
        if (!r.wd.length) throw new Error(`Plage limitée ${i + 1} : cochez au moins un jour de semaine.`);
        const md = toList(r.md); if (!md || md.some((d) => d < 1 || d > 31)) throw new Error(`Plage limitée ${i + 1} : jours du mois de 1 à 31 (ex. 1-15 ou 1, 15).`);
        if (!/^\d\d:\d\d$/.test(r.hs) || !/^\d\d:\d\d$/.test(r.he) || r.hs > r.he) throw new Error(`Plage limitée ${i + 1} : heures au format HH:MM, début avant la fin.`);
      }
      return r;
    });
  }
  const seasPeriods = (list) => list.map((r) => ({ hours_start: r.hs, hours_end: r.he, week_days: r.wd.length === 7 ? [] : r.wd, month_days: toList(r.md) || [], months: r.months.length === 12 ? [] : r.months }));
  const renderSeas = () => { $('se-slist').innerHTML = seas.map(seasHtml).join(''); };

  const gridHtml = () => `<div class="cf-wg"><div class="cf-wg-h"><span></span><div>${Array.from({ length: 9 }, (_, k) => `<b style="left:${(k * 3 / 24) * 100}%">${k * 3} h</b>`).join('')}</div><span></span></div>
    ${G.grid.map((row, d) => `<div class="cf-wg-r"><span class="cf-wg-d">${DAYS[d]}</span><div class="cf-wg-c" data-row="${d}">${row.map((on, i) => `<i data-d="${d}" data-i="${i}" class="${on ? 'on' : ''}${i % 4 === 0 ? ' h' : ''}"></i>`).join('')}</div><span class="cf-wg-s" id="wg-s${d}"></span></div>`).join('')}</div>`;
  const opt = (n, sel) => Array.from({ length: n }, (_, i) => `<option value="${i + 1}"${i + 1 === sel ? ' selected' : ''}>${i + 1}</option>`).join('');
  const mopt = (sel) => MONTHS.map((m, i) => `<option value="${i + 1}"${i + 1 === sel ? ' selected' : ''}>${m}</option>`).join('');
  const range = (r) => !(r.m1 === r.m2 && r.d1 === r.d2);
  const rowHtml = (r, i) => `<div class="cf-xr" data-x="${i}">
      <span class="cf-xr-l">Le</span><select data-d1>${opt(31, r.d1)}</select><select data-m1>${mopt(r.m1)}</select>
      <label class="inline"><input type="checkbox" data-rg${range(r) ? ' checked' : ''}> jusqu'au</label>
      <span data-end${range(r) ? '' : ' hidden'}><select data-d2>${opt(31, r.d2)}</select><select data-m2>${mopt(r.m2)}</select></span>
      <label class="inline"><input type="checkbox" data-all${r.all ? ' checked' : ''}> toute la journée</label>
      <span data-hrs${r.all ? ' hidden' : ''}>de <input type="time" data-hs value="${esc(r.hs)}"> à <input type="time" data-he value="${esc(r.he)}"></span>
      <span class="cf-xr-l">→</span>${pickerHtml(`se-xd${i}`, r.dest)}
      <button class="icon" data-delrow title="Supprimer cette fermeture">×</button></div>`;
  const keptHtml = () => keptExc.length ? `<p class="small muted">Autres fermetures conservées telles quelles (liées à un jour de semaine ou valables tous les mois) :</p><ul class="cf-kept">${keptExc.map((p, i) => `<li>${esc(periodTxt(p))} → ${esc(destLabel(p.destination))} <button class="icon" data-delkept="${i}" title="Supprimer cette fermeture">×</button></li>`).join('')}</ul>` : '';
  const help = `Ouvert : tirez un rectangle dans la grille (jours × heures) pour ouvrir tout le bloc ; partez d'une case déjà ouverte pour le fermer. Au quart d'heure ; les jours aux créneaux identiques sont regroupés, et une plage 09:00–12:00 couvre 12:00 (bornes incluses, comme dans Wazo). Si fermé : où part l'appel hors des plages d'ouverture. Fermetures exceptionnelles : vérifiées AVANT les plages d'ouverture ; chacune a sa date (ou sa période « jusqu'au »), ses heures et sa destination. Jours fériés : option qui ajoute les fériés français à date fixe (pas Pâques, l'Ascension ni la Pentecôte, dont la date change). Fuseau : ${s.timezone || '?'}. Rien n'est écrit avant « Appliquer… ».`;

  confirmModal(`<div class="cf-sched-ed">
    <div class="titlerow"><h3>Horaire « ${esc(s.name)} »</h3>${helpButton('se-hb', 'Aide')}</div>${helpBox('se-hb', help)}
    <h4 class="cf-per-t">1. Ouvert</h4>
    <p class="small muted cf-per-sub">Plages valables <strong>toute l'année</strong> (tous les mois, tous les jours du mois) :</p>
    <div class="btnrow cf-se-tools"><button data-tool="copy" title="Recopie les créneaux du lundi sur mardi à vendredi">Lundi → mar–ven</button><button data-tool="office" title="9h–12h et 14h–18h du lundi au vendredi">Bureau 9h-12h / 14h-18h</button><button data-tool="all" title="Ouvert tout le temps">24 h/24</button><button data-tool="clear">Tout fermer</button><span class="small muted">Tirez un bloc pour l'ouvrir ; partez d'une case ouverte pour le fermer.</span></div>
    <div id="se-grid">${gridHtml()}</div>
    ${G.rounded ? '<p class="warn small"><span>Certaines heures n\'étaient pas au quart d\'heure : elles sont arrondies dans la grille.</span></p>' : ''}
    <p class="small muted cf-per-sub">Plages <strong>limitées à certains mois ou jours du mois</strong> — comme dans Wazo, elles s'ajoutent aux plages ci-dessus (l'horaire est ouvert si l'une d'elles correspond) :</p>
    <div id="se-slist">${seas.map(seasHtml).join('')}</div>
    <div class="btnrow"><button data-tool="addseas">+ Plage limitée à certains mois</button></div>
    <h4 class="cf-per-t">2. Si fermé</h4>
    <div>L'appel part vers ${pickerHtml('se-closed', s.closed_destination)}</div>
    <h4 class="cf-per-t">3. Fermetures exceptionnelles (chaque année)</h4>
    <div class="warn small"><span>Wazo ne connaît pas l'année : une fermeture s'applique <strong>chaque année</strong> à la même date. Une fermeture ponctuelle (pont, congés, inventaire…) oubliée se rejouera l'année suivante : pensez à la retirer une fois passée, et relisez cette liste régulièrement.</span></div>
    <div class="cf-holopt">
      <label class="inline"><input type="checkbox" id="se-hol"${H.on ? ' checked' : ''}> <strong>Fermer les jours fériés français à date fixe</strong></label>
      <div class="small muted">1er janvier, 1er mai, 8 mai, 14 juillet, 15 août, 1er novembre, 11 novembre, 25 décembre — pas Pâques, l'Ascension ni la Pentecôte, dont la date change chaque année. Un jour férié qui a aussi sa propre ligne ci-dessous suit cette ligne.</div>
      <div id="se-holx"${H.on ? '' : ' hidden'}><label class="inline"><input type="checkbox" id="se-als"${H.alsace ? ' checked' : ''}> et le 26 décembre (Alsace-Moselle)</label> <span class="cf-xr-l">→</span>${pickerHtml('se-holdest', H.dest || defDest())}</div>
    </div>
    <div id="se-xlist">${rows.map(rowHtml).join('')}</div>
    <div class="btnrow"><button data-tool="addrow">+ Fermeture exceptionnelle</button></div>
    <div id="se-kept">${keptHtml()}</div>
    <p id="se-err" class="error small"></p></div>`, () => {
    try {
      const closed = readPicker('se-closed');
      const rs = readRows(true);
      const hol = { on: $('se-hol').checked, alsace: $('se-als').checked, dest: $('se-hol').checked ? (readPicker('se-holdest') || closed) : null };
      const ss = readSeas(true);
      onSave({ open_periods: [...periodsFromGrid(G.grid), ...seasPeriods(ss)], exceptional_periods: [...excFromRows(rs, hol), ...keptExc], closed_destination: closed });
      return true;
    } catch (e) { $('se-err').textContent = e.message; return false; }
  }, 'Ajouter au brouillon');

  // Lignes de fermeture : lecture du formulaire (validate : contrôles et destinations).
  function readRows(validate) {
    return [...$('se-xlist').querySelectorAll('.cf-xr')].map((el, i) => {
      const v = (q) => el.querySelector(q);
      const r = { d1: +v('[data-d1]').value, m1: +v('[data-m1]').value, all: v('[data-all]').checked, hs: v('[data-hs]').value, he: v('[data-he]').value };
      if (v('[data-rg]').checked) { r.d2 = +v('[data-d2]').value; r.m2 = +v('[data-m2]').value; } else { r.d2 = r.d1; r.m2 = r.m1; }
      const id = v('.cf-dp').id;
      if (validate) {
        if (r.d1 > MDAYS[r.m1 - 1] || r.d2 > MDAYS[r.m2 - 1]) throw new Error(`Fermeture ${i + 1} : le ${r.d1 > MDAYS[r.m1 - 1] ? r.d1 : r.d2} ${MONTHS[(r.d1 > MDAYS[r.m1 - 1] ? r.m1 : r.m2) - 1]} n'existe pas.`);
        if (!r.all && (!/^\d\d:\d\d$/.test(r.hs) || !/^\d\d:\d\d$/.test(r.he) || r.hs > r.he)) throw new Error(`Fermeture ${i + 1} : heures au format HH:MM, début avant la fin (Wazo refuse une plage qui passe minuit).`);
        r.dest = readPicker(id) || readPicker('se-closed');
      } else r.dest = (() => { try { return readPicker(id); } catch { return rows[i]?.dest || null; } })(); // choix incomplet : on garde l'ancien
      return r;
    });
  }
  const renderRows = () => { $('se-xlist').innerHTML = rows.map(rowHtml).join(''); rows.forEach((_, i) => bindPicker(`se-xd${i}`)); };
  ['se-closed', 'se-holdest'].forEach(bindPicker);
  rows.forEach((_, i) => bindPicker(`se-xd${i}`));

  const summary = () => G.grid.forEach((row, d) => { const segs = segmentsOf(row); $(`wg-s${d}`).textContent = segs.length ? segs.map(([a, b]) => `${hhmm(a)}–${b === 1440 ? '24:00' : hhmm(b)}`).join(' · ') : 'fermé'; });
  const redrawGrid = () => { $('se-grid').innerHTML = gridHtml(); summary(); };
  summary();

  // Sélection en bloc : rectangle entre la case de départ et la case sous le pointeur.
  const box = $('modal-body');
  let sel = null;
  const cellAt = (x, y) => {
    const rowsEl = [...$('se-grid').querySelectorAll('.cf-wg-c')];
    let d = rowsEl.findIndex((r) => { const b = r.getBoundingClientRect(); return y >= b.top - 2 && y <= b.bottom + 2; });
    if (d < 0) { const first = rowsEl[0].getBoundingClientRect(), last = rowsEl[6].getBoundingClientRect(); d = y < first.top ? 0 : y > last.bottom ? 6 : sel.d1; }
    const b = rowsEl[d].getBoundingClientRect();
    const i = Math.max(0, Math.min(N - 1, Math.floor(((x - b.left) / b.width) * N)));
    return [d, i];
  };
  const preview = () => {
    const [da, db] = [Math.min(sel.d0, sel.d1), Math.max(sel.d0, sel.d1)], [ia, ib] = [Math.min(sel.i0, sel.i1), Math.max(sel.i0, sel.i1)];
    for (const c of $('se-grid').querySelectorAll('.cf-wg-c i')) { const d = +c.dataset.d, i = +c.dataset.i; const inR = d >= da && d <= db && i >= ia && i <= ib; c.classList.toggle('pv-on', inR && sel.on); c.classList.toggle('pv-off', inR && !sel.on); }
    $('se-sel').textContent = `${DAYS[da]}${db > da ? `–${DAYS[db]}` : ''} ${hhmm(ia * SLOT)}–${hhmm((ib + 1) * SLOT === 1440 ? 1439 : (ib + 1) * SLOT)} : ${sel.on ? 'ouvrir' : 'fermer'}`;
  };
  box.insertAdjacentHTML('beforeend', '<div id="se-sel" class="cf-se-sel" hidden></div>');
  const onMove = (e) => { if (!sel) return; [sel.d1, sel.i1] = cellAt(e.clientX, e.clientY); preview(); const t = $('se-sel'); t.hidden = false; t.style.left = `${e.clientX + 14}px`; t.style.top = `${e.clientY + 14}px`; };
  const onUp = () => {
    if (!sel) return;
    const [da, db] = [Math.min(sel.d0, sel.d1), Math.max(sel.d0, sel.d1)], [ia, ib] = [Math.min(sel.i0, sel.i1), Math.max(sel.i0, sel.i1)];
    for (let d = da; d <= db; d++) for (let i = ia; i <= ib; i++) G.grid[d][i] = sel.on ? 1 : 0;
    sel = null; $('se-sel').hidden = true;
    window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
    redrawGrid();
  };
  box.onpointerdown = (e) => {
    const c = e.target.closest('.cf-wg-c i'); if (!c || e.button !== 0) return;
    e.preventDefault();
    const d = +c.dataset.d, i = +c.dataset.i;
    sel = { d0: d, i0: i, d1: d, i1: i, on: !G.grid[d][i] };
    preview();
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  };
  // Phrase en clair d'une plage limitée, mise à jour à chaque saisie.
  box.oninput = (e) => {
    const sr = e.target.closest?.('.cf-sr'); if (!sr) return;
    const i = [...$('se-slist').querySelectorAll('.cf-sr')].indexOf(sr);
    sr.querySelector('[data-stxt]').textContent = seasText(readSeas(false)[i]);
  };
  box.onchange = (e) => {
    const t = e.target;
    if (t.closest?.('.cf-sr')) box.oninput(e);
    if (t.id === 'se-hol') $('se-holx').hidden = !t.checked;
    const xr = t.closest('.cf-xr');
    if (xr && t.matches('[data-rg]')) { xr.querySelector('[data-end]').hidden = !t.checked; if (t.checked) { xr.querySelector('[data-d2]').value = xr.querySelector('[data-d1]').value; xr.querySelector('[data-m2]').value = xr.querySelector('[data-m1]').value; } }
    if (xr && t.matches('[data-all]')) xr.querySelector('[data-hrs]').hidden = t.checked;
  };
  box.onclick = (e) => {
    const dk = e.target.closest('[data-delkept]');
    if (dk) { keptExc.splice(+dk.dataset.delkept, 1); $('se-kept').innerHTML = keptHtml(); return; }
    const ds = e.target.closest('[data-delseas]');
    if (ds) { seas = readSeas(false); seas.splice(+ds.closest('.cf-sr').dataset.s, 1); renderSeas(); return; }
    const dr = e.target.closest('[data-delrow]');
    if (dr) { rows = readRows(false); rows.splice(+dr.closest('.cf-xr').dataset.x, 1); renderRows(); return; }
    const t = e.target.closest('[data-tool]')?.dataset.tool; if (!t) return;
    if (t === 'addseas') { seas = readSeas(false); seas.push({ months: [6, 7, 8], wd: [1, 2, 3, 4, 5], md: '', hs: '09:00', he: '12:00' }); renderSeas(); }
    if (t === 'addrow') { rows = readRows(false); rows.push({ m1: 12, d1: 24, m2: 12, d2: 24, all: true, hs: '12:00', he: '23:59', dest: rows[rows.length - 1]?.dest || defDest() }); renderRows(); }
    if (t === 'copy') { for (let d = 1; d < 5; d++) G.grid[d] = [...G.grid[0]]; redrawGrid(); }
    if (t === 'office') { G.grid.forEach((row, d) => { for (let i = 0; i < N; i++) { const m = i * SLOT; row[i] = d < 5 && ((m >= 540 && m < 720) || (m >= 840 && m < 1080)) ? 1 : 0; } }); redrawGrid(); }
    if (t === 'all') { G.grid.forEach((row) => row.fill(1)); redrawGrid(); }
    if (t === 'clear') { G.grid.forEach((row) => row.fill(0)); redrawGrid(); }
  };
}
function periodTxt(p) {
  const wd = (p.week_days || []).length && p.week_days.length < 7 ? p.week_days.map((d) => DAYS[d - 1]).join(', ') + ' ' : '';
  const md = partial(p.month_days, 31) ? `le ${p.month_days.join(', ')} ` : '';
  const mo = partial(p.months, 12) ? p.months.map((m) => MONTHS[m - 1]).join(', ') + ' ' : 'tous les mois ';
  return `${wd}${md}${mo}${p.hours_start}–${p.hours_end}`.trim();
}
