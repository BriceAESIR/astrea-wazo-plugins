// Astrea Desk — graphiques SVG sans bibliothèque (utilisés à l'écran et dans
// les exports HTML / PDF). Specs du skill dataviz : barres <= 24 px, bout
// arrondi 4 px côté valeur, 2 px d'écart entre segments empilés, grille en
// filet, texte en couleurs de texte (jamais la couleur de la série), légende
// dès deux séries. Les couleurs sont passées en paramètre : variables CSS à
// l'écran, hexadécimal dans les exports.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace('.0', '')}k` : String(n));

// Graduation « propre » : 0, pas, 2 pas… jusqu'à couvrir max.
function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

// Colonne arrondie en haut (côté valeur), carrée à la base.
function colPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function legend(series, c) {
  return `<div class="dk-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
}

// Colonnes empilées. buckets : [{ label, tip, values: { key: n } }].
// series : [{ key, label, color }]. Une étiquette d'axe sur `every`.
export function stackedColumns(buckets, series, { height = 220, ink = 'var(--muted)', grid = 'var(--line)', surface = 'var(--panel)' } = {}) {
  const W = 720, H = height, L = 36, B = 22, T = 8, R = 4;
  const pw = W - L - R, ph = H - B - T;
  const totals = buckets.map((b) => series.reduce((a, s) => a + (b.values[s.key] || 0), 0));
  const ticks = niceTicks(Math.max(1, ...totals));
  const top = ticks[ticks.length - 1];
  const y = (v) => T + ph - (v / top) * ph;
  const slot = pw / Math.max(1, buckets.length);
  const bw = Math.max(2, Math.min(24, slot * 0.62));
  const every = Math.max(1, Math.ceil(buckets.length / 12));
  let s = `<svg class="dk-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Appels par période" style="width:100%;height:auto;display:block">`;
  for (const t of ticks) s += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" style="stroke:${grid}" stroke-width="1"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" font-size="11" style="fill:${ink}">${fmtN(t)}</text>`;
  buckets.forEach((b, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    let acc = 0;
    const segs = series.filter((se) => b.values[se.key] > 0);
    segs.forEach((se, k) => {
      const v = b.values[se.key];
      const y0 = y(acc + v), h = y(acc) - y0;
      const gap = k > 0 ? 2 : 0; // écart de 2 px entre segments
      const hh = Math.max(0, h - gap);
      const tip = `${b.tip || b.label} · ${se.label} : ${v}`;
      const d = k === segs.length - 1 ? colPath(x, y0, bw, hh, 4) : `M${x},${y0 + hh}V${y0}H${x + bw}V${y0 + hh}Z`;
      s += `<path d="${d}" style="fill:${se.color}" data-tip="${esc(tip)}"><title>${esc(tip)}</title></path>`;
      acc += v;
    });
    // Zone de survol plus large que la barre (total de la période).
    s += `<rect x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}" fill="transparent" data-tip="${esc(`${b.tip || b.label} · total : ${totals[i]}`)}"/>`;
    if (i % every === 0) s += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" font-size="11" style="fill:${ink}">${esc(b.label)}</text>`;
  });
  s += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" style="stroke:${ink}" stroke-opacity=".5" stroke-width="1"/>`;
  return s + '</svg>';
}

// Barres horizontales d'une seule série, valeur au bout. En HTML (et non en
// SVG) pour garder un texte lisible quelle que soit la largeur du panneau.
// Styles : .dk-hbars dans desk.css et dans le rapport HTML.
export function hbars(rows, { color = 'var(--dk-s1)' } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="dk-hbars">${rows.map((r) => {
    const tip = `${r.label} : ${r.value}${r.extra ? ` (${r.extra})` : ''}`;
    const w = r.value ? Math.max(1, (r.value / max) * 100) : 0;
    return `<div class="dk-hb" data-tip="${esc(tip)}" title="${esc(tip)}"><span class="dk-hb-l">${esc(r.label)}</span><span class="dk-hb-t"><i style="width:${w}%;background:${color}"></i></span><span class="dk-hb-v">${r.value}${r.extra ? ` · ${esc(r.extra)}` : ''}</span></div>`;
  }).join('')}</div>`;
}
