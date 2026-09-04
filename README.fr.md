<div align="center">

# TCRN Workflow

### Votre Agent dit « c'est fait ». Ce framework l'oblige à vous remettre une preuve que vous pouvez vérifier vous-même

**Un framework de gouvernance pour la livraison par Agents IA. Chaque capacité qu'il revendique est liée à un critère réfutable par une machine — si le critère cesse de tenir, le build passe au rouge.**

[简体中文](./README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · Français

![status](https://img.shields.io/badge/status-1.0.1-blue?style=flat-square) ![gates](https://img.shields.io/badge/verify%3Ap1-24%20gates-brightgreen?style=flat-square) ![claims](https://img.shields.io/badge/proven%20claims-122-brightgreen?style=flat-square) ![deps](https://img.shields.io/badge/runtime%20deps-0-success?style=flat-square)

![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![node](https://img.shields.io/badge/node-24.16.0-informational?style=flat-square) ![pnpm](https://img.shields.io/badge/pnpm-11.3.0-informational?style=flat-square) ![network](https://img.shields.io/badge/network-none-important?style=flat-square) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-blueviolet?style=flat-square)

[Où vous en êtes](#où-vous-en-êtes) · [Pourquoi lui faire confiance](#pourquoi-lui-faire-confiance) · [Pour qui](#pour-qui) · [Ce que vous obtenez](#ce-que-vous-obtenez) · [Démarrer en trois minutes](#démarrer-en-trois-minutes) · [État actuel](#état-actuel) · [Documentation complète](#documentation-complète)

`Verified claims: 124 (hygiene 20 · inertness 13 · runtime 91)`

</div>

<table>
<tr>
<td align="center" width="25%">

### 24
gates P1<br><sub>Une commande. Le moindre imprévu l'arrête</sub>

</td>
<td align="center" width="25%">

### 122
critères<br><sub>Tous avec une jambe rouge, toutes mesurées</sub>

</td>
<td align="center" width="25%">

### 61
guards<br><sub>Cassés un par un, leur test doit virer au rouge</sub>

</td>
<td align="center" width="25%">

### 0
dépendance runtime<br><sub>Aucun réseau, aucune base de données</sub>

</td>
</tr>
</table>

> [!TIP]
> **Vous n'êtes pas obligé de croire ce README**. Installez-le et lancez une commande : il vous démontre ses 122 revendications une par une, entièrement hors ligne.

---

## Où vous en êtes

Votre Agent a modifié trente fichiers, puis vous annonce que les tests sont tous au vert.

Vous avez deux options : les relire un par un, et alors à quoi sert l'Agent ; ou le croire, et alors vous pariez. Quand quelqu'un demandera « est-ce que ça peut partir en production ? », ce que vous pouvez produire sur-le-champ décidera si c'est une conversation de dix minutes ou une journée entière.

TCRN Workflow vous donne une troisième option.

| Ce que vous voulez confirmer | ✗ Ce que vous avez aujourd'hui | ✓ Ce que vous avez ensuite |
| :--- | :--- | :--- |
| **Les tests ont-ils vraiment tourné** | Une ligne dans une fenêtre de chat | `pnpm verify:p1` — 24 gates dans l'ordre, le moindre imprévu l'arrête |
| **Qui a changé quoi, et quand** | Remonter l'historique du chat | Une chaîne d'événements chaînée par hash, en ajout seul. Modifiez une entrée de l'historique et tous les hash suivants cessent de correspondre |
| **Les protections fonctionnent-elles encore** | La supposition qu'elles fonctionnent | `pnpm guard-check` — 61 guards cassés un par un dans les sources, chacun devant faire virer son test au rouge |
| **Ces octets sont-ils ceux publiés** | Regarder le tag | Artefacts reconstruits octet par octet et comparés aux empreintes publiées |

---

## Pourquoi lui faire confiance

Le framework s'applique d'abord à lui-même la norme qu'il impose.

`pnpm guard-check` **supprime ou casse chacun des 61 guards enregistrés dans les sources**, un à la fois, et exige que le test couvrant ce guard vire au rouge. Les 61 doivent virer au rouge pour que la passe soit validée.

Ce que cela démontre n'est pas « nous avons écrit ces contrôles » mais « ces contrôles arrêtent encore quelqu'un, maintenant ». Un contrôle cassé que personne n'a remarqué équivaut à l'absence de contrôle.

Cette norme couvre les **122 revendications**. Chacune est liée dans `verification-map.yaml` à un code de raison stable, à une preuve exécutable hors ligne, et à une jambe rouge — l'énoncé du changement qui la fait virer au rouge, avec cet échec réellement observé. Les 122, sans exception.

<details>
<summary><b>Répartition des 122 critères</b></summary>

<br>

| Catégorie | Nombre | Portée |
| :--- | ---: | :--- |
| `framework-hygiene` | 20 | L'hygiène du framework lui-même : historique propre, liste blanche des sources, politique de licences et de vulnérabilités, frontière hors ligne |
| `inertness-proof` | 13 | Preuve d'inertie : un adaptateur d'hôte ne fait strictement rien après installation, jusqu'à approbation explicite de l'activation |
| `runtime-capability` | 89 | Capacités d'exécution : chaîne d'événements, bail, vues, cœur de connaissances, routeur de contexte, jeu de publication |

La liste complète est dans `verification-map.yaml`, chaque entrée portant `id`, `command`, `fixturePaths` et sa jambe rouge.

</details>

> [!IMPORTANT]
> Changez la portée d'un critère sans le re-démontrer et le build échoue. Ce n'est pas une préférence de style, c'est imposé.

---

## Pour qui

| ✓ Adapté si | ✗ Pas adapté si |
| :--- | :--- |
| Vous confiez à des Agents un travail à conséquences : code de production, livraison qui doit laisser une trace, plusieurs Agents qui se relaient sans que personne ne se rappelle qui a décidé quoi. | Vous voulez un assistant conversationnel sans configuration, utilisable dès l'installation. |
| Ce que vous remettez à un relecteur doit être un artefact qu'il peut relancer, pas une conversation qu'il doit croire. | Vous avez besoin de synchronisation cloud, d'un tableau de bord hébergé ou de vues collaboratives. |
| Vous exigez que tout reste sur votre machine : pas de base de données, pas de démon, pas de réseau, pas de télémétrie. | Votre travail est encore exploratoire et une piste d'audit en ajout seul est aujourd'hui un coût plutôt qu'un bénéfice. |

---

## Ce que vous obtenez

| Vous obtenez | Ce que c'est concrètement |
| :--- | :--- |
| **Un workspace fait uniquement de fichiers** | Tout le graphe Initiative → Epic → Story → Subtask en JSON canonique, plus une chaîne de hash. Auditable avec `cat` et `sha256sum`, exportable de façon reproductible octet par octet. |
| **24 gates en une commande** | `pnpm verify:p1` enchaîne format, lint, types, build, 133 fichiers de test, matrice de confiance, archive et SBOM et licences et politique de vulnérabilités, liste blanche des sources, frontière hors ligne, analyse de confidentialité, durcissement CI, registre des critères, historique propre. |
| **122 critères lisibles par une machine** | 20 framework-hygiene, 13 inertness-proof, 89 runtime-capability. Tous avec jambe rouge, tous liés à des codes de raison observables. |
| **Des guards qui prouvent leur efficacité** | 61 guards, cassés un par un par `pnpm guard-check`, chacun devant faire virer son test au rouge. |
| **137 verbes CLI gouvernés** | Tous en local. Chaque écriture déclare la version sur laquelle elle se base et est refusée si quelqu'un a écrit avant. Jamais d'écrasement silencieux. |
| **Zéro dépendance d'exécution** | `dependencies` et `optionalDependencies` sont vides dans `package.json`. Le mode développement ajoute un guard réseau au niveau du processus. La télémétrie est nulle. |

---

## Démarrer en trois minutes

Il faut la chaîne d'outils épinglée : **Node 24.16.0** et **pnpm 11.3.0**. Les scripts de cycle de vie des dépendances restent désactivés, donc l'installation n'exécute aucun code tiers.

```sh
# 1. Installer les dépendances de dev épinglées (explicite, figé, sans scripts)
pnpm install --offline --frozen-lockfile --ignore-scripts

# 2. Laisser le framework se prouver lui-même (24 gates, entièrement hors ligne)
pnpm verify:p1

# 3. Construire, puis piloter la CLI gouvernée
pnpm build
node scripts/tcrn-workflow.mjs commands
```

<details>
<summary><b>Les commandes gouvernées les plus utilisées</b></summary>

<br>

Toutes en local, sans réseau, sans base de données.

```sh
# valider un workspace et matérialiser ses vues déterministes
node scripts/tcrn-workflow.mjs validate --workspace <chemin>

# créer un enregistrement de travail avec une écriture vérifiée en version
node scripts/tcrn-workflow.mjs work-create --workspace <chemin> --expected-version <version> ...

# rechercher des enregistrements par sujet
node scripts/tcrn-workflow.mjs work-list --workspace <chemin> --search "<terme>"
```

</details>

> [!NOTE]
> La liste des capacités, c'est ce que produit `commands`, jamais ce que dit un document. La documentation peut prendre du retard sur le code. Le catalogue de commandes, non.

---

## État actuel

La version acceptée est **1.0.1**. Chaque version acceptée est un tag immuable accompagné d'un jeu d'artefacts reproductible, et `CHANGELOG.md` en est le registre complet.

Publication, push et pose de tag sont des étapes distinctes, jamais déduites des tests locaux. Les utilisateurs extérieurs vérifient les octets de version via le `tcrn-workflow-helper` qui l'accompagne, dont l'empreinte d'amorceur est publiée séparément et vérifiable de façon indépendante.

Les limites connues sont sur la page « Limites connues » du wiki : un seul écrivain par workspace, un plafond de volume d'événements, et une reprise vers le chemin d'origine uniquement. Ce sont des décisions de conception, pas une liste de tâches.

## Documentation complète

Architecture, référence des commandes, critères et gates, structure du dépôt, limites connues et questions fréquentes se trouvent tous dans le wiki GitHub de ce dépôt, accessible depuis l'onglet **Wiki** en haut de la page du dépôt.

[Contribuer](./CONTRIBUTING.md) · [Sécurité](./SECURITY.md) · [Confidentialité](./PRIVACY.md) · [Code de conduite](./CODE_OF_CONDUCT.md) · [Support](./SUPPORT.md)

## Licence

Apache-2.0. Voir [LICENSE](./LICENSE) et [NOTICE](./NOTICE).
