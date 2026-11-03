// Astrea Desk — Sons & Musiques (0.7.0) : sons du tenant, musiques d'attente,
// tons d'enregistrement. Pages du Portal (section soundsAndGreetings, code lu le
// 02/11/2026) : pbx.sounds, pbx.moh, pbx.recordings ; pbx.sound-files-system
// (sons Asterisk du serveur, multiTenant false) n'est pas repris.
// Routes lues dans wazo-confd master le 02/11/2026 :
//  - sons : GET /sounds (catégories ; « system » = sons du serveur, écartée),
//    GET /sounds/{cat} (files[{name, formats[{format, language, path}]}]),
//    POST /sounds {name} (nouvelle catégorie),
//    GET|PUT|DELETE /sounds/{cat}/files/{nom}?format=&language= ; PUT : corps
//    brut (request.data) ; format « slin » = .wav (SoundFormat.extension_map) ;
//  - musiques : GET|POST /moh, PUT|DELETE /moh/{uuid} (label ≤ 128, mode
//    custom | files | mp3, sort alphabetical | random | random_start),
//    GET|PUT|DELETE /moh/{uuid}/files/{nom} (corps brut) ;
//  - tons d'enregistrement : GET|PUT /recordings/announcements
//    {recording_start, recording_stop} (Wazo ≥ 25.04 ; valeur = chemin d'un son,
//    SUPPOSÉ comme pour les autres champs « son » de confd).
// Tout fichier audio envoyé est converti en WAV 8 kHz 16 bits mono (toWav8k
// de Call Flow), le format attendu par Wazo ; sauf une musique en mode mp3.
import { S, $, esc, toast, api, listAll, confirmModal, canWrite } from '../admin-tools/common/core.js?v=0.9.5';
import { toWav8k, moTxt } from './cf/sound-play.js?v=0.9.5';

// Format audio et préparation des fichiers (demande de Brice, 02/11/2026) :
// format exact, lien vers g711.org et pas-à-pas. Desk convertit de toute façon
// (toWav8k) ; g711.org sert à régler le volume et la qualité téléphonique.
const G711 = 'https://g711.org/';
const audioHelp = (open = false) => `<div class="dk-audio">
  <p>Format : <strong>WAV 8 kHz, 16 bits, mono</strong>. Les autres fichiers audio (mp3, m4a…) sont convertis automatiquement. Pour un son plus clair au téléphone : <a href="${G711}" target="_blank" rel="noopener">g711.org ↗</a> <button type="button" class="dk-link-sm" data-copy="${G711}">Copier l'adresse</button></p>
  <details${open ? ' open' : ''}><summary>Comment préparer un fichier avec g711.org</summary><ol>
    <li>Ouvrez <a href="${G711}" target="_blank" rel="noopener">g711.org ↗</a>.</li>
    <li><strong>Source File</strong> : cliquez sur <em>Browse</em> et choisissez votre fichier (mp3, wav, m4a… jusqu'à 50 Mo).</li>
    <li><strong>Output Format</strong> : cochez <em>Standard Definition 16-bit WAV (8Khz, Mono, 16-Bit PCM)</em>.</li>
    <li><strong>Volume</strong> : <em>Medium</em> ; <em>High</em> si l'enregistrement est faible.</li>
    <li>Facultatif : cochez <em>Optimize Audio for Phone (Bandpass Filter)</em> pour une voix plus nette au téléphone.</li>
    <li>Cliquez sur <em>Submit</em>, téléchargez le fichier obtenu, puis ajoutez-le ici.</li>
  </ol></details></div>`;
// « Copier l'adresse » : presse-papiers, sinon l'adresse est affichée pour une copie à la main.
document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('[data-copy]'); if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); toast(`Adresse copiée : ${b.dataset.copy}`); }
  catch { toast(`Copiez cette adresse dans votre navigateur : ${b.dataset.copy}`, 10000); }
});
const head = (title, site, sub, extra = '') => `<div class="phonehead"><div><h2>${esc(title)}</h2><div class="muted small">${esc(site.name)}${sub ? ` · ${esc(sub)}` : ''}</div></div>${extra}</div>`;
const LANGS = [['fr_FR', 'Français'], ['en_US', 'Anglais'], ['', 'Sans langue']];
const FMT = { slin: 'wav', wav: 'wav', ulaw: 'ulaw', alaw: 'alaw', gsm: 'gsm', mp3: 'mp3', g722: 'g722' };
const safeName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);

