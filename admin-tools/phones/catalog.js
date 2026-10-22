// À CHAQUE AJOUT / MODIFICATION D'OPTION : mettre à jour le tableau du catalogue
// dans docs/PHONE-MANAGER.md (et docs/AJOUTER-UNE-MARQUE.md si nouveau type de
// champ ou nouvelle règle) dans le même commit.
//
// Catalogue des options Phone Manager (Yealink). Chaque option coché sur un
// appareil produit des paramètres Yealink « clé = valeur » (option provd
// astrea_params), écrits en fin de configuration par le bloc Astrea v5.
// Sources : doc Yealink (support.yealink.com, admin guides V85/V86, captures
// de la doc fournies par Brice) et templates Wazo v86/v87 ; voir
// docs/PHONE-MANAGER.md (statut vérifié / supposé de chaque paramètre).
//
// Champs : { key, label, type: 'int' | 'select' | 'time' | 'days' | 'password',
//            min, max, def, ydef, options: [[valeur, libellé, modèles?]…] }
// (3e élément facultatif d'une option de liste : RegExp des modèles qui la proposent)
// ydef = valeur par défaut Yealink, affichée (grisée) quand l'option est
// décochée et reprise quand on la coche ; def = valeur proposée sinon.
// offText (option) : texte affiché à la place des champs quand c'est décoché
// (VLAN / mot de passe : modèle de la stack ; fonctions désactivées).
// kinds : 'phone' (postes) et/ou 'dect' (bases). models : RegExp facultative
// sur le modèle (option proposée seulement aux modèles concernés).

const onOff = [['1', 'Activé'], ['0', 'Désactivé']];
const DAYS = [['1', 'Lun'], ['2', 'Mar'], ['3', 'Mer'], ['4', 'Jeu'], ['5', 'Ven'], ['6', 'Sam'], ['0', 'Dim']];

