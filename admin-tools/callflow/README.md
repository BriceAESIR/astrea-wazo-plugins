# Call Flow Manager

Module d'Astrea Admin Tools : vue graphique du parcours des appels du tenant
courant. Cadrage, sources et décisions : `docs/CALLFLOW-MANAGER.md` (dépôt de dev).

## Utilisation (lecture seule pour l'instant)
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

## Droits utilisés
Lecture seule :
- `confd.incalls.read`, `confd.users.read`, `confd.groups.read`, `confd.queues.read` ;
- `confd.ivr.read`, `confd.schedules.read`, `confd.voicemails.read`, `confd.conferences.read` ;
- `confd.switchboards.read`, `confd.contexts.read`, `confd.trunks.read`, `confd.outcalls.read`, `confd.applications.read`.

Ces droits ne sont pas encore vérifiés en réel pour le token du portail. Sans
l'un d'eux, le graphe s'affiche quand même, sans ce type d'objet, avec un
avertissement.
