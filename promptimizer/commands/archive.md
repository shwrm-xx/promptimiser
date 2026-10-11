---
description: Consulte l'archive des lots clos (index / fiche / brut — un tiroir à la fois)
allowed-tools: Bash(node *)
---

Consulte l'archive des lots clos. **Un tiroir à la fois** : l'archive est une mémoire
durable, pas un contexte à recharger. N'ouvre jamais plus que ce qui est demandé.

## Sans argument — tier 0 (index seul)

`node ${CLAUDE_PLUGIN_ROOT}/scripts/archive.js index`

Restitue l'index **tel quel**. N'ouvre AUCUNE fiche sans demande explicite de
l'utilisateur. Si une réponse tient dans l'index (« quand a-t-on clos le lot #57 ? »,
« quels lots n'ont pas de fiche ? »), c'est fini — pas de second tiroir.

## Avec un identifiant de lot — tier 1 (une fiche)

`node ${CLAUDE_PLUGIN_ROOT}/scripts/archive.js show --id N`

Affiche la fiche du lot. Si elle n'a jamais été écrite, la commande rend la ligne d'index
et signale l'existence éventuelle d'un brut : ne l'ouvre pas pour autant.

## Brut — tier 2, derrière confirmation

`node ${CLAUDE_PLUGIN_ROOT}/scripts/archive.js raw --id N`

Sans `--confirm`, n'affiche que le chemin et la taille. Le brut peut peser des dizaines
de Ko de contexte : avant tout `--confirm`, **pose une question à choix** (« Afficher le
brut du lot #N (X octets) ? OK / Non ») et attends la réponse. Jamais en texte libre,
jamais d'affichage spontané.

## Écriture (rarement à la main — /close-batch le fait)

- Fiche : `node ${CLAUDE_PLUGIN_ROOT}/scripts/archive.js write --id N --stdin` (le corps
  doit commencer par `<!-- pmz:archive:lot N -->` ; borne dure 8 000 caractères ; une
  fiche existante n'est jamais écrasée sans `--force`).
- Brut : `node ${CLAUDE_PLUGIN_ROOT}/scripts/archive.js raw --id N --stdin`.
- Rétro-remplissage tier 0 : `node ${CLAUDE_PLUGIN_ROOT}/scripts/archive.js backfill --dry-run`
  puis sans `--dry-run`.

Interdits dans une fiche (anti-péremption) : diff, contenu de fichier, listing de code,
sortie de tests complète. Le sha du commit et l'entrée CHANGELOG font foi pour le volatil.
