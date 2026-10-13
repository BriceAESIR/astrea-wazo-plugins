# Astrea Admin Tools for Wazo

Plugin Portal Wazo (E-UC) : un menu **Astrea Admin Tools** dans le portail,
un sous-menu par outil. Installation : [INSTALLATION.md](INSTALLATION.md).

| Module | Dossier | État |
|---|---|---|
| BLF Manager : touches de fonction, pages, modules, étiquettes, déploiement en masse, touches ligne Yealink | [blf/](blf/README.md) | En service (pause) |

## Organisation

```
admin-tools/
  manifest.json    un seul manifest : une entrée de menu par module (parent « Astrea Admin Tools »)
  icon.svg         icône du plugin ; menu.svg = icône du menu
  INSTALLATION.md  tutoriel
  common/          partagé par tous les modules : style.css (charte du portail), SDK officiel (vendor/)
  blf/             module BLF Manager (index.html, app.js)
```

Ajouter un module : un dossier `<module>/` avec son `index.html`, qui charge
`../common/style.css` et le SDK depuis `../common/vendor/`, plus une entrée
`staticTabs` dans `manifest.json` (`context: ["pbxMenu"]`,
`parent: "Astrea Admin Tools"`, `parentIcon: "./menu.svg"`,
`contentUrl: "./<module>/index.html?v=<version>"`).

Les besoins côté serveur (options provd lues par le `base.tpl` personnalisé
des postes) sont installés par les scripts de [../provd/](../provd/README.md).
