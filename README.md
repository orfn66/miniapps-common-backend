# App Platform V1 (évolution du Mini-apps Common Backend)

Backend commun de l’App Platform, déployé par Coolify avec uniquement des données de validation non sensibles pendant la période pilote.

La migration `002_app_platform_feedback.sql` prépare sa généralisation en App Platform transversale : registre d’applications, workflow complet, interface `/admin`, pièces jointes privées, comptes de service à scopes et contrat `openapi.yaml`. Le pilote produit est `minigames-hub`; les jeux comme Perfect Tap restent des modules internes.

## Déploiement pilote

Connexion humaine par e-mail et mot de passe : voir [ADMIN_ACCESS.md](ADMIN_ACCESS.md) pour la première activation autorisée par le jeton admin existant. Les jetons de service/Codex restent valides.

- Dépôt : `orfn66/miniapps-common-backend`.
- Application Coolify : `cnot0zp2jgqy1ckyydnsui5i`.
- API technique : `https://cnot0zp2jgqy1ckyydnsui5i.179.237.105.82.sslip.io`.
- HTTP redirige vers HTTPS et le certificat public est valide.
- L'API écoute sur 3000 uniquement dans Docker ; PostgreSQL écoute sur 5432 uniquement dans Docker.
- Aucun nouveau port hôte ou UFW n'est ajouté.

Variables Coolify nécessaires, sans valeur dans Git :

| Variable | Usage |
|---|---|
| `POSTGRES_ADMIN_PASSWORD` | initialisation PostgreSQL et migrations uniquement |
| `APP_DB_PASSWORD` | authentification du rôle runtime limité `miniapps_api` |
| `CORS_ALLOWED_ORIGINS` | liste séparée par des virgules des origines frontend autorisées |

Le volume `miniapps_attachments` stocke les captures privées. Il n’est exposé par aucun port et est inclus dans les sauvegardes Restic chiffrées.

Les mots de passe production et preview sont indépendants. Ils sont gérés dans Coolify et ne doivent jamais être affichés, copiés dans Git ou transmis au client.

## Fonctions de la V1

- registry transversal avec `MiniGames Hub` comme pilote ; Perfect Tap reste un module interne ;
- création d'une installation pseudonyme et émission unique de son jeton ;
- stockage du jeton sous forme SHA-256 uniquement ;
- feedback, sessions de jeu idempotentes et statistiques personnelles ;
- logs JSON sans corps de requête ni jeton ;
- rôle PostgreSQL runtime limité ;
- aucun port hôte dans Docker Compose.

## Vérification locale

```bash
npm ci
npm test
node --check src/server.js
```

Le standard pour enregistrer et intégrer une application est décrit dans `INTEGRATION_STANDARD.md`. Un smoke test non destructif de la préproduction est disponible avec `npm run test:preprod`; il exige les URLs et jetons via variables d’environnement et ne les affiche jamais.

Pour un test Docker, copier `.env.example` vers `.env`, remplacer les valeurs par des secrets aléatoires indépendants, puis exécuter :

```bash
docker compose up --build
```

La configuration n'expose volontairement aucun port hôte. Un test HTTP local nécessite un proxy ou un override de développement lié exclusivement à `127.0.0.1`.

## Validation effectuée

- migrations `db-init` et SQL terminées avec le code 0 ;
- rôle runtime sans superutilisateur, création de base, création de rôle ou héritage ;
- création d'installation, feedback, session idempotente et statistiques validés via HTTPS ;
- origine CORS autorisée acceptée et origine étrangère refusée ;
- dump local restauré dans une base distincte avec les trois lignes attendues ;
- monitoring horaire actif pour l’API, l’admin et le Hub pilote ;
- sauvegarde Restic et restauration isolée d’une pièce jointe et du dump PostgreSQL validées.

L’URL `sslip.io` reste une préproduction temporaire. Aucun domaine réel ne doit être ajouté avant la décision de conserver le VPS et une validation DNS séparée.
