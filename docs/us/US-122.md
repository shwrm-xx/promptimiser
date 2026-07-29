# US 122 — Refonte synthétique orientée usage

- lot : #122
- epic : Dashboard usage

## Récit

En tant que destinataire du tableau de bord (le pilote du projet, pas le mesureur),
je veux que la page m'annonce d'abord ce qu'il faut garder, améliorer et arrêter,
afin de décider sans avoir à lire sept blocs d'indicateurs et à me fabriquer moi-même le
jugement qui va avec.

## Critères d'acceptation

1. Étant donné une fenêtre de sessions mesurable, quand la page est générée, alors elle
   **s'ouvre** sur une section « Synthèse » portant les quatre blocs libellés **Constat**,
   **Garder**, **Améliorer**, **Arrêter**, avant tout indicateur brut.
2. Étant donné la même fenêtre, quand la page est générée, alors elle porte **exactement 3 bons
   points** et **exactement 3 points d'attention**, chacun accompagné du chiffre qui l'a
   déclenché, tous dérivés des métriques déjà mesurées (aucun nouveau balayage de transcript).
3. Étant donné la même fenêtre, quand la page est générée, alors les blocs d'indicateurs du lot
   #114 (occupation, décomposition du coût, 4 postes, accrétion, loi d'échelle, recommandations,
   sessions, gain RTK) sont tous présents au **second niveau**, dans un pli fermé par défaut.
4. Étant donné une fenêtre trop pauvre pour qualifier 3 signaux d'un côté, quand la page est
   générée, alors la promesse de 3 + 3 est tenue par un encadré **neutre** annonçant
   l'insuffisance de mesure — jamais par un signal non mesuré.
5. Étant donné une fenêtre dont le contrôle de décomposition dépasse 1,15, quand la page est
   générée, alors le déclassement des parts en plafonds remonte **dans la synthèse**, pas
   seulement au second niveau.
6. Étant donné n'importe quelle fenêtre, quand la page est générée, alors elle reste sans requête
   réseau et **sans `<script>`** : le pli du second niveau est un `<details>` natif.
7. Étant donné les modes `--json` et la sortie texte, quand le script est appelé, alors ils
   rendent la même synthèse, dans le même ordre que la page.

## Hors périmètre

- **Publication en artefact** : c'est le lot #123, qui dépend de celui-ci.
- **Nouvelle métrique** : la synthèse est une *lecture* des indicateurs existants. Ajouter une
  mesure ici aurait mélangé deux frontières (le moteur mesure, le rendu interprète) et rendu la
  refonte non vérifiable à mesure constante.
- **Seuils configurables par projet** (`rules.yaml`) : les seuils sont nommés et centralisés dans
  `THRESHOLDS`, mais pas encore réglables. Rien ne le demandait ; le jour où un projet contestera
  un seuil, le point d'édition est déjà unique.
- **Réécriture des 3 recommandations chiffrées** : conservées telles quelles au second niveau, et
  le bloc « Améliorer » reprend la première au lieu d'ouvrir un classement concurrent.

## Preuve de clôture

- `node test/run-tests.js` (bloc D122-1 à D122-7 : ordre de la page, complétude 3 + 3, chiffrage
  de chaque signal, pli natif sans script, huit blocs conservés dans le pli, déclassement remonté,
  garde-fou de fenêtre pauvre, pureté du module de synthèse).
- Vérifié en rendu réel (page ouverte dans le navigateur, **vrai clic** sur le pli : `open`
  passe à `true` et la hauteur du document passe de 1500 à 4273 px).

## Notes

- La dérivation vit dans `lib/dashboard-synthesis.js`, **module pur** : aucun `require`, aucune
  I/O, formateurs injectés. C'est ce qui la rend testable sans transcript et sans HTML.
- L'occupation est jugée en fraction de la borne de zone rouge **du projet**
  (`occupancy.resolveRedZone`), pas d'un palier absolu : le même seuil absolu sur-alerterait sur
  une fenêtre étroite (Haiku) et sous-alerterait sur une large (Opus).
- Le numéro de lot est écrit **sans dièse** dans `templates/dashboard.html` : le contrôle
  anti-couleur-en-dur de la suite cherche un littéral hexadécimal, et « dièse + 3 chiffres » en
  est un.
