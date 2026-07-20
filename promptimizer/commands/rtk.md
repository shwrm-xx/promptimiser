---
description: Statut et activation guidée du bridge RTK (command optimizer) avec détection de conflit sur 3 canaux
allowed-tools: Bash(node *)
---

Gère le bridge RTK (lot #81/#82, epic « Bridge RTK »).

Détermine le sous-mot demandé par l'utilisateur après `/pmz:rtk` (défaut : `status` si aucun) :
`status`, `enable`, `disable` ou `migrate`. Exécute :
`node ~/.claude/promptimizer/scripts/rtk.js <sous-mot>`

Restitue tel quel : état (`absent` / `présent-inactif` / `actif` / `conflit` / `incompatible`),
canal(aux) en conflit avec la remédiation manuelle exacte affichée par le script, et le résultat
d'`enable`/`disable`/`migrate`. N'invente aucun état ni aucune remédiation au-delà de ce que le
script annonce.

- `status` : lit l'état sans rien modifier (sauf neutralisation automatique d'un bridge actif si
  un conflit est détecté — annoncé explicitement dans la sortie).
- `enable` : refuse si `conflit`/`absent`/`incompatible`, sinon persiste l'activation.
- `disable` : persiste la désactivation, toujours accepté.
- `migrate` : ne touche QUE le canal Claude Code (settings.json, avec sauvegarde horodatée) ;
  les canaux OpenCode/Codex restent à traiter manuellement (remédiation affichée).
