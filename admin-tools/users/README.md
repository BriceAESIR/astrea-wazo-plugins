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
  de l'utilisateur.

## Modification en masse
- Cocher des utilisateurs dans le tableau (la case de l'en-tête coche les
  lignes affichées : combiner avec les filtres), puis « Modifier la
  sélection ». Choisir le réglage et la valeur : l'aperçu montre avant / après
  pour chaque utilisateur, ceux déjà à la bonne valeur et ceux pour qui c'est
  impossible (ex. groupe pour un utilisateur sans ligne).
- Réglages (`settings.js`) : ne pas déranger, filtrage, renvois d'appel
  (occupé, inconditionnel, pas de réponse), durée de sonnerie, appels
  simultanés, musique d'attente, langue, fuseau, groupes, droits d'appel,
  horaire.
- À l'exécution, chaque utilisateur est relu ; rien n'est écrit s'il a déjà la
  valeur. Une **sauvegarde** JSON des valeurs précédentes est téléchargée avant
  la première écriture (et gardée dans le navigateur). « Restaurer… » la
  réapplique, avec aperçu.
- Les réglages de l'utilisateur lui-même (sonnerie, musique, langue…) et les
  groupes rechargent la configuration d'Asterisk et des postes à chaque
  écriture : elles sont espacées.

La fiche utilisateur modifiable et les renvois par défaut arrivent ensuite.

## Droits utilisés
Lecture : `confd.users.read`, plus, pour les libellés, `confd.moh.read`,
`confd.groups.read`, `confd.voicemails.read`, `confd.callpermissions.read`
et `confd.schedules.read`. Écriture : `confd.users.{id}.update`,
`…services.*`, `…forwards.*`, `…groups.update`, `…callpermissions.*`,
`…schedules.*` (non vérifiés en réel pour le token du portail). Si l'un d'eux est refusé,
l'audit fonctionne quand même et affiche les valeurs techniques, avec un
avertissement.
