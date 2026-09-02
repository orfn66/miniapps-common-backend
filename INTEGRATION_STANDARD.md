# Standard d’intégration App Platform

Ce document définit le contrat commun des applications présentes et futures. La préproduction V1 utilise l’URL technique `sslip.io`; aucune application ne doit coder cette URL en dur. Chaque environnement la reçoit par configuration.

## 1. Définir la frontière produit

Une entrée du registry représente un produit installable ou exploité comme une unité, pas chaque écran, jeu ou module interne.

- MiniGames Hub : une application, `app_id=minigames-hub`.
- Perfect Tap : module transmis comme `technical_context.module=perfect-tap`.
- Une variante Android/Capacitor du même produit conserve le même `app_id`; la plateforme et la version distinguent les clients.
- Un nouveau produit autonome reçoit un nouvel `app_id`, stable, en kebab-case et jamais recyclé.

## 2. Enregistrer une application

Champs obligatoires :

| Champ | Convention |
|---|---|
| `app_id` | identifiant produit stable, kebab-case |
| `name` | nom lisible, indépendant du nom de dépôt |
| `type` | `pwa`, `web`, `mini_game`, `android`, `capacitor`, `cloudflare_worker`, `supabase`, `firebase`, `wordpress`, `service` ou `other` |
| `platforms` | liste des surfaces réellement publiées |
| `current_version` | version informative actuellement diffusée |
| `status` | `active` ou `archived` |

Archiver bloque les nouvelles installations App Platform sans supprimer l’historique. Toute suppression de données est une opération distincte, sauvegardée, testée et explicitement autorisée.

## 3. Versionner les clients

- Utiliser SemVer lorsque le produit le permet : `MAJEUR.MINEUR.CORRECTIF`.
- Pour Android/Capacitor, envoyer la version visible et, si utile, le build dans le contexte technique : `{ "build": "123" }`.
- Pour un déploiement web continu, envoyer la version applicative ou un identifiant de release court, jamais une branche flottante.
- Un ticket conserve la version exécutée lors de sa création; une mise à jour du registry ne réécrit pas l’historique.

## 4. Intégrer le SDK

Le pilote fournit `@app-platform/feedback-client` dans le dépôt MiniGames Hub. Il n’est pas encore publié comme dépendance externe. Après la période pilote, il pourra être extrait dans un dépôt/package versionné sans modifier l’API `/api/v1`.

Configuration minimale :

```js
const feedback = createFeedbackClient({
  apiUrl: environment.APP_PLATFORM_URL,
  appId: "mon-app",
  appVersion: "1.2.3",
});
```

Règles :

- ne jamais embarquer de jeton admin ou Codex dans un client ;
- laisser le SDK créer et conserver uniquement son identifiant d’installation pseudonyme ;
- masquer ou désactiver le bouton si l’URL d’environnement est absente ;
- ne jamais empêcher l’application principale de fonctionner si la plateforme est indisponible ;
- limiter les retries et afficher un échec compréhensible à l’utilisateur ;
- déclarer exactement l’origine web/Capacitor dans CORS avant activation.

## 5. Métadonnées

Envoyer seulement ce qui aide à reproduire le problème : version, date/heure, famille d’appareil, OS, navigateur, résolution, route/écran, zone fonctionnelle et module interne.

Exemple :

```json
{
  "type": "bug",
  "message": "Le score reste masqué après la partie.",
  "route": "/perfect-tap/",
  "technical_context": {
    "area": "results",
    "module": "perfect-tap"
  }
}
```

Ne jamais envoyer : mot de passe, cookie, jeton, clé API, en-tête Authorization, e-mail, téléphone, adresse, paiement, identifiant publicitaire, variables d’environnement, corps de requête, sauvegarde, contenu utilisateur ou logs bruts. Un identifiant utilisateur facultatif doit être opaque et pseudonymisé côté serveur.

## 6. Pièces jointes

- facultatives et précédées d’un consentement explicite pour chaque fichier ;
- JPEG, PNG ou WebP uniquement ;
- aperçu client et rappel de vérifier l’absence de secret/donnée personnelle ;
- compression côté client lorsque possible ;
- aucun chemin de stockage public ;
- téléchargement uniquement par l’API autorisée ;
- suppression et rétention gérées par la plateforme.

## 7. Checklist d’une application pilote

1. Valider la frontière produit et réserver l’`app_id` dans le registry.
2. Configurer l’URL par environnement, sans valeur codée en dur.
3. Ajouter l’origine à CORS.
4. Tester création d’installation et ticket sans pièce jointe.
5. Tester consentement, compression, upload privé et refus sans authentification.
6. Vérifier le ticket dans l’admin, ses filtres et son historique.
7. Vérifier la lecture Codex et le refus des scopes absents.
8. Tester plateforme indisponible, mode hors ligne et reprise réseau.
9. Vérifier sauvegarde Restic et restauration isolée après création d’une pièce jointe.
10. Observer un seul pilote avant d’intégrer l’application suivante.

## 8. Ordre de déploiement progressif

1. MiniGames Hub, déjà pilote; ses jeux restent des modules.
2. Une deuxième application à faible risque et sans système de feedback existant.
3. Applications Cloudflare via appel HTTPS ou adaptateur Worker selon CORS et politique réseau.
4. Applications Supabase/Firebase seulement après analyse de leur Auth, RLS et stockage existants.
5. Applications métier ou contenant des données personnelles uniquement avec une validation dédiée.

Un système existant n’est jamais remplacé automatiquement. L’intégration peut rester parallèle, désactivée par configuration et réversible pendant toute la période d’observation.


## 9. Connecteur Velocoon

Velocoon conserve ses retours et captures dans son projet Supabase. Le connecteur `POST /api/v1/integrations/velocoon/feedback` reçoit uniquement une copie minimale des nouveaux tickets. Il valide le JWT utilisateur auprès de Supabase Auth avec `VELOCOON_SUPABASE_URL` et `VELOCOON_SUPABASE_PUBLISHABLE_KEY`, puis pseudonymise l'UUID utilisateur avec `INTEGRATION_HASH_SECRET`.

L'UUID du ticket source est la clé d'idempotence et la contrainte `(source_app, source_feedback_id)` empêche les doublons. Aucun accès aux tables métier Velocoon, aucune clé `service_role`, aucun chemin Storage et aucune pièce jointe ne sont utilisés. Avant activation, configurer l'origine Velocoon dans `CORS_ALLOWED_ORIGINS`; sans ces variables, le point d'entrée refuse l'authentification.
