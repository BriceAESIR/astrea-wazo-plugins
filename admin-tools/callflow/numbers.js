// Call Flow Manager — numéro interne d'un groupe, d'une file ou d'une
// conférence (demande de Brice, 17/10/2026 : « je devrais être informé des
// plages disponibles » au lieu de les découvrir par une erreur).
// Vérifié dans wazo-confd master : le numéro doit être dans les plages du
// contexte propres au type (group_ranges, queue_ranges,
// conference_room_ranges) ; il est facultatif (objet joignable seulement par
// une SDA, un SVI, un débordement…).
// Même champ partout (création et éditeurs complets) : liste des numéros
// libres, plages du contexte choisi et premier numéro libre, mis à jour au
// changement de contexte.
import { esc } from '../common/core.js?v=0.40.19';
import { M, showNum } from './model.js?v=0.40.19';

export const RANGE_KEY = { group: 'group_ranges', queue: 'queue_ranges', conference: 'conference_room_ranges' };
const RANGE_NAME = { group: 'groupes', queue: 'files d\'attente', conference: 'conférences' };
const WHAT = { group: 'le groupe', queue: 'la file', conference: 'la conférence' };
const MAX_FREE = 200; // numéros libres proposés au plus (au-delà : saisie libre)

const rangesOf = (ctx, kind) => M.by.context?.get(ctx)?.[RANGE_KEY[kind]] || [];
const rangeTxt = (r) => (r.end && r.end !== r.start ? `${r.start}–${r.end}` : `${r.start}`);

// Numéros des plages pas encore utilisés dans ce contexte (own : numéro actuel de l'objet, compté libre).
export function freeNumbers(ctx, kind, own = '') {
  const out = [];
  for (const r of rangesOf(ctx, kind)) {
    const len = String(r.start).length; let n = BigInt(r.start); const end = BigInt(r.end || r.start);
    for (; n <= end && out.length < MAX_FREE; n += 1n) {
      const ex = n.toString().padStart(len, '0');
      if (ex === own || !M.ext.has(`${ex}@${ctx}`)) out.push(ex);
    }
  }
  return out;
}

export function inRanges(ctx, kind, ex) {
  const c = M.by.context?.get(ctx);
  if (!c?.[RANGE_KEY[kind]]) return true; // plages non lues : Wazo contrôlera
  return c[RANGE_KEY[kind]].some((r) => ex.length === String(r.start).length && ex >= String(r.start) && ex <= String(r.end || r.start));
}