export const CATALOG = [
  {
    id: 'vlan', label: 'VLAN WAN et priorité', kinds: ['phone', 'dect'], reboot: true, offText: 'VLAN du modèle de provisionnement de la stack.',
    help: 'Port Internet (WAN) de l\'appareil : VLAN 802.1Q et priorité 802.1p. Remplace pour cet appareil le VLAN du modèle de provisionnement de la stack (untag / tag). Paramètres static.network.vlan.internet_port_enable / _vid (1 à 4094, défaut 1) / _priority (0 à 7, 7 = la plus haute, défaut 0). Un changement redémarre l\'appareil ; un mauvais VLAN le rend injoignable jusqu\'à correction sur le réseau ou retour usine.',
    fields: [
      { key: 'enable', label: 'VLAN', type: 'select', def: '1', options: [['1', 'Activé (trames taguées)'], ['0', 'Désactivé (untag)']] },
      { key: 'vid', label: 'VLAN ID', type: 'int', min: 1, max: 4094, def: 7 },
      { key: 'prio', label: 'Priorité 802.1p', type: 'int', min: 0, max: 7, def: 5 },
    ],
    params: (v) => (v.enable === '1'
      ? { 'static.network.vlan.internet_port_enable': '1', 'static.network.vlan.internet_port_vid': String(v.vid), 'static.network.vlan.internet_port_priority': String(v.prio) }
      : { 'static.network.vlan.internet_port_enable': '0' }),
  },
  {
    id: 'adminpw', label: 'Mot de passe admin propre à l\'appareil', kinds: ['phone', 'dect'], reboot: true, secret: true, offText: 'Mot de passe du modèle de provisionnement de la stack.',
    help: 'Mot de passe du compte administrateur de l\'interface web, à la place de celui du modèle de provisionnement (commun à toute la stack). Paramètre static.security.user_password = <compte>:<mot de passe>, où <compte> est le nom du compte admin défini par le modèle (« admin » par défaut). 1 à 32 caractères ASCII, sans espace ni « : ». Il reste visible en clair dans le fichier de configuration de l\'appareil et dans provd (comme celui du modèle aujourd\'hui). Un changement redémarre l\'appareil.',
    // user : nom du compte admin du modèle de provisionnement, fixé par l'appli
    // à l'enregistrement (app.js adminUser) ; absent (≤ 0.40.23) = « admin ».
    fields: [{ key: 'pwd', label: 'Mot de passe', type: 'password', def: '' }],
    params: (v) => ({ 'static.security.user_password': `${v.user || 'admin'}:${v.pwd}` }),
  },
  {
    id: 'autoprov', label: 'Provisionnement planifié (hebdomadaire)', kinds: ['phone', 'dect'], offText: 'Désactivé (défaut Yealink) : l\'appareil se provisionne au démarrage et sur synchronisation.',
    help: 'L\'appareil vérifie sa configuration (et son firmware) chaque semaine, les jours cochés, à un moment tiré entre l\'heure de début et l\'heure de fin. Paramètres static.auto_provision.weekly.enable / .dayofweek (chiffres 0 à 6, 0 = dimanche ; défaut 0123456) / .begin_time et .end_time (HH:MM, défaut 00:00).',
    fields: [
      { key: 'days', label: 'Jours', type: 'days', def: '12345', options: DAYS },
      { key: 'begin', label: 'Entre', type: 'time', def: '02:00' },
      { key: 'end', label: 'et', type: 'time', def: '04:00' },
    ],
    params: (v) => ({ 'static.auto_provision.weekly.enable': '1', 'static.auto_provision.weekly.dayofweek': v.days, 'static.auto_provision.weekly.begin_time': v.begin, 'static.auto_provision.weekly.end_time': v.end }),
  },
  {
    id: 'autoprov_repeat', label: 'Provisionnement répété', kinds: ['phone', 'dect'], offText: 'Désactivé (défaut Yealink).',
    help: 'L\'appareil vérifie sa configuration toutes les N minutes. Paramètres static.auto_provision.repeat.enable / .minutes (1 à 43200, défaut 1440 = une fois par jour).',
    fields: [{ key: 'minutes', label: 'Intervalle (minutes)', type: 'int', min: 1, max: 43200, def: 1440 }],
    params: (v) => ({ 'static.auto_provision.repeat.enable': '1', 'static.auto_provision.repeat.minutes': String(v.minutes) }),
  },
  {
    id: 'screensaver', label: 'Économiseur d\'écran', kinds: ['phone'],
    models: /^(T4[68]|T5[478]|T7[47]|T8|T33G|T43U|CP9|MP5)/,
    help: 'Délai d\'inactivité avant l\'économiseur, et horloge affichée dessus (écrans couleur). Paramètres screensaver.wait_time (15 à 43200 s, défaut 21600 = 6 h ; l\'interface du poste ne propose que 30 min à 12 h) et screensaver.display_clock.enable (défaut : activé).',
    fields: [
      { key: 'wait', label: 'Délai', type: 'select', def: '1800', ydef: '21600', options: [['300', '5 min'], ['900', '15 min'], ['1800', '30 min'], ['3600', '1 h'], ['7200', '2 h'], ['14400', '4 h'], ['21600', '6 h (défaut Yealink)'], ['43200', '12 h']] },
      { key: 'clock', label: 'Horloge', type: 'select', def: '1', ydef: '1', options: [['1', 'Affichée'], ['0', 'Masquée']] },
    ],
    params: (v) => ({ 'screensaver.wait_time': v.wait, 'screensaver.display_clock.enable': v.clock }),
  },
  {
    id: 'backlight', label: 'Rétroéclairage', kinds: ['phone'],
    help: 'Délai d\'inactivité (en secondes) avant que l\'écran baisse son éclairage. Paramètre phone_setting.backlight_time : 0 = toujours allumé (défaut), 15, 30, 60, 120, 300, 600 ou 1800 s ; 1 = toujours éteint, seulement sur T27G, T41S, T42S, T53W et CP920 (doc Yealink).',
    fields: [{ key: 'time', label: 'Délai', type: 'select', def: '0', ydef: '0', options: [['0', 'Toujours allumé (défaut Yealink)'], ['1', 'Toujours éteint', /^(T27G|T41S|T42S|T53W|CP920)$/], ['15', '15 s'], ['30', '30 s'], ['60', '1 min'], ['120', '2 min'], ['300', '5 min'], ['600', '10 min'], ['1800', '30 min']] }],
    params: (v) => ({ 'phone_setting.backlight_time': v.time }),
  },  {
    id: 'aec', label: 'Annulation d\'écho (AEC)', kinds: ['phone'],
    help: 'Supprime l\'écho de la voix du correspondant renvoyée par le haut-parleur. Paramètre voice.echo_cancellation (défaut : activé). À ne désactiver que pour un diagnostic.',
    fields: [{ key: 'on', label: 'AEC', type: 'select', def: '1', ydef: '1', options: onOff }],
    params: (v) => ({ 'voice.echo_cancellation': v.on }),
  },
  {
    id: 'vad', label: 'Détection d\'activité vocale (VAD)', kinds: ['phone'],
    help: 'N\'envoie pas d\'audio pendant les silences (économie de bande passante). Paramètre voice.vad (défaut : désactivé). Peut couper le début des phrases ; à combiner avec le bruit de confort (CNG).',
    fields: [{ key: 'on', label: 'VAD', type: 'select', def: '0', ydef: '0', options: onOff }],
    params: (v) => ({ 'voice.vad': v.on }),
  },
  {
    id: 'cng', label: 'Bruit de confort (CNG)', kinds: ['phone'],
    help: 'Génère un léger bruit de fond pendant les silences, pour que l\'interlocuteur ne croie pas la communication coupée. Paramètre voice.cng (défaut : activé).',
    fields: [{ key: 'on', label: 'CNG', type: 'select', def: '1', ydef: '1', options: onOff }],
    params: (v) => ({ 'voice.cng': v.on }),
  },
  {
    id: 'tns', label: 'Réduction des bruits parasites (TNS)', kinds: ['phone'],
    help: 'Atténue les bruits brefs captés par le micro (frappe clavier, clics). Paramètre voice.tns.enable (défaut : activé).',
    fields: [{ key: 'on', label: 'TNS', type: 'select', def: '1', ydef: '1', options: onOff }],
    params: (v) => ({ 'voice.tns.enable': v.on }),
  },
  {
    id: 'shield', label: 'Acoustic Shield', kinds: ['phone'],
    models: /^(T57W|T54W|T53W|T53|T48U|T46U|T43U|T42U)$/,
    help: 'Bloque les voix et bruits environnants autour de l\'utilisateur (open space). Paramètre features.acoustic_shield.mode : 0 désactivé, 1 activé par une touche, 2 automatique. Modèles : T57W, T54W, T53W, T53, T48U, T46U, T43U, T42U.',
    fields: [{ key: 'mode', label: 'Mode', type: 'select', def: '2', ydefText: 'défaut Yealink non documenté', options: [['0', 'Désactivé'], ['1', 'Manuel (touche)'], ['2', 'Automatique']] }],
    params: (v) => ({ 'features.acoustic_shield.mode': v.mode }),
  },
  {
    id: 'sendvol', label: 'Volumes d\'émission', kinds: ['phone'],
    help: 'Gain du micro envoyé au correspondant, pour le combiné (voice.handset_send), le casque (voice.headset_send) et le mains-libres (voice.handfree_send). Entier de -50 à 50, défaut 0. Yealink recommande de modifier ces valeurs avec prudence : une valeur inadaptée dégrade la voix.',
    fields: [
      { key: 'handset', label: 'Combiné', type: 'int', min: -50, max: 50, def: 0, ydef: 0 },
      { key: 'headset', label: 'Casque', type: 'int', min: -50, max: 50, def: 0, ydef: 0 },
      { key: 'handfree', label: 'Mains-libres', type: 'int', min: -50, max: 50, def: 0, ydef: 0 },
    ],
    params: (v) => ({ 'voice.handset_send': String(v.handset), 'voice.headset_send': String(v.headset), 'voice.handfree_send': String(v.handfree) }),
  },
  {
    id: 'ringer', label: 'Périphérique de sonnerie', kinds: ['phone'],
    help: 'Où sonne le poste : haut-parleur, casque, ou les deux. Paramètre features.ringer_device.is_use_headset : 0 haut-parleur, 1 casque, 2 casque et haut-parleur (défaut 2). Le casque n\'est utilisé que si le mode casque est activé sur le poste.',
    fields: [{ key: 'dev', label: 'Sonnerie', type: 'select', def: '2', ydef: '2', options: [['0', 'Haut-parleur'], ['1', 'Casque'], ['2', 'Casque et haut-parleur']] }],
    params: (v) => ({ 'features.ringer_device.is_use_headset': v.dev }),
  },
];

// Mot de passe aléatoire (sans caractères ambigus ni « : »).
export function randomPassword(n = 14) {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_.';
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => cs[x % cs.length]).join('');
}

// Valeur saisie → valeur normalisée, ou message d'erreur.
export function checkField(f, raw) {
  const v = raw ?? f.def;
  if (f.type === 'int') {
    const n = Number(v);
    if (!Number.isInteger(n) || n < f.min || n > f.max) return { err: `${f.label} : entier de ${f.min} à ${f.max}` };
    return { v: n };
  }
  if (f.type === 'time') return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? { v: String(v) } : { err: `${f.label} : heure HH:MM` };
  if (f.type === 'days') { const s = String(v).replace(/[^0-6]/g, ''); return s ? { v: [...new Set(s)].sort().join('') } : { err: 'Cochez au moins un jour' }; }
  if (f.type === 'password') return /^[\x21-\x39\x3b-\x7e]{1,32}$/.test(String(v)) ? { v: String(v) } : { err: `${f.label} : 1 à 32 caractères, sans espace ni « : »` };
  if (f.type === 'select') return f.options.some(([o]) => o === String(v)) ? { v: String(v) } : { err: `${f.label} : valeur inconnue` };
  return { v: String(v) };
}
