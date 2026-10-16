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
import { $, esc, confirmModal, helpButton, helpBox } from '../common/core.js?v=0.39.0';
import { M, listOf, nodeInfo } from './model.js?v=0.39.0';
import { sec, field, check, setSums, openSec } from './ed-ui.js?v=0.39.0';
import { describePattern, comparePatterns, dialedNumber } from './dialsim.js?v=0.39.0';

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

// onSave({ cfg, schedule })
export function openOutcallEditor(o, onSave) {
  const v = outcallCfgOf(o); const f = v.fields;
  let seq = 0;
  let rows = v.patterns.map((p) => ({ ...p, rid: `p${seq++}` }));
  let trunks = [...v.trunks];
  const outCtx = rows[0]?.context || (M.lists.context || []).find((c) => c.type === 'outcall')?.name || '';
  const sched = (o.schedules || [])[0]?.id;
  const rowHtml = (r) => `<li class="cf-oe-pat" data-row="${r.rid}">
    <div class="cf-ge-row"><input data-p="exten" value="${esc(r.exten)}" placeholder="_0XXXXXXXXX" spellcheck="false"><span class="small muted cf-oe-desc" data-desc="${r.rid}">${esc(describePattern(r.exten))}</span><button class="icon" data-delrow="${r.rid}" title="Retirer ce motif">×</button></div>
    <div class="cf-ge-3">
      ${field('Retirer en tête', `<input type="number" min="0" step="1" data-p="strip_digits" value="${esc(r.strip_digits)}">`, 'chiffres')}
      ${field('Ajouter devant', `<input data-p="external_prefix" value="${esc(r.external_prefix)}" placeholder="rien">`, 'avant l\'envoi au trunk')}
      ${field('Numéro présenté', `<input data-p="caller_id" value="${esc(r.caller_id)}" placeholder="celui de l'appelant">`)}
    </div>
    <div class="small muted" data-ex="${r.rid}"></div></li>`;
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
    ${sec('pat', 'Motifs de numéros', `<ul class="cf-ge-list cf-oe-list" id="oe-rows">${rows.map(rowHtml).join('')}</ul>
      <div class="btnrow"><button type="button" data-addrow>Ajouter un motif</button></div>`, { open: true, help: 'Règles d\'Asterisk : « _ » en tête = motif ; X = un chiffre 0-9, Z = 1-9, N = 2-9, [1-5] = un chiffre parmi, « . » = un ou plusieurs caractères. Ex. _0[1-5]XXXXXXXX = fixe, _0[67]XXXXXXXX = mobile, _00. = international. Quand plusieurs motifs correspondent, Asterisk prend le plus précis (vérifié dans son code). Le numéro envoyé = numéro composé, moins les chiffres retirés, avec le préfixe ajouté devant (vérifié dans wazo-agid).' })}
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
      const li = box.querySelector(`[data-row="${r.rid}"]`); const g = (k) => li.querySelector(`[data-p="${k}"]`).value.trim();
      const exten = g('exten');
      if (!/^_?[0-9*#+XZNxzn.!\[\]-]+$/.test(exten)) return err(`Motif « ${exten} » : chiffres, X Z N, [..], « . », « ! », avec « _ » en tête pour un motif.`, 'pat');
      if (seen.has(exten)) return err(`Le motif ${exten} apparaît deux fois.`, 'pat'); seen.add(exten);
      const sd = g('strip_digits'); if (sd !== '' && !/^\d+$/.test(sd)) return err('Chiffres retirés : entier positif.', 'pat');
      // Vérifié (outcall_extension/resource.py) : chiffres, * et #, « + » possible en tête ; 64 caractères max.
      const xp = g('external_prefix'); if (xp && (!/^\+?[0-9#*]*$/.test(xp) || xp.length > 64)) return err(`Préfixe ajouté « ${xp} » : chiffres, * et #, avec « + » possible en tête.`, 'pat');
      patterns.push({ id: r.id, exten, context: r.context || outCtx, strip_digits: Number(sd || 0), external_prefix: g('external_prefix'), prefix: r.prefix || '', caller_id: g('caller_id') });
    }
    if (patterns.some((p) => !p.context)) return err('Aucun contexte « sortant » trouvé pour un nouveau motif.', 'pat');
    const perms = [...box.querySelectorAll('[data-perm]:checked')].map((c) => Number(c.dataset.perm)).sort((a, b) => a - b);
    const s = $('oe-sched').value;
    onSave({ cfg: { fields: nf, patterns: patterns.sort((a, b) => comparePatterns(a.exten, b.exten)), trunks: [...trunks], perms }, schedule: s ? Number(s) : null });
    return true;
  }, 'Ajouter au brouillon');

  const box = $('modal-body');
  // Exemple de transformation sous chaque motif.
  const example = (p) => { const t = p.replace(/^_/, '').replace(/\[([^\]]*)\]/g, (m, x) => x[0]).replace(/[XxZzNn]/g, (c) => ({ x: '1', z: '1', n: '2' }[c.toLowerCase()])).replace(/[.!]/g, '123'); return t; };
  const recap = () => {
    for (const r of rows) {
      const li = box.querySelector(`[data-row="${r.rid}"]`); if (!li) continue;
      const g = (k) => li.querySelector(`[data-p="${k}"]`).value.trim();
      const ex = example(g('exten'));
      box.querySelector(`[data-desc="${r.rid}"]`).textContent = describePattern(g('exten'));
      box.querySelector(`[data-ex="${r.rid}"]`).textContent = ex ? `Ex. composé ${ex} → envoyé ${dialedNumber(ex, { strip_digits: Number(g('strip_digits') || 0), external_prefix: g('external_prefix') })}${g('caller_id') ? `, présenté ${g('caller_id')}` : ''}` : '';
    }
    setSums(box, {
      gen: [box.querySelector('[data-f="name"]').value.trim(), $('oe-en').checked ? '' : 'DÉSACTIVÉE'],
      pat: [`${rows.length} motif${rows.length > 1 ? 's' : ''}`],
      trk: [trunks.length ? trunks.map(trunkName).join(' puis ') : 'aucun trunk'],
      sch: [$('oe-sched').value ? $('oe-sched').selectedOptions[0].text : 'aucun'],
      perm: [`${box.querySelectorAll('[data-perm]:checked').length || 'aucune'}`],
      adv: [box.querySelector('[data-f="preprocess_subroutine"]').value.trim()],
    });
  };
  const redrawT = () => { $('oe-trunks').innerHTML = trunkRows(); $('oe-tadd').innerHTML = addT(); recap(); };
  box.addEventListener('input', () => { $('oe-err').textContent = ''; recap(); });
  box.addEventListener('change', recap);
  box.onclick = (e) => {
    if (e.target.closest('[data-addrow]')) { const r = { id: null, rid: `p${seq++}`, exten: '_0XXXXXXXXX', context: outCtx, strip_digits: 0, external_prefix: '', prefix: '', caller_id: '' }; rows.push(r); $('oe-rows').insertAdjacentHTML('beforeend', rowHtml(r)); recap(); return; }
    const d = e.target.closest('[data-delrow]'); if (d) { rows = rows.filter((r) => r.rid !== d.dataset.delrow); box.querySelector(`[data-row="${d.dataset.delrow}"]`)?.remove(); recap(); return; }
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
