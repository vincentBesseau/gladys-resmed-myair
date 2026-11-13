# ResMed myAir

Cette intégration récupère les données de thérapie nocturne de votre machine PPC ResMed (AirSense, AirCurve…) depuis le cloud **ResMed myAir** — le même compte que celui de l'application et du site [myAir](https://myair.resmed.eu).

Elle est **en lecture seule** : elle ne modifie aucun réglage de votre machine. Elle crée un appareil « CPAP » avec, pour la nuit la plus récente, les capteurs suivants :

| Capteur                     | Description                           | Unité        |
| --------------------------- | ------------------------------------- | ------------ |
| **Usage**                   | Durée d'utilisation de la nuit        | heures       |
| **IAH**                     | Indice d'apnées-hypopnées             | événements/h |
| **Fuite au masque**         | Niveau de fuite (`leakPercentile`)    | L/min        |
| **Score myAir**             | Score global de la nuit               | /100         |
| **Mise en place du masque** | Nombre de fois où le masque a été mis | —            |

> ⚠️ **API non officielle.** ResMed ne publie pas d'API. Cette intégration reconstitue le fonctionnement du site myAir (authentification Okta + API GraphQL). ResMed peut la modifier sans préavis ; en cas de panne, consultez le [composant Home Assistant de référence](https://github.com/Snuffy2/resmed_myair_sensors).

## Prérequis

- Un compte **myAir** actif, associé à une machine ResMed qui synchronise ses données.
- La **région** de votre compte :
  - **Europe** → `myair.resmed.eu`
  - **Amérique du Nord** → `myair.resmed.com`

## Configuration

1. Dans Gladys, ouvrez l'intégration **ResMed myAir**.
2. Choisissez votre **région myAir**.
3. Renseignez l'**email** et le **mot de passe** de votre compte myAir.
4. Enregistrez.

### Code de vérification (double authentification)

À la première connexion, ResMed envoie un **code de vérification à usage unique par email**. Le statut de connexion vous le demande :

1. Consultez votre boîte mail.
2. Utilisez l'action **« Saisir le code de vérification »** et entrez le code reçu.

L'appareil est ensuite **mémorisé** : vous ne devriez plus être sollicité pour un code. Si l'appareil mémorisé expire un jour, le statut vous invitera à utiliser l'action **« Reconnecter »** pour recevoir un nouveau code.

## Actions disponibles

- **Saisir le code de vérification** — termine la connexion après réception du code par email.
- **Reconnecter (envoyer un nouveau code)** — force une nouvelle connexion ; envoie un code si nécessaire.
- **Tester la connexion** — vérifie que l'accès au compte fonctionne.
- **Actualiser les données maintenant** — relance la récupération immédiatement.
- **Déconnecter** — supprime les jetons stockés.

## Entretien des filtres (rappels)

L'intégration peut suivre l'usure de vos filtres et vous **rappeler quand les changer** :

1. Dans la **Configuration**, renseignez un **intervalle de remplacement en jours** pour le **filtre appareil** et/ou le **filtre masque** (0 = suivi désactivé). Défaut : 30 jours.
2. Un capteur **« Vie du filtre »** (en %) est créé pour chaque filtre activé — il décroît de 100 % à 0 % sur l'intervalle.
3. Créez une **scène** déclenchée par ce capteur (ex. _quand « Vie filtre appareil » ≤ 10 % → m'envoyer une notification_). C'est votre rappel.
4. À chaque changement, lancez l'action **« Marquer un filtre comme remplacé »** (choisissez le filtre) : la vie repart à 100 %.

Le calcul se fait en **jours calendaires** depuis le dernier remplacement.

## Widget tableau de bord

L'intégration fournit un widget **« Dernière nuit »** à ajouter à vos tableaux de bord (éditeur → **+** → « Dernière nuit »). Il affiche en tuiles les 4 métriques de la nuit la plus récente (usage, IAH, fuite au masque, score), avec un code couleur par seuil (vert / orange / rouge). Sans données récentes, il affiche un état vide explicite.

## Fréquence de mise à jour

Les machines ResMed ne synchronisent leurs données qu'**environ une fois par jour**. L'intégration interroge le cloud toutes les heures pour récupérer la dernière nuit disponible dès qu'elle apparaît. Il est donc normal que les valeurs ne changent qu'une fois par jour.
