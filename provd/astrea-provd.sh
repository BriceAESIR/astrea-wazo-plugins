#!/usr/bin/env bash
# =============================================================================
# Astrea - provd Yealink : installe (ou retire) les blocs Astrea dans les
# templates personnalisés des plugins provd wazo-yealink-* (méthode officielle
# Wazo : var/templates/). Les blocs lisent les options provd de l'appareil
# écrites par « Astrea Admin Tools » :
#   - base.tpl (postes)      : touches ligne + étiquettes (BLF Manager),
#                              affichage adaptatif des contacts, paramètres
#                              Phone Manager (astrea_params) ;
#   - base-dect.tpl (bases)  : paramètres Phone Manager (astrea_params).
#
#   sudo bash astrea-provd.sh --dry-run          # montre, n'écrit rien
#   sudo bash astrea-provd.sh                    # installe / met à jour
#   sudo bash astrea-provd.sh --plugin wazo-yealink-v87
#   sudo bash astrea-provd.sh --remove           # retire les blocs (purge)
#
# - Contrôle avant écriture : les blocs sont rendus par Jinja (Python de la
#   stack) avec un appareil fictif ; en cas d'erreur, rien n'est écrit.
# - Idempotent : tout ancien bloc Astrea (v1 à v5) est remplacé.
# - Sauvegarde horodatée de chaque fichier modifié (<fichier>.astrea-AAAAMMJJ-HHMMSS).
# - Sans template personnalisé, copie d'abord celui du plugin (doc Wazo).
# - Ne régénère pas les appareils : enregistrer dans l'appli, ou reconfigure.
# - Les blocs sont embarqués en base64 (le dépôt public n'accepte pas la
#   syntaxe Jinja en clair).
# =============================================================================
set -euo pipefail

