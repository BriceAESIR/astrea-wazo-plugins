# Astrea Admin Tools for Wazo

Plugin Portal Wazo (E-UC) : un menu **Astrea Admin Tools** dans le portail,
un sous-menu par outil. Installation : [INSTALLATION.md](INSTALLATION.md).

| Module | Dossier | État |
|---|---|---|
| BLF Manager : touches de fonction, pages, modules, étiquettes, déploiement en masse, touches ligne Yealink | [blf/](blf/README.md) | En service (pause) |
| Phone Manager : bases DECT (comptes utilisés/max, alertes, affecter / retirer / glisser-déposer les comptes) et configuration des appareils Yealink (options du catalogue, par appareil ou en masse) | [phones/](phones/README.md) | 0.20 : DECT en lecture validé ; configuration à tester en réel |
| User Manager : audit des réglages des utilisateurs (renvois, services, renvois par défaut, messagerie, musique d'attente, groupes, droits), repérage des écarts, modification en masse avec sauvegarde | [users/](users/README.md) | 0.25 : audit validé en réel ; modification en masse (assistant, rechargements regroupés) à tester en réel |

## Organisation

```
admin-tools/
  manifest.json    un seul manifest : une entrée de menu par module (parent « Astrea Admin Tools »)
  icon.svg         icône du plugin ; menu.svg = icône du menu
  INSTALLATION.md  tutoriel
  common/          partagé par tous les modules : style.css (charte du portail), core.js (connexion, API confd, thème, dialogues), SDK officiel (vendor/)
  blf/             module BLF Manager (index.html, app.js ; pas encore sur core.js)
  phones/          module Phone Manager (index.html, app.js, catalog.js = options Yealink, phones.css)
  users/           module User Manager (index.html, app.js, users.css)
```

Ajouter un module : un dossier `<module>/` avec son `index.html`, qui charge
`../common/style.css` et le SDK depuis `../common/vendor/`, plus une entrée
`staticTabs` dans `manifest.json` (`context: ["pbxMenu"]`,
`parent: "Astrea Admin Tools"`, `parentIcon: "./menu.svg"`,
`contentUrl: "./<module>/index.html?v=<version>"`).

Les besoins côté serveur (options provd lues par le `base.tpl` personnalisé
des postes) sont installés par les scripts de [../provd/](../provd/README.md).
