// Call Flow Manager — écoute d'un fichier son (demande de Brice, 17/10/2026).
// Vérifié dans wazo-confd master (plugins/sound) :
//  - GET /sounds/{catégorie}/files/{fichier}?format=…&language=… renvoie le
//    fichier lui-même (send_file, application/octet-stream), ACL
//    confd.sounds.{catégorie}.files.{fichier}.read ; catégorie « system » =
//    sons Asterisk (/usr/share/asterisk/sounds) ;
//  - format « slin » = fichier .wav (SoundFormat.extension_map) ; les autres
//    formats portent le nom de leur extension (ulaw, alaw, gsm…).
// Le navigateur lit le .wav ; ulaw / alaw (8 kHz) sont décodés ici en WAV
// PCM. Les autres (gsm, g722…) ne sont pas lisibles : message, pas d'erreur
// silencieuse. Supposé : un son système dans un sous-dossier (« digits/1 »)
// passe encodé (%2F) dans l'URL — à tester en réel.
import { S, toast } from '../common/core.js?v=0.40.21';
import { M, sameTenant } from './model.js?v=0.40.21';

let audio = null, playing = null, url = null;
function stop() {
  if (audio) { audio.pause(); audio = null; }
  if (url) { URL.revokeObjectURL(url); url = null; }
  if (playing) { playing.textContent = 'Écouter'; playing = null; }
}

// G.711 → PCM 16 bits (formules standard ITU-T).
const ulaw = (u) => { u = ~u & 0xff; const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4); return u & 0x80 ? 0x84 - t : t - 0x84; };
const alaw = (a) => { a ^= 0x55; const e = (a & 0x70) >> 4; let t = (a & 0x0f) << 4; t += e ? 0x108 : 8; if (e > 1) t <<= e - 1; return a & 0x80 ? t : -t; };
function wav(pcm, rate) {
  const b = new ArrayBuffer(44 + pcm.length * 2); const v = new DataView(b);
  const s = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); s(8, 'WAVE'); s(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([b], { type: 'audio/wav' });
}
const PLAYABLE = ['slin', 'wav', 'mp3', 'ogg', 'ulaw', 'alaw'];
// Format et langue à demander : lisible d'abord, français de préférence.
function pick(formats) {
  const l = (formats || []).filter((f) => PLAYABLE.includes(f.format));
  const rank = (f) => PLAYABLE.indexOf(f.format) * 10 + (f.language?.startsWith('fr') ? 0 : f.language ? 2 : 1);
  return l.sort((a, b) => rank(a) - rank(b))[0] || null;
}

// Lecture commune : load() renvoie un Blob audio.
async function playFrom(btn, load) {
  if (playing === btn) { stop(); return; }
  stop();
  const tenant = M.tenant;
  btn.textContent = 'Chargement…'; playing = btn;
  try {
    const blob = await load();
    if (!sameTenant(tenant) || playing !== btn) return;
    url = URL.createObjectURL(blob);
    audio = new Audio(url);
    audio.onended = stop;
    audio.ontimeupdate = () => { if (!btn.isConnected) stop(); }; // fenêtre fermée
    await audio.play();
    btn.textContent = 'Arrêter';
  } catch (e) {
    stop();
    toast(`Lecture impossible : ${e.message}`, 7000);
  }
}
const headers = (extra = {}) => { const h = { 'X-Auth-Token': S.token, ...extra }; if (S.tenant) h['Wazo-Tenant'] = S.tenant; return h; };
const httpErr = (r, acl) => new Error(`HTTP ${r.status}${r.status === 403 ? ` (droit ${acl} ?)` : ''}`);