BLOCK_VERSION="v5"
PLUGINS_DIR="/var/lib/wazo-provd/plugins"
BASE_B64="eyMtIEFzdHJlYSB2NSA6IHRvdWNoZXMgbGlnbmUgKyDDqXRpcXVldHRlcyAoYXN0cmVhX2xpbmVrZXlzIC8gYXN0cmVhX2xpbmVsYWJlbHMpLCBhZmZpY2hhZ2UgYWRhcHRhdGlmLCBwYXJhbcOodHJlcyBQaG9uZSBNYW5hZ2VyIChhc3RyZWFfcGFyYW1zKSAtI30KeyUgc2V0IGFzdHJlYV9vcHQgPSBYWF9vcHRpb25zLmdldCgnYXN0cmVhX2xpbmVrZXlzJywgMSkgLSV9CnslIHNldCBhc3RyZWFfbWFwID0gYXN0cmVhX29wdCBpZiBhc3RyZWFfb3B0IGlzIG1hcHBpbmcgZWxzZSB7JzEnOiBhc3RyZWFfb3B0fSAtJX0KeyUgc2V0IGFzdHJlYV9sYiA9IFhYX29wdGlvbnMuZ2V0KCdhc3RyZWFfbGluZWxhYmVscycpIC0lfQp7JSBzZXQgYXN0cmVhX2xiID0gYXN0cmVhX2xiIGlmIGFzdHJlYV9sYiBpcyBtYXBwaW5nIGVsc2Uge30gLSV9CnslIHNldCBhc3RyZWFfbWF4ID0gKChhc3RyZWFfbWFwLnZhbHVlcygpfG1hcCgnaW50Jyl8bGlzdCkgKyBbMV0pfG1heCAtJX0KZmVhdHVyZXMuYXV0b19saW5la2V5cy5lbmFibGUgPSAwCnslIGZvciBhc3RyZWFfbm8sIGFzdHJlYV9saW5lIGluIFhYX3NpcF9saW5lc3xkaWN0c29ydCBpZiBhc3RyZWFfbGluZSAtJX0KYWNjb3VudC57eyBhc3RyZWFfbm8gfX0ubnVtYmVyX29mX2xpbmVrZXkgPSAxCmFjY291bnQue3sgYXN0cmVhX25vIH19LmF1dG9fbGFiZWwuZW5hYmxlID0gMAp7JSBlbmRmb3IgLSV9CnslIGlmIGFzdHJlYV9tYXggPiAxIG9yIGFzdHJlYV9sYiAtJX0KeyUgc2V0IGFzdHJlYSA9IG5hbWVzcGFjZShwb3M9MSkgLSV9CnslIGZvciBhc3RyZWFfbm8sIGFzdHJlYV9saW5lIGluIFhYX3NpcF9saW5lc3xkaWN0c29ydCBpZiBhc3RyZWFfbGluZSAtJX0KeyUgc2V0IGFzdHJlYV9udW0gPSBhc3RyZWFfbGluZS5nZXQoJ251bWJlcicpIG9yICcnIC0lfQp7JSBzZXQgYXN0cmVhX3RwbCA9IChhc3RyZWFfbGIuZ2V0KGFzdHJlYV9ubykgb3IgJycpfHN0cmluZ3xyZXBsYWNlKCdccicsICcgJyl8cmVwbGFjZSgnXG4nLCAnICcpfHJlcGxhY2UoJyVOVUxMJScsICcnKXx0cnVuY2F0ZSgyMCwgVHJ1ZSwgJycpIC0lfQp7JSBmb3IgaSBpbiByYW5nZShhc3RyZWFfbWFwLmdldChhc3RyZWFfbm8sIDEpfGludCkgLSV9CmxpbmVrZXkue3sgYXN0cmVhLnBvcyB9fS50eXBlID0gMTUKbGluZWtleS57eyBhc3RyZWEucG9zIH19LmxpbmUgPSB7eyBhc3RyZWFfbm8gfX0KbGluZWtleS57eyBhc3RyZWEucG9zIH19LnZhbHVlID0ge3sgYXN0cmVhX251bSB9fQpsaW5la2V5Lnt7IGFzdHJlYS5wb3MgfX0ubGFiZWwgPSB7eyBhc3RyZWFfdHBsfHJlcGxhY2UoJ3tufScsIGxvb3AuaW5kZXh8c3RyaW5nKXxyZXBsYWNlKCd7bnVtfScsIGFzdHJlYV9udW0pIGlmIGFzdHJlYV90cGwgZWxzZSBhc3RyZWFfbnVtIH19CnslIHNldCBhc3RyZWEucG9zID0gYXN0cmVhLnBvcyArIDEgLSV9CnslIGVuZGZvciAtJX0KeyUgZW5kZm9yIC0lfQp7JSBlbmRpZiAtJX0KcGhvbmVfc2V0dGluZy5jb250YWN0X3Bob3RvX2Rpc3BsYXkuZW5hYmxlID0gMgp7IyBQYXJhbcOodHJlcyBBc3RyZWEgKFBob25lIE1hbmFnZXIpIDogb3B0aW9uIHByb3ZkIGFzdHJlYV9wYXJhbXMgPSB7ICJjbMOpLnllYWxpbmsiOiAidmFsZXVyIiB9LgogICAgw4ljcml0cyBlbiBkZXJuaWVyIDogaWxzIGwnZW1wb3J0ZW50IHN1ciBjZSBxdWkgcHLDqWPDqGRlLiBDbMOpcyBsaW1pdMOpZXMgw6AgbGV0dHJlcywgY2hpZmZyZXMsIMKrIC4gwrsgZXQgwqsgXyDCuyA7IHZhbGV1cnMgc3VyIHVuZSBsaWduZS4gI30KeyUgc2V0IGFzdHJlYV9wID0gWFhfb3B0aW9ucy5nZXQoJ2FzdHJlYV9wYXJhbXMnKSAtJX0KeyUgaWYgYXN0cmVhX3AgaXMgbWFwcGluZyAtJX0KeyUgZm9yIGFzdHJlYV9rLCBhc3RyZWFfdiBpbiBhc3RyZWFfcHxkaWN0c29ydCAtJX0KeyUgaWYgYXN0cmVhX2sgaXMgc3RyaW5nIGFuZCBhc3RyZWFfdiBpcyBub3Qgbm9uZSBhbmQgKGFzdHJlYV9rfHJlcGxhY2UoJy4nLCAnJyl8cmVwbGFjZSgnXycsICcnKSkuaXNhbG51bSgpIC0lfQp7eyBhc3RyZWFfayB9fSA9IHt7IGFzdHJlYV92fHN0cmluZ3xyZXBsYWNlKCdccicsICcgJyl8cmVwbGFjZSgnXG4nLCAnICcpIH19CnslIGVuZGlmIC0lfQp7JSBlbmRmb3IgLSV9CnslIGVuZGlmIC0lfQo="
DECT_B64="eyMtIEFzdHJlYSB2NSAoREVDVCkgOiBwYXJhbcOodHJlcyBQaG9uZSBNYW5hZ2VyIChvcHRpb24gcHJvdmQgYXN0cmVhX3BhcmFtcyksIGFqb3V0w6lzIGVuIGZpbiBkZSBiYXNlLWRlY3QudHBsIC0jfQp7IyBQYXJhbcOodHJlcyBBc3RyZWEgKFBob25lIE1hbmFnZXIpIDogb3B0aW9uIHByb3ZkIGFzdHJlYV9wYXJhbXMgPSB7ICJjbMOpLnllYWxpbmsiOiAidmFsZXVyIiB9LgogICAgw4ljcml0cyBlbiBkZXJuaWVyIDogaWxzIGwnZW1wb3J0ZW50IHN1ciBjZSBxdWkgcHLDqWPDqGRlLiBDbMOpcyBsaW1pdMOpZXMgw6AgbGV0dHJlcywgY2hpZmZyZXMsIMKrIC4gwrsgZXQgwqsgXyDCuyA7IHZhbGV1cnMgc3VyIHVuZSBsaWduZS4gI30KeyUgc2V0IGFzdHJlYV9wID0gWFhfb3B0aW9ucy5nZXQoJ2FzdHJlYV9wYXJhbXMnKSAtJX0KeyUgaWYgYXN0cmVhX3AgaXMgbWFwcGluZyAtJX0KeyUgZm9yIGFzdHJlYV9rLCBhc3RyZWFfdiBpbiBhc3RyZWFfcHxkaWN0c29ydCAtJX0KeyUgaWYgYXN0cmVhX2sgaXMgc3RyaW5nIGFuZCBhc3RyZWFfdiBpcyBub3Qgbm9uZSBhbmQgKGFzdHJlYV9rfHJlcGxhY2UoJy4nLCAnJyl8cmVwbGFjZSgnXycsICcnKSkuaXNhbG51bSgpIC0lfQp7eyBhc3RyZWFfayB9fSA9IHt7IGFzdHJlYV92fHN0cmluZ3xyZXBsYWNlKCdccicsICcgJyl8cmVwbGFjZSgnXG4nLCAnICcpIH19CnslIGVuZGlmIC0lfQp7JSBlbmRmb3IgLSV9CnslIGVuZGlmIC0lfQo="

