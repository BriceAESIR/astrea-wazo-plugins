// Migration Assistant — import 3CX : fichiers son et musiques d'attente (demande
// de Brice, 04/11/2026). La sauvegarde 3CX ne contient que les noms des
// fichiers : ils sont déposés dans le navigateur, convertis en WAV 8 kHz mono
// 16 bits, gardés en mémoire (jamais dans le brouillon), puis envoyés à Wazo
// par la phase Fondations.
//
// Lu dans wazo-confd (master, 04/11/2026) :
//  - musiques d'attente : POST /moh {label, mode: files, sort} (nom technique
//    généré moh-<slug>-<uuid>) ; PUT /moh/{uuid}/files/{nom} en binaire ;
//    fichier refusé s'il n'est pas un WAV mono à 8 ou 16 kHz de 16 bits au plus
//    (moh/schema.py, MohFileUploadSchema) ;
//  - sons : POST /sounds {name} (catégorie, ^[a-zA-Z0-9][-_.a-zA-Z0-9]+$, ni
//    « system » ni réservée) ; PUT /sounds/{catégorie}/files/{nom}?format=wav
//    &language=fr_FR en binaire, rangé en <catégorie>/<langue>/<nom>.wav
//    (sound/storage.py) ; DELETE /sounds/{catégorie} supprime ses fichiers.
// Musique d'attente par défaut : option moh_suggest du modèle SIP global, comme
// le Wizard de déploiement de Wazo (lu dans son code) ; effet exact supposé.
import { S, ApiError } from '../common/core.js?v=0.40.66';

export const CATEGORY_RE = /^[a-zA-Z0-9][-_.a-zA-Z0-9]+$/;
export const SORTS = { alphabetical: 'Ordre alphabétique', random: 'Aléatoire', random_start: 'Départ aléatoire' };
const base = (f) => String(f || '').split('/').pop().replace(/\.(wav|mp3)$/i, '');
export const wazoName = (f) => base(f).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'son';
// Noms Wazo uniques pour des fichiers rangés au même endroit (une musique, une catégorie) :
// deux noms 3CX qui donnent le même nom Wazo (« Fermeture été » / « Fermeture-ete ») reçoivent
// « _2 », « _3 »… dans l'ordre alphabétique des noms 3CX. Les lots suivants (SVI, files)
// doivent viser les sons par ce même tableau, jamais par wazoName seul.
export function uniqueNames(files) {
  const out = new Map(); const used = new Set();
  for (const f of [...files].sort()) { const b = wazoName(f); let n = b; for (let i = 2; used.has(n.toLowerCase()); i++) n = `${b}_${i}`; used.add(n.toLowerCase()); out.set(f, n); }
  return out;
}
// Nom Wazo d'un fichier du brouillon, parmi les fichiers rangés au même endroit.
export function targetName(d, file) {
  const to = d.sounds?.files?.[file]?.to;
  return uniqueNames(Object.entries(d.sounds?.files || {}).filter(([, x]) => x.to === to).map(([f]) => f)).get(file) || wazoName(file);
}
export const SYSTEM_3CX = /^onhold\.wav$/i;
const ROUTE_FR = { closed: 'fermé', holiday: 'férié', break: 'pause' };
// Où chaque fichier 3CX sert : [{ file, uses: [{ kind: moh|sound, what }] }].
export function soundUsages(m) {
  const by = new Map(); const use = (f, kind, what) => { if (!f) return; const k = String(f).split('/').pop(); if (!/\.(wav|mp3)$/i.test(k)) return; if (!by.has(k)) by.set(k, []); by.get(k).push({ kind, what }); };
  use(m.moh, 'moh', 'musique d\'attente par défaut de 3CX');
  for (const x of m.mohSources || []) use(x.file, 'moh', x.what);
  for (const q of m.queues) { use(q.onHold, 'moh', `musique de la file ${q.number} ${q.name}`); use(q.intro, 'sound', `message d'intro de la file ${q.number}`); }
  for (const v of m.ivrs.filter((x) => !x.system)) use(v.prompt, 'sound', `message du SVI ${v.number} ${v.name}`);
  for (const o of [...m.ringGroups, ...m.queues, ...m.ivrs]) for (const [k, r] of Object.entries(o.routes || {})) if (r?.prompt) use(r.prompt, 'sound', `message ${ROUTE_FR[k] || k} de ${o.number} ${o.name}`);
  for (const h of m.holidays.filter((x) => !x.past)) use(h.prompt, 'sound', `fermeture « ${h.name} »`);
  for (const g of (m.groups || []).filter((x) => !x.favorites)) for (const h of (g.holidays || []).filter((x) => !x.past)) use(h.prompt, 'sound', `fermeture « ${h.name} » (${g.name})`);
  return [...by.entries()].map(([file, uses]) => ({ file, uses }));
}
// Réglages du brouillon : deux musiques d'attente (procédure de Brice : Attente,
// Prédécroché), une catégorie de sons, un choix par fichier.
export function ensureSounds(d, m) {
  // Musique dont le nom dit « prédécroché » (« Predecroche », « PRE_DECROCHE », « PRE_DEC ») :
  // dans la musique Prédécroché, sinon dans Attente. Lettres seules, sans accent, comparées.
  const pre = (f) => /predec/i.test(String(f).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, ''));
  // onhold.wav : fichier fourni par 3CX lui-même, pas par le client : non repris par défaut.
  const to = (x) => (SYSTEM_3CX.test(x.file) ? 'skip' : x.uses.some((u) => u.kind === 'moh') ? (pre(x.file) ? 'moh:predecroche' : 'moh:attente') : 'sound');
  d.sounds ||= { moh: [{ key: 'attente', label: '', sort: 'alphabetical' }, { key: 'predecroche', label: '', sort: 'alphabetical' }], defaultMoh: 'attente', category: '', files: {} };
  // Fichiers cités par la sauvegarde et pas encore dans le brouillon (brouillon d'une version
  // précédente) : ajoutés avec leur rangement par défaut, sans toucher aux choix déjà faits.
  for (const x of soundUsages(m)) d.sounds.files[x.file] ||= { to: to(x) };
  return d;
}
const DEFAULT_MOH_LABEL = { attente: 'Attente', predecroche: 'Prédécroché' };
export const mohLabel = (d, x) => x.label || `${d.write?.clientId || '<ID>'} - ${DEFAULT_MOH_LABEL[x.key] || x.key}`;
export const soundCategory = (d) => d.sounds?.category || `${d.write?.clientId || 'client'}-messages`;

