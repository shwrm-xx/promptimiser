# Delta Codex

Codex **n'est pas** la cible principale de Vibe Session Governor. L'auto-activation complète
(hooks globaux + skill + bootstrap) reste portée par **Claude Code**. Pour Codex, VSG fournit un
**delta** : le même socle de règles via `AGENTS.md`.

## Stratégie

```
Claude Code = hooks globaux + skill globale + bootstrap prudent  (auto complet)
Codex       = AGENTS.md + skill éventuelle + wrapper optionnel    (delta)
```

Codex lit `AGENTS.md` comme instructions persistantes. Le projet reçoit donc le même socle de
règles (lots courts, contexte minimal, clôture propre). On **ne reproduit pas** les hooks Claude
Code côté Codex.

## Mise en place

1. **Par projet** : laisser Claude Code créer `AGENTS.md` (via `/vsg-init` ou bootstrap), puis
   ouvrir le projet dans Codex.
2. **Global (optionnel)** : copier [`AGENTS.md`](AGENTS.md) vers `~/.codex/AGENTS.md`.
3. **Wrapper (optionnel)** : placer [`codex-vsg`](codex-vsg) dans le `PATH` (`chmod +x`). Il
   garantit un `AGENTS.md` projet avant de lancer `codex`, en s'appuyant sur le bootstrap VSG
   (repo git, jamais d'écrasement) ou, à défaut, sur le template.

## Usage recommandé

```
1. Initialiser le projet avec Claude Code (socle + AGENTS.md).
2. Ouvrir le projet dans Codex si besoin.
3. Codex applique les règles via AGENTS.md.
```

Ne cherche pas à obtenir le même comportement automatique que Claude Code côté Codex.