// Vérifié dans wazo-confd (helpers/converter.py, FilenameConverter) : un nom
// de fichier contenant « / » est refusé → un son système rangé dans un
// sous-dossier (ex. phonetic/a_P) ne peut pas être lu par l'API.
export const soundBlocked = (value) => { const m = M.soundMeta?.get(value); return m ? m.name.includes('/') : false; };
function play(value, btn) {
  const meta = M.soundMeta?.get(value);
  if (!meta) { toast('Son inconnu de la liste lue : rechargez la page.', 6000); return; }
  if (meta.name.includes('/')) { toast('Wazo ne permet pas de lire un son rangé dans un sous-dossier (refusé par l\'API, vérifié dans confd).', 8000); return; }
  const f = pick(meta.formats);
  if (!f) { toast(`Format non lisible par le navigateur (${(meta.formats || []).map((x) => x.format).join(', ') || 'inconnu'}).`, 7000); return; }
  return playFrom(btn, async () => {
    const q = new URLSearchParams({ format: f.format, ...(f.language ? { language: f.language } : {}) });
    const r = await fetch(`${S.base}/api/confd/1.1/sounds/${encodeURIComponent(meta.category)}/files/${encodeURIComponent(meta.name)}?${q}`, { headers: headers({ Accept: '*/*' }) });
    if (!r.ok) throw httpErr(r, 'confd.sounds…read');
    const blob = await r.blob();
    if (f.format === 'ulaw' || f.format === 'alaw') { const u8 = new Uint8Array(await blob.arrayBuffer()); return wav(Int16Array.from(u8, f.format === 'ulaw' ? ulaw : alaw), 8000); }
    return new Blob([blob], { type: { mp3: 'audio/mpeg', ogg: 'audio/ogg' }[f.format] || 'audio/wav' });
  });
}

