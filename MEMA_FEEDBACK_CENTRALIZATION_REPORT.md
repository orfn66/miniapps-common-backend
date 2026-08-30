# Mema Feedback Centralization Report

Date : 30 août 2026. Périmètre : plateforme VPS / Admin central uniquement.

## Verdict : NO-GO

**NO-GO pour l’activation de la synchronisation**, pas une impossibilité
technique d’agréger Mema. L’audit des deux côtés est terminé. Aucun accès
technique limité aux feedbacks n’a été trouvé ; aucune intégration n’est
annoncée comme prête ou déployée.

## Résultats factuels

| Contrôle | Résultat |
|---|---|
| Source Mema | Supabase `djhyfavdqhyzujgyrxjn`, `private.feedback_reports` |
| Nombre source au moment de l’audit | **4**, tous `bug`, statut `new` |
| Textes utilisateur consultés/exportés | Aucun ; seulement des agrégats et le schéma |
| Nombre importé dans la plateforme | **0** ; aucun import lancé |
| Mema dans le registre central | Absente, volontairement pas de faux branchement |
| Resync / doublons | Non exécuté, absence de connecteur |
| Nouveau feedback depuis Mema | Non exécuté ; envoi à réaliser par l’utilisateur après activation |
| Conservation du statut source | Aucune écriture Mema effectuée ; test central futur non réalisé |
| Monitoring connecteur | Non créé ; conception documentée |
| Migrations centrales de cette mission | Aucune |
| Modifications Mema | Aucune : ni fichier, ni SQL d’écriture, ni RPC d’écriture, ni compte, ni client |
| Secrets créés, copiés ou provisionnés | Aucun |
| Tests unitaires plateforme existants | **8/8 PASS** |
| Smoke HTTPS Hub/Inbox existant | **14 contrôles PASS**, dont permissions Codex et pièce jointe privée |
| Build du connecteur | Non réalisé : aucune implémentation |
| Déploiement de cette mission | Aucun ; runtime central conservé sur `2849413` |
| Données centrales observées | 7 rapports : 6 `minigames-hub`, 1 ancien `perfect-tap` |
| Ancien registre Perfect Tap | Archivé, conservé sans migration de ses données historiques |
| Infra | API et PostgreSQL sains, timers backup/contrôle/monitoring présents |
| Dernière sauvegarde existante constatée | `55143bc6`, 2026-08-30 19:53:25 UTC |

La sauvegarde et sa restauration avaient été validées lors du déploiement
d’authentification précédent. Cette mission n’a ni refait ni prétendu refaire
la restauration ; aucune migration centrale ne justifiait un nouveau snapshot.
Le smoke admin peut actualiser `last_used_at` du compte de service et le journal
de téléchargement autorisé, mais ne crée ni ne modifie de feedback.

## Blocages précis

1. `list_feedback_reports_admin(p_status)` vérifie côté serveur l’utilisateur
   Auth confirmé et sa présence dans la liste privée des administrateurs.
   Le mot de passe App Platform n’est pas une session Mema. Aucun secret
   réutilisable pour cette tâche n’a été recherché dans le navigateur.
2. Une session admin Mema aurait aussi le droit de changer les statuts source.
   Ce n’est pas un accès technique limité aux feedbacks en lecture seule.
3. Le RPC retourne au maximum les 200 derniers rapports, sans curseur ni
   pagination. Il suffit pour la quantité actuelle, mais ne garantit pas
   l’import complet ou la reprise après une longue interruption.
4. Aucun rôle reader dédié ni autre fonction d’export feedback n’a été trouvé
   dans les droits/fonctions de production examinés. Les rôles système de
   lecture globale ne sont pas retenus. Une clé `service_role` ne résout pas
   automatiquement la vérification `auth.uid()` du RPC.
5. Créer le bon accès nécessiterait une décision supplémentaire côté Mema,
   interdite par le périmètre actuel. Aucun rôle/RPC/secret n’a donc été créé.

## Adaptations centrales identifiées

- Provenance et unicité `(source_app, source_feedback_id)` dans le modèle existant.
- Rapport importé sans fausse installation ; conserver tous les contrôles
  d’accès qui reposent aujourd’hui sur les jointures d’installation.
- Description Mema 4000 caractères contre colonne centrale `varchar(1000)` :
  élargissement nécessaire avant import, sans troncature.
- Mapping `opinion → review`, `improvement → suggestion` confirmé par les
  libellés de Mema ; statut source séparé du workflow central existant.
- Worker isolé, polling, reprise et monitoring ; pagination centrale à prévoir
  au-delà de la limite actuelle de 500 tickets dans l’Inbox.
- Aucun changement automatique des scopes Codex, actuellement limités au Hub.

Le guide PostgreSQL a orienté la conception vers des droits minimaux, une clé
unique et des index explicites. Le guide Supabase a conduit à vérifier les
définitions et privilèges réels plutôt qu’à supposer qu’une clé serveur suffisait.

## Informations à demander à la conversation Mema

Message prêt à transmettre, **sans secret en réponse** :

> La plateforme VPS a audité `private.feedback_reports` et le RPC
> `list_feedback_reports_admin(p_status)` en production. Existe-t-il déjà un
> accès serveur dédié, limité en lecture aux feedbacks, différent d’une session
> admin humaine et d’une clé globale ? Si oui, fournir le nom/signature exacts,
> les champs retournés, la pagination/cursor, les permissions effectives et le
> mécanisme de renouvellement de l’authentification — sans transmettre de
> clé, mot de passe ou JWT dans la conversation. Sinon, confirmer l’absence et
> proposer pour validation un accès minimal. Ne rien créer ni déployer dans
> Mema : le périmètre actuel interdit toute modification côté source.

La création éventuelle de cet accès et d’un secret devra être autorisée
explicitement avant exécution. Un export manuel ne serait pas présenté comme
une synchronisation automatique conforme.

## Livrables

- `MEMA_FEEDBACK_CONNECTOR.md` : architecture, contrat vérifié, mapping,
  minimisation, accès, déduplication, polling, monitoring, tests et désactivation
  proposés, tous clairement distingués des éléments déjà en production.
- Ce rapport : état réel, preuves d’audit, blocages et prochaine décision.
- Documentation seule dans le dépôt plateforme ; aucun changement runtime,
  DNS, firewall, domaine ou application métier La Pâte de Jess.
