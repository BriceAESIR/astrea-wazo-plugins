#!/usr/bin/env bash
# =============================================================================
# Astrea - dialplan : installe (ou retire) les sous-routines Asterisk Astrea
# dans /etc/asterisk/extensions_extra.d/ d'une stack Wazo.
#
# Sous-routine fournie :
#   astrea-antiloop-groupcall : anti-boucle des groupes d'appel. Un appel
#   INTERNE qui arrive sur le groupe par le renvoi d'un utilisateur
#   (non-reponse, occupe, ne pas deranger, renvoi permanent, hors horaire)
#   ne fait pas sonner le groupe : message « injoignable » sans decrocher,
#   puis raccrochage « occupe ». Appels externes (SDA, meme transferes) et
#   appels directs au groupe : inchanges.
#   Activation groupe par groupe : champ « sous-routine » du groupe
#   (Call Flow ou Portal) = astrea-antiloop-groupcall.
#
#   sudo bash astrea-dialplan.sh --dry-run       # montre, n'ecrit rien
#   sudo bash astrea-dialplan.sh                 # installe / met a jour
#   sudo bash astrea-dialplan.sh --maxlen 4      # numeros internes <= 4 chiffres
#                                                # (defaut : valeur deja installee, sinon 6)
#   sudo bash astrea-dialplan.sh --remove        # retire la sous-routine
#
# - Idempotent ; sauvegarde horodatee dans /var/backups/astrea/ (jamais dans
#   extensions_extra.d : Wazo charge tous les fichiers de ce dossier).
# - Recharge le dialplan (dialplan reload) puis verifie le contexte.
# - Apres --remove, un groupe qui garde la sous-routine sonne normalement :
#   Wazo ignore une sous-routine absente.
# =============================================================================
set -euo pipefail

CTX="astrea-antiloop-groupcall"
DIALPLAN_DIR="/etc/asterisk/extensions_extra.d"
BACKUP_DIR="/var/backups/astrea"

DRY=0; REMOVE=0; MAXLEN=""
usage() { sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --remove) REMOVE=1 ;;
    --maxlen) MAXLEN="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue : $1 (voir --help)" >&2; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { echo "A lancer en root : sudo bash $0" >&2; exit 1; }
[ -d "$DIALPLAN_DIR" ] || { echo "$DIALPLAN_DIR introuvable : est-ce bien une stack Wazo ?" >&2; exit 1; }
F="$DIALPLAN_DIR/$CTX.conf"
# Sans --maxlen : garde la valeur deja installee, sinon 6.
if [ -z "$MAXLEN" ] && [ -f "$F" ]; then
  MAXLEN="$(sed -n 's/.*Set(ANTILOOP_MAXLEN=\([0-9]*\)).*/\1/p' "$F" | head -n 1)"
