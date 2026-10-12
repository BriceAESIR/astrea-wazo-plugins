# Plugin Portal « Touches des postes »

Onglet **Touches** dans la fiche utilisateur du portail Wazo, et vue globale
**Touches des postes**. L'appli lit et écrit directement les touches des postes
du serveur ouvert dans le portail, avec le token que fournit le portail.

- tuiles par position, avec la numérotation exacte du plugin Yealink de Wazo ;
  les modules EXP s'affichent au besoin ;
- *Vider* : la case reste vide. *Supprimer* : les touches suivantes remontent.
  *Insérer avant* ajoute une case vide, ◀ ▶ déplacent une touche ;
- **touches ligne** (bouton − / +) : les touches suivent. Le nombre est
  enregistré dans le champ `userfield` de l'utilisateur (`blf-linekeys=N`).
  C'est le stack plugin `astrea/blf-sync` qui l'applique sur le poste ;
- l'utilisateur lui-même n'est jamais proposé comme cible ; une touche vers
  un utilisateur supprimé apparaît en rouge pointillé ;
- récapitulatif avant/après avant chaque enregistrement, puis resynchro du
  poste (optionnelle) ;
- onglet **Libellés** : repère les touches dont le libellé ne correspond plus
  au nom du collègue (renommage) et les corrige en lot, sur les touches cochées.

## Déploiement (doc Wazo : developers.wazo.io/docs/plugins/ui/deploy)

1. Copier ce dossier sur un serveur web **public en HTTPS**, avec l'en-tête
   CORS sur `manifest.json` (voir `nginx.conf.example`).
2. Portail E-UC → **Plugins > Portal** → **Install** → URL du `manifest.json`.
3. Activer pour tous ou seulement pour certains administrateurs.

Aucune dépendance externe : le SDK officiel `@wazo/euc-plugins-sdk` 1.1.1 est
embarqué dans `vendor/` (licence MIT).

## Test hors portail

Ouvrir `index.html` directement dans un navigateur, puis se connecter avec
l'adresse du serveur et un identifiant ou un token. C'est la même appli,
sans le portail. Le serveur doit accepter le CORS depuis l'origine de la
page ; confd l'accepte par défaut.

## À vérifier à la première installation

- **Fiche utilisateur** : la doc ne dit pas comment l'onglet `pbx.users`
  reçoit l'utilisateur affiché. Pour l'onglet `contactTab`, il arrive dans
  `extra`. L'appli cherche donc d'abord un uuid d'utilisateur connu dans
  `extra`, puis dans l'URL. Si elle ne trouve rien, elle affiche la liste des
  utilisateurs. Si l'onglet n'ouvre pas le bon utilisateur, fais une copie
  du contenu de `extra` depuis la console du navigateur
  (`__blfSdk.getContext().app.extra`, dans le cadre du plugin) : je saurai alors où le chercher.
- **Menu** : le contexte `pbxMenu` et l'icône `Dialpad` sont repris de la doc.
  Il faudra peut-être les ajuster selon l'endroit où le lien apparaît.
- **Droits** : le token du portail doit pouvoir modifier les touches et le
  `userfield` des utilisateurs.

## Cohabitation avec le fichier YAML du stack plugin

Chaque utilisateur est géré **soit** par le portail, **soit** par
`/etc/wazo-blf-sync/config.yml`, jamais par les deux. En mode miroir, le YAML
écraserait toutes les 15 min ce qui a été fait dans le portail. Le plus
simple : laisser le YAML vide et ne s'en servir que pour les imports en
masse ponctuels.
