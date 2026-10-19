// Call Flow Manager — réglage d'une règle sortante (demande de Brice,
// 16/10/2026), selon la norme d'édition du module (ed-ui.js). Sans écriture :
// valeur au brouillon (onSave), écrite par write.js (outcall_cfg).
// Vérifié dans wazo-confd master (outcall/schema.py, outcall_extension,
// outcall_trunk, outcall_call_permission) :
//  - name (≤ 128, obligatoire), description, enabled, ring_time (≥ 0),
//    internal_caller_id, preprocess_subroutine ; PUT partiel ;
//  - motifs = extensions associées (PUT /outcalls/{id}/extensions/{ext_id}
//    {strip_digits, external_prefix, prefix, caller_id}) ;
//  - trunks : PUT /outcalls/{id}/trunks {trunks:[{id}]}, ordre = priorité.
// wazo-agid (outgoingfeatures.py) : seuls strip_digits et external_prefix
// changent le numéro envoyé ; « prefix » est lu mais pas appliqué.
import { $, esc, confirmModal, helpButton, helpBox, canWrite } from '../common/core.js?v=0.40.9';
// Création de l'autorisation « interdit-118 » liée au tenant des données chargées (tapi, model.js).
import { M, listOf, nodeInfo, tapi as api } from './model.js?v=0.40.9';
import { sec, field, check, setSums, openSec } from './ed-ui.js?v=0.40.9';
import { bindNewSchedule, schedValue } from './create.js?v=0.40.9';
import { describePattern, comparePatterns, dialedNumber, matches, famLabel } from './dialsim.js?v=0.40.9';

export const OUTCALL_FIELDS = ['name', 'description', 'enabled', 'ring_time', 'internal_caller_id', 'preprocess_subroutine'];
const DP = ['exten', 'strip_digits', 'external_prefix', 'prefix', 'caller_id'];
export function outcallCfgOf(o) {
  const f = {}; for (const k of OUTCALL_FIELDS) f[k] = o?.[k] ?? null;
  return {
    fields: f,
    patterns: [...(o?.extensions || [])].map((e) => ({ id: e.id ?? null, exten: e.exten, context: e.context, strip_digits: e.strip_digits ?? 0, external_prefix: e.external_prefix || '', prefix: e.prefix || '', caller_id: e.caller_id || '' })).sort((a, b) => comparePatterns(a.exten, b.exten)),
    trunks: (o?.trunks || []).map((t) => t.id),
    perms: (o?.call_permissions || []).map((p) => p.id).sort((a, b) => a - b),
  };
}
export function applyOutcallCfg(o, v) {
  Object.assign(o, v.fields);
  o.extensions = v.patterns.map((p) => ({ ...p }));
  o.trunks = v.trunks.map((id) => ({ ...(M.by.trunk?.get(String(id)) || {}), id }));
  o.call_permissions = v.perms.map((id) => ({ id, name: M.by.callpermission?.get(String(id))?.name || `#${id}` }));
}
const trunkName = (id) => nodeInfo(`trunk:${id}`).title || `trunk #${id}`;