DRY=0; REMOVE=0; ONLY=""
usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }
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

# Début d'un bloc Astrea (toutes versions) et bloc de fin de base.tpl.
MARK_RE='^[{]#- Astrea'
MSP_RE='^[{]%[ ]*block model_specific_parameters'

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
printf '%s' "$BASE_B64" | base64 -d > "$TMP/base.blk"
printf '%s' "$DECT_B64" | base64 -d > "$TMP/dect.blk"
grep -q "Astrea $BLOCK_VERSION" "$TMP/base.blk" && grep -q "Astrea $BLOCK_VERSION" "$TMP/dect.blk" || { echo "Blocs embarqués invalides" >&2; exit 1; }

# Contrôle de rendu Jinja avec le Python de provd (ou celui du système).
if [ "$REMOVE" -eq 0 ]; then
  PY=""
  for c in /opt/venvs/wazo-provd/bin/python3 /usr/bin/python3; do
    if [ -x "$c" ] && "$c" -c 'import jinja2' 2>/dev/null; then PY="$c"; break; fi
  done
  if [ -z "$PY" ]; then
    echo "ATTENTION : Python avec jinja2 introuvable, contrôle de rendu impossible." >&2
    [ "$DRY" -eq 1 ] || { echo "Abandon par sécurité (relancer avec --dry-run pour voir les changements)." >&2; exit 1; }
  else
    "$PY" - "$TMP/base.blk" "$TMP/dect.blk" > "$TMP/render.txt" <<'PYEOF' || { echo "ERREUR : rendu Jinja des blocs Astrea en échec, rien n'est écrit." >&2; cat "$TMP/render.txt" >&2; exit 1; }
import sys, jinja2
env = jinja2.Environment()
lines = {'1': {'number': '8001'}, '2': {'number': '8002'}}
opts = {
    'astrea_linekeys': {'1': 3, '2': 2},
    'astrea_linelabels': {'1': 'Ligne {n}'},
    'astrea_params': {'voice.vad': '1', 'static.network.vlan.internet_port_vid': '7', 'bad key!': 'x'},
}
for path in sys.argv[1:]:
    out = env.from_string(open(path, encoding='utf-8').read()).render(XX_options=opts, XX_sip_lines=lines)
    assert 'voice.vad = 1' in out, path
    assert 'bad key' not in out, path
    if 'base.blk' in path:
        assert 'linekey.5.line = 2' in out, out
        assert 'linekey.2.label = Ligne 2' in out, out
    out_empty = env.from_string(open(path, encoding='utf-8').read()).render(XX_options={}, XX_sip_lines=lines)
    print('--- ' + path + ' ---')
    print(out)
print('RENDU OK')
PYEOF
    echo "Contrôle de rendu Jinja : OK ($PY)"
  fi
fi

