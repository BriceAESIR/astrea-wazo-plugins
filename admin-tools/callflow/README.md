# Call Flow Manager

Module d'Astrea Admin Tools : vue graphique du parcours des appels du tenant
courant. Cadrage, sources et décisions : `docs/CALLFLOW-MANAGER.md` (dépôt de dev).

## Utilisation
- **Point de départ** : à gauche, choisir un type (SDA, trunks, utilisateurs,
  groupes, files, SVI, horaires, messageries…) puis un objet.
- **Où vont les appels** : chaque carte liste ses sorties (débordements,
  touches de SVI, horaire fermé, renvois…), avec les durées (sonnerie,
  délai du groupe ou de la file). Un lien en pointillé rejoint une carte déjà
  affichée (boucle, objet partagé). Une destination vers un objet supprimé
  apparaît en rouge.
- **Qui arrive ici** : les objets qui envoient des appels vers l'objet choisi.
- **Fiche** : un clic sur une carte affiche ses réglages et la liste « Arrive
  depuis » (cliquable). Double-clic ou « Partir de cette carte » : la carte
  devient le point de départ.
- **Canevas** :
  - glisser le fond pour se déplacer, molette pour le zoom ;
  - glisser une carte pour la déplacer avec sa branche (Alt : la carte seule) ;
  - − / + sur une carte pour replier ou déplier ;
  - « Réorganiser » revient à la disposition automatique.
  - Les positions sont mémorisées dans le navigateur.
- **Simulation date / heure** (sous le graphe) : les branches inactives au
  moment choisi sont atténuées. La ligne « Résultat » indique où arrive
  l'appel, minute par minute, et chaque horaire du parcours a sa propre ligne.

## Modifier (bouton « Modifier »)
- Une palette de cartes apparaît au-dessus du graphe : utilisateur, groupe,
  file, SVI, messagerie, standard, conférence, numéro, message, raccrocher.
- **Glisser une carte sur une sortie** (✎) : celle de la palette, ou une carte
  déjà présente dans le graphe. Un dialogue demande l'objet visé et ses
  options (durée de sonnerie, message d'accueil de la messagerie, tonalité…).
  **×** sur une sortie la vide.
- **Annuler une erreur** :
  - **↶** sur une sortie modifiée lui rend sa valeur d'origine ;
  - un clic sur le compteur du brouillon liste les modifications, chacune avec son ↶ ;
  - sur une carte sélectionnée, « Retirer de cette sortie » (ou la touche Suppr) vide la sortie qui y mène.
- Sorties modifiables :
  - destination des SDA ;
  - renvois par défaut des utilisateurs (pas de réponse, occupé, encombré,
    indisponible), des groupes, des files et des standards ;
  - seuils d'attente des files ;
  - touches existantes et cas (sans saisie, invalide, trop d'essais) des SVI.
- Pas encore modifiables : sorties des horaires, renvois d'appel de
  l'utilisateur, membres, ajout d'une nouvelle touche de SVI.
- Tout passe par un **brouillon** : un point orange marque chaque sortie
  modifiée, et rien n'est écrit tant qu'on n'a pas cliqué « Appliquer… ».
- **Appliquer…** se déroule ainsi :
  1. l'appli relit chaque objet sur le serveur ;
  2. elle montre l'aperçu avant / après ;
  3. elle télécharge une sauvegarde JSON (état lu et contenu envoyé) ;
  4. elle écrit une seule fois par objet, et seulement ce qui change ;
  5. elle relit le graphe.

  Les renvois par défaut sont toujours renvoyés en entier (confd les remplace
  tous à chaque écriture).

## Droits utilisés
Lecture seule :
- `confd.incalls.read`, `confd.users.read`, `confd.groups.read`, `confd.queues.read` ;
- `confd.ivr.read`, `confd.schedules.read`, `confd.voicemails.read`, `confd.conferences.read` ;
- `confd.switchboards.read`, `confd.contexts.read`, `confd.trunks.read`, `confd.outcalls.read`, `confd.applications.read`.

Pour les membres d'un groupe inscrits par la touche « bascule groupe », qui ne sont connus que d'Asterisk :
- `amid.action.QueueStatus.create` : lecture en direct, acceptée pour le token du portail (vérifié le 14/10/2026 avec le compte de Brice) ;
- `confd.users.{uuid}.funckeys.read` : bouton « Chercher les touches de bascule ».

Écriture (mode Modifier) :
- `confd.incalls.{id}.update`, `confd.users.{uuid}.fallbacks.update` ;
- `confd.groups.{uuid}.fallbacks.update`, `confd.queues.{id}.fallbacks.update`, `confd.queues.{id}.update` ;
- `confd.switchboards.{uuid}.fallbacks.update`, `confd.ivr.{id}.update`.

Ces droits ne sont pas encore vérifiés en réel pour le token du portail. Sans
l'un d'eux, le graphe s'affiche quand même, sans ce type d'objet, avec un
avertissement.