// ---------------------------------------------------------------------------
// Assistant de motifs « France » (choix de Brice, 16/10/2026) : jeu prêt de
// motifs courants pour un trunk français, numéros envoyés en E.164 sans « + »
// (33…) par défaut ; urgences et numéros courts envoyés tels quels (supposé :
// accepté par l'opérateur, à vérifier). Les 118 XXX ne sont pas routés et sont
// bloqués par une autorisation d'appel en refus (« interdit-118 ») : sans elle,
// un motif large comme _X. les ferait sortir. Les 08 restent autorisés.
// ---------------------------------------------------------------------------
const FR_FAMILIES = [
  { id: 'urg', label: 'Urgences', note: '15, 17, 18, 112, 114, 115, 119, 116 XXX', pats: ['15', '17', '18', '112', '114', '115', '119', '_116XXX'], kind: 'keep' },
  { id: 'fix', label: 'Fixes (01 à 05)', pats: ['_0[1-5]XXXXXXXX'], kind: 'nat' },
  { id: 'mob', label: 'Mobiles (06, 07)', pats: ['_0[67]XXXXXXXX'], kind: 'nat' },
  { id: 'ng', label: 'Non géographiques (09)', pats: ['_09XXXXXXXX'], kind: 'nat' },
  { id: 'spe', label: 'Spéciaux (08)', pats: ['_08XXXXXXXX'], kind: 'nat' },
  { id: 'court', label: 'Courts (3 XXX)', pats: ['_3XXX'], kind: 'keep' },
  { id: 'intl', label: 'International (00…, +…)', pats: ['_00Z.', '_+Z.'], kind: 'intl' },
];
const FR_FORMATS = { 33: 'E.164 sans + (33…)', '+33': 'E.164 avec + (+33…)', nat: 'National, tel que composé (0…)' };
// Transformation d'un motif de l'assistant selon le format attendu par l'opérateur.
function frTransform(kind, pat, fmt) {
  if (kind === 'keep') return { strip_digits: 0, external_prefix: '' };
  if (kind === 'nat') return fmt === 'nat' ? { strip_digits: 0, external_prefix: '' } : { strip_digits: 1, external_prefix: fmt };
  if (pat === '_00Z.') return fmt === '33' ? { strip_digits: 2, external_prefix: '' } : fmt === '+33' ? { strip_digits: 2, external_prefix: '+' } : { strip_digits: 0, external_prefix: '' };
  return fmt === '33' ? { strip_digits: 1, external_prefix: '' } : fmt === '+33' ? { strip_digits: 0, external_prefix: '' } : { strip_digits: 1, external_prefix: '00' };
}
// Motif attrape-tout (prend tout ce que les autres ne prennent pas).
const isCatchAll = (p) => /^_(X|Z|N|)[.!]$/i.test(String(p || ''));
const BLOCK_118 = '_118XXX';