// ---------------------------------------------------------------------------
// Fichiers audio : lecture (avec le token, donc par fetch) et envoi
// ---------------------------------------------------------------------------
async function raw(method, path, body, type = 'application/octet-stream') {
  if (S.readonly && method !== 'GET') throw new Error(`Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, 'Wazo-Tenant': S.tenant };
  if (body !== undefined) headers['Content-Type'] = type;
  const r = await fetch(`${S.base}/api/confd/1.1${path}`, { method, headers, body });
  // Client final : phrase simple à l'écran, réponse brute en console.
  if (!r.ok) {
    let m = ''; try { m = JSON.stringify(await r.json()).slice(0, 200); } catch { /* */ }
    console.warn('[astrea] sons', method, path, r.status, m);
    throw new Error(r.status === 400 ? 'fichier refusé par le serveur' : r.status === 403 ? "votre compte n'a pas le droit de faire cette action" : r.status === 404 ? 'introuvable, actualisez la page' : r.status === 413 ? 'fichier trop gros' : 'serveur indisponible pour le moment');
  }
  return r;
}
// G.711 → PCM 16 bits (formules ITU-T), puis WAV 8 kHz mono pour le navigateur.
const ulaw = (u) => { u = ~u & 0xff; const s = u & 0x80, e = (u >> 4) & 7, m = u & 0x0f; let x = ((m << 3) + 0x84) << e; x -= 0x84; return s ? -x : x; };
const alaw = (a) => { a ^= 0x55; let t = (a & 0x0f) << 4; const seg = (a & 0x70) >> 4; if (seg === 0) t += 8; else if (seg === 1) t += 0x108; else { t += 0x108; t <<= seg - 1; } return a & 0x80 ? t : -t; };
function g711ToWav(buf, dec) {
  const n = buf.length, out = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 8000, true); out.setUint32(28, 16000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, dec(buf[i]), true);
  return new Blob([out.buffer], { type: 'audio/wav' });
}
// Bouton de lecture : icône ▶ / ■ (demande de Brice, 02/11/2026), une seule piste à la fois.
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>',
  wait: '<svg viewBox="0 0 24 24" aria-hidden="true" class="dk-spin"><path d="M12 4a8 8 0 1 0 8 8h-2.5A5.5 5.5 0 1 1 12 6.5z"/></svg>',
};
const playBtn = (attr) => `<button type="button" class="dk-play" ${attr} title="Écouter" aria-label="Écouter">${ICON.play}</button>`;
const setBtn = (btn, s) => { btn.innerHTML = ICON[s]; btn.classList.toggle('on', s !== 'play'); btn.title = s === 'stop' ? 'Arrêter' : 'Écouter'; btn.setAttribute('aria-label', btn.title); };
let player = null, playingBtn = null;
function stop() { if (player) { player.pause(); URL.revokeObjectURL(player.src); } player = null; if (playingBtn) setBtn(playingBtn, 'play'); playingBtn = null; }
// Changement de page (app.js go) : le son s'arrête avec elle (retour de Brice,
// 02/11/2026 : il continuait, et le bouton revenu affichait « Écouter »).
export const stopAudio = stop;
async function play(btn, path, format) {
  if (playingBtn === btn) { stop(); return; }
  stop();
  setBtn(btn, 'wait'); playingBtn = btn;
  try {
    let blob = await (await raw('GET', path)).blob();
    if (format === 'ulaw' || format === 'alaw') blob = g711ToWav(new Uint8Array(await blob.arrayBuffer()), format === 'ulaw' ? ulaw : alaw);
    // Autre piste demandée, ou page quittée, pendant le téléchargement : on ne lit pas.
    if (playingBtn !== btn || !btn.isConnected) { if (playingBtn === btn) stop(); return; }
    player = new Audio(URL.createObjectURL(blob));
    setBtn(btn, 'stop');
    player.onended = stop;
    player.ontimeupdate = () => { if (!btn.isConnected) stop(); }; // filet : bouton retiré de la page
    await player.play();
  } catch (e) { if (playingBtn === btn) stop(); setBtn(btn, 'play'); toast(`Lecture impossible : ${e.message}`, 6000); }
}
const playable = (fmt) => ['slin', 'wav', 'ulaw', 'alaw', 'mp3', 'ogg'].includes(fmt);

// Choix d'un fichier audio, conversion, puis envoi.
function pickFile(accept = 'audio/*') {
  return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files?.[0] || null); i.click(); });
}

// ---------------------------------------------------------------------------
// Sons
// ---------------------------------------------------------------------------
export async function renderSounds(view, site) {
  view.innerHTML = head('Sons', site) + '<p class="dk-empty">Lecture…</p>';
  let cats = [];
  const load = async () => {
    const list = (await listAll('/sounds')).filter((c) => c.name !== 'system');
    cats = await Promise.all(list.map(async (c) => { try { return await api('GET', `/sounds/${encodeURIComponent(c.name)}`); } catch { return { ...c, files: [] }; } }));
  };
  const ro = !!S.readonly;
  const draw = () => {
    view.innerHTML = head('Sons', site, 'messages d\'accueil, annonces, sons des SVI', ro ? '' : '<div class="btnrow"><button id="sd-newcat">Nouvelle catégorie</button></div>')
      + audioHelp()
      + (cats.length ? cats.sort((a, b) => a.name.localeCompare(b.name, 'fr')).map((c) => `<section class="dk-panel"><div class="dk-panhead"><h3>${esc(c.name)} <span class="muted small">${(c.files || []).length} fichier${(c.files || []).length > 1 ? 's' : ''}</span></h3>${ro ? '' : `<button class="dk-text" data-add="${esc(c.name)}">Ajouter un son…</button>`}</div>`
        + ((c.files || []).length ? `<div class="dk-scroll"><table class="dk-table"><thead><tr><th>Nom</th><th>Versions</th><th></th></tr></thead><tbody>${[...c.files].sort((a, b) => a.name.localeCompare(b.name, 'fr')).map((f) => {
          const fm = f.formats || [];
          return `<tr><td class="nowrap">${esc(f.name)}</td><td>${fm.map((x) => `<span class="dk-ver">${playable(x.format) ? playBtn(`data-play="${esc(c.name)}|${esc(f.name)}|${esc(x.format || '')}|${esc(x.language || '')}"`) : '<span class="dk-play-none" title="Format non lisible dans le navigateur"></span>'}<span class="muted small">${esc(FMT[x.format] || x.format || '?')}${x.language ? ` · ${esc(LANGS.find(([k]) => k === x.language)?.[1] || x.language)}` : ''}</span></span>`).join('')}</td><td class="dk-acts">${ro ? '' : `<button class="dk-text" data-rep="${esc(c.name)}|${esc(f.name)}">Remplacer…</button> <button class="dk-text" data-del="${esc(c.name)}|${esc(f.name)}">Supprimer</button>`}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="muted small">Aucun fichier.</p>') + '</section>').join('')
        : '<p class="dk-empty">Aucune catégorie de sons sur ce site.</p>');
  };
  const refresh = async () => { await load(); draw(); };
  // Envoi : nom, langue, fichier.
  const upload = (cat, name0 = '') => {
    if (!canWrite()) return;
    confirmModal(`<h3>${name0 ? `Remplacer « ${esc(name0)} »` : `Ajouter un son dans « ${esc(cat)} »`}</h3>
      <label>Nom du son<input id="sd-name" value="${esc(name0)}" ${name0 ? 'readonly' : ''} maxlength="64" placeholder="ex. accueil_matin"></label>
      <label>Langue<select id="sd-lang">${LANGS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
      <div class="dk-ed-row"><button type="button" id="sd-file">Choisir le fichier…</button><span id="sd-info" class="muted small">aucun fichier</span></div>
      <p class="muted small">Envoi immédiat. Un son du même nom et de la même langue est remplacé.</p>${audioHelp()}<p id="sd-err" class="error small"></p>`, async () => {
      const name = safeName($('sd-name').value), lang = $('sd-lang').value;
      if (!name) { $('sd-err').textContent = 'Nom : lettres, chiffres, - et _.'; return false; }
      if (!pending) { $('sd-err').textContent = 'Choisissez un fichier.'; return false; }
      try { await raw('PUT', `/sounds/${encodeURIComponent(cat)}/files/${encodeURIComponent(name)}?format=slin${lang ? `&language=${lang}` : ''}`, pending.blob); }
      catch (e) { $('sd-err').textContent = `Échec de l'envoi : ${e.message}`; return false; }
      toast(`Son « ${name} » enregistré (${pending.seconds} s).`); refresh(); return true;
    }, 'Envoyer');
    let pending = null;
    $('sd-file').onclick = async () => {
      const f = await pickFile(); if (!f) return;
      $('sd-info').textContent = 'Conversion…';
      try { pending = await toWav8k(f); $('sd-info').textContent = `${f.name} · ${pending.seconds} s · ${moTxt(pending.sent)}`; if (!$('sd-name').value) $('sd-name').value = safeName(f.name); }
      catch (e) { pending = null; $('sd-info').textContent = ''; $('sd-err').textContent = `Fichier refusé : ${e.message}`; }
    };
  };
  view.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'sd-newcat') {
      if (!canWrite()) return;
      confirmModal('<h3>Nouvelle catégorie de sons</h3><label>Nom<input id="sd-cat" maxlength="64" placeholder="ex. accueil"></label><p id="sd-cerr" class="error small"></p>', async () => {
        const n = safeName($('sd-cat').value); if (!n) { $('sd-cerr').textContent = 'Nom : lettres, chiffres, - et _.'; return false; }
        try { await api('POST', '/sounds', { name: n }); } catch (x) { $('sd-cerr').textContent = x.message; return false; }
        toast(`Catégorie « ${n} » créée.`); refresh(); return true;
      }, 'Créer');
    } else if (b.dataset.add) upload(b.dataset.add);
    else if (b.dataset.rep) { const [c, n] = b.dataset.rep.split('|'); upload(c, n); }
    else if (b.dataset.play) { const [c, n, f, l] = b.dataset.play.split('|'); play(b, `/sounds/${encodeURIComponent(c)}/files/${encodeURIComponent(n)}?${new URLSearchParams({ ...(f ? { format: f } : {}), ...(l ? { language: l } : {}) })}`, f); }
    else if (b.dataset.del) {
      const [c, n] = b.dataset.del.split('|');
      if (canWrite()) confirmModal(`<p>Supprimer le son <strong>${esc(n)}</strong> (toutes ses versions) de « ${esc(c)} » ?</p><p class="muted small">Un SVI, une SDA ou un horaire qui l'utilise ne jouera plus rien.</p>`, async () => {
        try { await raw('DELETE', `/sounds/${encodeURIComponent(c)}/files/${encodeURIComponent(n)}`); } catch (x) { toast(`Échec : ${x.message}`, 8000); return true; }
        toast('Son supprimé.'); refresh(); return true;
      }, 'Supprimer');
    }
  };
  await refresh();
}