// ---------------------------------------------------------------------------
// Messages d'accueil d'une messagerie (demande de Brice, 17/10/2026, onglet
// « Pré-décrochés » du portail). Vérifié dans wazo-calld master
// (plugins/voicemails) : /voicemails/{id}/greetings/{name|unavailable|busy}
// HEAD (existe ?), GET (audio/wav), POST (création, 409 si déjà là), PUT
// (remplacement), DELETE ; corps = fichier brut (request.data) ; ACL
// calld.voicemails.{id}.greetings.{nom}.read|create|update|delete.
// Écriture IMMÉDIATE (hors brouillon : un fichier audio n'a pas sa place dans
// la sauvegarde JSON), avec confirmation dans l'éditeur.
// ---------------------------------------------------------------------------
export const MAX_GREETING_S = 90;
const MAX_SENT = 2097152; // MAX_CONTENT_LENGTH du patch Asterisk de Wazo
export const moTxt = (n) => `${(n / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Mo`;
export const GREETINGS = [['name', 'Prénom et nom'], ['unavailable', 'Indisponible'], ['busy', 'Occupé']];
const gUrl = (vm, g) => `${S.base}/api/calld/1.0/voicemails/${encodeURIComponent(vm)}/greetings/${g}`;
const tenantGuard = (t) => { if (!sameTenant(t)) throw new Error('Le tenant a changé dans le portail : opération arrêtée.'); };
export async function greetingExists(vm, g) {
  const r = await fetch(gUrl(vm, g), { method: 'HEAD', headers: headers(), cache: 'no-store' });
  if (r.status === 404) return false;
  if (!r.ok) throw httpErr(r, `calld.voicemails.${vm}.greetings.${g}.read`);
  return true;
}
export const playGreeting = (vm, g, btn) => playFrom(btn, async () => {
  const r = await fetch(gUrl(vm, g), { headers: headers({ Accept: 'audio/wav' }), cache: 'no-store' });
  if (!r.ok) throw httpErr(r, `calld.voicemails.${vm}.greetings.${g}.read`);
  return new Blob([await r.blob()], { type: 'audio/wav' });
});
export async function saveGreeting(vm, g, blob, exists, onVerify) {
  const t = M.tenant; tenantGuard(t);
  if (S.readonly) throw new Error(`Lecture seule : ${S.readonly}`);
  const r = await fetch(gUrl(vm, g), { method: exists ? 'PUT' : 'POST', headers: headers({ 'Content-Type': 'audio/wav' }), body: blob });
  if (!r.ok) throw httpErr(r, `calld.voicemails.${vm}.greetings.${g}.${exists ? 'update' : 'create'}`);
  // Vérifié (wazo-calld services.py) : une erreur d'Asterisk autre que 400 est
  // ignorée et calld répond quand même 204 → relecture pour confirmer.
  onVerify?.();
  if (!(await greetingExists(vm, g))) throw new Error('Wazo a répondu OK mais le message n\'est pas enregistré (fichier refusé par Asterisk ; trop long ?)');
  console.info('[astrea] Call Flow : message d\'accueil enregistré', vm, g);
}
export async function deleteGreeting(vm, g) {
  const t = M.tenant; tenantGuard(t);
  if (S.readonly) throw new Error(`Lecture seule : ${S.readonly}`);
  const r = await fetch(gUrl(vm, g), { method: 'DELETE', headers: headers() });
  if (!r.ok && r.status !== 404) throw httpErr(r, `calld.voicemails.${vm}.greetings.${g}.delete`);
  console.info('[astrea] Call Flow : message d\'accueil supprimé', vm, g);
}
// Fichier audio quelconque (wav, mp3, m4a…) → WAV 8 kHz 16 bits mono, le
// format attendu par Wazo (indiqué par le portail). Décodage et rééchantillonnage
// par le navigateur (Web Audio). Renvoie { blob, seconds }.
export async function toWav8k(file) {
  const buf = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let src;
  try { src = await ctx.decodeAudioData(buf); } catch { throw new Error('fichier audio illisible par le navigateur'); } finally { ctx.close?.(); }
  // Vérifié (patch Wazo d'Asterisk wazo_ari_expose_voicemail_functions) : corps
  // HTTP limité à 2 Mio (MAX_CONTENT_LENGTH 2097152), fichier envoyé en base64
  // → environ 95 s de WAV 8 kHz 16 bits. Marge prise : 90 s.
  if (src.duration > MAX_GREETING_S) throw new Error(`fichier trop long (${Math.round(src.duration)} s) : Wazo accepte ${MAX_GREETING_S} s au plus pour un message d'accueil`);
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(src.duration * 8000)), 8000);
  const node = off.createBufferSource(); node.buffer = src; node.connect(off.destination); node.start();
  const out = (await off.startRendering()).getChannelData(0);
  const pcm = Int16Array.from(out, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767))));
  const blob = wav(pcm, 8000);
  // Taille réellement envoyée à Asterisk : base64 du fichier + enveloppe JSON de calld (~100 octets).
  const sent = Math.ceil(blob.size / 3) * 4 + 100;
  if (sent > MAX_SENT) throw new Error(`trop gros une fois converti (${moTxt(sent)}) : Wazo accepte 2 Mo au plus`);
  return { blob, seconds: Math.round(src.duration), sent };
}
// Bouton « Écouter » à côté d'une liste de sons (une seule fois par liste).
export function attachPlay(sel) {
  if (!sel || sel.dataset.play) return;
  sel.dataset.play = '1';
  const row = document.createElement('span'); row.className = 'cf-play-row';
  sel.before(row); row.append(sel);
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'cf-play'; btn.textContent = 'Écouter';
  btn.title = 'Écouter le son choisi (lu depuis Wazo)';
  row.append(btn);
  const upd = () => { const blk = sel.value && soundBlocked(sel.value); btn.disabled = !sel.value; btn.classList.toggle('cf-play-off', !!blk); btn.title = blk ? 'Son rangé dans un sous-dossier : Wazo ne permet pas de le lire par l\'API (vérifié dans confd).' : 'Écouter le son choisi (lu depuis Wazo)'; if (playing === btn) stop(); };
  sel.addEventListener('change', upd);
  btn.addEventListener('click', (e) => { e.preventDefault(); if (sel.value) play(sel.value, btn); });
  upd();
}
// Fenêtre fermée : on arrête la lecture.
export const stopSound = stop;
