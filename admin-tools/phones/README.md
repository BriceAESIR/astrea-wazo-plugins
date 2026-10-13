# Module Phone Manager (Astrea Admin Tools)

Sous-menu **Astrea Admin Tools > Phone Manager** (ex-DECT Manager), deux vues :

- **Bases DECT** : vue d'ensemble des bases DECT et des lignes Wazo qui y sont
  provisionnées (détail ci-dessous). Les combinés (inscription, noms, compte de
  chaque combiné) restent gérés sur la page web de la base (base maître en
  multicellule).
- **Configuration des appareils** (Yealink, postes et bases DECT) : options du
  catalogue `catalog.js` cochées par appareil ou appliquées en masse.

## État de connexion (0.21)
- Pastille par appareil (listes) et par compte (tableau DECT), état dans l'en-tête : vert connecté, bleu en appel, rouge non connecté, vide inconnu. Source : `GET /api/calld/1.0/lines` (ACL `calld.lines.read`, un seul appel, tenant courant) : `registered` = contact PJSIP joignable (vérifié dans le code wazo-calld). Appareil connecté si une de ses lignes est enregistrée. Rafraîchi chaque minute.
- Avertissement avant une synchronisation vers un appareil non connecté (le NOTIFY check-sync ne l'atteindra pas).
- Pas d'IP ni d'user agent : seul wazo-amid les donne, réservé au tenant master.
- ✅ Validé en réel le 13/10/2026 (client, 3 W75DM + 3 T85W) : le token du portail a `calld.lines.read`, pastilles conformes.

## Configuration des appareils
- Options (fiche d'aide dans l'appli : description, valeurs, défaut Yealink) :
  VLAN WAN + priorité, mot de passe admin propre à l'appareil, provisionnement
  planifié (hebdomadaire / répété), économiseur d'écran, AEC, VAD, CNG, TNS,
  Acoustic Shield, volumes d'émission, périphérique de sonnerie. Une base DECT
  ne se voit proposer que les options qui la concernent.
- Stockage : options provd de l'appareil `astrea_settings` (ce que l'appli
  affiche) et `astrea_params` (paramètres Yealink plats) ; écriture par
  `PUT /dev_mgr/devices/{id}` relu juste avant, puis `reconfigure`.
- Application sur l'appareil : bloc Astrea v5 du template provd
  (`base.tpl` / `base-dect.tpl`), installé par `provd/astrea-provd.sh`. Les
  paramètres sont écrits en dernier et l'emportent sur le modèle de
  provisionnement de la stack.
- Option décochée après application : ses clés sont écrites à `%NULL%` (valeur
  vide Yealink ; retour à la valeur par défaut supposé), sauf VLAN et mot de
  passe, que le modèle de la stack réécrit.
- En masse : mêmes options et valeurs sur une sélection d'appareils du même
  type (mot de passe : un différent par appareil), ou retrait de ces options ;
  sauvegarde JSON des options précédentes téléchargée.
- ✅ Validé en réel le 13/10/2026 (steven-seagull, T46S plugin v86, script
  `astrea-provd.sh` bloc v5) : VAD et CNG réglés dans l'appli, appliqués sur le
  poste (page Voix du poste conforme). Testé aussi contre `tests/mock-dect.ps1`
  (décochage, masse). Reste à valider : bases DECT, VLAN, mot de passe, masse en réel.

## Bases DECT : ce que fait la vue
- **Liste des bases** (modèles DECT reconnus par les plugins provd) avec
  l'occupation `comptes utilisés / max` et une pastille d'alerte.
- **Fiche d'une base** : modèle, MAC, IP, firmware, plugin provd, état de
  provisionnement ; tableau des comptes (position = `account.N`), utilisateur,
  numéro, ligne ; comptes libres.
- **Alertes** : deux lignes au même compte, compte au-delà du maximum du
  modèle, ligne sans position ou sans utilisateur, base pleine, plugin
  Yealink v86 (ne gère pas le DECT), état provd ≠ configured, base secondaire
  probable (multicellule).
- **Recherche** : un nom ou un numéro donne la base et le compte de son DECT.
- **Actions** (récapitulatif avant écriture, synchronisation proposée) :
  - *Affecter un utilisateur* : choisir une de ses lignes et un compte libre ;
    si la ligne est sur un autre appareil, elle en est retirée (Wazo associe
    une ligne à un seul appareil) ;
  - **Glisser-déposer** : un compte déposé sur un compte libre y est déplacé, sur un compte occupé de la même base les deux sont échangés, sur une base de la liste il prend son premier compte libre. Les déplacements s'accumulent (barre orange), récapitulatif avant/après, puis *Enregistrer* (contrôle des doublons et du maximum, relecture des lignes juste avant d'écrire) ;
  - *Retirer* : la ligne n'est plus provisionnée sur la base (elle reste dans
    Wazo) ;
  - *Synchroniser la base*.

## Maximum de comptes (plugins provd, vérifié dans le code)
| Modèle | Comptes |
|---|---|
| Yealink W60B | 8 |
| Yealink W70B | 10 |
| Yealink W75B / W75DM | 20 |
| Yealink W80B / W80DM | 100 |
| Yealink W90B / W90DM | 250 |
| Gigaset N610 / N670 / N770 / N870(E) IP PRO | 8 / 20 / 100 / 250 |

Plugin Yealink : **v87** (le v86 n'a aucun modèle DECT).

## Écritures (API confd)
- Associer : `PUT /lines/{id}/devices/{device_id}` (refusé si la ligne a déjà
  un appareil ou si la position est prise ; la ligne doit avoir un
  utilisateur et une extension).
- Retirer : `DELETE /lines/{id}/devices/{device_id}`.
- Position : `PUT /lines/{id}` avec l'objet complet relu (confd ne vérifie pas
  l'unicité de la position à ce moment-là : le module la vérifie, sur des
  données relues juste avant l'écriture).
- Déplacer (glisser-déposer) : dissociation des lignes qui changent de base,
  puis positions (`PUT /lines/{id}`), puis réassociation. Échanges sur une même
  base : positions seulement. Testé contre `tests/mock-dect.ps1`, pas encore en réel.
- Synchroniser : `GET /devices/{id}/synchronize` (confd ne le fait pas seul).

## À vérifier en réel (première installation)
- ✅ Lecture validée le 13/10/2026 chez un client (3 bases W75DM, plugin v87, 23 comptes) : `GET /lines` renvoie bien `device_id` et `position`.
- `PUT /lines/{id}` accepte l'objet relu par `GET` (changement de position).
- Droits du token du portail sur `confd.lines.*.devices.*` et `confd.devices.*.synchronize`.
- Multicellule : seule la base maître (DM) apparaît-elle dans les appareils ?