fi
MAXLEN="${MAXLEN:-6}"
[[ "$MAXLEN" =~ ^[0-9]{1,2}$ ]] || { echo "--maxlen : nombre attendu (ex. 4)" >&2; exit 2; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
STAMP="$(date +%Y%m%d-%H%M%S)"

cat > "$TMP/$CTX.conf" <<'CONFEOF'
; =====================================================================
; Astrea - anti-boucle pour groupe d'appel (installe par astrea-dialplan.sh)
; Contexte : astrea-antiloop-groupcall
; Activation : groupe > sous-routine (preprocess_subroutine) = astrea-antiloop-groupcall
;
; Bloque (groupe non sonne, message puis raccrochage) : appel INTERNE arrive
; sur le groupe par le renvoi d'un utilisateur.
; Passent toujours : appel entre par une SDA (WAZO_CALLORIGIN = extern), meme
; transfere ; appel direct au groupe ; numero appelant de plus de
; ANTILOOP_MAXLEN chiffres ; appel marque transfere (BLINDTRANSFER /
; ATTENDEDTRANSFER).
;
; Variables Wazo (verifiees dans wazo-asterisk-config, dialplan/) :
;   WAZO_CALLORIGIN     extensions_lib_did.conf (extern), extensions_lib_user.conf (intern)
;   WAZO_CALLFORWARDED  extensions_lib_user.conf, contexte forward (renvoi utilisateur)
;   WAZO_FWD_REFERER    extensions_lib_user.conf (user:<id>)
;   Sous-routine appelee avant la sonnerie : extensions_lib_group.conf
; Trace : asterisk -rvvv, lignes "Astrea antiloop".
; Ne pas modifier ici : relancer astrea-dialplan.sh (--maxlen N).
; =====================================================================

[astrea-antiloop-groupcall]
; Longueur maximale d'un numero interne.
exten = s,1,Set(ANTILOOP_MAXLEN=6)
same  = n,NoOp(Astrea antiloop : origine=${WAZO_CALLORIGIN} renvoi=${WAZO_CALLFORWARDED} par=${WAZO_FWD_REFERER} appelant=${CALLERID(num)} xfer=${BLINDTRANSFER}${ATTENDEDTRANSFER})
same  = n,GotoIf($["${WAZO_CALLORIGIN}" = "extern"]?ok)
same  = n,GotoIf($["${WAZO_CALLFORWARDED}" != "1"]?ok)
same  = n,GotoIf($["${CUT(WAZO_FWD_REFERER,:,1)}" != "user"]?ok)
same  = n,GotoIf($["${BLINDTRANSFER}${ATTENDEDTRANSFER}" != ""]?ok)
same  = n,GotoIf($[${LEN(${CALLERID(num)})} > ${ANTILOOP_MAXLEN}]?ok)
same  = n,NoOp(Astrea antiloop : appel interne renvoye, groupe non sonne)
; Message sans decrocher puis raccrochage "occupe" (cause 17).
same  = n,Progress()
same  = n,Playback(user-unreachable,noanswer)
same  = n,Hangup(17)
same  = n(ok),Return()
CONFEOF
sed -i "s/Set(ANTILOOP_MAXLEN=[0-9]*)/Set(ANTILOOP_MAXLEN=$MAXLEN)/" "$TMP/$CTX.conf"
grep -q "Set(ANTILOOP_MAXLEN=$MAXLEN)" "$TMP/$CTX.conf" || { echo "Erreur interne (ANTILOOP_MAXLEN)" >&2; exit 1; }

backup() {
  mkdir -p "$BACKUP_DIR"
  cp -p "$F" "$BACKUP_DIR/$CTX.conf.$STAMP"
  echo "  sauvegarde : $BACKUP_DIR/$CTX.conf.$STAMP"
}

if [ "$REMOVE" -eq 1 ]; then
  [ -f "$F" ] || { echo "$CTX : absente, rien a retirer."; exit 0; }
  echo "$CTX : retrait de $F"
  [ "$DRY" -eq 1 ] && { echo "Mode --dry-run : rien n'a ete ecrit."; exit 0; }
  backup; rm -f "$F"
else
  if [ -f "$F" ] && cmp -s "$F" "$TMP/$CTX.conf"; then
    echo "$CTX : deja a jour (ANTILOOP_MAXLEN=$MAXLEN)."; exit 0
  fi
  echo "$CTX : installation dans $F (ANTILOOP_MAXLEN=$MAXLEN)"
  if [ "$DRY" -eq 1 ]; then
    if [ -f "$F" ]; then diff -u "$F" "$TMP/$CTX.conf" || true; else sed 's/^/  + /' "$TMP/$CTX.conf"; fi
    echo "Mode --dry-run : rien n'a ete ecrit."; exit 0
  fi
  [ -f "$F" ] && backup
  cp "$TMP/$CTX.conf" "$F"; chmod 644 "$F"
fi

# Rechargement et verification.
if ! command -v asterisk >/dev/null 2>&1; then
  echo "ATTENTION : commande asterisk introuvable, faire « asterisk -rx \"dialplan reload\" » a la main." >&2; exit 1
fi
asterisk -rx "dialplan reload" >/dev/null || { echo "ATTENTION : dialplan reload en echec (Asterisk arrete ?)" >&2; exit 1; }
# Sortie capturee (pas de « | grep -q » : avec pipefail, le SIGPIPE fausserait le test).
show="$(asterisk -rx "dialplan show $CTX" 2>/dev/null || true)"
case "$show" in *"'$CTX'"*) loaded=1 ;; *) loaded=0 ;; esac
if [ "$REMOVE" -eq 1 ]; then
  [ "$loaded" -eq 0 ] && echo "Contexte retire d'Asterisk : OK" || { echo "ATTENTION : contexte encore charge" >&2; exit 1; }
else
  [ "$loaded" -eq 1 ] || { echo "ATTENTION : contexte non charge, voir : asterisk -rx \"dialplan show $CTX\"" >&2; exit 1; }
  echo "Contexte charge par Asterisk : OK"
  echo
  echo "Activer sur un groupe : champ « sous-routine » = $CTX (Call Flow ou Portal)."
  echo "Trace des decisions : asterisk -rvvv, lignes « Astrea antiloop »."
fi
