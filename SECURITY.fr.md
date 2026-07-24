<!-- tcrn-doc-synced-to: SECURITY.md 4bc24fd915e062476a5ef7b02c7842d5958b95be0522b39c308597629de0bb3e -->

> **La version anglaise fait autorité.** Cette traduction est fournie par commodité ; en cas de divergence entre les deux, c'est le texte anglais de SECURITY.md qui prévaut.

# Politique de sécurité

## Versions prises en charge

Les correctifs de sécurité visent la branche par défaut actuelle et la dernière release étiquetée (`0.5.0`). Dans la plage `0.x`, il n'existe pas de voie de rétroportage : passez à la dernière version mineure pour recevoir les correctifs. Les versions mineures antérieures et tout candidat de pré-release ne sont pas maintenus séparément. Une release n'est prise en charge qu'une fois son bundle vérifié par rapport à une racine de confiance externe et accepté séparément.

## Signaler une vulnérabilité

Utilisez le formulaire privé d'avis de sécurité du dépôt. N'incluez pas de secrets, de données personnelles ni de détails d'exploitation dans une issue publique. Les mainteneurs accuseront réception d'un rapport complet dans la mesure où leur capacité le permet ; cette politique n'est pas un accord de niveau de service.

## Frontière de la chaîne d'approvisionnement

Les scripts de cycle de vie des dépendances sont désactivés. Les actions CI sont épinglées à des identifiants de commit immuables. La vérification de release rejette toute politique de confiance stockée à l'intérieur du checkout candidat.
