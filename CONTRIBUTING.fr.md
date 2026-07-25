<!-- tcrn-doc-synced-to: CONTRIBUTING.md 0309c55144aa0e4cdbdaab6290001650e3c0c805c3235bd767940a2934ddf93e -->

> **La version anglaise fait autorité.** Cette traduction est fournie par commodité ; en cas de divergence entre les deux, c'est le texte anglais de CONTRIBUTING.md qui prévaut.

# Contribution

Utilisez les versions épinglées de Node et de pnpm. N'activez pas les scripts de cycle de vie des paquets, n'ajoutez pas d'exécutable non épinglé, n'introduisez pas de télémétrie et ne faites pas en sorte qu'une commande de projet accède implicitement au réseau.

Avant de proposer une modification :

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm verify:p1
```

Les dépendances doivent être des versions exactes, compatibles avec une distribution Apache-2.0, et ajoutées aux politiques de dépendances hors ligne et de vulnérabilités. Les fichiers sources qui acceptent des commentaires doivent inclure `SPDX-License-Identifier: Apache-2.0`.

Le comportement de release doit échouer en fermeture lorsqu'une racine de confiance externe est absente, contrôlée par le candidat, expirée, révoquée ou incohérente avec le manifeste signé.

## Budget de preuve

**Définition.** La masse de preuve est le nombre total de sauts de ligne de `tests/**/*.mjs` plus `scripts/**/*.mjs` (le filtre `.mjs` exclut les fichiers de politique JSON de `scripts/policy`). La masse de produit est le nombre total de sauts de ligne de `packages/*/src/**/*.ts`. Les lignes vides et les commentaires sont comptés délibérément : la mesure est grossière à dessein, afin d'être déterministe et de ne pas prêter à débat sur le reformatage. Le ratio preuve/produit est `proofMass / productMass`.

**Règle.** Tant que le ratio est égal ou supérieur à `1.0`, aucune pull request ne peut introduire une NOUVELLE porte de vérification — c'est-à-dire un nouveau gestionnaire `scripts/task.mjs`, un nouveau script `verify:*` ou une nouvelle revendication de la carte de vérification dont la catégorie est `framework-hygiene` — à moins que la même pull request ne retire au moins l'équivalent en masse de preuve, ou que l'Owner ne consigne une exception écrite. Les revendications dont la catégorie est `runtime-capability` sont exemptées : elles sont le produit qui fait son travail, non de l'échafaudage de preuve.

**Base de référence.** Lors de l'adoption, le ratio mesuré était d'environ `1.62` (base de référence corrigée, le paquet `packages/protocol` étant inclus dans la masse de produit conformément à sa définition), bien au-dessus du seuil de `1.0`, de sorte que la règle s'impose.

**Exception consignée — OD-21, 2026-07-19, `pnpm guard-check`.** L'Owner accorde une exception écrite pour le registre de gardes et son vérificateur par mutation (`scripts/guard-check.mjs`, `scripts/policy/guard-registry.json`).

L'exception est consignée ici plutôt qu'évitée, et la distinction compte. Le vérificateur aurait pu être livré comme un script npm autonome — la forme que `push-gate` emploie déjà — puis l'on aurait pu soutenir qu'il tombe hors des trois formes que la règle nomme. Cet argument tient pour `push-gate`, qui vérifie la cohérence de release et n'ajoute aucune surface de preuve. Il ne tient pas ici : un vérificateur par mutation est de l'échafaudage de preuve par toute lecture, et contourner la règle sur une lecture textuelle étroite serait la forme de gouvernance de la substitution exacte que le propre audit de ce dépôt a débusquée dans son code.

Ce que l'exception achète : le programme rc.6 a fait atterrir à deux reprises une garde dont la preuve n'a jamais été écrite, et la conséquence était que revenir sur la garde ne faisait rien passer au rouge. La correction fut une discipline consignée dans les messages de commit — revenir sur chaque garde, observer le rouge, restaurer. Ceci fait de cette discipline un jugement de machine. Elle ne déclare aucune capacité nouvelle ; elle teste si la preuve existante mord encore.

Portée : `guard-check` reste un script autonome branché sur `push-gate`. Il n'est délibérément **pas** intégré à `verify:p1`, car chaque entrée coûte une compilation plus une exécution de tests (~4-5 s mesurées) et les dix-huit entrées du registre pousseraient le temps d'horloge de P1 au-delà du déclencheur d'escalade de 180 s qui protège la discipline « exécutez-le à chaque modification ».

**Actuel.** `{proofLines: 26631, productLines: 16011, ratio: 1.6633}`, mesuré le 2026-07-20. **Remesurez plutôt que de citer ce nombre.** C'est un instantané, pas une valeur épinglée : il a déjà été trouvé périmé de 144 lignes une fois, et chaque entrée du commentaire courant qui vivait ici s'est périmée à l'instant où la modification suivante a atterri — un paragraphe qui dit quel travail a ajouté « les dernières » lignes est faux dès qu'il en existe une plus tardive. Le ratio a évolué entre `1.535` et `1.6575` au fil du programme rc.6, du vérificateur de gardes OD-21, du durcissement post-release, du travail de déduplication OD-16 et de `host-evidence` ; **git log sur ce fichier est l'historique, et il ne se périme pas.** Ce qui compte ici, c'est la valeur actuelle, la règle ci-dessus, et que le ratio n'a jamais approché `1.0`, de sorte que la règle s'impose toujours.

**Mesure.** Exécutez la commande de rapport uniquement :

```sh
node scripts/task.mjs budget
```

Elle imprime `{proofLines, productLines, ratio}` avec le reason code `PROOF_BUDGET_REPORT` et se termine toujours avec le code `0`. La commande est une mesure, non une porte : elle est intentionnellement absente de la carte de vérification et de l'intégration continue, précisément pour que la règle de budget n'ajoute pas elle-même le genre de porte qu'elle gouverne. La règle lie les relecteurs et la porte de l'Owner, non la CI.

## La preuve n'est pas une porte — `pnpm host-evidence` (OD-C3, 2026-07-20)

`scripts/host-evidence.mjs` pilote le vrai binaire Claude Code contre une installation réelle de la charge utile de l'adaptateur et écrit `docs/verification/host/claude-code.json`. C'est une **preuve de release, non une porte de vérification**, et la distinction décide trois choses à son sujet :

- Elle n'est **pas** dans l'espace de noms `verify:*`, **pas** dans la carte de vérification, et **aucune** porte ni tâche CI n'en dépend. L'interdiction de nouvelles portes par la règle de budget n'est donc pas engagée et aucune exception n'a été nécessaire.
- Elle ne peut pas s'exécuter là où Claude Code est absent. Un contrôle que personne ne peut reproduire devient un contrôle que tout le monde apprend à sauter, ce qui est la façon dont une porte se met à mentir.
- Son **absence bloque une release** ; son code de sortie ne bloque rien. Ce sont des mécanismes différents, et ils ne sont délibérément pas exprimés par le même.

Le reçu est écrit en deux groupes parce qu'ils exigent des exécutants différents. Le groupe A est observable sans identifiants — les hooks se déclenchent avant l'authentification, de sorte qu'une session en bac à sable qui meurt sur un 401 les a tout de même exécutés. Le groupe B exige une session authentifiée et son exécution revient à l'Owner. **Lorsque le groupe B n'a pas été exécuté, le reçu doit le montrer comme absent plutôt que l'omettre** : un reçu qui n'énumère que ce qui a été vérifié se lit comme complet, et le passage au vert du groupe A est exactement le résultat qui, sinon, serait pris pour l'ensemble.

Le groupe B est constitué de deux commandes, non d'une procédure à reconstruire :

```sh
pnpm host-evidence --prepare-group-b     # installs a probe, prints what to run
# run the printed `claude -p …` in the probe, then:
pnpm host-evidence --record-group-b --observed "<the answer>" --runner "<who>"
```

La commande imprimée achemine son prompt via stdin. `--tools` est variadique, de sorte qu'un prompt écrit après lui est consommé comme un autre nom d'outil et la CLI refuse avec « Input must be provided » — la première version a été livrée ainsi, parce que le drapeau était vérifié dans `--help` et que la commande composée n'a jamais été réellement exécutée.

La question demande au modèle quel identifiant d'espace de travail son contexte de session mentionne, et la réponse est l'observation — c'est pourquoi `--record-group-b` la confronte à l'identifiant installé plutôt que d'accepter un verdict. Une réponse qui ne le nomme pas est enregistrée comme `CONTRADICTED`, non abandonnée en silence, et le nom de l'exécutant figure dans le reçu à côté du résultat.

**Deux propriétés font de cette réponse une preuve plutôt qu'une coïncidence, et les deux sont requises.** L'identifiant d'espace de travail est un nonce forgé à chaque préparation, de sorte qu'il ne peut être deviné à partir du chemin de la sonde ni de quoi que ce soit que le modèle a vu auparavant. Et la commande imprimée passe `--tools ""`, de sorte que l'identifiant ne peut être lu depuis `project.json` — lequel se trouve juste là et ne peut être retiré, parce que le gestionnaire le lit. Supprimez l'un ou l'autre et une réponse correcte devient compatible avec le fait que le résumé n'ait jamais atteint le modèle du tout — ce qui est précisément la seule chose que cette observation existe pour établir.

Une exécution du groupe A réécrit le reçu, mais **elle reporte un groupe B enregistré plutôt que de le réinitialiser**, en le marquant comme pris contre des octets antérieurs. Le groupe B coûte une session à un humain ; la régénération du groupe A ne doit jamais pouvoir dépenser cela en silence. Une provenance périmée mais déclarée est récupérable — un blanc là où se trouvait une observation ne l'est pas.

## Documentation et traductions

Les documents racine destinés aux humains sont reproduits dans les langues déclarées dans `scripts/policy/doc-coverage.json` et suivent le style maison décrit dans `docs/style/house-style.md`. L'anglais fait autorité ; chaque traduction épingle le SHA-256 de sa source anglaise. Lorsque vous modifiez l'un de ces documents, resynchronisez et réépinglez chaque traduction dans la même modification — `pnpm push-gate` échoue en fermeture sur une épingle périmée, une traduction manquante, une version restée dans la prose ou la règle d'emphase CJK. `LICENSE`, `NOTICE`, `CHANGELOG.md` et `SUPPORT.md` sont réservés à l'anglais par politique.
