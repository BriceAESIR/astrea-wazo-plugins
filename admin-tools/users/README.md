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

Rien n'est écrit. La modification en masse et la fiche utilisateur
modifiable arrivent dans les lots suivants.

## Droits utilisés
`confd.users.read`, plus, pour les libellés, `confd.moh.read`,
`confd.groups.read` et `confd.voicemails.read`. Si l'un d'eux est refusé,
l'audit fonctionne quand même et affiche les valeurs techniques, avec un
avertissement.
