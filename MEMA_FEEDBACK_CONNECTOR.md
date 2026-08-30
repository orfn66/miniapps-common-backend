# Connecteur feedback Mema — audit et conception V1

État au 30 août 2026 : **NON ACTIVÉ — accès source à décider**.
Ce document décrit le contrat observé et la solution proposée, pas un connecteur déployé.

## Périmètre

Mema/Supabase reste la source de vérité. Seul le VPS doit recevoir une copie
minimale dans son Inbox existante. Aucune migration, écriture, session créée,
modification de compte ou de client Mema n’est autorisée dans cette mission.
MiniGames Hub reste une seule application ; Perfect Tap et Swipe Panic sont
des modules, pas de nouvelles applications à enregistrer automatiquement.

## Architecture existante auditée

- Backend Node HTTP + `pg`, PostgreSQL 17, Compose/Coolify, Traefik HTTPS.
- `games.slug` représente l’`app_id`. Les rapports sont dans `feedback` et
  rattachés au registre via `installations.game_slug`.
- Le Hub utilise `@app-platform/feedback-client` : création d’une installation,
  jeton d’installation, `POST /api/v1/feedback`, puis upload optionnel distinct.
  Mema ne doit pas utiliser ce SDK pour doubler ses envois.
- `/api/v1/admin/feedback` filtre par app, type, statut, priorité, version et
  dates ; tri `created_at DESC`, limite actuelle de 500 lignes sans pagination.
- Statuts centraux conservés : `new`, `to_analyze`, `confirmed`, `in_progress`,
  `to_test`, `fixed`, `closed`. Ne pas créer un deuxième workflow.
- Admin : cookie sécurisé, CSRF, scopes contrôlés côté serveur ; alternative
  par jeton de service. Codex actuel : lecture limitée à `minigames-hub`.
  Il ne doit pas gagner automatiquement l’accès Mema.
- Pièces jointes privées et historique déjà présents. Aucun import d’image
  Mema dans cette V1 ; réutiliser plus tard `feedback_attachments`.
- Purge des pièces jointes toutes les 24 h dans l’API ; aucun worker de
  synchronisation externe dans Compose. Sauvegarde et monitoring par systemd.
- Restic existant : dump PostgreSQL quotidien vers NAS à 03:15 UTC avec jitter,
  contrôle hebdomadaire ; monitoring horaire. Les copies centrales futures
  seront incluses dans le même dump, sans deuxième système de backup.

## Contrat Mema confirmé dans les sources ET la production

Projet Supabase `djhyfavdqhyzujgyrxjn`, table privée `private.feedback_reports`.
Les requêtes d’audit ont utilisé des transactions `READ ONLY` et retourné
uniquement schéma, définitions de fonctions, droits et agrégats, pas les textes.

| Champ Mema | Destination centrale proposée |
|---|---|
| constante `mema` | `app_id` / `source_app` |
| `id` UUID | `source_feedback_id`, pas l’identifiant interne central |
| `kind` | `type` via mapping explicite ci-dessous ; conserver `source_kind` |
| `description` | `comment` exposé comme `message`, texte intégral |
| `created_at` | `created_at_source` et date de tri des copies |
| `client_occurred_at` | `client_occurred_at` existant |
| `app_version` | `client_version` existant |
| `app_build` | `build` |
| `platform` | `platform` |
| `interface_locale` | `language` |
| `current_screen` | `route` / écran affiché |
| `status` | `source_status`, indépendant de `feedback.status` central |
| `status_updated_at` | `source_status_updated_at` |
| horloge VPS au premier import | `imported_at`, jamais réécrit lors d’une resync |

Mapping confirmé par l’interface Mema : `bug → bug`, `opinion → review` (Avis),
`improvement → suggestion` (Mema affiche ce type « Suggestion »).
Statuts source : `new`, `in_progress`, `resolved`. À l’import initial, le statut
central serait `new`, sans conversion implicite du statut source.

Plateformes source : `android`, `ios`, `desktop`, `unknown`. Langues : `fr`,
`nl`, `en`. Version, build, écran limités à 64 caractères ; description à 4000.

