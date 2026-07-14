---
description: Pose ou retire la statusline Promptimizer (opt-in ; préserve toute statusLine tierce)
allowed-tools: Bash(node *)
---

Gère la **statusline Promptimizer** (opt-in) : `PMZ v<version> · <epic> · lot #<id> <titre> · <faits>/<total> · ctx <occupation>`.

1. Diagnostic : `node ~/.claude/promptimizer/install/merge-settings.js --check`
   - lis le champ `statusline` : `none` (aucune), `pmz` (déjà la nôtre), `third-party` (tierce).
2. Si `third-party` : **ne pose rien**, signale que PMZ ne remplace jamais une statusLine tierce
   (il faut la retirer soi-même d'abord). Si `pmz` : déjà posée, rien à faire.
3. Si `none`, et **seulement après accord explicite** de l'utilisateur :
   `node ~/.claude/promptimizer/install/merge-settings.js --statusline`
4. Pour la retirer : `node ~/.claude/promptimizer/install/merge-settings.js --statusline-remove`
   (ne touche jamais une statusLine tierce).

Restitue le résultat tel quel (posée / tierce préservée / retirée / déjà en place), jamais muet.
Rappelle qu'un **redémarrage de session** peut être nécessaire pour que la barre s'affiche.
