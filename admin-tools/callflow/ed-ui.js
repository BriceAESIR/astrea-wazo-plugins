// Call Flow Manager — briques de la norme d'édition du module (décision de
// Brice, 15/10/2026 ; modèle : éditeur de groupe). Sections dépliables avec un
// résumé dans le titre, une colonne aérée, aide sous les champs, options rares
// derrière une case à cocher. Styles : classes cf-ge-* de callflow.css, dans un
// conteneur .cf-ed (largeur du dialogue).
import { esc, helpButton, helpBox } from '../common/core.js?v=0.40.6';

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

// Codes (messagerie, conférence ; décision de Brice 16/10/2026) : saisis masqués,
// « Afficher » révèle la valeur actuelle (lisible dans confd), « Générer » propose
// un code de chiffres. Dans le brouillon, l'aperçu et la sauvegarde JSON, la
// valeur est remplacée par « *** » (SECRET_KEYS, voir redact).
// call_permission_password : code personnel d'autorisations d'appels d'un utilisateur (renvoyé par GET /users, audit du 16/10/2026).
export const SECRET_KEYS = new Set(['password', 'pin', 'admin_pin', 'call_permission_password']);
export const secretField = (attr, label, cur, help, len = 4) => field(label, `<span class="cf-ge-row cf-secret"><input type="password" ${attr} value="${esc(cur ?? '')}" inputmode="numeric" autocomplete="new-password" spellcheck="false" placeholder="aucun"><button type="button" data-reveal title="Afficher ou masquer le code">Afficher</button><button type="button" data-gen="${len}" title="Proposer un code de ${len} chiffres">Générer</button></span>`, help);
// À appeler une fois sur le corps du dialogue.
export function bindSecrets(box) {
  box.addEventListener('click', (e) => {
    const r = e.target.closest('[data-reveal]');
    if (r) { const i = r.parentElement.querySelector('input'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; r.textContent = show ? 'Masquer' : 'Afficher'; return; }
    const g = e.target.closest('[data-gen]');
    if (g) {
      const i = g.parentElement.querySelector('input'); const a = new Uint32Array(Number(g.dataset.gen)); crypto.getRandomValues(a);
      i.value = [...a].map((x) => x % 10).join(''); i.type = 'text'; g.parentElement.querySelector('[data-reveal]').textContent = 'Masquer';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
// Copie sans les codes (aperçu, brouillon, sauvegarde JSON).
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.has(k) && x != null && x !== '' ? '***' : redact(x)]));
  return v;
}
