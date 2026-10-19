// Migration Assistant — vue « Import 3CX » (lot 4, première étape : analyse et
// fiche de reprise, sans écriture dans Wazo). Lecteur : threecx.js.
import { $, esc, toast, helpButton, helpBox, downloadJson } from '../common/core.js?v=0.40.10';
import { I } from './inventory.js?v=0.40.10';
import { parse3cx, issuesOf, schedulesOf, destText, periodsText, wazoUsersCsv, redacted, nameOf, STRATEGY, STRATEGY_FR, KIND_FR } from './threecx.js?v=0.40.10';

const X = { m: null, file: '', blfOffset: 1 };
const SEV_FR = { error: 'Erreur', warn: 'À vérifier', info: 'Info' };

export function initThreecx() {
  $('x3-file').onchange = (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { X.m = parse3cx(r.result); X.file = f.name; draw(); toast('Sauvegarde 3CX lue (dans le navigateur, rien n\'a été envoyé).'); }
      catch (err) { toast(`Lecture impossible : ${err.message}`, 8000); console.error('[astrea] 3CX', err); }
    };
    r.readAsText(f);
  };
}
// Rafraîchit la comparaison avec le tenant après une relecture de l'inventaire.
export function renderThreecx() { if (X.m) draw(); }

function table(head, rows, cls = '') {
  return `<div class="tablewrap x3-table ${cls}"><table class="diff"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">Aucun.</td></tr>`}</tbody></table></div>`;
}
const tr = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const sec = (id, title, body, help, count) => `<section class="x3-sec" id="x3-${id}"><div class="titlerow"><h3>${esc(title)}${count !== undefined ? ` <span class="muted">(${count})</span>` : ''}</h3>${help ? helpButton(`x3h-${id}`, `Aide : ${title}`) : ''}</div>${help ? helpBox(`x3h-${id}`, help) : ''}${body}</section>`;

function draw() {
  const m = X.m;
  const D = (d) => esc(destText(m, d));
  const name = (n) => { const t = m.dn.get(n); return t ? `${esc(n)} <span class="muted">${esc(t.name || '')}</span>` : `<span class="error">${esc(n)} ?</span>`; };
  const issues = issuesOf(m);
  // Comparaison avec le tenant Wazo actuel (connecté dans le portail).
  const wazoExt = new Map((I.lists.extension || []).filter((e) => (e.lines || []).length || e.group || e.queue).map((e) => [e.exten, e]));
  for (const e of m.extensions) if (wazoExt.has(e.number)) issues.push({ sev: 'warn', area: `Poste ${e.number}`, text: `le numéro existe déjà dans ce tenant Wazo (${wazoExt.get(e.number).context}).` });
  const scheds = schedulesOf(m);
  const schedName = (k) => scheds.find((s) => s.periods.map((x) => `${x.day}:${x.from}-${x.to}`).join('|') === k)?.name || 'toujours ouvert';
  const ext = m.extensions;
  const blfOk = (e) => e.blfs.filter((b) => b.type !== 'BLF' || m.dn.has(b.target));
  // Libellés hors du gabarit : deux accolades ouvrantes collées sont refusées par publish.ps1 (pas de .nojekyll).
  const FWD_L = { NoAnswer: 'pas de réponse', Busy: 'occupé', NotRegistered: 'non enregistré' };
  const fwdTxt = (e) => Object.entries(e.fwd).filter(([, d]) => d && typeof d === 'object').map(([k, d]) => `${FWD_L[k]} → ${D(d)}`).join('<br>') + (e.fwd.timeout ? `<div class="muted">sonnerie ${e.fwd.timeout} s</div>` : '');
  const ctxs = (I.lists.context || []);
  const opt = (type, pick) => ctxs.filter((c) => c.type === type).map((c, i) => `<option value="${esc(c.name)}" ${i === 0 ? 'selected' : ''}>${esc(c.label || c.name)} (${esc(c.name)})</option>`).join('') || `<option value="">${pick}</option>`;

  $('x3').innerHTML = `
    <div class="card mg-card wide x3-head">
      <div><strong>${esc(m.company || 'Sauvegarde 3CX')}</strong> · 3CX ${esc(m.version)} · sauvegarde du ${esc(m.date)} · ${esc(X.file)}</div>
      <div class="muted small">${ext.length} postes, ${m.ringGroups.length} groupes, ${m.queues.length} file(s), ${m.ivrs.filter((v) => !v.system).length} SVI, ${m.trunks.reduce((s, t) => s + t.dids.length, 0)} SDA, ${m.holidays.filter((h) => !h.past).length} fermeture(s) à venir ou récurrente(s), ${m.prompts.length} fichier(s) son.</div>
      <div class="btnrow noprint"><button id="x3-print">Imprimer la fiche</button><button id="x3-json">Fiche JSON (sans secrets)</button><button id="x3-blf">Touches BLF (CSV)</button></div>
    </div>
    ${sec('issues', 'Points à vérifier', table(['Gravité', 'Où', 'Quoi'], issues.sort((a, b) => ['error', 'warn', 'info'].indexOf(a.sev) - ['error', 'warn', 'info'].indexOf(b.sev)).map((x) => `<tr class="x3-${x.sev}"><td>${SEV_FR[x.sev]}</td><td>${esc(x.area)}</td><td>${esc(x.text)}</td></tr>`)), 'Incohérences de la configuration 3CX et conflits avec le tenant Wazo ouvert dans le portail. Les erreurs (destination vers un objet absent) sont à régler avant de recréer le routage.', issues.length)}
    ${sec('users', 'Utilisateurs', table(['N°', 'Nom', 'E-mail', 'Mobile', 'Messagerie', 'Appareil', 'BLF', 'Renvois (profil Disponible)'], ext.map((e) => tr([
      esc(e.number) + (e.enabled ? '' : ' <span class="muted">désactivé</span>'), (() => { const n = nameOf(e); return n.guessed ? `${esc(`${n.first} ${n.last}`)} <span class="muted" title="Nom déduit de l'e-mail ; dans 3CX : ${esc([e.first, e.last].filter(Boolean).join(' ') || 'vide')}">déduit</span>` : esc([e.first, e.last].filter(Boolean).join(' ')); })(), esc(e.email), esc(e.mobile), e.vm.enabled ? 'oui' : '<span class="muted">non</span>',
      e.devices.map((d) => `${esc(d.model)} <span class="muted">${esc(d.mac)}</span>`).join('<br>') || '<span class="muted">aucun</span>', `${blfOk(e).length}${blfOk(e).length !== e.blfs.length ? ` <span class="muted">/ ${e.blfs.length}</span>` : ''}`, fwdTxt(e) || '<span class="muted">aucun</span>',
    ]))), 'Wazo : un utilisateur, une ligne SIP et son numéro interne (repris tel quel, zéros en tête compris) ; messagerie si elle est active dans 3CX. Appareil : à déclarer par MAC (Phone Manager, reprise de parc) puis à associer à la ligne. Renvois du profil « Disponible » : dans Wazo, débordements de l\'utilisateur (pas de réponse, occupé, indisponible) et durée de sonnerie.', ext.length)}
    ${sec('groups', 'Groupes de sonnerie → groupes Wazo', table(['N°', 'Nom', 'Stratégie', 'Sonnerie', 'Membres', 'Sans réponse', 'Fermé / férié / pause'], m.ringGroups.map((g) => tr([
      esc(g.number), esc(g.name), `${esc(g.strategy)} → ${esc(STRATEGY_FR[STRATEGY[g.strategy]] || '?')}`, `${g.ringTime} s`, g.members.map(name).join('<br>'), D(g.dest), routesTxt(m, g.routes),
    ]))), 'Wazo : groupe d\'appel avec la même stratégie, durée de sonnerie = délai du groupe, « sans réponse » = débordement pas de réponse. Les routes fermé / férié / pause de 3CX deviennent un horaire associé au groupe, avec sa destination de fermeture.', m.ringGroups.length)}
    ${sec('queues', 'Files d\'attente', table(['N°', 'Nom', 'Stratégie', 'Temps', 'Membres', 'Sans réponse', 'Sons', 'Fermé / férié / pause'], m.queues.map((q) => tr([
      esc(q.number), esc(q.name), `${esc(q.strategy)} → ${esc(STRATEGY_FR[STRATEGY[q.strategy]] || '?')}`, `${q.ringTimeout} s par membre, ${q.masterTimeout} s au total`, q.members.map(name).join('<br>'), D(q.dest), [q.intro && `intro ${esc(q.intro)}`, q.onHold && `attente ${esc(q.onHold)}`].filter(Boolean).join('<br>'), routesTxt(m, q.routes),
    ]))), 'Wazo : file d\'attente ; temps total → délai de la file (débordement pas de réponse) ; son d\'attente → classe de musique d\'attente propre à la file. À 2 membres et en « Hunt », un groupe Wazo « un par un » peut suffire.', m.queues.length)}
    ${sec('ivr', 'SVI', table(['N°', 'Nom', 'Message', 'Touches', 'Sans saisie'], m.ivrs.filter((v) => !v.system).map((v) => tr([
      esc(v.number), esc(v.name), esc(v.prompt), v.choices.map((c) => `${esc(c.key)} → ${D(c)}`).join('<br>') || '<span class="muted">aucune (message seul)</span>', `${v.timeout} s → ${v.timeoutDest.to === 'EndCall' ? 'raccrocher' : D(v.timeoutDest)}`,
    ]))), 'Wazo : SVI avec le même message (à téléverser dans Sons) et les mêmes touches. Un SVI sans touche qui renvoie après 1 s (« prédécroché ») devient en général un son joué en pré-décroché sur la SDA, ou le message d\'accueil de la file.', m.ivrs.filter((v) => !v.system).length)}
    ${sec('dids', 'SDA et routage entrant', table(['SDA', 'Règle', 'Horaire', 'Ouvert', 'Fermé', 'Férié'], m.inbound.map((r) => tr([
      esc(r.did || 'par défaut'), esc(r.name), esc(schedName(r.scheduleKey)), D(r.open), D(r.closed), D(r.holiday),
    ]))), 'Wazo : une SDA par numéro, vers la destination « ouvert », avec l\'horaire associé (destination de fermeture = « fermé » ; fermetures exceptionnelles = jours fériés, vers la destination « férié »). Les SDA directes vers un poste peuvent aussi être créées par le CSV d\'import des utilisateurs.', m.inbound.length)}
    ${sec('sched', 'Horaires à créer', scheds.map((s) => `<p><strong>${esc(s.name)}</strong> : ${esc(s.text)} <span class="muted">(${s.users.length} SDA)</span></p>`).join('') + `<p class="small"><strong>Fermetures exceptionnelles</strong> (à ajouter à chaque horaire) : ${m.holidays.filter((h) => !h.past).map((h) => `${esc(h.name)} (${h.day}/${h.month}${h.recurrent ? ', tous les ans' : `/${h.year}`}${h.from !== '00:00' || h.to !== '23:59' ? `, ${h.from}-${h.to}` : ''})`).join(' ; ') || 'aucune'}.</p><p class="small muted">Heures de la société (groupe 3CX par défaut) : ${esc(periodsText(m.defaultGroup?.hours.periods || []))} ; pause : ${esc(periodsText(m.defaultGroup?.breakTime.periods || []))}. Les jours fériés légaux français autres que le 14 juillet ne sont pas dans la sauvegarde.</p>`, 'Horaires Wazo déduits des règles 3CX : heures de bureau moins la pause pour les règles « heures de bureau », plages propres pour les autres. Un horaire par jeu de plages distinct.', scheds.length)}
    ${sec('trunk', 'Trunk et appels sortants', table(['Trunk', 'Serveurs', 'Numéro principal', 'Numéro présenté', 'Canaux', 'Codecs', 'SDA'], m.trunks.map((t) => tr([
      esc(t.name), `${esc(t.host)}${t.proxy ? `<br><span class="muted">proxy ${esc(t.proxy)}</span>` : ''}`, esc(t.mainNumber), esc(t.callerId), t.channels, esc(t.codecs.join(', ')), `${t.dids.length}<div class="muted small x3-dids">${esc(t.dids.join(', '))}</div>`,
    ]))) + `<p class="small">Règles sortantes 3CX : ${m.outbound.map((o) => `${esc(o.name)} (${o.routes.map((r) => esc(r.gateway)).join(', ')}${o.prefix ? `, préfixe ${esc(o.prefix)}` : ''})`).join(' ; ') || 'aucune'}. Identifiants SIP du trunk : dans la sauvegarde (non affichés), à reprendre de l'espace opérateur de préférence.</p>`, 'Wazo : interconnexion créée depuis le portail avec le modèle de l\'opérateur (serveur eqinoxe = Unyc), puis règle sortante vers ce trunk et numéro présenté. Les SDA sont celles déclarées sur la ligne 3CX.', m.trunks.length)}
    ${sec('sounds', 'Fichiers sons à récupérer', `<p class="small">À copier depuis le serveur 3CX (dossier <code>/var/lib/3cxpbx/Instance1/Data/Ivr/Prompts/</code>) puis à téléverser dans Wazo (Sons, ou Musiques d'attente pour ${esc(m.moh || 'la musique')}).</p><ul class="mg-list small x3-cols">${m.prompts.map((p) => `<li>${esc(p)}${p === m.moh ? ' <span class="muted">(musique d\'attente)</span>' : ''}</li>`).join('')}</ul>`, null, m.prompts.length)}
    ${sec('blf', 'Touches BLF', `<label class="inline noprint">Position Wazo = position 3CX + <input type="number" id="x3-off" min="0" max="5" value="${X.blfOffset}" class="short"> <span class="muted small">(supposé : 1, la touche 1 restant la ligne ; à vérifier sur un poste avant de déployer)</span></label>` + table(['Poste', 'Touches reprises', 'Non reprises'], ext.filter((e) => e.blfs.length).map((e) => tr([
      name(e.number), blfOk(e).map((b) => `${b.pos + X.blfOffset}:${b.type === 'SharedParking' ? 'parking' : esc(b.target)}`).join(' '), e.blfs.filter((b) => !blfOk(e).includes(b)).map((b) => esc(b.target)).join(' ') || '—',
    ]))), 'Touches de supervision des postes 3CX. Wazo : touches de fonction de l\'utilisateur (BLF Manager), type « supervision » vers l\'utilisateur cible ; « parking partagé » → touche parking. Le CSV donne poste, position Wazo, type et cible.')}
    ${sec('other', 'Autres éléments', `<p class="small">Parkings : ${m.parks.length} emplacement(s) (${esc(m.parks.map((p) => p.number).join(', '))}) → un parking Wazo. ${m.others.map((o) => `${esc(KIND_FR[o.kind] || o.kind)} ${esc(o.number)}${o.name ? ` (${esc(o.name)})` : ''}`).join(' ; ')}. Annuaire partagé : ${m.phonebook.length} contact(s) → annuaire Wazo (à saisir).</p>`)}
    <div class="card mg-card wide noprint">
      <div class="titlerow"><h3>CSV d'import des utilisateurs Wazo</h3>${helpButton('x3h-csv', 'Aide : CSV')}</div>
      ${helpBox('x3h-csv', 'Fichier au format de l\'import d\'utilisateurs de Wazo (colonnes lues dans wazo-confd, user_import) : prénom, nom, e-mail, mobile, ligne SIP et numéro dans le contexte interne choisi, messagerie si active dans 3CX, SDA directe quand une règle 3CX envoie une SDA vers ce poste en heures d\'ouverture. Les contextes proposés sont ceux du tenant ouvert dans le portail. Rien n\'est envoyé à Wazo depuis cette page : le fichier est à importer (portail ou API).')}
      <div class="ms-tools"><label>Contexte interne <select id="x3-ctx">${opt('internal', 'aucun contexte interne lu')}</select></label><label>Contexte entrant <select id="x3-inctx">${opt('incall', 'aucun contexte entrant lu')}</select></label></div>
      <label class="inline"><input type="checkbox" id="x3-dids" checked> Créer les SDA directes vers les postes</label>
      <label class="inline"><input type="checkbox" id="x3-pin"> Reprendre les codes de messagerie de 3CX</label>
      <label class="inline"><input type="checkbox" id="x3-guess" checked> Noms déduits de l'e-mail quand 3CX n'a que des initiales</label>
      <label class="inline"><input type="checkbox" id="x3-nodev" checked> Ignorer les postes sans appareil (répondeurs, administrateur)</label>
      <div class="btnrow"><button id="x3-csv" class="primary">Télécharger le CSV</button></div>
    </div>`;
  bind();
}
function routesTxt(m, r) {
  const parts = [];
  for (const [k, l] of [['closed', 'fermé'], ['holiday', 'férié'], ['break', 'pause']]) if (r[k]) parts.push(`${l} → ${esc(destText(m, r[k]))}${r[k].prompt ? ` <span class="muted">(${esc(r[k].prompt)})</span>` : ''}`);
  return parts.join('<br>') || '<span class="muted">toujours ouvert</span>';
}
function download(name, text, type) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { toast(`Téléchargement impossible : ${e.message}`); }
}
const base = () => (X.file || '3cx').replace(/\.xml$/i, '');
function bind() {
  const m = X.m;
  $('x3-print').onclick = () => window.print();
  $('x3-json').onclick = () => downloadJson(`astrea-3cx-${base()}.json`, { format: 'astrea-3cx-analysis', version: 1, source: X.file, analysed_at: new Date().toISOString(), model: redacted(m), issues: issuesOf(m), schedules: schedulesOf(m) });
  $('x3-blf').onclick = () => {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['poste', 'nom', 'position_3cx', 'position_wazo', 'type', 'cible', 'cible_nom', 'reprise'].join(';')];
    for (const e of m.extensions) for (const b of e.blfs) {
      const ok = b.type !== 'BLF' || m.dn.has(b.target);
      rows.push([e.number, [e.first, e.last].filter(Boolean).join(' '), b.pos, b.pos + X.blfOffset, b.type === 'SharedParking' ? 'parking' : 'supervision', b.target, m.dn.get(b.target)?.name || '', ok ? 'oui' : 'non (cible absente)'].map(q).join(';'));
    }
    download(`astrea-3cx-blf-${base()}.csv`, '﻿' + rows.join('\r\n'), 'text/csv;charset=utf-8');
  };
  $('x3-off').onchange = (e) => { X.blfOffset = Math.max(0, Math.min(5, Number(e.target.value) || 0)); draw(); document.getElementById('x3-blf')?.scrollIntoView(); };
  $('x3-csv').onclick = () => {
    const ctx = $('x3-ctx').value; const incallCtx = $('x3-inctx').value;
    if (!ctx) return toast('Choisissez le contexte interne (tenant Wazo à ouvrir dans le portail).', 6000);
    if ($('x3-dids').checked && !incallCtx) return toast('Aucun contexte entrant : décochez les SDA directes, ou ouvrez le bon tenant.', 6000);
    download(`wazo-import-utilisateurs-${base()}.csv`, wazoUsersCsv(m, { ctx, incallCtx, vmPin: $('x3-pin').checked, withDids: $('x3-dids').checked, guessNames: $('x3-guess').checked, skipNoDevice: $('x3-nodev').checked }), 'text/csv;charset=utf-8');
  };
}
