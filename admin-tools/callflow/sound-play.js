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
import { S, toast } from '../common/core.js?v=0.40.6';
import { M, sameTenant } from './model.js?v=0.40.6';

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

async function play(value, btn) {
  if (playing === btn) { stop(); return; }
  stop();
  const meta = M.soundMeta?.get(value);
  if (!meta) { toast('Son inconnu de la liste lue : rechargez la page.', 6000); return; }
  const f = pick(meta.formats);
  if (!f) { toast(`Format non lisible par le navigateur (${(meta.formats || []).map((x) => x.format).join(', ') || 'inconnu'}).`, 7000); return; }
  const tenant = M.tenant;
  btn.textContent = 'Chargement…'; playing = btn;
  try {
    const q = new URLSearchParams({ format: f.format, ...(f.language ? { language: f.language } : {}) });
    const headers = { 'X-Auth-Token': S.token, Accept: '*/*' };
    if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
    const r = await fetch(`${S.base}/api/confd/1.1/sounds/${encodeURIComponent(meta.category)}/files/${encodeURIComponent(meta.name)}?${q}`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 403 ? ' (droit confd.sounds…read ?)' : ''}`);
    if (!sameTenant(tenant) || playing !== btn) return;
    let blob = await r.blob();
    if (f.format === 'ulaw' || f.format === 'alaw') { const u8 = new Uint8Array(await blob.arrayBuffer()); const dec = f.format === 'ulaw' ? ulaw : alaw; blob = wav(Int16Array.from(u8, dec), 8000); }
    else blob = new Blob([blob], { type: { mp3: 'audio/mpeg', ogg: 'audio/ogg' }[f.format] || 'audio/wav' });
    url = URL.createObjectURL(blob);
    audio = new Audio(url);
    audio.onended = stop;
    await audio.play();
    btn.textContent = 'Arrêter';
  } catch (e) {
    stop();
    toast(`Lecture impossible : ${e.message}`, 7000);
  }
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
  const upd = () => { btn.disabled = !sel.value; if (playing === btn) stop(); };
  sel.addEventListener('change', upd);
  btn.addEventListener('click', (e) => { e.preventDefault(); if (sel.value) play(sel.value, btn); });
  upd();
}
// Fenêtre fermée : on arrête la lecture.
export const stopSound = stop;
