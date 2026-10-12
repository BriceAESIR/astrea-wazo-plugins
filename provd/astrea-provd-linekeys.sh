#!/usr/bin/env bash
# =============================================================================
# Astrea - touches ligne Yealink : installe (ou retire) le bloc Astrea dans le
# base.tpl personnalisé des plugins provd wazo-yealink-* (méthode officielle
# Wazo : var/templates/base.tpl). Le bloc lit les options provd du poste
# astrea_linekeys / astrea_linelabels écrites par « ASTREA - BLF Manager ».
#
#   sudo bash astrea-provd-linekeys.sh --dry-run          # montre, n'écrit rien
#   sudo bash astrea-provd-linekeys.sh                    # installe / met à jour
#   sudo bash astrea-provd-linekeys.sh --plugin wazo-yealink-v86
#   sudo bash astrea-provd-linekeys.sh --remove           # retire le bloc (purge)
#
# - Idempotent : tout ancien bloc Astrea (v1 à v4) est retiré avant insertion.
# - Sauvegarde horodatée de chaque base.tpl modifié (base.tpl.astrea-AAAAMMJJ-HHMMSS).
# - Sans base.tpl personnalisé, copie d'abord celui du plugin (doc Wazo).
# - Ne régénère pas les postes : enregistrer dans l'appli, ou reconfigure provd.
# - Le bloc est embarqué en base64 (le dépôt public n'accepte pas la syntaxe
#   Jinja en clair).
# =============================================================================
set -euo pipefail

BLOCK_VERSION="v4"
PLUGINS_DIR="/var/lib/wazo-provd/plugins"
BLOCK_B64="eyMtIEFzdHJlYSB2NCA6IHRvdWNoZXMgbGlnbmUgcG9zw6llcyBleHBsaWNpdGVtZW50ICsgw6l0aXF1ZXR0ZXMsIG9wdGlvbnMgcHJvdmQgYXN0cmVhX2xpbmVrZXlzIC8gYXN0cmVhX2xpbmVsYWJlbHMgLSN9CnslIHNldCBhc3RyZWFfb3B0ID0gWFhfb3B0aW9ucy5nZXQoJ2FzdHJlYV9saW5la2V5cycsIDEpIC0lfQp7JSBzZXQgYXN0cmVhX21hcCA9IGFzdHJlYV9vcHQgaWYgYXN0cmVhX29wdCBpcyBtYXBwaW5nIGVsc2UgeycxJzogYXN0cmVhX29wdH0gLSV9CnslIHNldCBhc3RyZWFfbGIgPSBYWF9vcHRpb25zLmdldCgnYXN0cmVhX2xpbmVsYWJlbHMnKSAtJX0KeyUgc2V0IGFzdHJlYV9sYiA9IGFzdHJlYV9sYiBpZiBhc3RyZWFfbGIgaXMgbWFwcGluZyBlbHNlIHt9IC0lfQp7JSBzZXQgYXN0cmVhX21heCA9ICgoYXN0cmVhX21hcC52YWx1ZXMoKXxtYXAoJ2ludCcpfGxpc3QpICsgWzFdKXxtYXggLSV9CmZlYXR1cmVzLmF1dG9fbGluZWtleXMuZW5hYmxlID0gMAp7JSBmb3IgYXN0cmVhX25vLCBhc3RyZWFfbGluZSBpbiBYWF9zaXBfbGluZXN8ZGljdHNvcnQgaWYgYXN0cmVhX2xpbmUgLSV9CmFjY291bnQue3sgYXN0cmVhX25vIH19Lm51bWJlcl9vZl9saW5la2V5ID0gMQphY2NvdW50Lnt7IGFzdHJlYV9ubyB9fS5hdXRvX2xhYmVsLmVuYWJsZSA9IDAKeyUgZW5kZm9yIC0lfQp7JSBpZiBhc3RyZWFfbWF4ID4gMSBvciBhc3RyZWFfbGIgLSV9CnslIHNldCBhc3RyZWEgPSBuYW1lc3BhY2UocG9zPTEpIC0lfQp7JSBmb3IgYXN0cmVhX25vLCBhc3RyZWFfbGluZSBpbiBYWF9zaXBfbGluZXN8ZGljdHNvcnQgaWYgYXN0cmVhX2xpbmUgLSV9CnslIHNldCBhc3RyZWFfbnVtID0gYXN0cmVhX2xpbmUuZ2V0KCdudW1iZXInKSBvciAnJyAtJX0KeyUgc2V0IGFzdHJlYV90cGwgPSAoYXN0cmVhX2xiLmdldChhc3RyZWFfbm8pIG9yICcnKXxzdHJpbmd8cmVwbGFjZSgnXHInLCAnICcpfHJlcGxhY2UoJ1xuJywgJyAnKXxyZXBsYWNlKCclTlVMTCUnLCAnJyl8dHJ1bmNhdGUoMjAsIFRydWUsICcnKSAtJX0KeyUgZm9yIGkgaW4gcmFuZ2UoYXN0cmVhX21hcC5nZXQoYXN0cmVhX25vLCAxKXxpbnQpIC0lfQpsaW5la2V5Lnt7IGFzdHJlYS5wb3MgfX0udHlwZSA9IDE1CmxpbmVrZXkue3sgYXN0cmVhLnBvcyB9fS5saW5lID0ge3sgYXN0cmVhX25vIH19CmxpbmVrZXkue3sgYXN0cmVhLnBvcyB9fS52YWx1ZSA9IHt7IGFzdHJlYV9udW0gfX0KbGluZWtleS57eyBhc3RyZWEucG9zIH19LmxhYmVsID0ge3sgYXN0cmVhX3RwbHxyZXBsYWNlKCd7bn0nLCBsb29wLmluZGV4fHN0cmluZyl8cmVwbGFjZSgne251bX0nLCBhc3RyZWFfbnVtKSBpZiBhc3RyZWFfdHBsIGVsc2UgYXN0cmVhX251bSB9fQp7JSBzZXQgYXN0cmVhLnBvcyA9IGFzdHJlYS5wb3MgKyAxIC0lfQp7JSBlbmRmb3IgLSV9CnslIGVuZGZvciAtJX0KeyUgZW5kaWYgLSV9Cg=="