### RPC réellement existants

- `feedback_admin_access()` : autorisation admin.
- `list_feedback_reports_admin(p_status text default null)` : lecture, 13
  champs listés ci-dessus, tri décroissant, **LIMIT 200 dans la fonction**.
- `update_feedback_report_status_admin(uuid, text)` : écriture, formellement
  exclue du connecteur.
- `submit_feedback(...)` : création côté Mema, formellement exclue du connecteur.

La lecture contrôle `private.is_feedback_admin()` côté serveur : `auth.uid()`,
utilisateur Auth confirmé et liste privée des identités admin. Ce n’est pas une
simple comparaison d’e-mail dans le frontend. Une clé de projet seule n’est
pas une identité admin. Le RPC n’a ni curseur, ni `since`, ni pagination ; un
Range HTTP ne peut pas faire apparaître les lignes au-delà de son LIMIT SQL.
`status_updated_at` ne constitue pas un timestamp générique de modification
du texte : ne pas lui attribuer une sémantique non prévue par Mema.

## Blocage d’accès et secrets

Aucun rôle de lecture limité à cette table ni RPC technique dédié n’a été
trouvé dans la production auditée. Les rôles système qui peuvent lire la table
ne sont pas des identités de connecteur limitées aux feedbacks.

Le RPC admin pourrait lire les 4 rapports présents avec une session admin
Mema explicitement fournie, mais cette session autorise aussi le RPC de
modification de statut. Elle n’est donc pas une capacité technique read-only
isolée. Aucun JWT de navigateur, mot de passe humain, clé `service_role`,
identifiant PostgreSQL global ou jeton Management API ne sera récupéré ou
réutilisé automatiquement. L’accès d’audit Supabase de cette tâche ne doit pas
devenir un secret du worker VPS.

Préférence : obtenir le contrat et le mécanisme d’authentification d’un accès
technique existant, limité à la lecture des champs ci-dessus, avec pagination
complète. S’il n’existe pas, une nouvelle décision utilisateur est nécessaire
avant toute création de rôle/RPC/secret côté Mema. Ce serait une extension du
périmètre actuel, et non une opération autorisée par ce document.

Les noms exacts de variables/identifiants et leur provisionnement seront
définis après cette décision, sans inventer de RPC. Les secrets iront uniquement
dans la configuration serveur du worker, jamais dans Git, l’API publique,
les logs, les assets admin, les réponses de monitoring ou le frontend Mema.

## Évolution centrale proposée, non appliquée

Adapter `feedback`, pas une Inbox parallèle : app directe et provenance pour
les copies importées, avec contrainte `UNIQUE(source_app, source_feedback_id)`.
Conserver intégralement le parcours installation des rapports SDK. Un import
ne doit pas nécessiter une fausse installation ni un jeton client Mema.

Points obligatoires de la future migration additive :

- permettre un rapport importé sans `installation_id`, uniquement avec une
  app et une provenance complètes ; maintenir l’exigence d’installation pour
  les rapports natifs ; ne pas réécrire les rapports historiques ;
- élargir `feedback.comment` de 1000 à 4000 caractères : le validateur JS accepte
  déjà 4000, mais la colonne actuelle reste `varchar(1000)` ; aucune troncature
  des messages Mema ne doit masquer cette différence ;
- ajouter les champs de provenance et métadonnées explicitement retenus ;
- modifier toutes les jointures d’accès admin, filtres, audit et pièces jointes
  pour conserver les contrôles d’app sur les deux sortes de rapports ;
- indexer l’app, la date source et la clé de déduplication ;
- utiliser un rôle central de worker aux droits minimaux et un état de sync
  séparé, sans secret ; droits de lecture de monitoring filtrés par app ;
- afficher clairement « Statut central » et « Statut Mema », build, plateforme,
  langue, écran ; pas de lien source en l’absence d’URL admin officielle sûre.

## Synchronisation proposée, non planifiée

