# Scan App — Scanner de documents (type CamScanner, minimaliste)

## Objectif du projet
Application web (PWA) qui permet de prendre un document papier en photo, de le
redresser et le nettoyer pour obtenir un rendu « scan », d'enchaîner plusieurs
pages, puis d'exporter le tout en un seul PDF. Usage principal : mobile.

Le développeur débute (bases HTML/JS). Explique tes choix simplement.

## Périmètre — UNE seule chose, bien faite : scanner → PDF
Parcours utilisateur, le SEUL à gérer :
1. Accueil : un grand bouton central « Scanner ».
2. Ouverture caméra + détection des bords en temps réel (cadre superposé).
3. Capture de la photo.
4. Recadrage : 4 coins détectés, ajustables au doigt (glisser).
5. Filtre « scan » avec 3 modes SEULEMENT : Original, Auto (contraste rehaussé),
   Noir & blanc.
6. La page redressée s'ajoute à une liste de pages.
7. Liste : ajouter une page, supprimer une page, réordonner.
8. Bouton « Exporter en PDF » : un seul PDF multi-pages, téléchargeable/partageable.

## Interdits (rester strictement minimal)
- PAS de comptes, connexion, ni cloud.
- PAS d'OCR ni d'analyse de texte (ce sera une autre app).
- PAS de réglages, menus à rallonge, ni multi-langue.
- PAS de fonctionnalité « bonus ». Si une idée sort de ce périmètre, ne pas l'ajouter.
- Tout fonctionne côté client. AUCUNE donnée envoyée à un serveur.

## Stack technique (garder simple, pas de build compliqué)
- PWA mobile-first, installable sur l'écran d'accueil.
- HTML / CSS / JS. Vanilla JS par défaut ; framework léger seulement si vraiment utile.
- Détection des bords + redressement : jscanify (basé sur OpenCV.js), ou OpenCV.js.
- Caméra : API getUserMedia.
- Génération PDF : jsPDF.

## Direction artistique (IMPORTANT)
- Minimal, bold, moderne. Beaucoup d'espace blanc.
- Palette quasi monochrome : noir, blanc, nuances de gris.
- UNE seule couleur d'accent, utilisée avec parcimonie, pour l'action principale.
- Typographie forte et lisible : gros titres, contrastes marqués.
- Boutons larges, faciles à toucher au pouce.
- Pas de dégradés criards, pas d'icônes superflues, pas de décoration inutile.
- Le bouton de capture est l'élément central et dominant de l'interface.

## Méthode de travail attendue
- Avant d'écrire du code : proposer l'arborescence des fichiers et expliquer le rôle
  de chacun. Attendre validation.
- Construire ensuite étape par étape, avec une explication brève de chaque partie.
- getUserMedia exige HTTPS ou localhost : prévoir et expliquer comment tester sur
  téléphone (tunnel, certificat local, ou hébergement simple).
- Si une demande sort du périmètre minimal défini ci-dessus, le signaler plutôt
  que de l'implémenter.
