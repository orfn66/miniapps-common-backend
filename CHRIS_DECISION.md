# Décision de Chris — version locale, non déployée

Cette évolution ajoute une orientation humaine à chaque ticket, **sans changer
son statut technique et sans envoyer de message**. Le centre distribuera les
demandes lorsqu’il sera sollicité, un ticket à la fois avec un bilan groupé.

## Contrôle dans l’admin

Dans le détail, au-dessus du workflow :

- « Décision de Chris » : choix unique À trier / À faire / À discuter / Pas besoin.
- À faire : destinataire Auto / ChatGPT / Codex. Cela demande une solution,
  **pas une autorisation générale de développer ou déployer**.
- À discuter : ChatGPT imposé, sans sélecteur de destination.
- À trier et Pas besoin : aucun destinataire ; aucun envoi, fermeture ou effacement.
- Consigne facultative, 1000 caractères maximum ; bouton « Enregistrer la décision ».
- Version, date et historique des 50 derniers changements affichés.
- Badge sur chaque carte et filtre « Décision de Chris » dans l’Inbox.

L’historique antérieur reste accessible dans le journal d’audit selon ses règles
existantes. Le texte libre des tickets reste non fiable : ne pas le confondre
avec une consigne enregistrée par l’admin.

## Droits

La modification exige une **session humaine e-mail/mot de passe**, active, avec
`feedback:read` et `feedback:write`, l’app autorisée, l’origine exacte et le CSRF.
La capacité `can_edit_decision` est calculée côté serveur. Ce contrôle utilise
le modèle d’identité existant, pas une comparaison d’e-mail dans le navigateur.
Si d’autres comptes humains admin sont créés ultérieurement, cette règle devra
être réévaluée : aujourd’hui il n’existe pas de rôle distinct « Chris seul ».

Tous les Bearer, même admin, sont refusés pour cette opération. Ils conservent
leurs autres droits. Aucun scope n’est ajouté au compte Codex reader : il peut
lire les décisions uniquement sur les applications déjà autorisées.

Les installations ne peuvent pas créer de ticket avec ces champs de décision,
ni les modifier. Ils ne sont pas exposés par `/feedback/mine`. Le endpoint de
statut rejette les champs de décision pour éviter une modification combinée.
Notes et historique restent exclusivement dans les réponses admin autorisées.

## API additive

Les GET `/api/v1/admin/feedback` et `/api/v1/admin/feedback/{id}` ajoutent :

```json
{
  "chris_decision": "to_triage",
  "decision_destination": "none",
  "decision_note": "",
  "decision_version": 0,
  "decision_updated_at": null
}
```

Le GET détail ajoute `can_edit_decision` et `decision_history`. Le filtre est
`?chris_decision=to_do`, combinable avec les filtres actuels et restrictions d’app.

`PATCH /api/v1/admin/feedback/{id}/decision`, JSON complet :

```json
{
  "chris_decision": "to_do",
  "decision_destination": "codex",
  "decision_note": "Proposer une solution, sans déployer.",
  "expected_version": 0
}
```

Associations : `to_do → auto/chatgpt/codex`, `to_discuss → chatgpt`,
`to_triage/not_needed → none`. Valeurs inconnues, champs supplémentaires ou
association incohérente : 400. Pas de session : 401. Droits/CSRF : 403.
Ticket absent ou hors périmètre : 404. Version périmée : 409 `decision_conflict`.
Le bouton de rechargement permet alors de revoir la décision sans écrasement.

Chaque changement réel incrémente `decision_version` et enregistre une entrée
`feedback.decision_update` dans `platform_audit_log`, avec avant/après/version,
dans **la même transaction**. Échec d’audit = annulation du changement. Une
sauvegarde identique avec la bonne version ne change ni date, ni version,
ni historique. Changer uniquement la consigne constitue un changement réel.
Le statut technique ne change pas la version de décision, et inversement.

## Consommation par le centre