// onSave({ cfg, schedule })
export function openOutcallEditor(o, onSave) {
  const v = outcallCfgOf(o); const f = v.fields;
  let seq = 0;
  let rows = v.patterns.map((p) => ({ ...p, rid: `p${seq++}` }));
  let trunks = [...v.trunks];
  const outCtx = rows[0]?.context || (M.lists.context || []).find((c) => c.type === 'outcall')?.name || '';
  const sched = (o.schedules || [])[0]?.id;
  // Motifs regroupés par transformation (retour de Brice, 16/10/2026 : « ça n'a
  // pas changé l'assistant ») : un bloc par combinaison chiffres retirés /
  // préfixe ajouté / numéro présenté, réglages communs au bloc, motifs en
  // pastilles. Le n° sur chaque pastille = ordre d'essai d'Asterisk (le plus
  // précis d'abord, vérifié dans pbx.c) : il ne se règle pas, Wazo ne stocke
  // aucun ordre ; recalculé à chaque modification. L'état est tenu dans rows.
  const tkey = (r) => `${Number(r.strip_digits || 0)}|${r.external_prefix || ''}|${r.caller_id || ''}`;
  const sortRows = () => rows.sort((a, b) => comparePatterns(a.exten, b.exten));
  const groupsOf = () => { sortRows(); const g = new Map(); rows.forEach((r, i) => { r.rank = i + 1; const k = tkey(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }); return [...g.values()]; };
  const famsOf = (rs) => [...new Set(rs.map((r) => famLabel(r.exten)))].join(', ').replace(/^./, (c) => c.toUpperCase());
  const example = (p) => String(p || '').replace(/^_/, '').replace(/\[([^\]]*)\]/g, (m, x) => x[0]).replace(/[XxZzNn]/g, (c) => ({ x: '1', z: '1', n: '2' }[c.toLowerCase()])).replace(/[.!]/g, '123');
  const groupHtml = (rs, gi) => {
    const r0 = rs[0]; const ex = example(r0.exten);
    return `<li class="cf-oe-grp" data-g="${gi}" data-rids="${rs.map((r) => r.rid).join(',')}">
      <div class="cf-oe-grp-h"><strong>${esc(famsOf(rs))}</strong><span class="small muted">${rs.length} motif${rs.length > 1 ? 's' : ''}</span><span class="spacer"></span><button type="button" class="icon" data-gdel="${gi}" title="Retirer ce groupe et tous ses motifs">×</button></div>
      <div class="cf-oe-grp-f">
        <label>Retirer <input type="number" min="0" step="1" data-gf="strip_digits" value="${esc(r0.strip_digits ?? 0)}" title="Chiffres retirés en tête"> chiffre(s)</label>
        <label>Ajouter devant <input data-gf="external_prefix" value="${esc(r0.external_prefix || '')}" placeholder="rien" title="Ajouté devant, avant l'envoi au trunk"></label>
        <label>Présenté <input data-gf="caller_id" value="${esc(r0.caller_id || '')}" placeholder="de l'appelant" title="Numéro présenté"></label>
      </div>
      <div class="cf-oe-chips">${rs.map((r) => `<span class="cf-oe-chip" data-row="${r.rid}" title="${esc(describePattern(r.exten))} · essayé en n° ${r.rank} par Asterisk"><small>${r.rank}</small><code>${esc(r.exten)}</code><button type="button" data-delrow="${r.rid}" aria-label="Retirer ${esc(r.exten)}">×</button></span>`).join('')}<input class="cf-oe-add" data-gadd="${gi}" placeholder="+ motif" spellcheck="false" title="Ajouter un motif à ce groupe (Entrée)"></div>
      <div class="small muted">${ex ? `ex. ${esc(ex)} → envoyé ${esc(dialedNumber(ex, { strip_digits: Number(r0.strip_digits || 0), external_prefix: r0.external_prefix }))}${r0.caller_id ? `, présenté ${esc(r0.caller_id)}` : ''}` : ''}</div></li>`;
  };
  const readRows = () => {}; // état déjà dans rows (mis à jour à la saisie)
  const listHtml = () => groupsOf().map(groupHtml).join('') || '<li class="muted">Aucun motif : aucun numéro ne part par cette règle</li>';
  const PAT_RE = /^_?[0-9*#+XZNxzn.!\[\]-]+$/;
  const trunkRows = () => trunks.map((id, i) => `<li><span class="cf-ge-n">${i + 1}</span><span>${esc(trunkName(id))}</span><span class="small muted">${i ? 'si le précédent échoue' : 'en premier'}</span><span class="spacer"></span><button class="icon" data-tup="${i}"${i ? '' : ' disabled'}>↑</button><button class="icon" data-tdown="${i}"${i < trunks.length - 1 ? '' : ' disabled'}>↓</button><button class="icon" data-tdel="${i}" title="Retirer ce trunk">×</button></li>`).join('') || '<li class="muted">Aucun trunk : les appels ne peuvent pas sortir</li>';
  const addT = () => `<option value="">Choisir un trunk à ajouter…</option>${(M.lists.trunk || []).filter((t) => !trunks.includes(t.id)).map((t) => `<option value="${t.id}">${esc(trunkName(t.id))}</option>`).join('')}`;

  confirmModal(`<div class="cf-ed cf-outcall-ed">
    <div class="cf-ge-head"><div><h3>Règle sortante « ${esc(o.name)} »</h3><div class="small muted">${esc(o.description || '')}</div></div>${helpButton('oe-hb', 'Aide')}</div>${helpBox('oe-hb', 'Motifs de numéros, transformation du numéro, trunks dans l\'ordre, horaire et autorisations. Les modifications vont dans le brouillon ; « Appliquer… » relit la règle et n\'écrit que ce qui change.')}
    ${sec('gen', 'Général', `
      ${field('Nom *', `<input data-f="name" value="${esc(f.name || '')}" maxlength="128">`)}
      ${field('Description', `<input data-f="description" value="${esc(f.description || '')}">`)}
      ${field('Durée de sonnerie (s)', `<input type="number" min="0" step="1" data-f="ring_time" value="${esc(f.ring_time ?? '')}" placeholder="défaut">`, 'Avant d\'abandonner l\'appel sortant.')}
      ${check('oe-en', 'Règle activée', '', f.enabled !== false)}
      ${check('oe-int', 'Présenter le numéro interne', 'Le correspondant voit le numéro interne de l\'appelant au lieu de son numéro public (rarement utile vers l\'extérieur).', !!f.internal_caller_id)}`, { open: true })}
    ${sec('pat', 'Motifs de numéros', `<ul class="cf-oe-grps" id="oe-rows">${listHtml()}</ul>
      <div id="oe-wiz" class="cf-oe-wiz" hidden></div>
      <div class="cf-oe-new small"><span class="cf-ge-l">Nouveau groupe</span><input id="oe-ng-exten" placeholder="motif, ex. _0[67]XXXXXXXX" spellcheck="false"><label>retirer <input type="number" min="0" step="1" id="oe-ng-strip" value="0"></label><label>ajouter <input id="oe-ng-prefix" placeholder="rien"></label><button type="button" data-ngadd>Ajouter</button></div>
      <div class="cf-ge-row"><button type="button" data-wizard title="Ajouter d'un coup les motifs courants pour un trunk français">Assistant France…</button><span class="spacer"></span><input id="oe-test" inputmode="tel" placeholder="Tester un numéro" autocomplete="off" title="Quel motif de cette règle prend ce numéro"></div>
      <div id="oe-test-r" class="small"></div>`, { open: true, help: 'Règles d\'Asterisk : « _ » en tête = motif ; X = un chiffre 0-9, Z = 1-9, N = 2-9, [1-5] = un chiffre parmi, « . » = un ou plusieurs caractères. Ex. _0[1-5]XXXXXXXX = fixe, _0[67]XXXXXXXX = mobile, _00. = international, _X. = tout le reste. Ordre : quand plusieurs motifs correspondent, Asterisk prend le plus précis, position par position (chiffre fixe, puis [ensemble] le plus petit, N, Z, X, puis « . ») ; vérifié dans son code. Cet ordre ne se règle pas (Wazo ne stocke aucune priorité pour les motifs) : le n° de chaque pastille le montre, recalculé à chaque modification. Les motifs sont regroupés par transformation (chiffres retirés, préfixe, numéro présenté) : modifier un réglage de groupe vaut pour tous ses motifs. Pour changer la priorité, rendez un motif plus ou moins précis. Le numéro envoyé = numéro composé, moins les chiffres retirés, avec le préfixe ajouté devant (vérifié dans wazo-agid).' })}
    ${sec('trk', 'Trunks', `<ul class="cf-ge-list" id="oe-trunks">${trunkRows()}</ul>
      <div class="cf-ge-row"><select id="oe-tadd">${addT()}</select><button data-tadd>Ajouter</button></div>`, { open: true, help: 'L\'appel part par le premier trunk ; s\'il échoue, par le suivant.' })}
    ${sec('sch', 'Horaire', field('Horaire de la règle', `<select id="oe-sched"><option value="">Aucun : toujours ouverte</option>${listOf('schedule').map((x) => `<option value="${esc(x.key.slice(9))}"${String(sched) === x.key.slice(9) ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select>`))}
    ${sec('perm', 'Autorisations d\'appels', `<div class="cf-ge-perms">${(M.lists.callpermission || []).map((p) => `<label class="inline"><input type="checkbox" data-perm="${p.id}"${v.perms.includes(p.id) ? ' checked' : ''}> ${esc(p.name)}${p.mode ? ` <span class="small muted">(${esc(p.mode === 'deny' ? 'refus' : 'autorisation')})</span>` : ''}</label>`).join('') || '<span class="small muted">Aucune autorisation d\'appel définie.</span>'}</div>`)}
    ${sec('adv', 'Avancé', field('Sous-routine', `<input data-f="preprocess_subroutine" value="${esc(f.preprocess_subroutine || '')}" maxlength="79" placeholder="aucune">`))}
    <p id="oe-err" class="error small"></p></div>`, () => {
    const box = $('modal-body');
    const err = (m, s) => { openSec(box, s); $('oe-err').textContent = m; return false; };
    const nf = { ...f };
    nf.name = box.querySelector('[data-f="name"]').value.trim(); if (!nf.name) return err('Nom obligatoire.', 'gen');
    nf.description = box.querySelector('[data-f="description"]').value.trim() || null;
    const rt = box.querySelector('[data-f="ring_time"]').value.trim(); if (rt === '') nf.ring_time = f.ring_time; else if (!/^\d+$/.test(rt)) return err('Durée de sonnerie : entier positif.', 'gen'); else nf.ring_time = Number(rt);
    nf.enabled = $('oe-en').checked; nf.internal_caller_id = f.internal_caller_id == null && !$('oe-int').checked ? f.internal_caller_id : $('oe-int').checked;
    nf.preprocess_subroutine = box.querySelector('[data-f="preprocess_subroutine"]').value.trim() || null;
    const patterns = []; const seen = new Set();
    for (const r of rows) {
      const exten = String(r.exten || '').trim();
      if (!PAT_RE.test(exten)) return err(`Motif « ${exten} » : chiffres, X Z N, [..], « . », « ! », avec « _ » en tête pour un motif.`, 'pat');
      if (seen.has(exten)) return err(`Le motif ${exten} apparaît deux fois.`, 'pat'); seen.add(exten);
      const sd = String(r.strip_digits ?? '').trim(); if (sd !== '' && !/^\d+$/.test(sd)) return err('Chiffres retirés : entier positif.', 'pat');
      // Vérifié (outcall_extension/resource.py) : chiffres, * et #, « + » possible en tête ; 64 caractères max.
      const xp = String(r.external_prefix || '').trim(); if (xp && (!/^\+?[0-9#*]*$/.test(xp) || xp.length > 64)) return err(`Préfixe ajouté « ${xp} » : chiffres, * et #, avec « + » possible en tête.`, 'pat');
      patterns.push({ id: r.id, exten, context: r.context || outCtx, strip_digits: Number(sd || 0), external_prefix: xp, prefix: r.prefix || '', caller_id: String(r.caller_id || '').trim() });
    }
    if (patterns.some((p) => !p.context)) return err('Aucun contexte « sortant » trouvé pour un nouveau motif.', 'pat');
    const perms = [...box.querySelectorAll('[data-perm]:checked')].map((c) => Number(c.dataset.perm)).sort((a, b) => a - b);
    const s = schedValue($('oe-sched'));
    onSave({ cfg: { fields: nf, patterns: patterns.sort((a, b) => comparePatterns(a.exten, b.exten)), trunks: [...trunks], perms }, schedule: s ? Number(s) : null });
    return true;
  }, 'Ajouter au brouillon');

  const box = $('modal-body');
  bindNewSchedule($('oe-sched'));
  const recap = () => {
    setSums(box, {
      gen: [box.querySelector('[data-f="name"]').value.trim(), $('oe-en').checked ? '' : 'DÉSACTIVÉE'],
      pat: [`${rows.length} motif${rows.length > 1 ? 's' : ''}`, `${new Set(rows.map(tkey)).size} groupe${new Set(rows.map(tkey)).size > 1 ? 's' : ''}`],
      trk: [trunks.length ? trunks.map(trunkName).join(' puis ') : 'aucun trunk'],
      sch: [schedValue($('oe-sched')) ? $('oe-sched').selectedOptions[0].text : 'aucun'],
      perm: [`${box.querySelectorAll('[data-perm]:checked').length || 'aucune'}`],
      adv: [box.querySelector('[data-f="preprocess_subroutine"]').value.trim()],
    });
  };
  const redrawT = () => { $('oe-trunks').innerHTML = trunkRows(); $('oe-tadd').innerHTML = addT(); recap(); };
  // Liste redessinée dans l'ordre d'Asterisk (après saisie d'un motif, ajout, retrait).
  const redrawRows = (focusGroupOf) => {
    $('oe-rows').innerHTML = listHtml(); recap(); testNum();
    if (focusGroupOf) box.querySelector(`[data-row="${focusGroupOf}"]`)?.closest('.cf-oe-grp')?.querySelector('.cf-oe-add')?.focus();
  };
  // Tester un numéro : motif retenu parmi ceux de la règle (règles d'Asterisk), numéro envoyé.
  const testNum = () => {
    const n = $('oe-test').value.replace(/[\s.()-]/g, ''); const out = $('oe-test-r');
    for (const el of box.querySelectorAll('.cf-oe-chip.hit')) el.classList.remove('hit');
    if (!n) { out.textContent = ''; return; }
    sortRows(); const i = rows.findIndex((r) => matches(r.exten, n));
    if (i < 0) { out.innerHTML = `<span class="cf-ge-dnd">Aucun motif de cette règle ne prend ${esc(n)}</span>`; return; }
    const r = rows[i]; box.querySelector(`.cf-oe-chip[data-row="${r.rid}"]`)?.classList.add('hit');
    out.textContent = `${n} → motif n° ${i + 1} ${r.exten} → envoyé ${dialedNumber(n, { strip_digits: Number(r.strip_digits || 0), external_prefix: r.external_prefix })} (dans cette règle ; une autre règle ou un numéro interne du contexte peut passer avant)`;
  };
  // Réglage d'un groupe : appliqué à tous ses motifs ; redessin à la fin de la saisie (des groupes peuvent fusionner).
  const groupRows = (el) => { const ids = (el.closest('.cf-oe-grp')?.dataset.rids || '').split(','); return rows.filter((r) => ids.includes(r.rid)); };
  // Ajout d'un motif : contrôlé (forme, doublon) avant d'entrer dans rows.
  const addPattern = (exten, t) => {
    exten = String(exten || '').trim(); const msg = $('oe-test-r');
    if (!exten) return false;
    if (!PAT_RE.test(exten)) { msg.innerHTML = `<span class="cf-ge-dnd">Motif « ${esc(exten)} » : chiffres, X Z N, [..], « . », « ! », avec « _ » en tête pour un motif.</span>`; return false; }
    if (rows.some((r) => r.exten === exten)) { msg.innerHTML = `<span class="cf-ge-dnd">Le motif ${esc(exten)} est déjà dans la règle.</span>`; return false; }
    const r = { id: null, rid: `p${seq++}`, exten, context: outCtx, prefix: '', caller_id: '', strip_digits: 0, external_prefix: '', ...t };
    rows.push(r); redrawRows(r.rid); return true;
  };
  box.addEventListener('input', (e) => {
    $('oe-err').textContent = '';
    const k = e.target.dataset.gf; if (k) for (const r of groupRows(e.target)) r[k] = e.target.value.trim();
    recap(); if (e.target.id === 'oe-test' || k) testNum();
  });
  box.addEventListener('change', (e) => { if (e.target.dataset.gf) redrawRows(); else recap(); });
  box.addEventListener('keydown', (e) => {
    const a = e.target.closest?.('[data-gadd]'); if (!a || e.key !== 'Enter') return;
    e.preventDefault(); const g = groupRows(a)[0];
    if (addPattern(a.value, g ? { strip_digits: g.strip_digits, external_prefix: g.external_prefix, caller_id: g.caller_id } : {})) a.value = '';
  });
  // --- Assistant France -----------------------------------------------------
  const permBox = () => box.querySelector('.cf-ge-perms');
  const find118 = () => (M.lists.callpermission || []).find((p) => p.mode === 'deny' && (p.extensions || []).includes(BLOCK_118));
  const wizHtml = () => {
    readRows();
    const have = new Set(rows.map((r) => r.exten));
    const catchAll = rows.filter((r) => isCatchAll(r.exten)).map((r) => r.exten);
    const p118 = find118();
    return `<div class="cf-oe-wiz-h"><strong>Assistant France</strong><span class="small muted">motifs courants pour un trunk français ; l'ordre d'essai reste celui d'Asterisk (le plus précis d'abord)</span></div>
      <div class="cf-oe-wiz-f">${FR_FAMILIES.map((fa) => { const all = fa.pats.every((p) => have.has(p)); return `<label class="inline"><input type="checkbox" data-wf="${fa.id}"${all ? ' disabled' : ' checked'}> <strong>${esc(fa.label)}</strong> <code>${esc(fa.note || fa.pats.join(', '))}</code>${all ? ' <span class="small muted">déjà présents</span>' : ''}</label>`; }).join('')}</div>
      ${field('Format attendu par l\'opérateur', `<select id="oe-wfmt">${Object.entries(FR_FORMATS).map(([k, l]) => `<option value="${k}"${k === '33' ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`, 'Fixes, mobiles, 09 et 08 : 0 retiré puis préfixe ; international : 00 ou + retiré. Urgences et numéros courts : envoyés tels quels (supposé accepté par l\'opérateur).')}
      ${check('oe-w118', 'Bloquer les 118 XXX (renseignements surtaxés)', p118 ? `Autorisation « ${p118.name} » (refus de ${BLOCK_118}) cochée sur cette règle.` : `Crée tout de suite dans Wazo l'autorisation « interdit-118 » (refus de ${BLOCK_118}) et la coche sur cette règle. Sans elle, un motif large comme _X. les ferait sortir.`, true)}
      ${catchAll.length ? check('oe-wcatch', `Retirer le motif attrape-tout ${catchAll.join(', ')}`, 'Il prend tout numéro qu\'aucun autre motif ne prend (numéros mal composés, services inconnus). Avec l\'assistant, il n\'est plus nécessaire.', false) : ''}
      <div class="btnrow"><button type="button" data-wapply class="primary">Ajouter à la règle</button><button type="button" data-wclose>Fermer</button></div>
      <div id="oe-wiz-r" class="small"></div>`;
  };
  const wizApply = async () => {
    readRows();
    const fmt = $('oe-wfmt').value; const have = new Set(rows.map((r) => r.exten)); let added = 0, kept = 0;
    for (const fa of FR_FAMILIES) {
      if (!box.querySelector(`[data-wf="${fa.id}"]`)?.checked) continue;
      for (const p of fa.pats) {
        if (have.has(p)) { kept++; continue; }
        rows.push({ id: null, rid: `p${seq++}`, exten: p, context: outCtx, prefix: '', caller_id: '', ...frTransform(fa.kind, p, fmt) }); have.add(p); added++;
      }
    }
    let removed = 0;
    if ($('oe-wcatch')?.checked) { const n = rows.length; rows = rows.filter((r) => !isCatchAll(r.exten)); removed = n - rows.length; }
    redrawRows();
    const msg = [`${added} motif${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''}`, kept ? `${kept} déjà présent${kept > 1 ? 's' : ''} (gardés tels quels)` : '', removed ? 'attrape-tout retiré' : ''];
    // Autorisation « interdit-118 » : existante → cochée ; sinon créée (écriture immédiate, comme les créations de la palette).
    if ($('oe-w118').checked) {
      let p = find118();
      if (!p && canWrite()) {
        try {
          p = await api('POST', '/callpermissions', { name: 'interdit-118', mode: 'deny', enabled: true, extensions: [BLOCK_118], description: 'Renseignements 118 XXX surtaxés (assistant Call Flow Manager)' });
          (M.lists.callpermission ||= []).push(p); M.by.callpermission?.set(String(p.id), p);
          permBox().querySelector('.small.muted')?.remove();
          permBox().insertAdjacentHTML('beforeend', `<label class="inline"><input type="checkbox" data-perm="${p.id}"> ${esc(p.name)} <span class="small muted">(refus)</span></label>`);
          msg.push('autorisation « interdit-118 » créée dans Wazo');
        } catch (e) { msg.push(`autorisation « interdit-118 » non créée : ${e.message || e}`); }
      }
      const cb = p && box.querySelector(`[data-perm="${p.id}"]`); if (cb) { cb.checked = true; msg.push(`« ${p.name} » cochée`); }
    }
    recap();
    $('oe-wiz').hidden = true;
    $('oe-test-r').textContent = `Assistant : ${msg.filter(Boolean).join(' ; ')}. Vérifiez la liste puis « Ajouter au brouillon ».`;
  };
  box.onclick = (e) => {
    if (e.target.closest('[data-wizard]')) { const w = $('oe-wiz'); w.hidden = !w.hidden; if (!w.hidden) w.innerHTML = wizHtml(); return; }
    if (e.target.closest('[data-wclose]')) { $('oe-wiz').hidden = true; return; }
    if (e.target.closest('[data-wapply]')) { wizApply(); return; }
    // Nouveau groupe : un motif avec sa transformation (rejoint un groupe existant si la transformation est la même).
    if (e.target.closest('[data-ngadd]')) {
      const sd = $('oe-ng-strip').value.trim(); if (sd !== '' && !/^\d+$/.test(sd)) { $('oe-test-r').innerHTML = '<span class="cf-ge-dnd">Chiffres retirés : entier positif.</span>'; return; }
      if (addPattern($('oe-ng-exten').value, { strip_digits: Number(sd || 0), external_prefix: $('oe-ng-prefix').value.trim() })) { $('oe-ng-exten').value = ''; $('oe-ng-prefix').value = ''; $('oe-ng-strip').value = '0'; }
      return;
    }
    const gd = e.target.closest('[data-gdel]'); if (gd) { const ids = new Set(groupRows(gd).map((r) => r.rid)); rows = rows.filter((r) => !ids.has(r.rid)); redrawRows(); return; }
    const d = e.target.closest('[data-delrow]'); if (d) { rows = rows.filter((r) => r.rid !== d.dataset.delrow); redrawRows(); return; }
    const t = e.target.closest('[data-tup],[data-tdown],[data-tdel],[data-tadd]'); if (!t) return;
    if (t.dataset.tadd != null) { const id = Number($('oe-tadd').value); if (id) trunks.push(id); }
    const i = Number(t.dataset.tup ?? t.dataset.tdown ?? t.dataset.tdel);
    if (t.dataset.tup != null && i > 0) [trunks[i - 1], trunks[i]] = [trunks[i], trunks[i - 1]];
    if (t.dataset.tdown != null && i < trunks.length - 1) [trunks[i + 1], trunks[i]] = [trunks[i], trunks[i + 1]];
    if (t.dataset.tdel != null) trunks.splice(i, 1);
    redrawT();
  };
  recap();
}

export function outcallCfgDiff(a, b) {
  if (!a || !b) return '';
  const L = { name: 'nom', description: 'description', enabled: 'activée', ring_time: 'durée de sonnerie', internal_caller_id: 'numéro interne présenté', preprocess_subroutine: 'sous-routine' };
  const out = OUTCALL_FIELDS.filter((k) => JSON.stringify(a.fields[k] ?? null) !== JSON.stringify(b.fields[k] ?? null)).map((k) => L[k]);
  const pk = (l) => JSON.stringify((l || []).map((p) => DP.map((k) => p[k])));
  if (pk(a.patterns) !== pk(b.patterns)) out.push('motifs');
  if (JSON.stringify(a.trunks) !== JSON.stringify(b.trunks)) out.push('trunks');
  if (JSON.stringify(a.perms) !== JSON.stringify(b.perms)) out.push('autorisations');
  return out.join(', ');
}
