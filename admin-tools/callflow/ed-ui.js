// Call Flow Manager — briques de la norme d'édition du module (décision de
// Brice, 15/10/2026 ; modèle : éditeur de groupe). Sections dépliables avec un
// résumé dans le titre, une colonne aérée, aide sous les champs, options rares
// derrière une case à cocher. Styles : classes cf-ge-* de callflow.css, dans un
// conteneur .cf-ed (largeur du dialogue).
import { esc, helpButton, helpBox } from '../common/core.js?v=0.37.1';

// Section dépliable : le résumé (data-sum) est rempli par l'éditeur (recap).
export const sec = (id, title, body, { open = false, help = '' } = {}) => `<details class="cf-ge-sec" data-sec="${id}"${open ? ' open' : ''}>
    <summary><span class="cf-ge-st">${esc(title)}</span><span class="cf-ge-sum" data-sum="${id}"></span></summary>
    <div class="cf-ge-body">${help ? `<div class="titlerow cf-ge-hrow"><span class="small muted">Aide</span>${helpButton(`ge-h-${id}`, title)}</div>${helpBox(`ge-h-${id}`, help)}` : ''}${body}</div></details>`;
// Champ : libellé au-dessus, aide en dessous.
export const field = (label, input, help) => `<label class="cf-ge-f"><span class="cf-ge-l">${esc(label)}</span>${input}${help ? `<span class="small muted">${esc(help)}</span>` : ''}</label>`;
// Case à cocher avec son explication en dessous.
export const check = (id, label, help, on, attr = '') => `<label class="cf-ge-b"><input type="checkbox" id="${id}"${on ? ' checked' : ''}${attr ? ` ${attr}` : ''}><span><strong>${esc(label)}</strong>${help ? `<span class="small muted">${esc(help)}</span>` : ''}</span></label>`;
// Résumés : { id: [morceaux] } → texte des titres de section.
export function setSums(box, S) {
  for (const [k, a] of Object.entries(S)) { const el = box.querySelector(`[data-sum="${k}"]`); if (el) el.textContent = a.filter(Boolean).join(' · '); }
}
// Ouvre une section (erreur de saisie).
export const openSec = (box, id) => { const d = box.querySelector(`[data-sec="${id}"]`); if (d) d.open = true; };
