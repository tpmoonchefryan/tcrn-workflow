<div align="center">

# TCRN Workflow

### Transformez le « c'est fait » de votre agent en une preuve que vous pouvez vérifier vous-même

**Un cadre de gouvernance pour la livraison pilotée par des agents IA. Chaque capacité annoncée est une affirmation qu'une machine peut réfuter.**

[简体中文](./README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · Français

![status](https://img.shields.io/badge/status-1.0.1-blue) ![gates](https://img.shields.io/badge/verify%3Ap1-24%20gates-brightgreen) ![claims](https://img.shields.io/badge/proven%20claims-122-brightgreen) ![deps](https://img.shields.io/badge/runtime%20deps-0-success)

![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![node](https://img.shields.io/badge/node-24.16.0-informational) ![pnpm](https://img.shields.io/badge/pnpm-11.3.0-informational) ![network](https://img.shields.io/badge/network-none-important) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-blueviolet)

[Ce que cela résout](#ce-que-cela-résout) · [Pour qui](#pour-qui) · [Ce que vous obtenez](#ce-que-vous-obtenez) · [Démarrer en trois minutes](#démarrer-en-trois-minutes) · [Un exemple réel](#un-exemple-réel) · [État actuel](#état-actuel) · [Documentation complète](#documentation-complète)

`Verified claims: 122 (hygiene 20 · inertness 13 · runtime 89)`

</div>

---

## Ce que cela résout

Votre agent vous dit que les tests passent. Ce que vous avez en main, c'est une ligne de texte dans une fenêtre de discussion.

TCRN Workflow remplace cette ligne par trois choses vérifiables.

- **Un registre d'affirmations.** Chaque capacité annoncée par le cadre correspond à une affirmation dans `verification-map.yaml`, liée à un code de raison stable et prouvée par un test qui s'exécute hors ligne.
- **Une chaîne d'événements infalsifiable.** Chaque modification d'un espace de travail est un enregistrement chaîné. Chaque entrée est hachée avec la précédente, l'ajout est la seule opération possible, et l'historique ne peut pas être réécrit.
- **Une publication reproductible.** Chaque version peut être reconstruite octet par octet et comparée aux empreintes publiées.

Modifiez ce qu'une affirmation couvre sans la prouver à nouveau et la construction échoue. C'est appliqué, pas conseillé.

## Pour qui

| | |
| --- | --- |
| **Adapté** | Vous confiez à des agents un travail qui a des conséquences : code de production, livraison qui doit laisser une trace, passages de relais entre agents où plus personne ne sait qui a décidé quoi. Vous voulez un artefact qu'un relecteur peut vérifier, pas une transcription qu'il doit croire. Vous voulez que tout reste sur votre machine : pas de base de données, pas de démon, pas de réseau, pas de télémétrie. |
| **Pas adapté** | Vous voulez un assistant conversationnel sans configuration, il vous faut une synchronisation cloud ou un tableau de bord hébergé, ou votre travail est assez exploratoire pour qu'une piste d'audit en ajout seul soit une gêne plutôt qu'une valeur. |

## Ce que vous obtenez

| Vous obtenez | Concrètement |
| --- | --- |
| **Un espace de travail fait uniquement de fichiers** | Tout le graphe de travail — Initiative → Epic → Story → Subtask — est du JSON en forme canonique plus une chaîne de hachage. Auditez-le avec `cat` et `sha256sum` ; les exports sont reproductibles à l'octet près. |
| **Une commande, 24 barrières** | `pnpm verify:p1` enchaîne le formatage, le lint, le typage, la construction, 134 fichiers de tests, la matrice de confiance, les politiques d'archive, SBOM, licences et vulnérabilités, la liste blanche des sources, la frontière hors ligne, l'analyse de confidentialité, le durcissement CI, le registre d'affirmations et la preuve d'historique propre. Le moindre imprévu l'arrête. |
| **122 affirmations lisibles par une machine** | `verification-map.yaml` lie 122 affirmations à des codes de raison observables : 20 d'hygiène du cadre, 13 de preuve d'inertie, 89 de capacité d'exécution. Les 122 ont une branche rouge : chacune indique quel changement la ferait passer au rouge, et ce rouge a été mesuré. |
| **Des garde-fous qui prouvent qu'ils mordent encore** | `pnpm guard-check` casse dans le code source chacun des 61 garde-fous enregistrés et exige que le test correspondant passe au rouge. |
| **137 verbes CLI gouvernés** | Tous locaux. Chaque écriture déclare sur quelle version elle s'appuie ; si quelqu'un a écrit avant, l'écriture est refusée au lieu d'écraser en silence. |
| **Zéro dépendance d'exécution** | `dependencies` et `optionalDependencies` sont vides dans `package.json`. Le mode développement installe aussi un garde réseau au niveau du processus, et la télémétrie est nulle. |

## Démarrer en trois minutes

Il vous faut la chaîne d'outils épinglée : Node 24.16.0 et pnpm 11.3.0. Les scripts de cycle de vie des dépendances restent désactivés : l'installation n'exécute aucun code tiers.

```sh
# 1. Installer les dépendances de développement épinglées : verrou figé, sans scripts
pnpm install --offline --frozen-lockfile --ignore-scripts

# 2. Laisser le cadre se prouver lui-même : 24 barrières, entièrement hors ligne
pnpm verify:p1

# 3. Construire, puis piloter la CLI gouvernée
pnpm build
node scripts/tcrn-workflow.mjs commands
```

Commandes gouvernées courantes, toutes locales, sans réseau ni base de données :

```sh
# valider un espace de travail et matérialiser ses vues déterministes
node scripts/tcrn-workflow.mjs validate --workspace <chemin>

# créer un enregistrement de travail avec une écriture vérifiée par version
node scripts/tcrn-workflow.mjs work-create --workspace <chemin> --expected-version <version> ...

# rechercher des enregistrements par sujet
node scripts/tcrn-workflow.mjs work-list --workspace <chemin> --search "<mot-clé>"
```

## Un exemple réel

`pnpm guard-check` retire ou casse dans le code source chacun des 61 garde-fous enregistrés, un par un, et exige que le test nommé de ce garde-fou passe au rouge. Les 61 doivent passer au rouge pour que la série soit validée.

Ce que cela prouve : ces protections fonctionnent encore aujourd'hui, et pas seulement que quelqu'un les a écrites un jour. Une vérification qui pourrait se casser sans que personne s'en aperçoive équivaut à une absence de vérification.

## État actuel

La version acceptée en cours est 1.0.1. Chaque version acceptée est une étiquette immuable accompagnée d'un ensemble d'artefacts reproductibles ; `CHANGELOG.md` porte le registre complet.

La publication, la poussée et l'étiquetage sont des étapes distinctes et ne se déduisent jamais des tests locaux. Les consommateurs externes vérifient les octets de la version via le compagnon `tcrn-workflow-helper`, dont la propre empreinte d'amorçage est publiée séparément pour être vérifiée de façon indépendante.

Les limites connues figurent sur la page « Limites connues » du wiki : un seul écrivain par espace de travail, le plafond du nombre d'événements, et la restauration uniquement au même chemin. Ce sont des décisions de conception, pas un arriéré.

## Documentation complète

Architecture, référence des commandes, affirmations et barrières, structure du dépôt, limites connues et réponses directes se trouvent dans le wiki GitHub de ce dépôt, accessible par l'onglet Wiki en haut de la page du dépôt.

[Contribuer](./CONTRIBUTING.md) · [Sécurité](./SECURITY.md) · [Confidentialité](./PRIVACY.md) · [Code de conduite](./CODE_OF_CONDUCT.md) · [Support](./SUPPORT.md)

## Licence

Apache-2.0. Voir [LICENSE](./LICENSE) et [NOTICE](./NOTICE).
