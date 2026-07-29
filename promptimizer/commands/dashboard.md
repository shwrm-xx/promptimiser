---
description: Génère le tableau de bord HTML d'économie de contexte du projet (mesure hors bande)
allowed-tools: Bash(node *), Artifact
---

Génère le tableau de bord d'économie de contexte du projet courant, en HTML autonome.

Exécute :
`node ~/.claude/promptimizer/scripts/dashboard.js`

La page est écrite dans `.vibe-agent/dashboard.html` (options : `--sessions N` pour la largeur
de la fenêtre, `--all` pour tout le projet, `--out <chemin>` pour une autre destination).
Le script écrit **aussi** une variante artefact à côté (suffixe `.artifact.html` — même contenu,
sans `<!doctype>`/`<html>`/`<head>`/`<body>`). Si l'outil **Artifact** est disponible dans cette
session, publie cette variante avec ce même outil (titre : « Économie de contexte — tableau de
bord », favicon 📊) en plus du fichier écrit sur disque ; sinon dis simplement que l'artefact
n'a pas pu être publié et que le fichier reste consultable tel quel.
Le script balaye des transcripts entiers : c'est une mesure **hors bande**, à la demande —
ne l'appelle jamais depuis un hook.

Le script mesure tout lui-même (occupation, décomposition du coût, accrétion, loi d'échelle,
recommandations). **Ne fabrique aucun chiffre toi-même** : reprends ceux de sa sortie.

La page **s'ouvre sur une synthèse** (Constat / Garder / Améliorer / Arrêter, puis 3 bons points
et 3 points d'attention) ; le détail technique est replié au second niveau. La sortie du script
rend la même synthèse, dans le même ordre : reprends-la telle quelle.

Rends compte en 5 points, sans relire la page produite :
1. le chemin du fichier écrit, et le résultat de la publication en artefact (publié / non
   disponible / échec) ;
2. la **synthèse** : les quatre blocs Constat / Garder / Améliorer / Arrêter, puis les 3 bons
   points et les 3 points d'attention, dans l'ordre du script (sévérité, puis montant en jeu).
   Un encadré annoncé comme **neutre** signale une fenêtre trop pauvre : dis-le, ne le présente
   pas comme un signal ;
3. les indicateurs tels que chiffrés par le script (occupation, accrétion, exposant de la loi
   d'échelle, coût de la fenêtre) ;
4. les 3 recommandations chiffrées, dans l'ordre où le script les classe (par montant
   récupérable) ;
5. les deux réserves de mesure, si elles s'appliquent — **jamais silencieusement** :
   - contrôle de décomposition **> 1,15** → les 4 postes sont des **plafonds**, pas des parts
     (compaction, ou raisonnement étendu compté en sortie mais non rejoué) ;
   - le coût d'**écriture de cache est un plancher** (tarif 5 minutes ; le TTL 1 heure n'est
     pas exposé par les transcripts).

Si le script annonce un statut d'indisponibilité (aucun transcript pour ce projet), dis-le tel
quel : la page est produite quand même, avec ce statut affiché. N'invente pas de mesure de repli.
