// Migration Assistant — vue « Import 3CX » (lot 4) : fiche de reprise (état de
// la sauvegarde 3CX) et brouillon d'import modifiable par onglets (3cx-edit.js),
// source des exports. Aucune écriture dans Wazo. Lecteur : 3cx.js ; brouillon : 3cx-draft.js.
import { $, esc, toast, helpButton, helpBox, downloadJson } from '../common/core.js?v=0.40.13';
import { I } from './inventory.js?v=0.40.13';
import { parse3cx, issuesOf, schedulesOf, destText, periodsText, redacted, nameOf, STRATEGY, STRATEGY_FR, KIND_FR } from './3cx.js?v=0.40.13';
import { buildDraft, buildDevices, loadDraft, saveDraft, blfRows } from './3cx-draft.js?v=0.40.13';
import { TABS, setDraft, renderTab, tabCounts, onDraftChange, draft } from './3cx-edit.js?v=0.40.13';

const X = { m: null, file: '', tab: 'fiche' };
const SEV_FR = { error: 'Erreur', warn: 'À vérifier', info: 'Info' };

export function init3cx() {
  $('x3-file').onchange = (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        X.m = parse3cx(r.result); X.file = f.name;
        // Brouillon déjà commencé pour cette sauvegarde (même nom, même date) : repris.
        const saved = loadDraft(f.name, X.m.date);
        // Brouillon d'avant l'onglet Appareils : appareils ajoutés depuis la sauvegarde.
        if (saved && !saved.devices) saved.devices = buildDevices(X.m, saved.users);
        const d = saved || buildDraft(X.m, f.name);
        saveDraft(d);
        setDraft(d, X.m, f.name, () => {});
        draw();
        toast(saved ? 'Sauvegarde 3CX lue ; brouillon repris là où vous l\'aviez laissé.' : 'Sauvegarde 3CX lue (dans le navigateur, rien n\'a été envoyé) ; brouillon créé.', 5000);
      } catch (err) { toast(`Lecture impossible : ${err.message}`, 8000); console.error('[astrea] 3CX', err); }
    };
    r.readAsText(f);
  };
  onDraftChange(() => drawTabs());
}
// Rafraîchit la comparaison avec le tenant après une relecture de l'inventaire.
export function render3cx() { if (X.m) draw(); }

function draw() {
  const m = X.m;
  $('x3').innerHTML = `
    <div class="card mg-card wide x3-head">
      <div><strong>${esc(m.company || 'Sauvegarde 3CX')}</strong> · 3CX ${esc(m.version)} · sauvegarde du ${esc(m.date)} · ${esc(X.file)}</div>
      <div class="muted small">${m.extensions.length} postes, ${m.ringGroups.length} groupes, ${m.queues.length} file(s), ${m.ivrs.filter((v) => !v.system).length} SVI, ${m.trunks.reduce((s, t) => s + t.dids.length, 0)} SDA, ${m.holidays.filter((h) => !h.past).length} fermeture(s) à venir ou récurrente(s), ${m.prompts.length} fichier(s) son.</div>
    </div>
    <nav class="x3-tabs noprint" id="x3-tabs"></nav>
    <div id="x3-body"></div>`;
  $('x3-tabs').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) { X.tab = b.dataset.tab; drawTabs(); drawBody(); } };
  drawTabs();
  drawBody();
}
function drawTabs() {
  const c = tabCounts();
  $('x3-tabs').innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === X.tab ? 'active' : ''}">${esc(l)}${c[k] !== undefined ? ` <span class="mg-count${k === 'checks' && c[k] ? ' s-warn' : ''}">${c[k]}</span>` : ''}</button>`).join('');
}
function drawBody() {
  if (X.tab === 'fiche') { $('x3-body').innerHTML = ficheHtml(); bindFiche(); } else renderTab($('x3-body'), X.tab);
}