Worker indépendant de l’API, pull toutes les 3 minutes, sans port public.
Mema indisponible ne doit pas impacter le serveur HTTP ni son healthcheck.
Timeout 15 s, au plus 3 tentatives sur erreurs transitoires avec backoff et
jitter ; pas de retry agressif des 401/403. Verrou de sync pour éviter les
exécutions concurrentes ; transactions locales par lot.

L’algorithme dépend du futur contrat d’accès confirmé : curseur composite stable,
pagination complète, reprise avec recouvrement pour les arrivées tardives, et
réconciliation périodique bornée pour les changements de statut source. Ne pas
annoncer de polling incrémental avec le RPC actuel qui ne le permet pas.

Upsert conditionnel seulement si des champs source changent ; préserver statut
central, priorité, notes et historique. Une resync sans nouveauté ne réécrit
aucun ticket ; seul le petit état de monitoring peut être actualisé. Pas de
suppression centrale déclenchée par une absence source ou une page incomplète.

Monitoring admin proposé : dernier succès, dernier ID/date importé, nombre
ajouté et actualisé au dernier passage, `OK/ERROR`, code d’erreur technique
autorisé. Ni message utilisateur, ni réponse d’erreur Supabase brute, ni JWT.
Un 401/403 demande une intervention ; pas de bascule automatique vers des
droits plus larges. Une page pleine sans pagination doit produire une alerte
d’incomplétude, jamais un faux succès.

Désactivation future : arrêter le worker uniquement ; conserver la copie et
l’Inbox. Aucun changement dans Mema. Aucune commande réelle d’activation ou
d’arrêt n’est fournie tant que le worker n’existe pas.

## Minimisation et limites

Ne copier ni Auth, JWT, e-mail, identifiant utilisateur, IP, données famille,
enfant, apprentissage, listes, sessions ou captures. Pas de jointure vers ces
tables. Le message libre peut néanmoins contenir des informations que l’auteur
a lui-même saisies ; une liste blanche de colonnes ne garantit pas son anonymat.
Ne pas prétendre à une anonymisation ni modifier silencieusement son texte.

Les champs techniques inconnus doivent être rejetés/ignorés explicitement,
pas copiés en bloc dans `technical_context`.

## Validation requise avant activation

1. Accès source durable et limité approuvé ; pagination et renouvellement validés.
2. Tests unitaires mapping, Unicode/4000 caractères, déduplication, retry,
   erreurs, données supplémentaires et absence de secret dans les sorties.
3. Tests PostgreSQL isolés, imports concurrents, conservation du statut central,
   contrôle d’accès multi-app, même timestamp, interruptions et reprise.
4. Sauvegarde Restic fraîche, migration isolée réussie avant la cible, build,
   smoke Hub/Inbox, puis déploiement de la plateforme seule sur sslip.io.
5. Comparer nombre source/importé et champs par empreintes calculées sans loguer
   les textes ; resync attendue : 0 ajout, 0 doublon.
6. L’utilisateur envoie lui-même un nouveau feedback via Mema : cette mission
   interdit toute écriture source par l’agent. Vérifier l’arrivée automatique et
   la conservation du statut Mema après une modification uniquement centrale.
7. Vérifier snapshot/restauration incluant les copies ; rollback du code sans
   migration inverse destructive.

Futur bidirectionnel : chantier séparé avec autorisation d’écriture dédiée,
gestion des conflits et journalisation ; aucune invocation de RPC d’écriture
dans cette V1.

## Références auditées

- Plateforme : `src/server.js`, `src/domain.js`, `src/password-auth.js`,
  `migrations/001_initial.sql`, `002_app_platform_feedback.sql`,
  `003_admin_password_auth.sql`, `admin/app.js`, `compose.yaml`.
- Mema : `supabase/migrations/20260828202339_store_private_feedback_reports.sql`,
  `20260829091430_private_feedback_admin_inbox.sql`, `src/data/feedbackAdmin.ts`,
  `src/data/feedback.ts`, `src/domain/feedback.ts`, `src/components/AdminFeedbackInbox.tsx`.
- Définitions et droits de production vérifiés via requêtes de lecture.
- [Supabase — Database Functions](https://supabase.com/docs/guides/database/functions)
  pour les règles RPC et privilèges ; changelog officiel consulté.