// ---------------------------------------------------------------------------
// Fichiers chargés (mémoire de la page) et conversion
// ---------------------------------------------------------------------------
// Clé : nom sans extension, en minuscules (« Accueil.mp3 » répond à « accueil.wav »).
export const FILES = new Map();
export const keyOf = (f) => base(f).toLowerCase();
export const loaded = (f) => FILES.get(keyOf(f)) || null;
// Décodage par le navigateur (WAV, MP3…), mélange en mono, rééchantillonnage à
// 8 kHz (OfflineAudioContext), puis WAV PCM 16 bits : le format exigé par confd
// pour une musique d'attente, et lu par Asterisk pour un son.
export async function toWav8k(file) {
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let audio;
  try { audio = await ctx.decodeAudioData(buf.slice(0)); } finally { ctx.close?.(); }
  const rate = 8000; const len = Math.max(1, Math.ceil(audio.duration * rate));
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
  const out = (await off.startRendering()).getChannelData(0);
  const pcm = new DataView(new ArrayBuffer(44 + out.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) pcm.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); pcm.setUint32(4, 36 + out.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true); pcm.setUint16(22, 1, true); pcm.setUint32(24, rate, true);
  pcm.setUint32(28, rate * 2, true); pcm.setUint16(32, 2, true); pcm.setUint16(34, 16, true); str(36, 'data'); pcm.setUint32(40, out.length * 2, true);
  for (let i = 0; i < out.length; i++) { const v = Math.max(-1, Math.min(1, out[i])); pcm.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
  return { blob: new Blob([pcm.buffer], { type: 'audio/wav' }), seconds: audio.duration, from: `${file.type || file.name.split('.').pop()} ${audio.sampleRate} Hz, ${audio.numberOfChannels} canal(aux)` };
}
export async function addFiles(list) {
  const res = [];
  for (const f of list) {
    try { const w = await toWav8k(f); const old = FILES.get(keyOf(f.name)); if (old?.url) URL.revokeObjectURL(old.url); FILES.set(keyOf(f.name), { name: f.name, ...w, url: URL.createObjectURL(w.blob) }); res.push({ name: f.name, ok: true }); } catch (e) { res.push({ name: f.name, ok: false, error: e.message || String(e) }); }
  }
  return res;
}
// Fichier déposé sur une ligne précise (demande de Brice, 04/11/2026) : rattaché au fichier
// 3CX de cette ligne, quel que soit son propre nom (« accueil-v2.mp3 » pour « REP.wav »).
export async function addFileAs(file, target) {
  const w = await toWav8k(file);
  const old = FILES.get(keyOf(target)); if (old?.url) URL.revokeObjectURL(old.url);
  FILES.set(keyOf(target), { name: target, source: file.name, ...w, url: URL.createObjectURL(w.blob) });
}

// Envoi binaire à confd (api() de core.js n'envoie que du JSON).
export async function putBinary(path, blob) {
  if (S.readonly) throw new ApiError(0, `Lecture seule : ${S.readonly}`);
  const headers = { 'X-Auth-Token': S.token, 'Content-Type': 'application/octet-stream' };
  if (S.tenant) headers['Wazo-Tenant'] = S.tenant;
  const r = await fetch(`${S.base}/api/confd/1.1${path}`, { method: 'PUT', headers, body: blob });
  if (!r.ok) { let msg = `PUT ${path} → ${r.status}`; try { msg += ` ${JSON.stringify(await r.json()).slice(0, 300)}`; } catch { /* */ } throw new ApiError(r.status, msg); }
}
