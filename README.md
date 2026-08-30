# Mini-apps Common Backend

Backend pilote commun des mini-jeux. Il est déployé par Coolify avec uniquement des données de validation non sensibles.

## Déploiement pilote

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

Les mots de passe production et preview sont indépendants. Ils sont gérés dans Coolify et ne doivent jamais être affichés, copiés dans Git ou transmis au client.

## Fonctions du prototype

- registre des jeux avec `Perfect Tap` comme pilote ;
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
```

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
- monitoring horaire actif.

La sauvegarde reste locale et n'est pas une vraie sauvegarde externe. Aucun frontend réel ne doit envoyer de données importantes avant activation de cette protection externe et validation de son origine CORS.
