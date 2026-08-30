# Connexion administrateur par e-mail et mot de passe

L’adresse sert d’identifiant App Platform. Ce mécanisme n’utilise ni Google, ni le mot de passe de la messagerie, ni SMTP. Il ne vérifie pas la possession de la boîte e-mail : l’autorisation initiale est donnée par le jeton administrateur existant.

## Première activation, une seule fois

1. Ouvrir `/admin` sur la préproduction HTTPS actuelle (la racine `/` y redirige).
2. Cliquer « Première connexion : définir mon mot de passe ».
3. Saisir son adresse e-mail, un nouveau mot de passe personnel de 15 à 128 caractères et sa confirmation.
4. Coller le jeton administrateur du coffre local dans le champ dédié.
5. Cliquer « Activer mon accès ».

Le jeton de première activation n’est pas enregistré dans le formulaire ou la session navigateur. Les connexions suivantes demandent uniquement l’e-mail et le mot de passe. Aucun mot de passe utilisateur n’est généré, envoyé par e-mail, versionné ou affiché dans les logs.

L’activation exige un compte de service actif avec tous les scopes et sans restriction d’applications. Un jeton Codex ne peut donc pas créer de compte administrateur. Un seul accès mot de passe peut être lié à chaque compte de service ; une nouvelle activation ne peut pas écraser un compte existant.

## Sessions et déconnexion

- cookie `__Host-app-platform-session`, `Secure`, `HttpOnly`, `SameSite=Strict`, sans domaine partagé ;
- durée absolue de 12 heures, vérifiée côté serveur ;
- jeton de session aléatoire stocké sous SHA-256 en base ;
- protection CSRF et vérification d’origine stricte pour les écritures par cookie ;
- les scopes et la révocation du compte de service restent vérifiés à chaque requête ;
- « Se déconnecter » révoque la session côté serveur et efface le cookie ;
- « Changer le mot de passe » exige le mot de passe actuel et ferme toutes les anciennes sessions.

Le hachage utilise scrypt N=131072, r=8, p=1, un sel aléatoire de 16 octets et une clé de 64 octets. Le service limite à deux calculs coûteux simultanés et à 20 demandes d’authentification par minute globalement, compteur persistant PostgreSQL.

## Accès de secours

Le bouton « Accès par jeton » reste disponible pour les jetons admin/Codex existants. Leurs permissions sont inchangées. En cas d’oubli du mot de passe, il n’existe pas encore de réinitialisation publique par e-mail : utiliser le coffre pour l’accès de secours, puis demander une réinitialisation contrôlée. Ne jamais communiquer de mot de passe dans une conversation ou un ticket.

## Migration et rollback

La migration `003_admin_password_auth.sql` ajoute trois tables, sans modifier les tickets, installations, pièces jointes ou tokens existants. Elle doit être testée dans une base isolée avant la cible et précédée d’une sauvegarde fraîche. Le rollback du code vers la version précédente conserve ces tables et revient à l’authentification par jeton ; aucune migration inverse destructive n’est nécessaire.

## Vérifications

`npm test` et `npm run test:integration` couvrent hachage, activation autorisée/interdite, mauvais mot de passe, cookie sécurisé, CSRF, connexion/déconnexion, expiration, révocation, changement de mot de passe, limites de tentatives, maintien des jetons et accès privé aux pièces jointes.

Références : [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
