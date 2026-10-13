# Installer « ASTREA - BLF Manager »

Tutoriel d'installation sur une stack Wazo Entreprise et son portail.
Deux parties indépendantes :

| Partie | Pour quoi | Où | Obligatoire |
|---|---|---|---|
| 1. Plugin Portal | Touches BLF, pages, modules, étiquettes, déploiement en masse | Portail Wazo (navigateur) | Oui |
| 2. Script provd | Plusieurs **touches ligne** par poste et leurs étiquettes (Yealink) | Serveur de la stack (SSH, root) | Seulement pour les touches ligne |

Sans la partie 2, tout fonctionne sauf les touches ligne : l'appli enregistre
le réglage, mais le téléphone garde une seule touche ligne.

---

## Partie 1 — Plugin Portal (5 minutes)

### Prérequis
- Un compte administrateur du portail E-UC qui peut installer des plugins.

### Étapes
1. Ouvrir le portail Wazo, menu **Plugins > Portal**, puis **Install**.
2. Coller l'URL du manifest :
   ```
   https://briceaesir.github.io/astrea-wazo-plugins/portal/blf/manifest.json
   ```
3. Valider, puis activer le plugin (pour tous les administrateurs ou seulement
   certains).
4. Ouvrir une stack client : le menu **ASTREA - BLF Manager** apparaît sous
   **Gestion des utilisateurs**.

### Vérifier
- La liste des utilisateurs à poste de bureau s'affiche à gauche.
  Les utilisateurs sans ligne, avec seulement un DECT ou une ligne analogique
  sont masqués (normal).
- Aucun bandeau rouge « Lecture seule ». Un bandeau orange « version non
  validée » est un simple avertissement : vérifier le résultat avant
  d'enregistrer.

### Mettre à jour
Rien à faire : le portail charge toujours la dernière version publiée.
Si l'ancienne version reste affichée : outils de développement du navigateur
(F12) → onglet Réseau → cocher « Désactiver le cache », puis Ctrl+F5.

---

## Partie 2 — Touches ligne : script provd (10 minutes par stack)

Le script ajoute un bloc « Astrea » au modèle de configuration personnalisé
(`var/templates/base.tpl`) de chaque plugin provd Yealink installé. C'est la
méthode prévue par la documentation Wazo pour personnaliser les fichiers des
postes. Le bloc lit les réglages enregistrés par l'appli et les traduit en
touches ligne sur le téléphone.

### Prérequis
- Accès SSH **root** au serveur de la stack.
- Au moins un plugin provd `wazo-yealink-*` installé.

### Étapes
1. Télécharger le script sur le serveur :
   ```bash
   curl -fsSLO https://briceaesir.github.io/astrea-wazo-plugins/provd/astrea-provd-linekeys.sh
   ```
2. Vérifier son empreinte (doit être identique à celle indiquée dans
   [provd/README.md](../../provd/README.md)) :
   ```bash
   sha256sum astrea-provd-linekeys.sh
   ```
3. Simulation, rien n'est écrit :
   ```bash
   sudo bash astrea-provd-linekeys.sh --dry-run
   ```
   Pour chaque plugin, le script dit ce qu'il ferait et montre les lignes
   ajoutées.
4. Installation :
   ```bash
   sudo bash astrea-provd-linekeys.sh
   ```
   Une sauvegarde `base.tpl.astrea-AAAAMMJJ-HHMMSS` est faite à côté de chaque
   fichier modifié.

### Vérifier sur un poste
1. Dans l'appli, ouvrir un utilisateur Yealink, passer à 2 touches ligne,
   enregistrer (le poste est resynchronisé automatiquement).
2. Le téléphone redémarre avec 2 touches ligne.
3. En cas de doute, sur le serveur, la 1re ligne du fichier du poste doit
   commencer par `#!version` :
   ```bash
   head -n 1 /var/lib/wazo-provd/plugins/<plugin>/var/tftpboot/<mac>.cfg
   ```

### Quand relancer le script
- Après l'installation d'un **nouveau plugin provd Yealink** (ex. passage de
  v86 à v87) : ses modèles personnalisés ne sont pas recopiés.
- Quand une nouvelle version du bloc est publiée.

Le script peut être relancé sans risque : il remplace l'ancien bloc et
n'ajoute jamais de doublon.

### Options
| Option | Effet |
|---|---|
| `--dry-run` | Montre les changements, n'écrit rien |
| `--plugin wazo-yealink-v86` | Un seul plugin |
| `--remove` | Retire le bloc Astrea |

---

## Désinstaller
1. Portail : **Plugins > Portal**, désinstaller « ASTREA - BLF Manager ».
   Les touches BLF restent dans Wazo (ce sont des touches Wazo standard).
2. Serveur, si le script a été passé :
   ```bash
   sudo bash astrea-provd-linekeys.sh --remove
   ```
   puis resynchroniser les postes concernés. Ils reviennent à une touche ligne.
   Les réglages `astrea_linekeys` / `astrea_linelabels` restés sur les postes
   dans provd sont ignorés sans le bloc.

## Dépannage
| Symptôme | Cause probable | Solution |
|---|---|---|
| Le nombre de touches ligne ne change pas sur le téléphone | Script non passé, ou nouveau plugin provd | Relancer le script, puis réenregistrer le poste dans l'appli |
| Le poste refuse sa configuration après une modification manuelle du `base.tpl` | La 1re ligne du fichier n'est plus `#!version` | Remettre la sauvegarde `base.tpl.astrea-…`, resynchroniser |
| Une touche modifiée sur le téléphone n'est plus mise à jour par Wazo | Modification locale prioritaire chez Yealink | Réinitialiser la touche sur le poste ; ne jamais modifier les touches sur le téléphone |
| Bandeau rouge « Lecture seule » | Réponse de Wazo au format inattendu (mise à jour de la stack) | Ne rien forcer ; envoyer le message et la console (F12) au support Astrea |
| Ancienne version de l'appli affichée | Cache du navigateur | F12, « Désactiver le cache », Ctrl+F5 |
