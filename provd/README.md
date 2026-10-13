# Astrea - provd : blocs Yealink pour Astrea Admin Tools

Script d'installation des blocs Astrea (v5) dans les templates personnalisés
des plugins provd `wazo-yealink-*` d'une stack Wazo. Ces blocs appliquent sur
les appareils les réglages faits dans le plugin Portal « Astrea Admin Tools » :

| Template | Contenu du bloc |
|---|---|
| `base.tpl` (postes) | touches ligne et leurs étiquettes (BLF Manager : options provd `astrea_linekeys` / `astrea_linelabels`), affichage adaptatif des contacts, paramètres Phone Manager (`astrea_params`) |
| `base-dect.tpl` (bases DECT, plugin v87) | paramètres Phone Manager (`astrea_params`) |

## Utilisation (sur la stack, en root)

```bash
curl -fsSLO https://briceaesir.github.io/astrea-wazo-plugins/provd/astrea-provd.sh
sha256sum astrea-provd.sh     # comparer avec la valeur ci-dessous
less astrea-provd.sh          # relire avant d'exécuter
sudo bash astrea-provd.sh --dry-run
sudo bash astrea-provd.sh
```

SHA-256 de la version publiée : `63f2b825b6b28293eec3bbdb9dda95c99031e3e67d13833b7d72e7ff7419a5aa`

Options :

| Option | Effet |
|---|---|
| `--dry-run` | Montre les différences, n'écrit rien |
| `--plugin wazo-yealink-v87` | Un seul plugin (sinon tous les `wazo-yealink-*`) |
| `--remove` | Retire les blocs Astrea (retour aux templates sans Astrea) |

Comportement :

- contrôle avant écriture : les blocs sont rendus par Jinja (Python de la
  stack) avec un appareil fictif ; en cas d'erreur, rien n'est écrit ;
- idempotent : tout ancien bloc Astrea (v1 à v5) est remplacé ;
- sauvegarde horodatée de chaque template modifié (`<template>.astrea-AAAAMMJJ-HHMMSS`) ;
- sans template personnalisé, copie d'abord celui du plugin (procédure Wazo) ;
- abandonne si la première ligne du fichier change (l'appareil rejetterait sa configuration) ;
- ne régénère pas les appareils : enregistrer dans l'appli, ou reconfigure + synchronize.

Après installation, contrôler un appareil :
`head -n 1 /var/lib/wazo-provd/plugins/<plugin>/var/tftpboot/<mac>.cfg` doit
commencer par `#!version`.

À refaire après l'installation d'un nouveau plugin provd Yealink (les templates
personnalisés ne sont pas recopiés) ; une désinstallation du plugin efface son
dossier, templates compris.

Ancien script `astrea-provd-linekeys.sh` (bloc v4, touches ligne seulement) :
remplacé par celui-ci, qui reprend les touches ligne à l'identique.