// ---------------------------------------------------------------------------
// Musiques d'attente
// ---------------------------------------------------------------------------
const SORT = [['alphabetical', 'Ordre alphabétique'], ['random', 'Aléatoire'], ['random_start', 'Aléatoire au démarrage']];
const MODE = { files: 'Fichiers', mp3: 'Fichiers MP3', custom: 'Application' };
export async function renderMoh(view, site) {
  view.innerHTML = head("Musiques d'attente", site) + '<p class="dk-empty">Lecture…</p>';
  let list = [];
  const ro = !!S.readonly;
  const draw = () => {
    view.innerHTML = head("Musiques d'attente", site, '', ro ? '' : '<div class="btnrow"><button id="mh-new">Nouvelle musique</button></div>')
      + '<p class="muted small">Chaque musique est une liste de fichiers jouée en boucle pendant l\'attente.</p>' + audioHelp()
      + (list.length ? list.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name, 'fr')).map((m) => `<section class="dk-panel"><div class="dk-panhead"><h3>${esc(m.label || m.name)} <span class="muted small">${esc(SORT.find(([k]) => k === m.sort)?.[1] || 'ordre par défaut')}</span></h3>${ro ? '' : `<span class="btnrow">${m.mode === 'custom' ? '' : `<button class="dk-text" data-madd="${m.uuid}">Ajouter un fichier…</button>`}<button class="dk-text" data-medit="${m.uuid}">Modifier</button>${m.name === 'default' ? '' : `<button class="dk-text" data-mdel="${m.uuid}">Supprimer</button>`}</span>`}</div>`
        + (m.mode === 'custom' ? '<p class="muted small">Musique fournie par une source externe : elle se règle dans le Portal.</p>' : (m.files || []).length ? `<ul class="dk-files">${m.files.map((f) => `<li><span class="dk-track">${playBtn(`data-mplay="${m.uuid}|${esc(f.name)}"`)}${esc(f.name)}</span><span>${ro ? '' : ` <button class="dk-link-sm" data-mfdel="${m.uuid}|${esc(f.name)}">Supprimer</button>`}</span></li>`).join('')}</ul>` : '<p class="muted small">Aucun fichier : rien n\'est joué.</p>')
        + '</section>').join('') : '<p class="dk-empty">Aucune musique d\'attente sur ce site.</p>');
  };
  const refresh = async () => { list = await listAll('/moh'); draw(); };
  const form = (m) => {
    if (!canWrite()) return;
    confirmModal(`<h3>${m ? `Musique « ${esc(m.label || m.name)} »` : 'Nouvelle musique d\'attente'}</h3>
      <label>Nom affiché<input id="mh-label" value="${esc(m?.label || '')}" maxlength="128"></label>
      ${m ? '' : `<label>Type<select id="mh-mode"><option value="files">Fichiers (WAV)</option><option value="mp3">Fichiers MP3</option></select></label>`}
      <label>Ordre de lecture<select id="mh-sort">${SORT.map(([v, l]) => `<option value="${v}"${(m?.sort || 'alphabetical') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label><p id="mh-err" class="error small"></p>`, async () => {
      const label = $('mh-label').value.trim(); if (!label) { $('mh-err').textContent = 'Nom obligatoire.'; return false; }
      try {
        if (m) await api('PUT', `/moh/${m.uuid}`, { label, mode: m.mode, sort: $('mh-sort').value, ...(m.mode === 'custom' ? { application: m.application } : {}) });
        else await api('POST', '/moh', { label, mode: $('mh-mode').value, sort: $('mh-sort').value });
      } catch (x) { $('mh-err').textContent = x.message; return false; }
      toast('Musique enregistrée.'); refresh(); return true;
    }, m ? 'Enregistrer' : 'Créer');
  };
  view.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const m = list.find((x) => x.uuid === (b.dataset.madd || b.dataset.medit || b.dataset.mdel || (b.dataset.mplay || b.dataset.mfdel || '').split('|')[0]));
    if (b.id === 'mh-new') form(null);
    else if (b.dataset.medit) form(m);
    else if (b.dataset.mplay) { const n = b.dataset.mplay.split('|')[1]; play(b, `/moh/${m.uuid}/files/${encodeURIComponent(n)}`, /\.mp3$/i.test(n) ? 'mp3' : 'wav'); }
    else if (b.dataset.madd) {
      if (!canWrite()) return;
      const f = await pickFile(m.mode === 'mp3' ? 'audio/mpeg,.mp3' : 'audio/*'); if (!f) return;
      try {
        let blob = f, name = `${safeName(f.name)}.mp3`, info = '';
        if (m.mode !== 'mp3') { const w = await toWav8k(f); blob = w.blob; name = `${safeName(f.name)}.wav`; info = ` (${w.seconds} s)`; }
        await raw('PUT', `/moh/${m.uuid}/files/${encodeURIComponent(name)}`, blob);
        toast(`Fichier ${name} ajouté${info}.`); refresh();
      } catch (x) { toast(`Échec de l'envoi : ${x.message}`, 8000); }
    } else if (b.dataset.mfdel) {
      const n = b.dataset.mfdel.split('|')[1];
      if (canWrite()) confirmModal(`<p>Retirer <strong>${esc(n)}</strong> de « ${esc(m.label || m.name)} » ?</p>`, async () => { try { await raw('DELETE', `/moh/${m.uuid}/files/${encodeURIComponent(n)}`); toast('Fichier retiré.'); } catch (x) { toast(`Échec : ${x.message}`, 8000); } refresh(); return true; }, 'Retirer');
    } else if (b.dataset.mdel) {
      if (canWrite()) confirmModal(`<p>Supprimer la musique <strong>${esc(m.label || m.name)}</strong> et ses fichiers ?</p><p class="muted small">Vérifiez d'abord qu'aucun groupe, file ou utilisateur ne l'utilise.</p>`, async () => { try { await api('DELETE', `/moh/${m.uuid}`); toast('Musique supprimée.'); } catch (x) { toast(`Échec : ${x.message}`, 8000); } refresh(); return true; }, 'Supprimer');
    }
  };
  await refresh();
}

