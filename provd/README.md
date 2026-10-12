# Astrea - provd : touches ligne Yealink

Script d'installation du bloc Astrea (v4) dans le `base.tpl` personnalisé des
plugins provd `wazo-yealink-*` d'une stack Wazo. Ce bloc applique sur les
postes les touches ligne et leurs étiquettes réglées dans le plugin Portal
« ASTREA - BLF Manager » (options provd `astrea_linekeys` / `astrea_linelabels`).

## Utilisation (sur la stack, en root)

```bash
curl -fsSLO https://briceaesir.github.io/astrea-wazo-plugins/provd/astrea-provd-linekeys.sh
sha256sum astrea-provd-linekeys.sh     # comparer avec la valeur ci-dessous
less astrea-provd-linekeys.sh          # relire avant d'exécuter
sudo bash astrea-provd-linekeys.sh --dry-run
sudo bash astrea-provd-linekeys.sh
```

SHA-256 de la version publiée : `39e7715e776682847283321e0805ae48079469984794fe08392d891bfdf6d3d0`

Options :

| Option | Effet |
|---|---|
| `--dry-run` | Montre les différences, n'écrit rien |
| `--plugin wazo-yealink-v86` | Un seul plugin (sinon tous les `wazo-yealink-*`) |
| `--remove` | Retire le bloc Astrea (retour au base.tpl sans Astrea) |

Comportement :

- idempotent : un ancien bloc Astrea (v1 à v4) est retiré avant l'insertion ;
- sauvegarde horodatée de chaque `base.tpl` modifié (`base.tpl.astrea-AAAAMMJJ-HHMMSS`) ;
- sans `base.tpl` personnalisé, copie d'abord celui du plugin (procédure Wazo) ;
- abandonne si la première ligne du fichier change (le poste rejetterait sa configuration) ;
- ne régénère pas les postes : enregistrer dans l'appli, ou reconfigure + synchronize.

Après installation, contrôler un poste :
`head -n 1 /var/lib/wazo-provd/plugins/<plugin>/var/tftpboot/<mac>.cfg` doit
commencer par `#!version`.

À refaire après l'installation d'un nouveau plugin provd Yealink (les templates
personnalisés ne sont pas recopiés) ; une désinstallation du plugin efface son
dossier, templates compris.
