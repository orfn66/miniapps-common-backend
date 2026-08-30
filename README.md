# Mini-apps Common Backend

Prototype local du backend commun des mini-jeux. Il n'est pas déployé et ne contient aucune donnée utilisateur réelle.

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

## État

Ce code est un socle de conception. Avant tout déploiement : revue du modèle, tests d'intégration PostgreSQL, choix du dépôt Git, origine CORS réelle, domaine HTTPS et destination de sauvegarde externe.