DRY=0; REMOVE=0; ONLY=""
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --remove) REMOVE=1 ;;
    --plugin) ONLY="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue : $1 (voir --help)" >&2; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { echo "À lancer en root : sudo bash $0" >&2; exit 1; }
command -v base64 >/dev/null && command -v awk >/dev/null || { echo "base64 et awk sont requis" >&2; exit 1; }

# Début d'un bloc Astrea (toutes versions) et ligne du bloc de fin de base.tpl.
MARK_RE='^[{]#- Astrea'
MSP_RE='^[{]%[ ]*block model_specific_parameters'

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
printf '%s' "$BLOCK_B64" | base64 -d > "$TMP/block.tpl"
grep -q "Astrea $BLOCK_VERSION" "$TMP/block.tpl" || { echo "Bloc embarqué invalide" >&2; exit 1; }

shopt -s nullglob
plugins=( "$PLUGINS_DIR"/wazo-yealink-* )
[ ${#plugins[@]} -gt 0 ] || { echo "Aucun plugin wazo-yealink-* dans $PLUGINS_DIR"; exit 0; }

STAMP="$(date +%Y%m%d-%H%M%S)"
changed=0
for p in "${plugins[@]}"; do
  name="$(basename "$p")"
  [ -n "$ONLY" ] && [ "$name" != "$ONLY" ] && continue
  [ -f "$p/templates/base.tpl" ] || { echo "• $name : pas de templates/base.tpl, ignoré"; continue; }
  custom="$p/var/templates/base.tpl"
  if [ -f "$custom" ]; then src="$custom"
  elif [ "$REMOVE" -eq 1 ]; then echo "• $name : pas de base.tpl personnalisé, rien à retirer"; continue
  else src="$p/templates/base.tpl"; echo "• $name : pas de base.tpl personnalisé, copie de l'original du plugin"
  fi
  if ! grep -qE "$MSP_RE" "$src"; then echo "• $name : bloc model_specific_parameters introuvable, ignoré"; continue; fi

  # Retire tout bloc Astrea (du marqueur jusqu'au bloc de fin), réinsère le v4.
  awk -v blk="$TMP/block.tpl" -v remove="$REMOVE" -v mre="$MARK_RE" -v bre="$MSP_RE" '
    BEGIN { while ((getline l < blk) > 0) b = b l "\n" }
    $0 ~ mre { skip = 1 }
    $0 ~ bre { skip = 0; if (remove != 1) printf "%s", b }
    !skip { print }
  ' "$src" > "$TMP/new.tpl"

  if [ -f "$custom" ] && cmp -s "$custom" "$TMP/new.tpl"; then
    echo "• $name : déjà à jour ($( [ "$REMOVE" -eq 1 ] && echo 'aucun bloc Astrea' || echo "bloc $BLOCK_VERSION" ))"
    continue
  fi
  [ "$(head -n 1 "$src")" = "$(head -n 1 "$TMP/new.tpl")" ] || { echo "• $name : 1re ligne modifiée, abandon par sécurité" >&2; continue; }

  echo "• $name : $( [ "$REMOVE" -eq 1 ] && echo 'retrait du bloc Astrea' || echo "installation du bloc $BLOCK_VERSION" )"
  if [ "$DRY" -eq 1 ]; then
    diff -u "$src" "$TMP/new.tpl" | sed 's/^/    /' | head -n 60 || true
    continue
  fi
  mkdir -p "$p/var/templates"
  [ -f "$custom" ] && cp -p "$custom" "$custom.astrea-$STAMP" && echo "    sauvegarde : $custom.astrea-$STAMP"
  cp "$TMP/new.tpl" "$custom"; chmod 644 "$custom"
  if [ "$REMOVE" -eq 1 ]; then grep -q "Astrea" "$custom" && echo "    ATTENTION : un bloc Astrea subsiste" >&2
  else grep -q "Astrea $BLOCK_VERSION" "$custom" || echo "    ATTENTION : bloc non trouvé après écriture" >&2
  fi
  changed=$((changed + 1))
done

echo
if [ "$DRY" -eq 1 ]; then echo "Mode --dry-run : rien n'a été écrit."
elif [ "$changed" -gt 0 ]; then
  echo "$changed base.tpl modifié(s). Étapes suivantes :"
  echo "  1. Régénérer les postes : enregistrer dans « ASTREA - BLF Manager »,"
  echo "     ou reconfigure + synchronize des postes concernés."
  echo "  2. Contrôler un poste : head -n 1 <plugin>/var/tftpboot/<mac>.cfg  (doit commencer par #!version)"
  echo "  3. Annuler : remettre la sauvegarde base.tpl.astrea-$STAMP puis régénérer."
else echo "Rien à modifier."
fi
