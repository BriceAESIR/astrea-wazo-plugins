# Module BLF Manager (Astrea Admin Tools)

**Installation pas à pas : [../INSTALLATION.md](../INSTALLATION.md).**

Onglet **Touches** dans la fiche utilisateur du portail Wazo, et sous-menu
**Astrea Admin Tools > BLF Manager**. L'appli lit et écrit directement les touches des postes
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
- **poste partagé** (plusieurs comptes SIP sur un téléphone ; position de la
  ligne = numéro de compte) : seules les touches du compte 1 vont sur le poste
  (vérifié dans le code confd). Compte secondaire : bandeau « ces touches ne
  s'affichent pas sur ce téléphone ». Compte 1 : positions des autres comptes
  affichées « Ligne N » et réservées (une touche de fonction y masquerait la
  ligne). Touches ligne réglables **par compte** depuis le compte 1 (option provd
  `{"1": n1, "2": n2}`, bloc v2 du base.tpl) : avec N > 1, le téléphone place les
  comptes à la suite (compte 1 sur 1..N, puis les autres, 1 touche chacun),
  observé sur T46S ; avec 1 seule, placement Wazo (compte N en touche N) ;
- **glisser-déposer** : une touche déposée sur une case vide y est déplacée ;
  sur une autre touche, les deux sont échangées (entre pages et modules aussi).
  Lignes, touches héritées et touche de page ne bougent pas ;
- *Vider* : la case reste vide. *Supprimer* : les touches suivantes remontent.
  *Insérer avant* ajoute une case vide, ◀ ▶ déplacent une touche ;
- **touches ligne** (bouton − / +) : les touches suivent. Le nombre est
  écrit dans l'**option provd du poste** (`options.astrea_linekeys`, via
  `/api/provd/0.2`), puis le poste est régénéré et resynchronisé. Sur le
  poste, c'est la fonction native Yealink (`features.auto_linekeys.enable`,
  `account.1.number_of_linekey`) posée par quelques lignes ajoutées au **`base.tpl` personnalisé** de chaque
  plugin provd (`var/templates/base.tpl`, tous modèles ; voir
  le script [../../provd/](../../provd/README.md)). Validé sur T46S le 12/10/2026. L'ancien jeton
  `blf-linekeys=N` du userfield est lu en repli puis retiré à l'enregistrement ;
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
  noté dans le nom du modèle Wazo
  (`Commerciaux blf-linekeys=2` ; sans jeton = 1 ligne). Une touche placée
  dans Wazo sur une position de ligne est décalée après les lignes (avec
  avertissement). Applique ensuite le modèle (ou les touches d'un
  utilisateur) à une sélection d'utilisateurs, en remplacement (touches + nombre
  de touches ligne, Yealink seulement pour les lignes) ou à la suite (sans
  doublon, lignes inchangées). Sa propre touche est retirée chez chacun, les suivantes
  remontent ; le bloc commence après les touches ligne de chacun. Aperçu
  avant/après, un seul PUT par utilisateur modifié, resynchro optionnelle.
  Le modèle partagé n'est pas rattaché (il mettrait à chacun sa propre touche) ;
- onglet **Étiquettes de touches** : l'étiquette d'un utilisateur (texte des
  BLF qui le supervisent chez ses collègues ; vide = nom complet) n'est
  **stockée nulle part** : c'est le libellé le plus utilisé sur les touches qui
  le visent, lu sur tous les postes (en tâche de fond au chargement, 6 lectures
  en parallèle). La modifier renomme ces touches (aperçu coché, sauvegarde
  avant). *Harmoniser les libellés* liste les touches dont le libellé diffère :
  cochées d'office pour les libellés vides ou égaux au nom complet, décochées
  pour les libellés personnalisés. Reprise pour les nouvelles touches dans
  l'éditeur et le déploiement en masse ;
- **userfield laissé libre** depuis la 0.17 : call-logd reprend le `userfield`
  comme « Mots clés » des journaux d'appels. Les anciens jetons `blf-label=` et
  `blf-linekeys=` sont signalés (bandeau orange) et retirés par *Nettoyer les
  userfield* (onglet Étiquettes), et filtrés à la restauration d'une sauvegarde.

## Utilisateur à plusieurs postes (0.22)

- Vérifié dans confd : les touches de fonction appartiennent à l'utilisateur et sont envoyées sur chaque poste où il est titulaire de la ligne de plus petite position → mêmes touches, mêmes positions sur tous ses postes. Pas de jeu de touches par poste possible.
- Sélecteur de poste dans l'éditeur (modèle · MAC) : même jeu de touches, aperçu et capacité du poste choisi.
- Touches ligne (compte 1 : nombre et étiquette) appliquées à tous les postes de l'utilisateur ; postes désalignés signalés, alignés à l'enregistrement (bouton Enregistrer actif). Déploiement en masse : idem.
- Avertissement si des touches dépassent la capacité d'un autre poste de l'utilisateur.
- Resynchronisation de tous ses postes.
- Testé contre `tests/mock-dect.ps1` (T46S + T54W), pas encore en réel.

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

## Fichiers

`index.html` et `app.js` du module ; le style et le SDK officiel
`@wazo/euc-plugins-sdk` 1.1.1 (licence MIT) sont partagés dans `../common/`.
Aucune dépendance externe.

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
- **Droits** : le token du portail doit pouvoir modifier les touches et le
  `userfield` des utilisateurs, et lire/écrire les postes dans provd.
