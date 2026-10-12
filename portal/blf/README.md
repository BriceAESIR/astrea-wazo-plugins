# Plugin Portal « Touches des postes »

Onglet **Touches** dans la fiche utilisateur du portail Wazo, et vue globale
**Touches des postes**. L'appli lit et écrit directement les touches des postes
du serveur ouvert dans le portail, avec le token que fournit le portail.

- tuiles par position, toutes marques de postes confondues. Profils
  constructeur dans `VENDORS` (`app.js`). Seul **Yealink** est vérifié :
  numérotation exacte du plugin Yealink de Wazo, modules EXP affichés au
  besoin, touches ligne multiples. Pour les autres marques, la grille est
  indicative (capacité non vérifiée), sans module ni touches ligne multiples ;
- **pages comme sur le poste** pour les Yealink à pages (T54W, T46S/U, T53/W/C,
  T43U, T42S/U, T41S, T33G/P) : touches de part et d'autre de l'écran, touche
  de page en bas à droite (ex. T54W : 3 pages de 9 touches + touche de page).
  Les modèles tactiles (T48, T57W, T58, T7x, T8x) restent en grille simple ;
- **glisser-déposer** : une touche déposée sur une case vide y est déplacée ;
  sur une autre touche, les deux sont échangées (entre pages et modules aussi).
  Lignes, touches héritées et touche de page ne bougent pas ;
- *Vider* : la case reste vide. *Supprimer* : les touches suivantes remontent.
  *Insérer avant* ajoute une case vide, ◀ ▶ déplacent une touche ;
- **touches ligne** (bouton − / +) : les touches suivent. Le nombre est
  enregistré dans le champ `userfield` de l'utilisateur (`blf-linekeys=N`).
  C'est le stack plugin `astrea/blf-sync` qui l'applique sur le poste
  (Yealink uniquement) ;
- l'utilisateur lui-même n'est jamais proposé comme cible ; une touche vers
  un utilisateur supprimé apparaît en rouge pointillé ;
- récapitulatif avant/après avant chaque enregistrement, puis resynchro du
  poste (optionnelle) ;
- pages Yealink : jusqu'à 10 touches (T54W) une seule page ; *Ajouter une
  page* / *Ajouter un module d'extension*, et un **×** sur chaque page (2e et
  suivantes) et chaque module pour le retirer : confirmation si des touches
  sont effacées, ce qui suit remonte d'un cran ; en revenant à 1 page, la
  touche 10 est gardée ;
- modules d'extension : une carte par module, une page à la fois, avec un
  sélecteur 1·2·3 (point = page qui contient des touches) ;
- onglet **Déploiement en masse** : *Nouveau modèle* / *Modifier ce modèle*
  ouvre l'éditeur de poste sur un modèle de touches Wazo (aperçu sur un modèle
  Yealink au choix), touches ligne comprises. Le nombre de touches ligne est
  noté dans le nom du modèle Wazo avec le même jeton que le userfield
  (`Commerciaux blf-linekeys=2` ; sans jeton = 1 ligne). Une touche placée
  dans Wazo sur une position de ligne est décalée après les lignes (avec
  avertissement). Applique ensuite le modèle (ou les touches d'un
  utilisateur) à une sélection d'utilisateurs, en remplacement (touches + nombre
  de touches ligne, Yealink seulement pour les lignes) ou à la suite (sans
  doublon, lignes inchangées). Sa propre touche est retirée chez chacun, les suivantes
  remontent ; le bloc commence après les touches ligne de chacun. Aperçu
  avant/après, un seul PUT par utilisateur modifié, resynchro optionnelle.
  Le modèle partagé n'est pas rattaché (il mettrait à chacun sa propre touche) ;
- onglet **Étiquettes de touches** : une étiquette par utilisateur (texte des
  BLF qui le supervisent chez ses collègues ; vide = nom complet), enregistrée
  dans son `userfield` (jeton `blf-label=<texte encodé URI>`). Reprise par
  l'éditeur et le déploiement en masse. *Vérifier les touches de tous les
  postes* liste les touches dont l'étiquette diffère : cochées d'office pour
  les étiquettes qui viennent de changer et les libellés par défaut, décochées
  pour les libellés personnalisés ;
- (ancien onglet **Libellés**) : repère les touches dont le libellé ne correspond plus
  au nom du collègue (renommage) et les corrige en lot, sur les touches cochées.

## Sécurité : auto-contrôle et sauvegardes

- **Auto-contrôle au démarrage** : forme des réponses confd (utilisateurs avec
  `uuid`/`id`/`lines[].device_id`, postes avec `model`/`vendor`/`plugin`,
  touches `keys`) et version de stack (`TESTED_STACK` dans `app.js`). Format
  inattendu → bandeau rouge et **lecture seule** (aucune écriture possible) ;
  version non validée → simple avertissement orange. Détail dans la console
  (`[astrea] auto-contrôle`).
- **Sauvegarde automatique** avant chaque déploiement en masse et chaque mise
  à jour d'étiquettes : fichier JSON téléchargé + copie dans le navigateur.
  Restauration depuis l'onglet *Déploiement en masse* (fichier ou dernière
  sauvegarde) : touches propres et userfield des utilisateurs concernés.
- Pages des T73/T74 (8/10 touches × 5 pages) et du T85W (12 × 5) : touche de
  page physique dédiée, aucune touche prise. Au-delà de 5 pages, Wazo numérote
  encore des positions que le poste n'affiche pas (signalé).

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
