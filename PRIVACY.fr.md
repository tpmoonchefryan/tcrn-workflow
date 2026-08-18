<!-- tcrn-doc-synced-to: PRIVACY.md 6f95447d986dc694988233e433650c82fd3c76d8dfc74c27db7a0ab08d7f39bf -->

> **La version anglaise fait autorité.** Cette traduction est fournie par commodité ; en cas de divergence, le texte anglais de [PRIVACY.md](./PRIVACY.md) prévaut.

[English](./PRIVACY.md) · [简体中文](./PRIVACY.zh-CN.md) · [日本語](./PRIVACY.ja.md) · [한국어](./PRIVACY.ko.md) · Français

# Confidentialité

TCRN Workflow ne contient aucun client de télémétrie. Les commandes projet P1
s'exécutent avec une garde réseau de processus Node, une liste blanche exacte
de processus enfants, des réglages par défaut hors ligne du gestionnaire de
paquets, et des contrôles statiques des imports et outils capables d'accéder au
réseau. Ce n'est pas un bac à sable réseau au niveau du noyau ou du système
d'exploitation. Le démarrage des actions CI et l'étape gelée et explicitement
marquée d'acquisition des dépendances demeurent des frontières réseau externes.

Les archives source et de release ne doivent contenir aucune information
d'identification, aucune donnée personnelle, aucun chemin spécifique à une
machine, aucun enregistrement privé du plan de contrôle, aucun état d'exécution,
aucune adresse e-mail brute, aucun export client/source, ni aucun identifiant de
conversation. L'URL publique du dépôt Git, les noms d'utilisateur d'hébergement
Git publics et les adresses noreply générées par GitHub correspondantes ne sont
autorisés que là où les métadonnées de commit Git ou d'étiquette annotée les
exigent. Ils ne sont pas autorisés dans les sources, les noms de fichiers, les
archives ou les messages de commit simplement parce qu'ils sont publics.

`pnpm verify:privacy` analyse les noms de fichiers et contenus actuels,
l'archive source, tous les objets Git commit/tree/blob/tag stockés, les chemins
récursifs complets depuis chaque racine de commit atteignable, et les métadonnées
de références. Les lectures échouent en fermeture ; des entrées source régulières
à lien unique sont requises. La sortie générée est ignorée par Git mais n'est
écrite qu'à travers une racine `dist` réelle et validée pendant que la session de
sortie exclusive du checkout propre est détenue. Les redirections préexistantes
échouent en fermeture ; la mutation hostile concurrente de l'espace de travail
est hors du modèle de menace P1.

L'analyseur est une politique d'expressions régulières déterministe et ciblée,
non un système DLP généraliste. Une analyse fraîche d'avis de sécurité ou un scan
Codex Security, ainsi qu'un bac à sable réseau du système d'exploitation,
demeurent des frontières externes.

Le bundle candidat P8 ne contient que l'archive source canonique, le manifeste de
release, les sommes de contrôle, le SBOM, la provenance et les notes de release.
Les clés de test de confiance locales demeurent hors du checkout candidat et ne
sont jamais copiées dans ces artefacts.

P2 autorise une chaîne exacte publique du plan de contrôle uniquement comme
contrat normatif :
`.context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json`.
Le marqueur lui-même est absent de P2 et sa présence est rejetée par la
vérification P2. Aucun chemin frère du plan de contrôle ni contenu de plan de
contrôle intégré n'est autorisé.

Toute fonctionnalité réseau future requiert un contrat d'adhésion explicite, un
flux de données documenté, une politique de rétention et une acceptation
distincte.