shopt -s nullglob
plugins=( "$PLUGINS_DIR"/wazo-yealink-* )
[ ${#plugins[@]} -gt 0 ] || { echo "Aucun plugin wazo-yealink-* dans $PLUGINS_DIR"; exit 0; }

STAMP="$(date +%Y%m%d-%H%M%S)"
changed=0

# process <plugin_dir> <template> <bloc> <mode : before-msp | append>
process() {
  local p="$1" tpl="$2" blk="$3" mode="$4" name src custom
  name="$(basename "$p")"
  [ -f "$p/templates/$tpl" ] || return 0
  custom="$p/var/templates/$tpl"
  if [ -f "$custom" ]; then src="$custom"
  elif [ "$REMOVE" -eq 1 ]; then echo "• $name/$tpl : pas de template personnalisé, rien à retirer"; return 0
  else src="$p/templates/$tpl"; echo "• $name/$tpl : pas de template personnalisé, copie de l'original du plugin"
  fi
  if [ "$mode" = before-msp ]; then
    grep -qE "$MSP_RE" "$src" || { echo "• $name/$tpl : bloc model_specific_parameters introuvable, ignoré"; return 0; }
    # Retire tout bloc Astrea (du marqueur jusqu'au bloc de fin), réinsère le nouveau.
    awk -v blk="$blk" -v remove="$REMOVE" -v mre="$MARK_RE" -v bre="$MSP_RE" '
      BEGIN { while ((getline l < blk) > 0) b = b l "\n" }
      $0 ~ mre { skip = 1 }
      $0 ~ bre { skip = 0; if (remove != 1) printf "%s", b }
      !skip { print }
    ' "$src" > "$TMP/new.tpl"
  else
    # Bloc en fin de fichier : retire tout bloc Astrea (marqueur → fin), puis ajoute.
    awk -v blk="$blk" -v remove="$REMOVE" -v mre="$MARK_RE" '
      BEGIN { while ((getline l < blk) > 0) b = b l "\n" }
      $0 ~ mre { skip = 1 }
      !skip { print }
      END { if (remove != 1) printf "%s", b }
    ' "$src" > "$TMP/new.tpl"
  fi

  if [ -f "$custom" ] && cmp -s "$custom" "$TMP/new.tpl"; then
    echo "• $name/$tpl : déjà à jour ($( [ "$REMOVE" -eq 1 ] && echo 'aucun bloc Astrea' || echo "bloc $BLOCK_VERSION" ))"
    return 0
  fi
  [ "$(head -n 1 "$src")" = "$(head -n 1 "$TMP/new.tpl")" ] || { echo "• $name/$tpl : 1re ligne modifiée, abandon par sécurité" >&2; return 0; }

  echo "• $name/$tpl : $( [ "$REMOVE" -eq 1 ] && echo 'retrait du bloc Astrea' || echo "installation du bloc $BLOCK_VERSION" )"
  if [ "$DRY" -eq 1 ]; then
    diff -u "$src" "$TMP/new.tpl" | sed 's/^/    /' | head -n 80 || true
    return 0
  fi
  mkdir -p "$p/var/templates"
  [ -f "$custom" ] && cp -p "$custom" "$custom.astrea-$STAMP" && echo "    sauvegarde : $custom.astrea-$STAMP"
  cp "$TMP/new.tpl" "$custom"; chmod 644 "$custom"
  if [ "$REMOVE" -eq 1 ]; then grep -q "Astrea" "$custom" && echo "    ATTENTION : un bloc Astrea subsiste" >&2
  else grep -q "Astrea $BLOCK_VERSION" "$custom" || echo "    ATTENTION : bloc non trouvé après écriture" >&2
  fi
  changed=$((changed + 1))
}

for p in "${plugins[@]}"; do
  [ -n "$ONLY" ] && [ "$(basename "$p")" != "$ONLY" ] && continue
  process "$p" base.tpl "$TMP/base.blk" before-msp
  process "$p" base-dect.tpl "$TMP/dect.blk" append
done

echo
if [ "$DRY" -eq 1 ]; then echo "Mode --dry-run : rien n'a été écrit."
elif [ "$changed" -gt 0 ]; then
  echo "$changed template(s) modifié(s). Étapes suivantes :"
  echo "  1. Régénérer les appareils : enregistrer dans « Astrea Admin Tools »,"
  echo "     ou reconfigure + synchronize des appareils concernés."
  echo "  2. Contrôler un appareil : head -n 1 <plugin>/var/tftpboot/<mac>.cfg  (doit commencer par #!version)"
  echo "  3. Annuler : remettre la sauvegarde <template>.astrea-$STAMP puis régénérer."
else echo "Rien à modifier."
fi
