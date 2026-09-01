# Notifications communes App Platform

État : code préparé sur `codex/platform-req-001`, non déployé. Aucun appareil réel ni secret fournisseur n'est inclus.

## Architecture

Mema et MiniGames Hub gardent la décision métier : Mema émet par exemple un événement de rappel de contrôle, le Hub un nouveau défi. L'App Platform reçoit une demande déjà décidée, trouve les appareils de la même application et assure chiffrement, file, livraison, retries bornés, invalidation et observation technique.

```text
Mema backend / Hub backend
  -> compte de service limité à un seul app_id
  -> POST devices / messages (API v1)
  -> PostgreSQL privé (capacités et payload chiffrés AES-256-GCM)
  -> worker commun, 5 tentatives maximum avec backoff 15 s à 4 min
  -> FCM HTTP v1 (Android/Capacitor) ou Web Push VAPID (PWA)
```

FCM HTTP v1 est retenu pour Android : rotation des tokens gérée par le client, OAuth serveur par compte de service et invalidation sur `UNREGISTERED`, `INVALID_ARGUMENT` ou `SENDER_ID_MISMATCH`. Web Push reste retenu pour les PWA, notamment l'intégration Mema déjà préparée : le navigateur fournit nativement une subscription VAPID et l'ajout du SDK Firebase Web ne simplifierait pas ce cycle. Les deux transports utilisent exactement la même file et la même administration.

FCM ne facture pas l'envoi de messages à ce jour ; un projet Firebase/Google Cloud, un compte de service limité et la gestion de ses quotas restent nécessaires. Les coûts d'hébergement VPS/PostgreSQL et d'exploitation existent indépendamment.

## Contrats et scopes

- `notifications:devices:write` : inscrire, renouveler, désactiver un appareil de l'`app_id` autorisé ;
- `notifications:send` : créer une notification pour un destinataire de l'`app_id` autorisé ;
- `notifications:read` : voir appareils et livraisons techniques, jamais capacités ni contenu ;
- une liste `app_ids` explicite est obligatoire pour les comptes applicatifs Mema et Hub ; aucun compte client ne reçoit `*`.

`POST /api/v1/notifications/devices` reçoit `app_id`, deux références opaques (`recipient_reference`, `device_reference`), `transport`, `platform`, `permission` et la capacité FCM/Web Push. Une permission refusée est enregistrée comme désactivation sans capacité. Une nouvelle inscription avec la même référence d'appareil renouvelle le token de façon idempotente.

`DELETE /api/v1/notifications/devices/{uuid}` révoque une inscription appartenant au périmètre du compte.

`POST /api/v1/notifications/messages` exige `Idempotency-Key`. Le corps contient `app_id`, `event_type`, une référence destinataire opaque, titre (120), corps (500), au plus douze chaînes de données techniques et un deep-link interne ou HTTPS facultatif. Le service ne décide pas du moment ou du texte fonctionnel. Une même clé avec un contenu différent renvoie 409.

`GET /api/v1/admin/notifications` et `/devices` exposent uniquement application, événement, transport, plateforme, états, compteurs, codes techniques nettoyés et dates. Aucun token, endpoint, clé Web Push, référence utilisateur, payload ou texte n'est retourné.

## Vie privée et sécurité

Les références destinataire/appareil sont transformées par HMAC-SHA-256 lié à l'application. Capacités fournisseur et payload en attente sont chiffrés AES-256-GCM avec une clé distincte. Les empreintes servent uniquement à la déduplication. Les secrets FCM/VAPID et clés de chiffrement restent dans le gestionnaire de secrets serveur/CI ; ils ne vont ni dans Git, ni dans les clients, ni dans les logs.

Le worker ne journalise que le nombre traité ou un code technique borné. Il ne journalise pas les payloads ni les réponses fournisseur brutes. Un token définitivement mort passe `invalid` et est révoqué. Les erreurs transitoires repassent `pending` jusqu'à cinq tentatives ; aucune boucle infinie.

Une livraison restée `processing` après interruption du worker est reprise après deux minutes. Les messages techniques terminés sont conservés 90 jours ; les appareils révoqués sans historique restant sont purgés après 180 jours. Cette rétention ne constitue pas une archive métier.

## Intégration des pilotes

### Mema

La PWA demande la permission après action explicite dans ses réglages. Son backend/endpoint authentifié transmet l'abonnement Web Push à l'App Platform avec un compte `mema` limité. L'Android futur utilisera FCM avec le même `recipient_reference` opaque. Refus ou indisponibilité laisse l'application utilisable et le réglage indique l'état réel.

### MiniGames Hub

Le Hub demande la permission depuis un écran contextualisé, puis son backend inscrit le token FCM Android ou la subscription PWA avec un compte limité à `minigames-hub`. Le backend crée `challenge.created` lorsque sa propre règle métier le décide ; la plateforme ne lit ni les amis, ni le score, ni le contenu du défi. Le deep-link vise l'écran Défis.

## Configuration nécessaire avant environnement réel

Variables serveur uniquement :

- `NOTIFICATION_TOKEN_ENCRYPTION_KEY` : 32 octets encodés Base64 ;
- `NOTIFICATION_IDENTITY_HMAC_SECRET` : secret aléatoire indépendant ;
- Android FCM : `FCM_SERVICE_ACCOUNT_JSON`, identité serveur Google minimale ;
- PWA : `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.

Créer deux comptes de service API distincts avec les scopes écriture appareil/envoi/lecture nécessaires et respectivement `app_ids=mema` et `app_ids=minigames-hub`. Le compte Codex reader ne reçoit aucun nouveau scope automatiquement.

Appliquer `006_common_notifications.sql` d'abord dans PostgreSQL 17 isolé, effectuer une sauvegarde fraîche avant la cible puis ajouter le worker Coolify sans port public. Ces opérations et les secrets restent hors de cette mission. Une validation réelle exige un appareil/compte jetable de chaque pilote et les actions console Firebase/VAPID correspondantes ; aucun utilisateur réel tiers ne doit être ciblé.