// Message d'erreur si le numéro ne convient pas, '' sinon.
export function checkNumber(ctx, kind, ex, own = '') {
  if (!ex) return '';
  if (!/^[0-9*#]{1,40}$/.test(ex)) return 'Numéro interne : chiffres, * et # seulement.';
  const c = M.by.context?.get(ctx);
  if (!inRanges(ctx, kind, ex)) return `Numéro ${ex} hors des plages « ${RANGE_NAME[kind]} » du contexte ${c?.label || ctx} (${rangesOf(ctx, kind).map(rangeTxt).join(', ') || 'aucune'}).`;
  if (ex !== own && M.ext.has(`${ex}@${ctx}`)) return `Le numéro ${ex} est déjà utilisé dans le contexte ${c?.label || ctx}.`;
  return '';
}

function hint(ctx, kind, own) {
  const c = M.by.context?.get(ctx);
  const l = rangesOf(ctx, kind);
  if (!c) return '';
  if (!l.length) return `Aucune plage « ${RANGE_NAME[kind]} » dans ${c.label || ctx} : Wazo refusera tout numéro. Déclarez-en une dans le portail (Contextes), ou laissez vide.`;
  const free = freeNumbers(ctx, kind, own);
  return `Plages « ${RANGE_NAME[kind]} » de ${c.label || ctx} : ${l.map(rangeTxt).join(', ')}. ${free.length ? `${free.length >= MAX_FREE ? `${MAX_FREE} et plus` : free.length} libre${free.length > 1 ? 's' : ''}, premier : ${free[0]}.` : 'Aucun numéro libre.'}`;
}

// Champ numéro + contexte + plages. attrs : { ext, ctx } (attributs data-* des deux champs).
// prefill : propose le premier numéro libre (création).
export function numberFieldHtml(kind, { exten = '', ctx = '', ctxList = [], attrs = { ext: 'data-ext', ctx: 'data-extctx' }, prefill = false, field, pfx = 'nf' }) {
  const c0 = ctxList.some((c) => c.name === ctx) ? ctx : ctxList[0]?.name || '';
  const val = exten || (prefill ? freeNumbers(c0, kind)[0] || '' : '');
  const id = `${pfx}-${kind}`;
  return `<div class="cf-ge-2">
    ${field('Numéro interne', `<input ${attrs.ext} value="${esc(val)}" placeholder="aucun" inputmode="numeric" list="${id}-l" autocomplete="off"><datalist id="${id}-l"></datalist>`, `Facultatif : sans numéro, ${WHAT[kind]} n'est joignable que par une SDA, un SVI, un débordement… Avec un numéro, on peut l'appeler ou y transférer depuis un poste.`)}
    ${field('Contexte du numéro', `<select ${attrs.ctx}>${ctxList.map((c) => `<option value="${esc(c.name)}"${c.name === c0 ? ' selected' : ''}>${esc(c.label || c.name)}</option>`).join('')}</select>`)}
  </div><p class="small muted cf-nf-hint" id="${id}-h"></p>`;
}

export function bindNumberField(box, kind, { attrs = { ext: 'data-ext', ctx: 'data-extctx' }, own = '', pfx = 'nf' } = {}) {
  const sel = box.querySelector(`[${attrs.ctx}]`);
  const id = `${pfx}-${kind}`;
  const upd = () => {
    const ctx = sel?.value || '';
    const dl = box.querySelector(`#${id}-l`); const h = box.querySelector(`#${id}-h`);
    if (dl) dl.innerHTML = freeNumbers(ctx, kind, own).map((x) => `<option value="${esc(x)}">`).join('');
    if (h) h.textContent = hint(ctx, kind, own);
  };
  sel?.addEventListener('change', upd);
  upd();
}

// ---------------------------------------------------------------------------
// SDA : numéro ou motif (« Format d'extension » du portail).
// Vérifié dans wazo-confd master (helpers/validator.py, extension/validator.py) :
// EXTEN_REGEX = ^_[*#0-9_XxZzNn\[\].!-]{1,39}$ | [*#0-9]{1,40} pour un
// contexte entrant ; un motif (commence par « _ ») échappe au contrôle des
// incall_ranges, un numéro doit être dans ces plages.
// ---------------------------------------------------------------------------
const PAT_RE = /^_[*#0-9_XxZzNn[\].!-]{1,39}$/;
const incallRanges = (ctx) => M.by.context?.get(ctx)?.incall_ranges || [];
export const inIncallRange = (ctx, ex) => incallRanges(ctx).some((r) => /^\d+$/.test(ex) && ex.length === String(r.start).length && BigInt(ex) >= BigInt(r.start) && BigInt(ex) <= BigInt(r.end || r.start));
export function checkIncallNumber(ctx, ex, own = '') {
  const c = M.by.context?.get(ctx);
  if (!ex) return 'Numéro obligatoire.';
  if (ex.startsWith('_')) { if (!PAT_RE.test(ex)) return 'Motif : commence par « _ », puis chiffres, X (0-9), Z (1-9), N (2-9), [1-5], « . » ou « ! » (40 caractères au plus).'; }
  else {
    if (!/^[0-9*#]{1,40}$/.test(ex)) return 'Numéro : chiffres seulement, tel que reçu de l\'opérateur.';
    if (!inIncallRange(ctx, ex)) return `Numéro ${ex} hors des plages SDA du contexte ${c?.label || ctx} (${incallRanges(ctx).map(rangeTxt).join(', ') || 'aucune'}).`;
  }
  if (ex !== own && M.ext.has(`${ex}@${ctx}`)) return `Le numéro ${ex} a déjà une SDA dans ce contexte.`;
  return '';
}
export function incallNumberHtml({ exten = '', pattern = false, field }) {
  return `<div class="cf-ge-f"><span class="cf-ge-l">Format du numéro *</span><span class="cf-ge-row">
      <label class="inline"><input type="radio" name="inc-fmt" value="num"${pattern ? '' : ' checked'}> Numéro</label>
      <label class="inline"><input type="radio" name="inc-fmt" value="pat"${pattern ? ' checked' : ''}> Motif (dial pattern)</label></span></div>
    <span id="inc-num"${pattern ? ' hidden' : ''}><span class="cf-ge-2">${field('Numéro *', `<input data-inc="num" value="${pattern ? '' : esc(exten)}" inputmode="numeric" list="inc-num-l" autocomplete="off" placeholder="tel que reçu de l'opérateur, ex. 33978247652"><datalist id="inc-num-l"></datalist>`, '')}<span id="inc-free-f">${field('Numéros libres du contexte', '<select id="inc-free"></select>', 'Numéros déclarés dans le contexte qui n\'ont pas encore de SDA : le choisir remplit le champ.')}</span></span></span>
    <span id="inc-pat"${pattern ? '' : ' hidden'}>${field('Motif *', `<input data-inc="pat" value="${pattern ? esc(exten) : ''}" placeholder="ex. _3397824765X">`, 'Plusieurs numéros vers la même destination : « _ » puis X (0-9), Z (1-9), N (2-9), [1-5], « . » (un ou plusieurs chiffres). Pas de contrôle de plage pour un motif (vérifié dans confd).')}</span>
    <p class="small muted cf-nf-hint" id="inc-h"></p>`;
}
export const readIncallNumber = (box) => {
  const pat = box.querySelector('input[name="inc-fmt"]:checked')?.value === 'pat';
  const v = (box.querySelector(`[data-inc="${pat ? 'pat' : 'num'}"]`)?.value || '').trim();
  return pat ? v : v.replace(/[\s.-]/g, '');
};
// own : numéro actuel de la SDA (pas compté libre : retour de Brice, 19/10/2026). getCtx : contexte courant (création : liste déroulante).
export function bindIncallNumber(box, ctxOrFn, own = '') {
  const ctxOf = typeof ctxOrFn === 'function' ? ctxOrFn : () => ctxOrFn;
  const upd = () => {
    const ctx = ctxOf(); const pat = box.querySelector('input[name="inc-fmt"]:checked')?.value === 'pat';
    box.querySelector('#inc-num').hidden = pat; box.querySelector('#inc-pat').hidden = !pat;
    const l = incallRanges(ctx); const free = [];
    for (const r of l) { const len = String(r.start).length; for (let n = BigInt(r.start), e = BigInt(r.end || r.start); n <= e && free.length < MAX_FREE; n += 1n) { const x = n.toString().padStart(len, '0'); if (x !== own && !M.ext.has(`${x}@${ctx}`)) free.push(x); } }
    box.querySelector('#inc-num-l').innerHTML = free.map((x) => `<option value="${esc(x)}">`).join('');
    const fs = box.querySelector('#inc-free');
    if (fs) fs.innerHTML = `<option value="">Choisir un numéro libre…</option>${free.map((x) => `<option value="${esc(x)}">${esc(showNum(x))}${showNum(x).replace(/\s/g, '') !== x ? ` · ${esc(x)}` : ''}</option>`).join('')}`;
    const ff = box.querySelector('#inc-free-f'); if (ff) ff.hidden = !free.length;
    const c = M.by.context?.get(ctx);
    // Plages au format national (un numéro seul ou « de … à … »), 6 au plus puis « + N ».
    const nat = (r) => (r.end && String(r.end) !== String(r.start) ? `${showNum(String(r.start))} à ${showNum(String(r.end))}` : showNum(String(r.start)));
    const rl = l.slice(0, 6).map(nat).join(', ') + (l.length > 6 ? ` (+ ${l.length - 6})` : '');
    const nf = free.length >= MAX_FREE ? `${MAX_FREE} numéros et plus` : `${free.length} numéro${free.length > 1 ? 's' : ''}`;
    box.querySelector('#inc-h').textContent = pat ? 'Motif : pas de plage à respecter.' : !c ? ''
      : !l.length ? `Aucun numéro SDA déclaré dans le contexte ${c.label || ctx} : seul un motif est possible. Déclarez les numéros dans le portail (Contextes, plages SDA).`
      : free.length ? `Numéros déclarés dans le contexte ${c.label || ctx} : ${rl}. ${nf} sans SDA, dans la liste ci-dessus.`
      : `Numéros déclarés dans le contexte ${c.label || ctx} : ${rl}. Tous ont déjà une SDA${own ? ' (dont celle-ci)' : ''} : pour un autre numéro, déclarez-le d'abord dans le portail (Contextes, plages SDA).`;
  };
  box.addEventListener('change', (e) => {
    if (e.target.id === 'inc-free' && e.target.value) { const i = box.querySelector('[data-inc="num"]'); i.value = e.target.value; i.dispatchEvent(new Event('input', { bubbles: true })); e.target.value = ''; return; }
    if (e.target.name === 'inc-fmt' || e.target.matches('[data-c="ctx"]')) upd();
  });
  upd();
}