La clé de suivi est `(public_id, decision_version)`, pas `updated_at` ni le type
du ticket. Le centre doit mémoriser les versions traitées et relire la décision
avant de transmettre, car Chris peut la changer après la lecture initiale.
À trier et Pas besoin ne produisent aucune mission ; À discuter va à ChatGPT ;
À faire demande seulement une solution au destinataire choisi (Auto laisse le
choix au centre). La consigne reste soumise aux garde-fous de la mission.

**Aucune garantie « exactement une fois »** : il n’y a ni outbox, ni accusé
de traitement, ni réservation de travail dans cette évolution. Une panne entre
envoi et mémorisation doit être réconciliée par le centre avant tout nouvel envoi.
La liste existante reste limitée à 500 tickets ; le filtre À faire / À discuter
facilite la lecture, mais ne remplace pas une pagination future si ce seuil est
atteint. Aucune connexion OpenAI, aucun scheduler, aucune nouvelle conversation.

## Migration et future mise en ligne

`004_chris_decision.sql` ajoute cinq colonnes, une contrainte de routage et un
index. Tous les tickets, y compris historiques, deviennent À trier, destination
none, version 0 et date null ; aucune décision n’est déduite de leur contenu.
Les colonnes préexistantes, captures et historique technique sont conservés.

Migration testée dans un PostgreSQL 17 **local et dédié**, pas sur le VPS.
Le guide PostgreSQL a conduit à conserver les privilèges minimaux existants et
à rendre le changement de décision et son audit atomiques.

Avant toute mise en ligne ultérieure : revue et validation utilisateur,
sauvegarde Restic fraîche, répétition isolée VPS selon le processus habituel,
migration avant démarrage de la nouvelle API, puis smoke admin/Hub et contrôle
du backup. Le dump Restic existant inclura les colonnes et l’audit sans nouvelle
configuration. Rollback du code possible en conservant les colonnes ajoutées ;
aucune migration inverse destructive ni restauration écrasant les tickets.

## Vérifications locales

- `npm test` : validation des valeurs, rôles humains/service et champs forgés.
- `npm run test:integration` : historique par défaut, contrôle multi-app, session
  reader, CSRF, refus des Bearer, contrainte DB, version, concurrence, no-op,
  annulation sur échec d’audit, conservation statut/captures et filtre Codex.
- `npm run test:ui` : Edge headless, API simulée, mobile 390 px et desktop 1440 px,
  choix unique, routage, filtre, conflit, lecture seule et texte échappé ; aucun
  secret réel, aucune API de production.
- Build Docker local ; aucune image poussée et aucun déploiement.

Le test d’intégration exige une base vierge `app_platform_*` sur localhost.
Le test UI utilise Edge sous Windows par défaut, configurable via `BROWSER_PATH`.

### Résultat de cette livraison — 30 août 2026

- 11/11 tests unitaires réussis.
- Intégration complète réussie deux fois sur deux bases locales vierges,
  dont `app_platform_decision_final` ; migrations 001 à 004 validées.
- Tests Edge mobile et desktop réussis, capture mobile inspectée visuellement.
- Build `app-platform-decision-local:20260830` réussi ; syntaxe OpenAPI YAML
  vérifiée avec js-yaml 4.1.1 utilisé ponctuellement, sans dépendance projet ajoutée.
- `git diff --check` réussi. Aucun secret réel lu ni utilisé pour ces tests.
- Conteneur local `app-platform-decision-test-20260830` arrêté après validation,
  bases de test conservées. Aucun autre conteneur modifié.
- Aucun push, aucune migration VPS, aucun déploiement, aucun envoi de mission.

Fichiers du changement :

| Périmètre | Fichiers |
|---|---|
| Migration | `migrations/004_chris_decision.sql` |
| API et validation | `src/decision.js`, `src/server.js`, `src/domain.js` |
| Interface | `admin/index.html`, `admin/app.js`, `admin/style.css` |
| Tests | `test/decision.test.js`, `test/decision.integration.mjs`, `test/integration.mjs`, `scripts/test-admin-ui.mjs` |
| Contrat et documentation | `openapi.yaml`, `CHRIS_DECISION.md`, `README.md` |
| Commande de test UI | `package.json` |