// ---------------------------------------------------------------------------
// Enregistrements : tons de début et de fin d'enregistrement
// ---------------------------------------------------------------------------
export async function renderRecordings(view, site) {
  view.innerHTML = head('Enregistrements', site) + '<p class="dk-empty">Lecture…</p>';
  let cur, sounds = [];
  try {
    [cur, sounds] = await Promise.all([api('GET', '/recordings/announcements'), (async () => {
      const cats = (await listAll('/sounds')).filter((c) => c.name !== 'system');
      const all = await Promise.all(cats.map((c) => api('GET', `/sounds/${encodeURIComponent(c.name)}`).catch(() => ({ files: [] }))));
      return all.flatMap((c) => (c.files || []).map((f) => ({ label: `${c.name} / ${f.name}`, value: (f.formats || []).find((x) => x.path)?.path || f.name })));
    })()]);
  } catch (e) { view.innerHTML = head('Enregistrements', site) + `<p class="dk-empty">Ce réglage n'est pas disponible sur ce site.</p>`; return; }
  const ro = !!S.readonly;
  const sel = (id, v) => `<select id="${id}"${ro ? ' disabled' : ''}><option value="">Aucun</option>${sounds.map((s) => `<option value="${esc(s.value)}"${s.value === v ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}${v && !sounds.some((s) => s.value === v) ? `<option value="${esc(v)}" selected>${esc(v)}</option>` : ''}</select>`;
  view.innerHTML = head('Enregistrements', site, 'tons joués au début et à la fin d\'un enregistrement d\'appel')
    + `<section class="dk-panel dk-ed"><label>Ton de début d'enregistrement${sel('rc-start', cur?.recording_start)}</label><label>Ton de fin d'enregistrement${sel('rc-stop', cur?.recording_stop)}</label>
      <p class="muted small">Pour un nouveau son, ajoutez-le d'abord dans « Sons ».</p>${ro ? '' : '<div class="btnrow"><button id="rc-save" class="primary">Enregistrer</button></div>'}</section>`;
  if (ro) return;
  $('rc-save').onclick = async () => {
    if (!canWrite()) return;
    const body = { recording_start: $('rc-start').value || null, recording_stop: $('rc-stop').value || null };
    if (body.recording_start === (cur?.recording_start ?? null) && body.recording_stop === (cur?.recording_stop ?? null)) { toast('Aucune modification.'); return; }
    try { await api('PUT', '/recordings/announcements', body); cur = body; toast('Tons d\'enregistrement enregistrés.'); } catch (e) { toast(`Échec : ${e.message}`, 8000); }
  };
}
