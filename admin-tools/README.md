# Astrea Admin Tools for Wazo

Plugin Portal Wazo (E-UC) : un menu **Astrea Admin Tools** dans le portail,
un sous-menu par outil. Installation : [INSTALLATION.md](INSTALLATION.md).

| Module | Dossier | État |
|---|---|---|
| BLF Manager : touches de fonction, pages, modules, étiquettes, déploiement en masse, touches ligne Yealink | [blf/](blf/README.md) | En service (pause) |
| DECT Manager : bases DECT (Yealink W70B/W75/W80/W90, Gigaset Nx70), comptes utilisés/max, alertes, affecter / retirer / déplacer une ligne, synchroniser | [dect/](dect/README.md) | 0.18 : à tester en réel |

## Organisation

```
admin-tools/
  manifest.json    un seul manifest : une entrée de menu par module (parent « Astrea Admin Tools »)
  icon.svg         icône du plugin ; menu.svg = icône du menu
  INSTALLATION.md  tutoriel
  common/          partagé par tous les modules : style.css (charte du portail), core.js (connexion, API confd, thème, dialogues), SDK officiel (vendor/)
  blf/             module BLF Manager (index.html, app.js ; pas encore sur core.js)
  dect/            module DECT Manager (index.html, app.js, dect.css)
```

Ajouter un module : un dossier `<module>/` avec son `index.html`, qui charge
`../common/style.css` et le SDK depuis `../common/vendor/`, plus une entrée
`staticTabs` dans `manifest.json` (`context: ["pbxMenu"]`,
`parent: "Astrea Admin Tools"`, `parentIcon: "./menu.svg"`,
`contentUrl: "./<module>/index.html?v=<version>"`).

Les besoins côté serveur (options provd lues par le `base.tpl` personnalisé
des postes) sont installés par les scripts de [../provd/](../provd/README.md).
