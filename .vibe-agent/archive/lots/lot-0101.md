<!-- pmz:archive:lot 101 -->
# Lot #101 — Purge logs/handoffs orphelins + FIA-23

- epic : Archive à tiroirs · clos : 2026-07-27 · commit : d2e2ee9 · session : courante
- verify : node test/run-tests.js → OK (1631 OK / 0 échec) · coût : non mesuré

## Objectif

Solder les trois dettes explicitement laissées par le lot #100 : `.vibe-agent/logs/` non borné,
handoffs de lot orphelins d'une vague **abandonnée** (pas seulement quittée volontairement), et
FIA-23 (seul FIA du catalogue encore non traité — atomicité/corruption/concurrence).

## Décisions (et pourquoi)

- **`purgeLogs` en une passe triée par `mtime`, pas un job séparé.** Même famille que `clearWave`
  (une écriture/suppression groupée plutôt qu'une boucle par appel). Câblée directement dans
  `writeFullLog` et `writeReintegrateReport` — la purge est **incrémentale**, il n'y a rien à
  penser à relancer ailleurs. Plafond `MAX_LOG_FILES = 200`, valeur généreuse (pas de perte de
  diagnostic récent) mais bornée.
- **`purgeOrphanLotHandoffs` détecte, `purgeLotHandoffs` exécute — pas de duplication.** La
  fonction d'exécution existait déjà (lot #99) ; le trou était uniquement la **détection** d'une
  vague redevenue inerte par un chemin **autre** que `closeWave`/`fleet leave` (reset manuel,
  `clearWave` direct). `active === false` + fichiers de lot présents = signal suffisant, sans
  false positive : une vague encore en vol n'est jamais touchée.
- **Câblée au SessionStart, pas à un hook dédié.** Le rangement est mécanique et silencieux —
  jamais dans le message injecté (cohérent avec le reste du hook : aucune fuite de bruit
  opérationnel dans le contexte). Un seul point de passage garanti (au moins un
  `startup`/`clear` par session) suffit ; pas besoin d'un déclencheur plus fin.
- **FIA-23, périmètre resserré aux corrections adversariales du catalogue.** Le point le plus
  risqué (concurrence) est testé par **deux processus séparés** via backgrounding shell
  (`node ... & node ... & wait`), pas par un entrelacement simulé dans un seul process Node —
  Atomics.wait aurait aussi bloqué la livraison des events `exit`, rendant l'approche inopérante.
  L'assertion porte **uniquement** sur « fichier final toujours JSON parsable » : la perte de
  mise à jour reste assumée (`fleet.js:14-18`), ce n'était jamais l'objet du test (cf. correction
  adversariale (b) du catalogue). Sous-test sauté proprement (pas un échec) si `/bin/sh` est
  absent (Windows).

## Vérifié

- `purgeLogs` : retire l'excédent le plus ancien au-delà du plafond, idempotent, no-op si le
  dossier `.vibe-agent/logs/` est absent.
- `purgeOrphanLotHandoffs` : no-op si la vague est active ; purge les `handoff-lot-*.md` une fois
  la vague inerte (y compris après un `clearWave` direct, hors `closeWave`) ; épargne toujours
  `handoff.md` ; idempotent ; déclenché au `SessionStart` sans fuite dans le message injecté.
- FIA-23 : `writeAtomic` sous rafale de 50 écritures → contenu final valide, aucun `.tmp`
  résiduel ; `readJson` sur JSON corrompu → fallback + quarantaine `<file>.corrupt` sans
  exception, un seul exemplaire conservé au second passage ; `handoff.md` vide/sans marqueur →
  `readHandoff` `null`, et un handoff auto redevient lisible une fois le fichier retiré ; deux
  processus Node séparés en `upsertLot` rapides sur le même `fleet.json` → fichier final toujours
  JSON parsable, aucun `.tmp` résiduel.
- Suite complète : 1631 OK / 0 échec (3 nouvelles sections, lot #101).

## Non vérifié

- `MAX_LOG_FILES = 200` n'a pas été atteint en conditions réelles (testé directement sur
  `purgeLogs`, pas via 200+ écritures Bash réelles — coût de test jugé disproportionné).
- Canal plugin non redéployé (`~/.claude/plugins/.../1.6.2`) : ce lot n'est actif qu'après
  réinstallation du plugin, comme les lots #98–#100.
- Sous-test de concurrence FIA-23 non exécuté sous Windows (garde `/bin/sh` absent → sauté, pas
  vérifié sur cette plateforme).

## Dette restante

- Backlog vide de lots à faire — aucune dette connue laissée par ce lot.

## Périmètre
promptimizer/lib/output-fallback.js · promptimizer/lib/handoff.js · promptimizer/lib/reintegrate.js ·
promptimizer/hooks/session-start.js · test/run-tests.js · ARCHITECTURE.md · CHANGELOG.md

## Liens
- commit d2e2ee9 · entrée CHANGELOG du 2026-07-27 · dettes issues de la fiche
  `.vibe-agent/archive/lots/lot-0100.md`
