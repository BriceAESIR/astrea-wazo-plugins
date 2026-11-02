// Astrea Desk — outils communs aux modules à exports (journal d'appels,
// statistiques) : téléchargement, impression PDF, styles du rapport HTML,
// infobulles des graphiques.
import { $, toast } from '../admin-tools/common/core.js?v=0.7.10';

export function download(name, text, type) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Fichier ${name} téléchargé`);
  } catch (e) { console.warn('[astrea] téléchargement', e); toast('Téléchargement impossible dans cette appli.', 6000); }
}

// Nom de fichier sans accents ni caractères spéciaux.
export const fileSafe = (s) => String(s || 'site').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-');

// CSV pour Excel en français : séparateur « ; », BOM UTF-8.
export function csv(head, rows) {
  const q = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [head, ...rows].map((r) => r.map(q).join(';')).join('\r\n');
}

// PDF : impression du rapport HTML (« Enregistrer au format PDF »). En cas
// d'échec dans l'appli, on propose l'export HTML à imprimer ailleurs.
export function printHtml(html) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  f.onload = () => {
    try { f.contentWindow.focus(); f.contentWindow.print(); }
    catch (e) { console.warn('[astrea] impression', e); toast("Impression impossible ici : utilisez l'export HTML puis imprimez-le en PDF.", 8000); }
    setTimeout(() => f.remove(), 60000);
  };
  f.srcdoc = html;
}

// Styles du rapport HTML autonome (couleurs en dur, mode clair).
export const REPORT_CSS = `body{font:14px/1.45 "Mulish",Helvetica,Arial,sans-serif;color:#0b0b0b;margin:24px;background:#fff}h1{font-size:20px;margin:0}h3{font-size:15px;margin:0 0 8px}
.sub{color:#52514e;font-size:12px;margin:2px 0 16px}.dk-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:16px}.dk-panel>p{color:#52514e;font-size:11px;margin:-4px 0 8px}
.dk-kpi{border:1px solid #e1e0d9;border-radius:4px;padding:8px 12px}.dk-kpi span{display:block;color:#52514e;font-size:11px}.dk-kpi strong{font-size:18px}
.dk-panel{border:1px solid #e1e0d9;border-radius:4px;padding:12px 16px;margin-bottom:16px;break-inside:avoid}.dk-two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.dk-legend{display:flex;gap:16px;font-size:12px;color:#52514e;margin-bottom:6px}.dk-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.dk-hb{display:grid;grid-template-columns:minmax(80px,38%) 1fr auto;gap:10px;align-items:center;font-size:12px;padding:3px 0}.dk-hb-l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dk-hb-t{height:14px}.dk-hb-t i{display:block;height:100%;border-radius:0 4px 4px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact}.dk-hb-v{color:#52514e;white-space:nowrap}.dk-wide .dk-hb{grid-template-columns:minmax(200px,40%) 1fr auto}.dk-two+.dk-panel{margin-top:16px}
.dk-legend i,svg{-webkit-print-color-adjust:exact;print-color-adjust:exact}
table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;color:#52514e;font-weight:600;border-bottom:1px solid #c3c2b7;padding:6px 8px}td{border-bottom:1px solid #e1e0d9;padding:5px 8px}.num{text-align:right;white-space:nowrap}
@media print{body{margin:0}.dk-kpis{grid-template-columns:repeat(4,1fr)}thead{display:table-header-group}tr{break-inside:avoid}}`;

// Infobulle au survol des marques ([data-tip]) ; l'élément #dk-tip est dans la vue.
export function hoverTips(root) {
  root.addEventListener('mousemove', (e) => {
    const t = $('dk-tip'); if (!t) return;
    const m = e.target.closest?.('[data-tip]');
    if (!m) { t.hidden = true; return; }
    t.textContent = m.getAttribute('data-tip');
    t.hidden = false;
    t.style.left = `${Math.min(e.clientX + 12, innerWidth - t.offsetWidth - 8)}px`;
    t.style.top = `${e.clientY + 14}px`;
  });
  root.addEventListener('mouseleave', () => { const t = $('dk-tip'); if (t) t.hidden = true; });
}
