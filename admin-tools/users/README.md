# User Manager

Module d'Astrea Admin Tools pour les réglages des utilisateurs Wazo.
Cadrage, sources et décisions : `docs/USER-MANAGER.md` (dépôt de dev).

## Audit des utilisateurs (lecture seule)
- Un tableau avec tous les utilisateurs du tenant courant. Colonnes au choix :
  renvois d'appel (utilisateur), renvois par défaut (admin), ne pas déranger,
  filtrage, sonnerie, appels simultanés, numéro présenté, mobile, messagerie, musique d'attente,
  langue, fuseau, groupes, droits d'appel, horaire. Le choix des colonnes est
  mémorisé dans le navigateur.
- **Écarts** : une cellule est surlignée quand sa valeur diffère de la valeur
  la plus fréquente de la colonne, parmi les lignes affichées. On peut afficher
  seulement les utilisateurs qui ont un écart. Un renvoi par défaut vers la propre
  messagerie de l'utilisateur compte comme la même valeur pour tout le monde.
- Filtres par texte (nom, numéro, e-mail, mobile) et par groupe d'appel. Un
  clic sur un en-tête trie la colonne. Un clic sur une ligne affiche le détail
  de l'utilisateur (fiche modifiable, voir plus bas).

## Modification en masse
- Cocher des utilisateurs dans le tableau (la case de l'en-tête coche les
  lignes affichées : combiner avec les filtres), puis « Modifier la
  sélection ». Assistant :
  1. cocher les réglages à modifier ;
  2. une étape par réglage : valeur et aperçu avant / après (déjà à la bonne
     valeur, impossible pour tel utilisateur) ; « Précédent » / « Suivant » ;
  3. récapitulatif de toutes les modifications, puis « Appliquer ».
- Réglages (`settings.js`) : ne pas déranger, filtrage, renvois d'appel
  (occupé, inconditionnel, pas de réponse), renvois par défaut (si occupé,
  congestion, échec, non répondu : aucune, sa messagerie, utilisateur,
  groupe, file, standard, numéro, raccrocher), numéro présenté (par défaut,
  anonyme, numéros du tenant, sa SDA, autre), licence (Voix, Communication
  unifiée, Relation client), boîte vocale associée (associer une boîte
  existante ou dissocier ; les boîtes se configurent dans Messageries
  vocales), durée
  de sonnerie, appels simultanés, musique d'attente, langue, fuseau, groupes,
  droits d'appel, horaire.
- À l'exécution, chaque utilisateur est relu ; rien n'est écrit s'il a déjà la
  valeur. Une **sauvegarde** JSON des valeurs précédentes est téléchargée avant
  la première écriture. Le navigateur garde aussi l'historique des 20
  dernières opérations (propre à ce poste) : « Restaurer… » les liste et
  remet les valeurs d'avant l'opération choisie, avec aperçu.
- **Rechargements** : certains réglages rechargent Asterisk à chaque écriture
  (sonnerie, musique, langue, fuseau, numéro présenté, licence, groupes,
  boîte vocale associée).
  Avec plusieurs écritures, l'option « Regrouper les rechargements » coupe le
  live reload du serveur pendant les écritures, le réactive (même en cas
  d'erreur) et déclenche un seul rechargement. Le live reload est commun à
  tout le serveur : s'il est trouvé coupé au chargement, un bandeau rouge
  propose de le réactiver. Sans ce droit, les écritures sont espacées.

## Fiche utilisateur
- Clic sur une ligne : la fiche s'ouvre à droite, avec chaque réglage et un
  bouton ✎ (formulaire prérempli, aperçu avant / après).
- En plus des réglages de la masse : prénom, nom, e-mail (annuaire), mobile,
  description, nom présenté (champs propres à chaque utilisateur, pas
  modifiables en masse).
- Chaque modification est ajoutée à l'historique du navigateur (« Restaurer… »),
  sans téléchargement de fichier.
- « Utilisateur actif » n'a pas d'effet visible dans Wazo : il n'apparaît que
  pour un utilisateur déjà désactivé, pour le réactiver.
- Pas de partie Authentification (identifiant, mot de passe, méthode) : elle
  se gère dans le portail.

Le CSV (export, création) arrive ensuite.
## Droits utilisés
Lecture : `confd.users.read`, plus, pour les libellés, `confd.moh.read`,
`confd.groups.read`, `confd.voicemails.read`, `confd.callpermissions.read`
et `confd.schedules.read`. Écriture : `confd.users.{id}.update`,
`…services.*`, `…forwards.*`, `…groups.update`, `…callpermissions.*`,
`…schedules.*`, `…fallbacks.update`, `confd.voicemails.{id}.update`,
`confd.configuration.live_reload.read|update` (non vérifiés en réel pour le token du portail). Si l'un d'eux est refusé,
l'audit fonctionne quand même et affiche les valeurs techniques, avec un
avertissement.
