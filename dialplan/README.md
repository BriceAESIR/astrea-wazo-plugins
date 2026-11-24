# Astrea - dialplan : sous-routines Asterisk

Script d'installation des sous-routines Asterisk Astrea dans
`/etc/asterisk/extensions_extra.d/` d'une stack Wazo. Une sous-routine ne fait
rien tant qu'elle n'est pas choisie sur un objet (champ « sous-routine »).

| Sous-routine | Rôle | À poser sur |
|---|---|---|
| `astrea-antiloop-groupcall` | Anti-boucle : un appel **interne** qui arrive sur le groupe par le renvoi d'un utilisateur (non-réponse, occupé, ne pas déranger, renvoi permanent, hors horaire) ne fait pas sonner le groupe. L'appelant entend « injoignable », puis l'appel est raccroché (occupé). | un groupe d'appel (champ « sous-routine ») |

Cas typique : l'accueil, membre du groupe Accueil, transfère un appel à un
collègue dont la non-réponse renvoie vers ce même groupe. Sans la
sous-routine, l'appel de consultation revient sonner sur le poste de l'accueil.

Passent toujours, le groupe sonnant normalement :

- un appel entré par une SDA, même transféré (`WAZO_CALLORIGIN = extern`) ;
- un appel direct au numéro du groupe ;
- un numéro appelant plus long que `ANTILOOP_MAXLEN` (option `--maxlen`) ;
- un appel marqué transféré par Asterisk (`BLINDTRANSFER` / `ATTENDEDTRANSFER`).

## Utilisation (sur la stack, en root)

```bash
curl -fsSLO https://briceaesir.github.io/astrea-wazo-plugins/dialplan/astrea-dialplan.sh
sha256sum astrea-dialplan.sh     # comparer avec la valeur ci-dessous
less astrea-dialplan.sh          # relire avant d'exécuter
sudo bash astrea-dialplan.sh --dry-run
sudo bash astrea-dialplan.sh --maxlen 4
```

SHA-256 de la version publiée : `895617eb9810440e58ffe325c9d456a11651573490b7013f46c9f1110681c2de`

| Option | Effet |
|---|---|
| `--dry-run` | Montre le fichier ou les différences, n'écrit rien |
| `--maxlen N` | Longueur maximale d'un numéro interne (défaut : valeur déjà installée, sinon 6) |
| `--remove` | Retire la sous-routine (un groupe qui la garde sonne alors normalement) |

Comportement :

- idempotent ; sauvegarde horodatée dans `/var/backups/astrea/` (jamais dans
  `extensions_extra.d`, dont Wazo charge tous les fichiers) ;
- recharge le dialplan (`dialplan reload`) et vérifie que le contexte est chargé.

Activation : dans Call Flow (éditeur du groupe) ou le Portal, champ
« sous-routine » du groupe = `astrea-antiloop-groupcall`.

Trace des décisions : `asterisk -rvvv`, lignes `Astrea antiloop`.

Le fichier installé n'est pas modifié par les mises à jour de Wazo
(`extensions_extra.d` est réservé aux ajouts locaux).