function table(head, rows, cls = '') {
  return `<div class="tablewrap x3-table ${cls}"><table class="diff"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">Aucun.</td></tr>`}</tbody></table></div>`;
}
const tr = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const sec = (id, title, body, help, count) => `<section class="x3-sec" id="x3-${id}"><div class="titlerow"><h3>${esc(title)}${count !== undefined ? ` <span class="muted">(${count})</span>` : ''}</h3>${help ? helpButton(`x3h-${id}`, `Aide : ${title}`) : ''}</div>${help ? helpBox(`x3h-${id}`, help) : ''}${body}</section>`;

function ficheHtml() {
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
  // Touches : reprise selon le brouillon (postes et cibles repris).
  const d = draft();
  const rows = blfRows(d, m);
  const blfOk = (e) => rows.filter((b) => b.owner === e.number && b.ok);
  const blfKo = (e) => rows.filter((b) => b.owner === e.number && !b.ok);
  const off = d.blfOffset ?? 1;
  // Libellés hors du gabarit : deux accolades ouvrantes collées sont refusées par publish.ps1 (pas de .nojekyll).
  const FWD_L = { NoAnswer: 'pas de réponse', Busy: 'occupé', NotRegistered: 'non enregistré' };
  const fwdTxt = (e) => Object.entries(e.fwd).filter(([, d]) => d && typeof d === 'object').map(([k, d]) => `${FWD_L[k]} → ${D(d)}`).join('<br>') + (e.fwd.timeout ? `<div class="muted">sonnerie ${e.fwd.timeout} s</div>` : '');
  return `
    <div class="btnrow noprint x3-fiche-bar"><span class="muted small">Fiche = sauvegarde 3CX telle quelle. Les exports se font depuis le brouillon (onglet Exports).</span><span class="spacer"></span><button id="x3-print">Imprimer la fiche</button><button id="x3-json">Fiche JSON (sans secrets)</button></div>
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
      esc(t.name), `${esc(t.host)}${t.proxy ? `<br><span class="muted">proxy ${esc(t.proxy)}</span>` : ''}`, esc(t.mainNumber), esc(t.callerId), t.channels, esc(t.codecs.join(', ')), t.dids.length,
    ]))) + m.trunks.map((t) => `<p class="small x3-dids"><strong>SDA ${esc(t.name)}</strong> : ${esc(t.dids.join(', '))}</p>`).join('') + `<p class="small">Règles sortantes 3CX : ${m.outbound.map((o) => `${esc(o.name)} (${o.routes.map((r) => esc(r.gateway)).join(', ')}${o.prefix ? `, préfixe ${esc(o.prefix)}` : ''})`).join(' ; ') || 'aucune'}. Identifiants SIP du trunk : dans la sauvegarde (non affichés), à reprendre de l'espace opérateur de préférence.</p>`, 'Wazo : interconnexion créée depuis le portail avec le modèle de l\'opérateur (serveur eqinoxe = Unyc), puis règle sortante vers ce trunk et numéro présenté. Les SDA sont celles déclarées sur la ligne 3CX.', m.trunks.length)}
    ${sec('sounds', 'Fichiers sons à récupérer', `<p class="small">À copier depuis le serveur 3CX (dossier <code>/var/lib/3cxpbx/Instance1/Data/Ivr/Prompts/</code>) puis à téléverser dans Wazo (Sons, ou Musiques d'attente pour ${esc(m.moh || 'la musique')}).</p><ul class="mg-list small x3-cols">${m.prompts.map((p) => `<li>${esc(p)}${p === m.moh ? ' <span class="muted">(musique d\'attente)</span>' : ''}</li>`).join('')}</ul>`, null, m.prompts.length)}
    ${sec('blf', 'Touches BLF', `<p class="small muted">Position Wazo = position 3CX + ${off} (réglable dans l'onglet Exports ; supposé, à vérifier sur un poste). Reprise selon le brouillon.</p>` + table(['Poste', 'Touches reprises', 'Non reprises'], ext.filter((e) => e.blfs.length).map((e) => tr([
      name(e.number), blfOk(e).map((b) => `${b.wpos}:${b.type === 'parking' ? 'parking' : esc(b.target)}`).join(' ') || '<span class="muted">aucune</span>',
      blfKo(e).some((b) => b.status === 'non (poste non repris)') ? '<span class="muted">poste non repris</span>' : blfKo(e).map((b) => `${esc(b.target)} <span class="muted">${esc(b.status.replace(/^non \((.*)\)$/, '$1'))}</span>`).join(', ') || '—',
    ]))), 'Touches de supervision des postes 3CX. Wazo : touches de fonction de l\'utilisateur (BLF Manager), type « supervision » vers l\'utilisateur cible ; « parking partagé » → touche parking. Non reprises : cible absente de la sauvegarde, cible ou poste non repris (mêmes règles que le CSV d\'import), doublon sur le même poste. Le CSV donne poste, position Wazo, type, cible et reprise.')}
    ${sec('other', 'Autres éléments', `<p class="small">Parkings : ${m.parks.length} emplacement(s) (${esc(m.parks.map((p) => p.number).join(', '))}) → un parking Wazo. ${m.others.map((o) => `${esc(KIND_FR[o.kind] || o.kind)} ${esc(o.number)}${o.name ? ` (${esc(o.name)})` : ''}`).join(' ; ')}. Annuaire partagé : ${m.phonebook.length} contact(s) → annuaire Wazo (à saisir).</p>`)}`;
}
function routesTxt(m, r) {
  const parts = [];
  for (const [k, l] of [['closed', 'fermé'], ['holiday', 'férié'], ['break', 'pause']]) if (r[k]) parts.push(`${l} → ${esc(destText(m, r[k]))}${r[k].prompt ? ` <span class="muted">(${esc(r[k].prompt)})</span>` : ''}`);
  return parts.join('<br>') || '<span class="muted">toujours ouvert</span>';
}
const base = () => (X.file || '3cx').replace(/\.xml$/i, '');
function bindFiche() {
  const m = X.m;
  $('x3-print').onclick = () => window.print();
  $('x3-json').onclick = () => downloadJson(`astrea-3cx-${base()}.json`, { format: 'astrea-3cx-analysis', version: 1, source: X.file, analysed_at: new Date().toISOString(), model: redacted(m), issues: issuesOf(m), schedules: schedulesOf(m) });
}
