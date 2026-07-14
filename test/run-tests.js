#!/usr/bin/env node
'use strict';
// Harnais de test Promptimizer — zéro dépendance (Node stdlib + git).
// Couvre : fail-open des 5 hooks, verdicts PreToolUse (deny/ask/allow),
// occupation par tokens (paliers, anti-spam monotone, scan par blocs),
// merge-settings (abort/idempotence/strip legacy/takeover/restore/sidecar corrompu),
// bootstrap (hors-git refusé, non-écrasement).
// Usage : node test/run-tests.js   (exit 0 si tout passe, 1 sinon)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PKG = path.join(REPO, 'promptimizer');
const HOOKS = path.join(PKG, 'hooks');
const MS = path.join(PKG, 'install', 'merge-settings.js');
const BOOTSTRAP = path.join(PKG, 'scripts', 'bootstrap-project.js');

// Bac à sable isolé + état isolé (occupancy/merge lisent PMZ_STATE_DIR).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-test-'));
const STATE = path.join(SANDBOX, 'state');
fs.mkdirSync(STATE, { recursive: true });
process.env.PMZ_STATE_DIR = STATE;
// Identité git déterministe pour tout le run (les commits auto-créés par le bootstrap
// ne doivent pas dépendre de la config git globale de la machine qui lance les tests).
process.env.GIT_AUTHOR_NAME = 'PMZ Test';
process.env.GIT_AUTHOR_EMAIL = 'pmz-test@example.com';
process.env.GIT_COMMITTER_NAME = 'PMZ Test';
process.env.GIT_COMMITTER_EMAIL = 'pmz-test@example.com';
fs.writeFileSync(path.join(SANDBOX, 'empty.jsonl'), ''); // transcript vide réutilisé par plusieurs tests stop.js

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; failures.push(label); console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// --- Lance un hook avec un stdin JSON ; renvoie { code, out }. Jamais throw. ---
function runHook(file, inputObj, extraEnv) {
  const input = typeof inputObj === 'string' ? inputObj : JSON.stringify(inputObj);
  try {
    const out = execFileSync(process.execPath, [path.join(HOOKS, file)], {
      input, encoding: 'utf8', env: Object.assign({}, process.env, extraEnv || {}),
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || '').toString() };
  }
}
// Verdict PreToolUse : 'allow' (stdout vide) | 'ask' | 'deny' | 'invalid'.
function bashVerdict(command) {
  const r = runHook('pre-tool-use.js', { tool_name: 'Bash', tool_input: { command } });
  if (r.code !== 0) return 'exit' + r.code;
  if (!r.out.trim()) return 'allow';
  try {
    const d = JSON.parse(r.out).hookSpecificOutput.permissionDecision;
    return d || 'invalid';
  } catch (_) { return 'invalid'; }
}
function runNode(file, args, env) {
  try {
    const out = execFileSync(process.execPath, [file].concat(args || []), {
      encoding: 'utf8', env: Object.assign({}, process.env, env || {}),
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || '').toString(), err: (e.stderr || '').toString() };
  }
}

// ============================ A. FAIL-OPEN ============================
section('Fail-open des hooks (stdin vide / malformé / valide → exit 0)');
const ALL_HOOKS = ['session-start.js', 'user-prompt-submit.js', 'pre-tool-use.js', 'post-tool-use.js', 'stop.js', 'pre-compact.js'];
for (const h of ALL_HOOKS) {
  ok(runHook(h, '').code === 0, `${h} : stdin vide → exit 0`);
  ok(runHook(h, '{bad json').code === 0, `${h} : stdin malformé → exit 0`);
  ok(runHook(h, {}).code === 0, `${h} : stdin {} → exit 0`);
}
// Kill-switch
ok(runHook('stop.js', { stop_hook_active: false }, { PMZ_DISABLE: '1' }).code === 0, 'PMZ_DISABLE=1 → exit 0');
// pre-tool-use sur non-Bash = passThrough
ok(bashVerdict.call(null, 'x') !== undefined, 'pre-tool-use répond');
{
  const r = runHook('pre-tool-use.js', { tool_name: 'Read', tool_input: { file_path: 'x' } });
  ok(r.code === 0 && !r.out.trim(), 'pre-tool-use : tool Read → passThrough (aucune décision)');
}
// Préambule fail-open : si le require(guard) échoue (module corrompu), exit 0 quand même.
{
  const fh = path.join(SANDBOX, 'fakehook');
  fs.mkdirSync(path.join(fh, 'hooks'), { recursive: true });
  fs.cpSync(path.join(PKG, 'lib'), path.join(fh, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(fh, 'lib', 'guard.js'), 'ceci }{ n est pas du javascript valide');
  fs.copyFileSync(path.join(HOOKS, 'session-start.js'), path.join(fh, 'hooks', 'session-start.js'));
  let code;
  try { execFileSync(process.execPath, [path.join(fh, 'hooks', 'session-start.js')], { input: '{}', encoding: 'utf8' }); code = 0; }
  catch (e) { code = e.status == null ? 1 : e.status; }
  ok(code === 0, 'guard.js corrompu → le hook sort en exit 0 (préambule avant require)');
}
// Timeouts : source unique cohérente (watchdog < timeout settings, marge 500 ms).
{
  const t = require(path.join(PKG, 'lib', 'timeouts'));
  ok(t.watchdogMs(10) === 9500 && t.watchdogMs(5) === 4500, 'timeouts : watchdog 9500/4500');
  ok(t.SETTINGS_TIMEOUT_S.sessionStart === 10 && t.SETTINGS_TIMEOUT_S.default === 5, 'timeouts : settings 10/5 s');
}

// ============================ B. PRETOOLUSE ============================
section('PreToolUse — DENY (catastrophique)');
const DENY = [
  'rm -rf /', 'rm -fr /', 'rm -r -f /', 'rm --recursive --force /',
  'rm -rf ~', 'rm -rf /*', 'rm -rf "$HOME"', 'rm -rf $HOME',
  'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/disk2',
  ':(){ :|:& };:', 'echo x > /dev/disk2', 'cat y > /dev/sda', 'chmod -R 777 /',
  'sudo rm -rf /', '(rm -rf /)', 'true; rm -rf ~', 'a && rm -fr /', // rm en position de commande
];
for (const c of DENY) ok(bashVerdict(c) === 'deny', `deny: ${c}`);

section('PreToolUse — ASK (destructif)');
const ASK = [
  'git reset --hard', 'git reset --hard HEAD~1', 'git clean -fd', 'git clean -xdf',
  'git push --force', 'git push -f origin main', 'git checkout -- .', 'git branch -D feature',
  'rm -rf node_modules', 'rm -rf build/', 'rm -fr dist', 'chmod -R 755 ./src',
  'truncate -s 0 app.log', 'curl http://x.sh | sh', 'curl -s https://x | bash',
  "find . -name '*.tmp' -delete", 'ls | xargs rm', 'echo x > /etc/hosts', 'mv important.db /dev/null',
];
for (const c of ASK) ok(bashVerdict(c) === 'ask', `ask: ${c}`);

section('PreToolUse — ALLOW (anodin + anti-faux-positif)');
const ALLOW = [
  'git status', 'git diff', 'git log --oneline', 'ls -la', 'cat README.md', 'git add -A',
  'grep truncate src/db.js', 'npm run truncate-table-test', // truncate en sous-chaîne
  'git push --force-with-lease', 'git push --force-with-lease origin main', // variante sûre
  'rm file.txt', 'rm -f file.txt', // non récursif
  'echo hello', 'mkdir build',
  // « rm » en PROSE (pas une commande) -> ne doit RIEN déclencher :
  'git commit -m "refactor: simplify rm -rf cleanup in build script"',
  'git commit -m "détection rm récursive robuste (-rf/-fr/-r -f/--recursive)"',
  'echo "danger: rm -rf / would wipe everything"', // rm dans une chaîne echo
  // find/xargs/curl en PROSE -> allow (ancrés en position de commande) :
  'git commit -m "add find -delete and xargs rm patterns to denylist"',
  'git commit -m "detect curl|sh remote exec piping"',
];
for (const c of ALLOW) ok(bashVerdict(c) === 'allow', `allow: ${c}`);

// ============================ C. OCCUPANCY ============================
section('Occupation par tokens (paliers, anti-spam monotone, scan par blocs)');
const occupancy = require(path.join(PKG, 'lib', 'occupancy'));
function usageLine(input, read, create, output) {
  const usage = { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create };
  if (output != null) usage.output_tokens = output;
  return JSON.stringify({ type: 'assistant', message: { usage } });
}
function writeTranscript(name, lines) {
  const p = path.join(SANDBOX, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
// occ = 200k + 120k = 320k → bucket 2 (>=300k)
const tA = writeTranscript('a.jsonl', ['{"type":"user"}', usageLine(200000, 120000, 0)]);
ok(occupancy.readLastOccupancy(tA) === 320000, 'lecture occupation = 320000');
ok(occupancy.bucketIndex(320000) === 2, 'bucketIndex(320k) = 2');
const e1 = occupancy.evaluate(tA, 'sessA');
ok(e1 && e1.bucket === 2 && e1.crossedNew === true, '1er franchissement palier 2 → crossedNew');
const e2 = occupancy.evaluate(tA, 'sessA');
ok(e2 && e2.crossedNew === false, 'anti-spam : même palier → pas de nouvelle alerte');
// Redescente (occ plus bas) → pas de nouvelle alerte, palier non réarmé (monotone)
const tLow = writeTranscript('low.jsonl', [usageLine(100000, 0, 0)]); // occ 100k → bucket 0
const e3 = occupancy.evaluate(tLow, 'sessA');
ok(e3 && e3.crossedNew === false, 'monotone : redescente sous le palier → pas de réarmement');
// Ré-escalade au-dessus → nouvelle alerte
const tHi = writeTranscript('hi.jsonl', [usageLine(500000, 300000, 0)]); // 800k → bucket 4
const e4 = occupancy.evaluate(tHi, 'sessA');
ok(e4 && e4.bucket === 4 && e4.crossedNew === true, 'ré-escalade au-dessus → nouvelle alerte');
// Session différente = état neuf
const e5 = occupancy.evaluate(tA, 'sessB');
ok(e5 && e5.crossedNew === true, 'nouvelle session → état neuf (alerte de nouveau)');
// Scan par blocs : ligne usage repoussée au-delà de 512 KB par du remplissage
const filler = [];
const fillerLine = '{"type":"user","content":"' + 'x'.repeat(900) + '"}';
for (let i = 0; i < 800; i++) filler.push(fillerLine); // ~720 KB de remplissage
const tBig = writeTranscript('big.jsonl', [usageLine(180000, 0, 0)].concat(filler)); // usage tout au début
ok(fs.statSync(tBig).size > 512 * 1024, 'transcript de test > 512 KB');
ok(occupancy.readLastOccupancy(tBig) === 180000, 'scan par blocs retrouve la ligne usage au-delà de 512 KB');

// ============================ D. MERGE-SETTINGS ============================
section('merge-settings — abort / idempotence / strip legacy / takeover / restore');
function writeSettings(obj) {
  const p = path.join(SANDBOX, 'settings.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
function readSettings() { return JSON.parse(fs.readFileSync(path.join(SANDBOX, 'settings.json'), 'utf8')); }
function hookCmds(s) {
  const out = [];
  for (const ev of Object.keys(s.hooks || {})) for (const e of s.hooks[ev]) for (const h of (e.hooks || [])) out.push(h.command);
  return out;
}
const SP = path.join(SANDBOX, 'settings.json');

// D1. JSON invalide → abort (exit 1), fichier inchangé
fs.writeFileSync(SP, '{invalid json');
const rInvalid = runNode(MS, [SP], { PMZ_STATE_DIR: STATE });
ok(rInvalid.code === 1, 'JSON invalide → exit 1 (abort)');
ok(fs.readFileSync(SP, 'utf8') === '{invalid json', 'JSON invalide → fichier NON modifié');

// D2. Install sur settings utilisateur existant (préservation + 5 hooks)
writeSettings({ permissions: { allow: ['Read'] }, statusLine: { type: 'command', command: 's' }, enabledPlugins: ['p'] });
runNode(MS, [SP], { PMZ_STATE_DIR: STATE });
let s = readSettings();
ok(s.permissions && s.statusLine && s.enabledPlugins, 'préserve permissions/statusLine/enabledPlugins');
ok(hookCmds(s).filter((c) => c.includes('promptimizer/hooks/')).length === 6, 'install → 6 hooks PMZ');
ok(hookCmds(s).every((c) => /^"[^"]+\/node" /.test(c) || /^"[^"]*node" /.test(c)), 'hooks câblés avec node en chemin absolu quoté');

// D3. Idempotence
runNode(MS, [SP], { PMZ_STATE_DIR: STATE });
s = readSettings();
ok(hookCmds(s).filter((c) => c.includes('promptimizer/hooks/')).length === 6, 'réinstall → toujours 6 (idempotent)');

// D3bis. Matchers PMZ à jour : clear/compact déclenchent SessionStart, TodoWrite observé.
function pmzEntry(s2, ev) {
  return (s2.hooks[ev] || []).find((e) => (e.hooks || []).some((h) => h.command.includes('promptimizer/hooks/')));
}
ok(pmzEntry(s, 'SessionStart').matcher === 'startup|resume|clear|compact', 'matcher SessionStart couvre clear et compact');
ok(pmzEntry(s, 'PostToolUse').matcher === 'Read|Edit|Write|TodoWrite', 'matcher PostToolUse couvre TodoWrite');
ok(pmzEntry(s, 'PreCompact') && pmzEntry(s, 'PreCompact').matcher === 'manual|auto', 'PreCompact enregistré (manual|auto)');

// D4. Strip legacy (vibe-session-governor) + double-firing
writeSettings({
  hooks: {
    SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node ~/.claude/vibe-session-governor/hooks/session-start.js' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node ~/.claude/vibe-session-governor/hooks/stop.js' }] }],
  },
});
runNode(MS, [SP], { PMZ_STATE_DIR: STATE });
s = readSettings();
ok(hookCmds(s).filter((c) => c.includes('vibe-session-governor')).length === 0, 'strip legacy : 0 hook vibe-session-governor');
ok(hookCmds(s).filter((c) => c.includes('promptimizer/hooks/')).length === 6, 'strip legacy : 6 hooks PMZ (pas de doublon)');

// D5. Takeover context-guard.py → sidecar
writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/context-guard.py' }] }] } });
runNode(MS, [SP, '--takeover'], { PMZ_STATE_DIR: STATE });
s = readSettings();
ok(hookCmds(s).filter((c) => c.includes('context-guard')).length === 0, 'takeover : context-guard retiré de settings');
ok(fs.existsSync(path.join(STATE, 'taken-over.json')), 'takeover : sidecar créé');

// D6. Remove → restaure context-guard, retire PMZ
runNode(MS, [SP, '--remove'], { PMZ_STATE_DIR: STATE });
s = readSettings();
ok(hookCmds(s).filter((c) => c.includes('context-guard')).length === 1, 'remove : context-guard restauré depuis sidecar');
ok(hookCmds(s).filter((c) => c.includes('promptimizer/hooks/')).length === 0, 'remove : 0 hook PMZ');

// D7. Sidecar corrompu au remove → avertissement, exit 0
writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/context-guard.py' }] }] } });
runNode(MS, [SP, '--takeover'], { PMZ_STATE_DIR: STATE });
fs.writeFileSync(path.join(STATE, 'taken-over.json'), '{{{corrupt');
const rCorrupt = runNode(MS, [SP, '--remove'], { PMZ_STATE_DIR: STATE });
ok(rCorrupt.code === 0, 'sidecar corrompu : exit 0 (fail-open du flux)');
ok(/corrompu/i.test(rCorrupt.out + rCorrupt.err), 'sidecar corrompu : avertissement émis');

// ============================ E. BOOTSTRAP ============================
section('bootstrap-project — hors-git refusé / non-écrasement');
// E1. Hors git → refus
const noGit = path.join(SANDBOX, 'nogit');
fs.mkdirSync(noGit, { recursive: true });
const rNoGit = runNode(BOOTSTRAP, ['--cwd', noGit]);
let jNoGit = {};
try { jNoGit = JSON.parse(rNoGit.out); } catch (_) {}
ok(jNoGit.ok === false, 'hors-git → ok:false (rien créé)');
ok(!fs.existsSync(path.join(noGit, '.vibe-agent')), 'hors-git → .vibe-agent NON créé');

// E2. Repo git → socle créé ; 2e run → skip ; non-écrasement d'un CLAUDE.md existant
const repo = path.join(SANDBOX, 'repo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', repo]);
fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'CONTENU EXISTANT À PRÉSERVER');
const rBoot1 = runNode(BOOTSTRAP, ['--cwd', repo]);
let jBoot1 = {};
try { jBoot1 = JSON.parse(rBoot1.out); } catch (_) {}
ok(jBoot1.ok === true, 'repo git → ok:true');
ok(fs.existsSync(path.join(repo, '.vibe-agent', 'rules.yaml')), 'repo git → .vibe-agent/rules.yaml créé');
ok(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8') === 'CONTENU EXISTANT À PRÉSERVER', 'CLAUDE.md existant NON écrasé');
ok(Array.isArray(jBoot1.skipped) && jBoot1.skipped.some((p) => p.endsWith('CLAUDE.md')), 'CLAUDE.md listé dans skipped');
const rBoot2 = runNode(BOOTSTRAP, ['--cwd', repo]);
let jBoot2 = {};
try { jBoot2 = JSON.parse(rBoot2.out); } catch (_) {}
ok(jBoot2.ok === true && Array.isArray(jBoot2.created) && jBoot2.created.length === 0, '2e run → rien recréé (idempotent)');

// ============================ F. LEDGER AUTO-CRÉÉ (point 1) ============================
section('Ledger auto-créé sans confirmation, socle visible non (point 1)');
const project = require(path.join(PKG, 'lib', 'project'));
{
  const repo = path.join(SANDBOX, 'repo-autoledger');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'existing.txt'), 'hello');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']); // projet MATURE (hasAnyCommit)
  ok(!fs.existsSync(path.join(repo, '.vibe-agent')), 'avant : .vibe-agent absent');
  ok(project.isInitialized(repo) === false, 'avant : isInitialized=false');
  ok(project.isFullyInitialized(repo) === false, 'avant : isFullyInitialized=false');
  runHook('post-tool-use.js', { tool_name: 'Read', tool_input: { file_path: path.join(repo, 'existing.txt') }, cwd: repo });
  ok(fs.existsSync(path.join(repo, '.vibe-agent')), 'après un Read : .vibe-agent auto-créé sans confirmation');
  ok(project.isInitialized(repo) === true, 'après : isInitialized=true (ledger présent)');
  ok(project.isFullyInitialized(repo) === false, 'après : isFullyInitialized=false (pas de CLAUDE.md)');
  ok(!fs.existsSync(path.join(repo, 'CLAUDE.md')), 'projet mature : aucun CLAUDE.md créé sans confirmation explicite');
  // stop.js doit aussi auto-créer le ledger (via ensureLedger dans le bloc clôture).
  const repo2 = path.join(SANDBOX, 'repo-autoledger-stop');
  fs.mkdirSync(repo2, { recursive: true });
  execFileSync('git', ['init', '-q', repo2]);
  fs.writeFileSync(path.join(repo2, 'a.txt'), '1');
  execFileSync('git', ['-C', repo2, 'add', '.']);
  execFileSync('git', ['-C', repo2, 'commit', '-q', '-m', 'init']);
  ok(!fs.existsSync(path.join(repo2, '.vibe-agent')), 'repo2 avant stop.js : .vibe-agent absent');
  runHook('stop.js', { cwd: repo2, session_id: 'sess-f', transcript_path: path.join(SANDBOX, 'empty.jsonl') });
  ok(fs.existsSync(path.join(repo2, '.vibe-agent')), 'stop.js : .vibe-agent auto-créé aussi');
}

// ============================ G. PALIER FLOTTANT (point 3) ============================
section('Palier flottant au-delà de 750k (point 3)');
ok(occupancy.bucketIndex(750000) === 4, 'bucketIndex(750k) = 4 (dernier palier fixe)');
ok(occupancy.bucketIndex(1000000) === 5, 'bucketIndex(1000k) = 5 (1er palier flottant)');
ok(occupancy.bucketIndex(1249999) === 5, 'bucketIndex(1249999) = 5 (juste avant le suivant)');
ok(occupancy.bucketIndex(1250000) === 6, 'bucketIndex(1250k) = 6 (palier flottant suivant)');
{
  const tF1 = writeTranscript('float1.jsonl', [usageLine(750000, 0, 0)]);
  const ef1 = occupancy.evaluate(tF1, 'sessFloat');
  ok(ef1 && ef1.bucket === 4 && ef1.crossedNew === true, 'flottant : dernier palier fixe franchi');
  const tF2 = writeTranscript('float2.jsonl', [usageLine(1000000, 0, 0)]);
  const ef2 = occupancy.evaluate(tF2, 'sessFloat');
  ok(ef2 && ef2.bucket === 5 && ef2.crossedNew === true, 'flottant : nouvelle alerte au-delà de 750k (ne se tait plus)');
  const tF3 = writeTranscript('float3.jsonl', [usageLine(1300000, 0, 0)]);
  const ef3 = occupancy.evaluate(tF3, 'sessFloat');
  ok(ef3 && ef3.bucket === 6 && ef3.crossedNew === true, 'flottant : encore une alerte au palier flottant suivant');
}
const messages = require(path.join(PKG, 'lib', 'messages'));
{
  const m1 = messages.occupancyMessage(320000, 2);
  ok(/\/close-batch/.test(m1) && /\/fresh-session/.test(m1), 'occupancyMessage nomme /close-batch et /fresh-session');
  const m2 = messages.occupancyMessage(1000000, 5);
  ok(/dernier palier fixe/i.test(m2), 'occupancyMessage : mentionne le palier flottant au-delà de 750k');

  // T1 — argument chiffré anti-compaction au palier 300k (bucket ≥ 2), pas avant.
  ok(/cache-write/.test(m1) && /×1,25/.test(m1) && /8k/.test(m1),
    'occupancyMessage (300k) : argument chiffré compaction (cache-write ×1,25) vs handoff ~8k');
  ok(/400k/.test(m1), 'occupancyMessage (320k) : cache-write ≈ 400k chiffré (320×1,25)');
  ok(/5 min/.test(m1) && /1 h/.test(m1), 'occupancyMessage (300k) : TTL prudent (5 min clé API / 1 h abonnement)');
  ok(!/[€$]|euros?|dollars?/i.test(m1), 'occupancyMessage : aucun prix codé en dur');
  const mLow = messages.occupancyMessage(160000, 1);
  ok(!/cache-write/.test(mLow), 'occupancyMessage (<300k, bucket 1) : pas encore de nudge chiffré');

  // T1 — message pre-compact manuel : même argument chiffré, sans prix.
  const mc = messages.compactionNudgeMessage(400000);
  ok(/Compaction manuelle/.test(mc) && /cache-write/.test(mc) && /8k/.test(mc),
    'compactionNudgeMessage : argument chiffré compaction vs handoff');
  ok(/5 min/.test(mc) && /1 h/.test(mc) && !/[€$]|euros?|dollars?/i.test(mc),
    'compactionNudgeMessage : TTL prudent, aucun prix codé en dur');
  ok(/\/fresh-session/.test(mc) && /\/close-batch/.test(mc), 'compactionNudgeMessage : oriente vers close-batch/fresh-session');
  const mc0 = messages.compactionNudgeMessage(null);
  ok(/Compaction manuelle/.test(mc0) && !/cache-write/.test(mc0), 'compactionNudgeMessage : occ inconnue → nudge sans chiffre, fail-open');
}
ok(/\/close-batch/.test(messages.MSG_CLOTURE), 'MSG_CLOTURE nomme /close-batch');

// ============================ H. HYGIÈNE DE LECTURE (point 4) ============================
section('Ratio Read-complet / recherche (point 4)');
function toolUseLine(name, input) {
  return JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name, input: input || {} }] } });
}
{
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(toolUseLine('Read', { file_path: `f${i}.js` }));
  lines.push(toolUseLine('Grep', { pattern: 'x' }));
  const t = writeTranscript('readmix.jsonl', lines);
  const mix = occupancy.scanTailForReadMix(t);
  ok(!!mix && mix.reads === 5 && mix.fullReads === 5 && mix.searches === 1, 'scanTailForReadMix : 5 Read complets + 1 recherche');
  const note1 = occupancy.evaluateReadMix(t, 'sessReadMix');
  ok(!!note1 && note1.fullReads === 5, 'majorité de Read complets → note émise');
  const note2 = occupancy.evaluateReadMix(t, 'sessReadMix');
  ok(note2 === null, 'anti-spam : pas de 2e note dans la même session');
}
{
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(toolUseLine('Read', { file_path: `f${i}.js`, offset: 1, limit: 50 }));
  const t = writeTranscript('readmix-partial.jsonl', lines);
  const note = occupancy.evaluateReadMix(t, 'sessReadMixPartial');
  ok(note === null, 'majorité de lectures partielles → pas de note');
}
{
  const lines = [toolUseLine('Bash', { command: 'git grep foo' }), toolUseLine('Read', { file_path: 'a.js' })];
  const t = writeTranscript('readmix-bashgrep.jsonl', lines);
  const mix = occupancy.scanTailForReadMix(t);
  ok(!!mix && mix.searches === 1, 'Bash "git grep" compté comme recherche');
}

// ============================ I. LOT & TITRE DE SESSION (point 5) ============================
section('Numérotation de lot et titre de session (point 5)');
const lot = require(path.join(PKG, 'lib', 'lot'));
const trigram = require(path.join(PKG, 'lib', 'trigram'));
{
  const repo = path.join(SANDBOX, 'repo-lot');
  fs.mkdirSync(path.join(repo, '.vibe-agent'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '## 2026-06-16 (lot 3)\n\ntexte\n\n## 2026-06-11 (lot 1)\n');
  const trg = trigram.deriveTrigram(repo);
  ok(lot.getLotCounter(repo) === 3, 'seed depuis CHANGELOG : plus grand (lot N) trouvé = 3');
  // Pas de backlog ici (aucun plan nommé) + rien de déductible (pas de commit, « (lot N) »
  // écarté) -> titre « Session Libre » nu, jamais lié au compteur lot-counter.
  ok(lot.suggestedTitle(repo) === `[${trg}] Session Libre`, 'sans plan ni déduction : titre = Session Libre');
  ok(lot.incrementLot(repo) === 4, 'incrementLot : 3 → 4');
  ok(lot.getLotCounter(repo) === 4, 'compteur persisté = 4');
  ok(lot.suggestedTitle(repo) === `[${trg}] Session Libre`, 'titre reste Session Libre, indépendant du compteur');
  fs.writeFileSync(path.join(repo, '.vibe-agent', 'epic'), 'MonEpic\n');
  ok(lot.readEpic(repo) === 'MonEpic', 'epic configurable via .vibe-agent/epic (label de groupement global)');
}

section('Trigramme de projet (lot #35)');
{
  const repo = path.join(SANDBOX, 'japlan-app');
  fs.mkdirSync(repo, { recursive: true });
  ok(trigram.deriveTrigram(repo) === 'JAP', 'dérivation par défaut : 3 premières lettres alpha du nom de dossier');
  ok(trigram.readTrigram(repo) === 'JAP', 'readTrigram sans fichier .vibe-agent/trigram : retombe sur la dérivation');

  const applied = trigram.writeTrigram(repo, 'pmz');
  ok(applied === 'PMZ', 'writeTrigram : normalisé en 3 lettres majuscules');
  ok(trigram.readTrigram(repo) === 'PMZ', 'readTrigram : relit le trigramme choisi une fois écrit');
  ok(fs.existsSync(trigram.trigramFile(repo)), 'trigramme persisté dans .vibe-agent/trigram');

  ok(trigram.writeTrigram(repo, '') === null, 'writeTrigram : chaîne vide/sans lettre refusée (null)');
  ok(trigram.writeTrigram(repo, '12') === null, 'writeTrigram : sans aucune lettre alpha refusée (null)');
  ok(trigram.writeTrigram(repo, 'ab') === 'ABX', 'writeTrigram : <3 lettres complété (padding X)');

  const suggestions = trigram.suggestTrigrams(path.join(SANDBOX, 'japlan-app'));
  ok(suggestions.length === 3 && new Set(suggestions).size === suggestions.length,
    'suggestTrigrams : 3 propositions distinctes');
  ok(suggestions[0] === 'JAP', 'suggestTrigrams : la dérivation par défaut est en tête');

  // CLI : trigram --suggest / --set / show
  const BKLG0 = path.join(PKG, 'scripts', 'backlog.js');
  const repoCli = path.join(SANDBOX, 'repo-trigram-cli');
  fs.mkdirSync(repoCli, { recursive: true });
  execFileSync('git', ['init', '-q', repoCli]);
  const rSuggest = runNode(BKLG0, ['trigram', '--cwd', repoCli, '--suggest']);
  ok(/\[.{3}\]/.test(rSuggest.out), 'CLI trigram --suggest : liste des propositions au format [XXX]');
  const rSet = runNode(BKLG0, ['trigram', '--cwd', repoCli, '--set', 'xyz']);
  ok(/\[XYZ\]/.test(rSet.out) && /enregistré/.test(rSet.out), 'CLI trigram --set : confirmation');
  const rShow = runNode(BKLG0, ['trigram', '--cwd', repoCli]);
  ok(/\[XYZ\]/.test(rShow.out), 'CLI trigram sans --set : affiche le trigramme courant');
}

section('suggestedTitle : suffixe « (partie N) » quand un lot dépasse une session (lot #35)');
{
  const backlogLib0 = require(path.join(PKG, 'lib', 'backlog'));
  const repo = path.join(SANDBOX, 'repo-lot-parties');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const trg = trigram.deriveTrigram(repo);
  const l = backlogLib0.addLot(repo, 'Lot qui traîne', null, 'sonnet');
  backlogLib0.startLot(repo, l.id);

  // 1er appel (1re session sur ce lot) : pas de suffixe. Lot sans epic -> « Session Libre ».
  ok(lot.suggestedTitle(repo) === `[${trg} · #${l.id}] Session Libre · Lot qui traîne`,
    '1er touch : pas de « (partie N) » (cas normal, silence sur la 1re session)');
  // 2e appel (le lot est toujours in_progress -> 2e session dessus) : « (partie 2) ».
  ok(lot.suggestedTitle(repo) === `[${trg} · #${l.id}] Session Libre · Lot qui traîne (partie 2)`,
    '2e touch sur un lot toujours ouvert : suffixe « (partie 2) »');
  ok(lot.suggestedTitle(repo) === `[${trg} · #${l.id}] Session Libre · Lot qui traîne (partie 3)`,
    '3e touch : « (partie 3) »');

  // Clôture : le récap du dernier lot clos ne porte plus de suffixe (le travail est fini).
  backlogLib0.doneLot(repo, l.id);
  ok(lot.suggestedTitle(repo) === `[${trg} · #${l.id}] Session Libre · Lot qui traîne`,
    'lot clos : pas de « (partie N) » sur le récap final, peu importe combien de sessions ça a pris');

  // Un nouveau lot démarré repart de « partie 1 » (compteur remis à 0 par startLot).
  const l2 = backlogLib0.addLot(repo, 'Lot suivant', null, 'sonnet');
  backlogLib0.startLot(repo, l2.id);
  ok(lot.suggestedTitle(repo) === `[${trg} · #${l2.id}] Session Libre · Lot suivant`,
    'nouveau lot démarré : compteur de sessions repart à zéro, pas de suffixe hérité');
}
{
  // Intégration : stop.js incrémente le lot au moment où le lot se referme.
  const repo = path.join(SANDBOX, 'repo-stopclose');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const sid = 'sess-close';
  fs.writeFileSync(path.join(repo, 'a.txt'), '2'); // lot ouvert
  runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: path.join(SANDBOX, 'empty.jsonl') });
  const before = lot.getLotCounter(repo);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'close']);
  runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: path.join(SANDBOX, 'empty.jsonl') });
  ok(lot.getLotCounter(repo) === before + 1, 'lot incrémenté quand le working tree redevient propre');
}

// ============================ J. AUTO-SCAFFOLD PROJET NEUF (point 6) ============================
section('Auto-scaffold sur détection de projet neuf (point 6)');
const bootstrapLib = require(path.join(PKG, 'lib', 'bootstrap'));
{
  // (a) repo git existant, 0 commit → session-start.js scaffold automatiquement.
  const repo = path.join(SANDBOX, 'repo-newproject');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  ok(!fs.existsSync(path.join(repo, 'CLAUDE.md')), 'avant : pas de CLAUDE.md');
  const r = runHook('session-start.js', { source: 'startup', cwd: repo, session_id: 's-newproject' });
  ok(r.code === 0, 'session-start sur projet neuf → exit 0');
  ok(fs.existsSync(path.join(repo, 'CLAUDE.md')), 'CLAUDE.md créé automatiquement (0 commit, sans confirmation)');
  ok(fs.existsSync(path.join(repo, '.vibe-agent')), '.vibe-agent créé');
  const log = execFileSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' });
  ok(log.trim().split('\n').length === 1, 'commit initial du socle créé par PMZ');
}
{
  // (b) aucun .git du tout → user-prompt-submit.js fait git init + scaffold + commit.
  const dir = path.join(SANDBOX, 'no-git-yet');
  fs.mkdirSync(dir, { recursive: true });
  const r = runHook('user-prompt-submit.js', { cwd: dir, prompt: 'initialise un nouveau projet de todo-list', session_id: 's-nogit' });
  ok(r.code === 0, 'user-prompt-submit sur dossier sans .git → exit 0');
  ok(fs.existsSync(path.join(dir, '.git')), 'git init effectué automatiquement');
  ok(fs.existsSync(path.join(dir, 'CLAUDE.md')), 'CLAUDE.md créé automatiquement après git init');
}
{
  // (c) prompt anodin sur dossier sans .git → on ne touche à rien (comportement inchangé).
  const dir = path.join(SANDBOX, 'no-git-anodin');
  fs.mkdirSync(dir, { recursive: true });
  const r = runHook('user-prompt-submit.js', { cwd: dir, prompt: 'quelle heure est-il ?', session_id: 's-anodin' });
  ok(r.code === 0 && !fs.existsSync(path.join(dir, '.git')), 'prompt anodin sans .git → rien créé');
}
{
  // (d) racine interdite → jamais d'auto-init.
  const r = bootstrapLib.autoInitGitAndBootstrap(os.homedir());
  ok(r.ok === false && r.reason === 'forbidden_root', 'autoInitGitAndBootstrap refuse une racine interdite ($HOME)');
}
{
  // (e) projet MATURE (déjà des commits) sans CLAUDE.md → pas d'auto-scaffold, juste la proposition.
  const repo = path.join(SANDBOX, 'repo-mature-noclaude');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  runHook('session-start.js', { source: 'startup', cwd: repo, session_id: 's-mature' });
  ok(!fs.existsSync(path.join(repo, 'CLAUDE.md')), 'projet mature sans /init → CLAUDE.md toujours NON créé automatiquement');
}

// ============================ K2. SÉCURISATION DU BACKLOG (ADN) ============================
section('Sécurisation du backlog — .vibe-agent/.gitignore whitelist + staging auto');
{
  const backlog = require(path.join(PKG, 'lib', 'backlog'));
  const repo = path.join(SANDBOX, 'repo-backlog-dna');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  bootstrapLib.runBootstrap(repo);

  const giPath = path.join(repo, '.vibe-agent', '.gitignore');
  ok(fs.existsSync(giPath), 'bootstrap : .vibe-agent/.gitignore créé');
  const gi = fs.readFileSync(giPath, 'utf8');
  ok(/^\*$/m.test(gi) && /^!backlog\.json$/m.test(gi), '.gitignore : whiteliste backlog.json (ignore le reste)');

  const ignored = (rel) => {
    try { execFileSync('git', ['-C', repo, 'check-ignore', '-q', rel]); return true; } catch (_) { return false; }
  };
  ok(ignored('.vibe-agent/context-ledger.json') && ignored('.vibe-agent/read-ledger.json') &&
    ignored('.vibe-agent/session-state.json'), 'état éphémère (ledgers, session-state) : gitignoré');
  ok(!ignored('.vibe-agent/backlog.json') && !ignored('.vibe-agent/rules.yaml'),
    'durable (backlog.json, rules.yaml) : NON gitignoré');

  // saveBacklog stage le backlog automatiquement → il part au prochain commit ET
  // survit à un git clean -fd (fichier stagé jamais supprimé).
  backlog.addLot(repo, 'Lot test', 'fait quand : …');
  const staged = execFileSync('git', ['-C', repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
  ok(/\.vibe-agent\/backlog\.json/.test(staged), 'addLot : backlog.json stagé automatiquement');
  execFileSync('git', ['-C', repo, 'clean', '-fd'], { encoding: 'utf8' });
  ok(fs.existsSync(path.join(repo, '.vibe-agent', 'backlog.json')), 'backlog.json survit à git clean -fd (stagé)');

  // commitScaffold ne s'étrangle pas sur les ledgers ignorés : 1 commit du socle.
  const repo2 = path.join(SANDBOX, 'repo-backlog-dna2');
  fs.mkdirSync(repo2, { recursive: true });
  const rInit = bootstrapLib.autoInitGitAndBootstrap(repo2);
  ok(rInit.ok === true && rInit.committed === true, 'autoInit : socle commité malgré les ledgers ignorés');
  const tracked = execFileSync('git', ['-C', repo2, 'ls-files', '.vibe-agent'], { encoding: 'utf8' });
  ok(/\.vibe-agent\/\.gitignore/.test(tracked) && /\.vibe-agent\/rules\.yaml/.test(tracked),
    'commit du socle : .gitignore + rules.yaml suivis');
  ok(!/context-ledger\.json/.test(tracked) && !/session-state\.json/.test(tracked),
    'commit du socle : ledgers éphémères NON suivis');
}

// ============================ L. INIT PROJET EN COURS (--augment) ============================
section('Init d\'un projet en cours — augmentation taguée de CLAUDE.md/AGENTS.md existants');
{
  const repo = path.join(SANDBOX, 'repo-augment');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Mon projet\n\nRègles maison.\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'projet en cours']);

  // L1. --augment : fichiers manquants créés + CLAUDE.md existant augmenté (pas écrasé)
  const r1 = runNode(BOOTSTRAP, ['--cwd', repo, '--augment']);
  let j1 = {};
  try { j1 = JSON.parse(r1.out); } catch (_) {}
  ok(j1.ok === true, '--augment → ok:true');
  const claude1 = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
  ok(claude1.startsWith('# Mon projet'), 'CLAUDE.md existant : contenu original préservé en tête');
  ok(claude1.includes('<!-- pmz:rules:start -->') && claude1.includes('<!-- pmz:rules:end -->'),
    'CLAUDE.md existant : section PMZ taguée ajoutée en fin');
  ok(Array.isArray(j1.augmented) && j1.augmented.some((p) => p.endsWith('CLAUDE.md')),
    'CLAUDE.md listé dans augmented');
  // AGENTS.md était ABSENT -> créé depuis le template (qui porte déjà le marqueur),
  // donc PAS ré-augmenté en plus (pas de doublon de règles)
  const agents1 = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  ok(Array.isArray(j1.created) && j1.created.some((p) => p.endsWith('AGENTS.md')), 'AGENTS.md absent → créé');
  ok(agents1.split('pmz:rules:start').length === 2, 'fichier fraîchement créé : une seule section (marqueur du template)');

  // L2. Idempotence : 2e run → rien de neuf, pas de double section
  const r2 = runNode(BOOTSTRAP, ['--cwd', repo, '--augment']);
  let j2 = {};
  try { j2 = JSON.parse(r2.out); } catch (_) {}
  ok(j2.ok === true && (j2.augmented || []).length === 0, '2e --augment → rien de ré-augmenté');
  const claude2 = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
  ok(claude2.split('pmz:rules:start').length === 2, 'idempotent : une seule section PMZ');

  // L3. Sans --augment : comportement historique inchangé (aucune modification d'un existant)
  const repo3 = path.join(SANDBOX, 'repo-noaugment');
  fs.mkdirSync(repo3, { recursive: true });
  execFileSync('git', ['init', '-q', repo3]);
  fs.writeFileSync(path.join(repo3, 'CLAUDE.md'), 'INTACT');
  runNode(BOOTSTRAP, ['--cwd', repo3]);
  ok(fs.readFileSync(path.join(repo3, 'CLAUDE.md'), 'utf8') === 'INTACT',
    'sans --augment : CLAUDE.md existant strictement intact');

  // L4. L'auto-scaffold des hooks (projet neuf, 0 commit) n'augmente JAMAIS un existant
  const repo4 = path.join(SANDBOX, 'repo-hook-noaugment');
  fs.mkdirSync(repo4, { recursive: true });
  execFileSync('git', ['init', '-q', repo4]);
  fs.writeFileSync(path.join(repo4, 'CLAUDE.md'), 'INTACT-HOOK');
  runHook('session-start.js', { source: 'startup', cwd: repo4, session_id: 's-hook-noaug' });
  ok(fs.readFileSync(path.join(repo4, 'CLAUDE.md'), 'utf8') === 'INTACT-HOOK',
    'auto-scaffold hook : CLAUDE.md existant jamais modifié');
}

// ============================ K. HANDOFF DE FIN DE TOUR ============================
section('Handoff auto (.vibe-agent/handoff.md) — écrasement, manuel, injection, consommation');
const handoff = require(path.join(PKG, 'lib', 'handoff'));
{
  const repo = path.join(SANDBOX, 'repo-handoff');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'règles'); // + ledger -> isFullyInitialized
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'premier commit']);
  const hf = path.join(repo, '.vibe-agent', 'handoff.md');
  const empty = path.join(SANDBOX, 'empty.jsonl');
  function startCtx(sid) {
    const r = runHook('session-start.js', { source: 'startup', cwd: repo, session_id: sid });
    try { return JSON.parse(r.out).hookSpecificOutput.additionalContext || ''; } catch (_) { return ''; }
  }

  // K1. stop.js écrit le handoff auto en fin de tour
  runHook('stop.js', { session_id: 'sess-h1', cwd: repo, transcript_path: empty });
  ok(fs.existsSync(hf), 'stop.js → handoff.md créé');
  const c1 = fs.readFileSync(hf, 'utf8');
  ok(c1.includes(handoff.AUTO_MARKER), 'handoff auto : marqueur auto présent');
  ok(/premier commit/.test(c1), 'handoff auto : mentionne le dernier commit');

  // K2. écrasé à chaque tour (jamais cumulé) et reflète l'état courant
  fs.writeFileSync(path.join(repo, 'b.txt'), 'x');
  runHook('stop.js', { session_id: 'sess-h1', cwd: repo, transcript_path: empty });
  const c2 = fs.readFileSync(hf, 'utf8');
  ok(c2.split('pmz:handoff:auto').length === 2, 'handoff écrasé à chaque tour (un seul marqueur, pas de cumul)');
  ok(/b\.txt/.test(c2), 'handoff auto : reflète le working tree courant');

  // K3. session-start injecte le handoff au démarrage de la session suivante
  const ctx1 = startCtx('sess-h2');
  ok(/handoff/i.test(ctx1) && /b\.txt/.test(ctx1), 'session-start : handoff injecté dans additionalContext');

  // K4. un handoff manuel (/fresh-session) n'est jamais écrasé par stop.js
  fs.writeFileSync(hf, handoff.MANUAL_MARKER + '\n## Handoff session fraîche\nCONTENU-RICHE\n');
  runHook('stop.js', { session_id: 'sess-h2', cwd: repo, transcript_path: empty });
  ok(/CONTENU-RICHE/.test(fs.readFileSync(hf, 'utf8')), 'handoff manuel préservé par stop.js');

  // K5. handoff manuel injecté au démarrage suivant puis consommé (manuel -> auto)
  const ctx2 = startCtx('sess-h3');
  ok(/CONTENU-RICHE/.test(ctx2), 'handoff manuel injecté au démarrage');
  const consumed = fs.readFileSync(hf, 'utf8');
  ok(consumed.includes(handoff.AUTO_MARKER) && !consumed.includes(handoff.MANUAL_MARKER),
    'consommation : marqueur manuel rebasculé en auto');
  runHook('stop.js', { session_id: 'sess-h3', cwd: repo, transcript_path: empty });
  ok(!/CONTENU-RICHE/.test(fs.readFileSync(hf, 'utf8')), 'après consommation : le handoff auto reprend la main');

  // K6. resume/compact : aucune réinjection (anti-bloat)
  const r3 = runHook('session-start.js', { source: 'resume', cwd: repo, session_id: 'sess-h4' });
  ok(r3.code === 0 && !(r3.out || '').trim(), 'resume → aucune injection (handoff compris)');

  // K7. fichier sans marqueur PMZ (notes utilisateur) : ni écrasé ni injecté
  fs.writeFileSync(hf, 'notes perso sans marqueur');
  runHook('stop.js', { session_id: 'sess-h5', cwd: repo, transcript_path: empty });
  ok(fs.readFileSync(hf, 'utf8') === 'notes perso sans marqueur', 'fichier utilisateur : jamais écrasé');
  ok(!/notes perso/.test(startCtx('sess-h6')), 'fichier utilisateur : jamais injecté');
}
{
  // K8. le bruit .vibe-agent/ (ledgers + handoff réécrits chaque tour) ne compte
  // pas comme lot ouvert et ne bloque plus la clôture du lot.
  const repo = path.join(SANDBOX, 'repo-handoff-noise');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const empty = path.join(SANDBOX, 'empty.jsonl');
  runHook('stop.js', { session_id: 'sess-n1', cwd: repo, transcript_path: empty }); // crée .vibe-agent + handoff
  ok(project.gitStatusPorcelain(repo).length > 0, 'porcelain brut : voit le bruit .vibe-agent non commité');
  ok(project.gitStatusMeaningful(repo).length === 0, 'gitStatusMeaningful : ignore .vibe-agent');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2'); // lot ouvert
  runHook('stop.js', { session_id: 'sess-n1', cwd: repo, transcript_path: empty });
  const before = lot.getLotCounter(repo);
  execFileSync('git', ['-C', repo, 'add', 'a.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'close']);
  runHook('stop.js', { session_id: 'sess-n1', cwd: repo, transcript_path: empty });
  ok(lot.getLotCounter(repo) === before + 1, 'lot clôturé malgré .vibe-agent non commité (ledgers/handoff)');
}

// ============================ M. LOT A0 — AUDIT-BATCH & CHAMPS MORTS ============================
section('audit-batch — gitStatusMeaningful + champs morts retirés');
const AUDIT = path.join(PKG, 'scripts', 'audit-batch.js');
{
  const repo = path.join(SANDBOX, 'repo-auditbatch');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  fs.mkdirSync(path.join(repo, '.vibe-agent'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.vibe-agent', 'x.json'), '{}');
  let j = {};
  try { j = JSON.parse(runNode(AUDIT, ['--cwd', repo, '--json']).out); } catch (_) {}
  ok(j.needs_closure === false && Array.isArray(j.modified_files) && j.modified_files.length === 0,
    'audit-batch : seul .vibe-agent/ sale → clôturable (aligné stop.js)');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2');
  let j2 = {};
  try { j2 = JSON.parse(runNode(AUDIT, ['--cwd', repo, '--json']).out); } catch (_) {}
  ok(j2.needs_closure === true && j2.modified_files.length === 1, 'audit-batch : fichier réel sale → clôture nécessaire');
}
{
  const state = require(path.join(PKG, 'lib', 'state'));
  for (const k of ['current_batch', 'batch_status', 'verification_status']) {
    ok(!(k in state.DEFAULT_STATE), `champ mort retiré de DEFAULT_STATE : ${k}`);
  }
  const tpl = JSON.parse(fs.readFileSync(path.join(PKG, 'templates', 'session-state.json'), 'utf8'));
  ok(!('current_batch' in tpl) && !('batch_status' in tpl) && !('verification_status' in tpl),
    'template session-state.json sans champs morts');
}

// ============================ N. BACKLOG — NOYAU ============================
section('backlog — CRUD, caps, corruption, reconcile');
const backlogLib = require(path.join(PKG, 'lib', 'backlog'));
const BKLG = path.join(PKG, 'scripts', 'backlog.js');
{
  const repo = path.join(SANDBOX, 'repo-backlog');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

  // N1. add ×3 via CLI : ids monotones, ledger auto-créé
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot un', '--scope', 'fait quand : test A', '--model', 'sonnet']);
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot deux', '--model', 'opus']);
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot trois', '--model', 'haiku']);
  let b = backlogLib.loadBacklog(repo);
  ok(b.lots.length === 3 && b.lots.map((l) => l.id).join(',') === '1,2,3' && b.next_id === 4,
    'backlog add ×3 : ids 1,2,3 et next_id=4');
  ok(b.lots[0].scope === 'fait quand : test A' && b.lots[0].status === 'todo', 'backlog : scope et statut posés');

  // N2. start : un seul in_progress à la fois
  runNode(BKLG, ['start', '--cwd', repo, '--id', '1']);
  runNode(BKLG, ['start', '--cwd', repo, '--id', '2']);
  b = backlogLib.loadBacklog(repo);
  ok(b.lots.filter((l) => l.status === 'in_progress').length === 1 && backlogLib.currentLot(b).id === 2,
    'backlog start : un seul in_progress (le dernier démarré)');
  ok(b.lots[0].status === 'todo', 'backlog start : le précédent rétrogradé en todo');

  // N3. done : commit, date, lot_number ; idempotent
  runNode(BKLG, ['done', '--cwd', repo, '--id', '2', '--commit', 'abc1234']);
  b = backlogLib.loadBacklog(repo);
  const l2 = b.lots.find((l) => l.id === 2);
  ok(l2.status === 'done' && l2.closed_commit === 'abc1234' && !!l2.closed_at && Number.isFinite(l2.lot_number),
    'backlog done : statut, commit, date, lot_number posés');
  const again = backlogLib.doneLot(repo, 2, 'zzz9999');
  ok(again && again.closed_commit === 'abc1234', 'backlog done : idempotent (lot déjà clos non réécrit)');

  // N4. next = premier todo dans l'ordre du tableau
  const nx = backlogLib.nextLot(backlogLib.loadBacklog(repo));
  ok(!!nx && nx.id === 1, 'backlog next : premier todo dans l\'ordre');

  // N5. progress + summaryLines (consommés par handoff/messages)
  runNode(BKLG, ['start', '--cwd', repo, '--id', '1']);
  const p = backlogLib.progress(backlogLib.loadBacklog(repo));
  ok(p.done === 1 && p.total === 3, 'backlog progress : 1/3');
  const sum = backlogLib.summaryLines(repo);
  ok(sum.length >= 2 && /1\/3 faits/.test(sum[0]) && /#1/.test(sum[0]), 'summaryLines : x/y + lot en cours');
  ok(/Suivants/.test(sum[1]) && /#3/.test(sum[1]), 'summaryLines : lots suivants listés');

  // N6. drop : exclu du total
  runNode(BKLG, ['drop', '--cwd', repo, '--id', '3', '--note', 'hors périmètre']);
  b = backlogLib.loadBacklog(repo);
  ok(b.lots.find((l) => l.id === 3).status === 'dropped', 'backlog drop : statut abandonné');
  ok(backlogLib.progress(b).total === 2, 'backlog progress : dropped exclu du total');

  // N7. troncatures
  const long = backlogLib.addLot(repo, 'x'.repeat(200), 'y'.repeat(600));
  ok(!!long && long.title.length <= 80 && long.scope.length <= 400, 'backlog : troncatures titre 80 / scope 400');

  // N8. cap de lots ouverts (refus doux)
  for (let i = 0; i < 25; i++) runNode(BKLG, ['add', '--cwd', repo, '--title', 'lot ' + i, '--model', 'sonnet']);
  b = backlogLib.loadBacklog(repo);
  ok(b.lots.filter((l) => l.status === 'todo' || l.status === 'in_progress').length <= backlogLib.MAX_LOTS_OPEN,
    'backlog cap : jamais plus de 20 lots ouverts');
  const refused = runNode(BKLG, ['add', '--cwd', repo, '--title', 'un de trop', '--model', 'sonnet']);
  ok(/Refusé/.test(refused.out) && refused.code === 0, 'backlog cap : refus doux, exit 0');

  // N9. fichier corrompu → backlog vide valide, jamais de crash
  fs.writeFileSync(path.join(repo, '.vibe-agent', 'backlog.json'), '{pas du json');
  const rShow = runNode(BKLG, ['show', '--cwd', repo]);
  ok(rShow.code === 0 && /Aucun plan de lots/.test(rShow.out), 'backlog corrompu : show → vide, exit 0');

  // N10. reconcile : deux in_progress forgés + done sans commit
  fs.writeFileSync(path.join(repo, '.vibe-agent', 'backlog.json'), JSON.stringify({
    version: 1, next_id: 4, lots: [
      { id: 1, title: 'a', status: 'in_progress', started_at: '2026-07-10T10:00:00Z' },
      { id: 2, title: 'b', status: 'in_progress', started_at: '2026-07-10T11:00:00Z' },
      { id: 3, title: 'c', status: 'done' },
    ],
  }));
  const rRec = runNode(BKLG, ['reconcile', '--cwd', repo]);
  b = backlogLib.loadBacklog(repo);
  ok(b.lots.filter((l) => l.status === 'in_progress').length === 1 && backlogLib.currentLot(b).id === 2,
    'reconcile : garde le in_progress le plus récent');
  ok(!!b.lots.find((l) => l.id === 3).closed_commit, 'reconcile : commit attaché au done orphelin');
  ok(/Réparé/.test(rRec.out), 'reconcile : sortie explicite');

  // N11. hors git : message doux, rien créé
  const noRepo = path.join(SANDBOX, 'backlog-nogit');
  fs.mkdirSync(noRepo, { recursive: true });
  const rNo = runNode(BKLG, ['add', '--cwd', noRepo, '--title', 'x']);
  ok(rNo.code === 0 && /Pas un dépôt git/.test(rNo.out) && !fs.existsSync(path.join(noRepo, '.vibe-agent')),
    'backlog hors git : refus doux, rien créé');
}

// N12. done sans lotNumber (chemin CLI/manuel, ex. /close-batch) PERSISTE l'avance du
// compteur global (régression du bug « Lot N qui se répète » : avant le fix, seul le
// Stop hook auto persistait ; une clôture manuelle relisait compteur+1 sans l'écrire,
// si bien que la session suivante recalculait le même numéro pour un autre lot).
{
  const repo = path.join(SANDBOX, 'repo-backlog-counter');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const lotLib = require(path.join(PKG, 'lib', 'lot'));

  const counterBefore = lotLib.getLotCounter(repo);
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot quatre', '--model', 'sonnet']);
  const idQuatre = backlogLib.loadBacklog(repo).lots.find((l) => l.title === 'Lot quatre').id;
  runNode(BKLG, ['done', '--cwd', repo, '--id', String(idQuatre)]);
  const counterAfterFirst = lotLib.getLotCounter(repo);
  ok(counterAfterFirst === counterBefore + 1, 'backlog done manuel : le compteur global avance et est persisté');

  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot cinq', '--model', 'sonnet']);
  const idCinq = backlogLib.loadBacklog(repo).lots.find((l) => l.title === 'Lot cinq').id;
  runNode(BKLG, ['done', '--cwd', repo, '--id', String(idCinq)]);
  const counterAfterSecond = lotLib.getLotCounter(repo);
  ok(counterAfterSecond === counterAfterFirst + 1, 'backlog done manuel : deux clôtures de suite avancent deux fois (jamais figé)');

  const closed = backlogLib.loadBacklog(repo).lots.filter((l) => l.id === idQuatre || l.id === idCinq);
  ok(closed[0].lot_number !== closed[1].lot_number, 'backlog done manuel : deux lots clos de suite reçoivent des lot_number distincts');
}

// ==================== N-bis. B6 — PRÉCONISATION DE MODÈLE PAR LOT ====================
section('backlog — model_hint (préconisation de modèle par lot)');
{
  const repo = path.join(SANDBOX, 'repo-model-hint');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

  // M1. add sans --model : refusé (préconisation imposée), rien créé
  const rNoModel = runNode(BKLG, ['add', '--cwd', repo, '--title', 'Sans modèle']);
  ok(rNoModel.code === 0 && /--model/.test(rNoModel.out) && /Refus/.test(rNoModel.out),
    'add sans --model : refusé, exit 0');
  ok(backlogLib.loadBacklog(repo).lots.length === 0, 'add sans --model : aucun lot persisté');

  // M2. add avec --model : model_hint persisté + affiché dans la sortie add
  const rAdd = runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot mécanique', '--scope', 'fait quand : OK', '--model', 'sonnet']);
  ok(/\[modèle : sonnet\]/.test(rAdd.out), 'add : model_hint réaffiché dans la sortie');
  let b = backlogLib.loadBacklog(repo);
  ok(b.lots[0].model_hint === 'sonnet', 'add : model_hint persisté dans backlog.json');

  // M3. show : model_hint réaffiché sur chaque ligne
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot archi', '--model', 'opus']);
  const rShow = runNode(BKLG, ['show', '--cwd', repo]);
  ok(/#1.*\[modèle : sonnet\]/.test(rShow.out) && /#2.*\[modèle : opus\]/.test(rShow.out),
    'show : model_hint réaffiché sur chaque lot');

  // M4. start : model_hint réaffiché dans la sortie
  const rStart = runNode(BKLG, ['start', '--cwd', repo, '--id', '2']);
  ok(/\[modèle : opus\]/.test(rStart.out), 'start : model_hint réaffiché');

  // M5. next : model_hint réaffiché
  const rNext = runNode(BKLG, ['next', '--cwd', repo]);
  ok(/\[modèle : sonnet\]/.test(rNext.out), 'next : model_hint réaffiché');

  // M6. summaryLines (→ handoff auto) : model_hint sur lot en cours + suivants
  const sum = backlogLib.summaryLines(repo);
  ok(/\[modèle : opus\]/.test(sum[0]), 'summaryLines : model_hint sur le lot en cours');
  ok(sum.some((l) => /#1.*\[modèle : sonnet\]/.test(l)), 'summaryLines : model_hint sur les suivants');

  // M7. troncature du model_hint au cap
  const long = backlogLib.addLot(repo, 'Lot long', null, 'x'.repeat(200));
  ok(!!long && long.model_hint.length <= backlogLib.MAX_MODEL_HINT, 'addLot : model_hint tronqué au cap');

  // M8. lot legacy sans model_hint (pré-B6) : chargé sans crash, affiché sans tag
  fs.writeFileSync(path.join(repo, '.vibe-agent', 'backlog.json'), JSON.stringify({
    version: 1, next_id: 2, lots: [{ id: 1, title: 'Legacy', status: 'todo' }],
  }));
  b = backlogLib.loadBacklog(repo);
  ok(b.lots[0].model_hint === null, 'legacy : model_hint absent → null, pas de crash');
  const rShowLegacy = runNode(BKLG, ['show', '--cwd', repo]);
  ok(rShowLegacy.code === 0 && !/\[modèle :/.test(rShowLegacy.out), 'legacy : show sans tag modèle, exit 0');
}

// ==================== N-ter. B7 — EFFORT DE RAISONNEMENT PAR LOT ====================
section('backlog — effort_hint (effort de raisonnement par lot)');
{
  const repo = path.join(SANDBOX, 'repo-effort-hint');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

  // E1. add avec --effort invalide : refusé, rien créé
  const rBadEffort = runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot invalide', '--model', 'sonnet', '--effort', 'extreme']);
  ok(rBadEffort.code === 0 && /--effort invalide/.test(rBadEffort.out) && /Refus/.test(rBadEffort.out),
    'add avec --effort invalide : refusé, exit 0');
  ok(backlogLib.loadBacklog(repo).lots.length === 0, 'add avec --effort invalide : aucun lot persisté');

  // E2. add sans --effort : toléré (effort optionnel), model_hint seul réaffiché
  const rNoEffort = runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot mécanique', '--model', 'sonnet']);
  ok(/\[modèle : sonnet\]/.test(rNoEffort.out) && !/· effort/.test(rNoEffort.out), 'add sans --effort : tag modèle seul');
  ok(backlogLib.loadBacklog(repo).lots[0].effort_hint === null, 'add sans --effort : effort_hint null');

  // E3. add avec --effort valide : persisté + réaffiché combiné avec le modèle
  const rAdd = runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot plomberie', '--scope', 'fait quand : OK', '--model', 'sonnet', '--effort', 'medium']);
  ok(/\[modèle : sonnet · effort medium\]/.test(rAdd.out), 'add : effort_hint réaffiché combiné avec le modèle');
  let b = backlogLib.loadBacklog(repo);
  ok(b.lots[1].effort_hint === 'medium', 'add : effort_hint persisté dans backlog.json');

  // E4. show : effort réaffiché sur la ligne du lot
  const rShow = runNode(BKLG, ['show', '--cwd', repo]);
  ok(/\[modèle : sonnet · effort medium\]/.test(rShow.out), 'show : effort_hint réaffiché');

  // E5. start : effort réaffiché
  const rStart = runNode(BKLG, ['start', '--cwd', repo, '--id', String(b.lots[1].id)]);
  ok(/\[modèle : sonnet · effort medium\]/.test(rStart.out), 'start : effort_hint réaffiché');

  // E6. next : effort réaffiché sur le prochain lot todo (le lot 1, sans effort, est
  // abandonné pour laisser le lot archi/opus/high seul candidat todo)
  backlogLib.dropLot(repo, b.lots[0].id);
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot archi', '--model', 'opus', '--effort', 'high']);
  const rNext = runNode(BKLG, ['next', '--cwd', repo]);
  ok(/\[modèle : opus · effort high\]/.test(rNext.out), 'next : effort_hint réaffiché');

  // E7. summaryLines (→ handoff auto) : effort combiné sur le lot en cours
  const sum = backlogLib.summaryLines(repo);
  ok(/\[modèle : sonnet · effort medium\]/.test(sum[0]), 'summaryLines : effort_hint combiné sur le lot en cours');

  // E8. lot legacy sans effort_hint : chargé sans crash, null
  fs.writeFileSync(path.join(repo, '.vibe-agent', 'backlog.json'), JSON.stringify({
    version: 1, next_id: 2, lots: [{ id: 1, title: 'Legacy', status: 'todo', model_hint: 'sonnet' }],
  }));
  b = backlogLib.loadBacklog(repo);
  ok(b.lots[0].effort_hint === null, 'legacy : effort_hint absent → null, pas de crash');
  const rShowLegacy = runNode(BKLG, ['show', '--cwd', repo]);
  ok(rShowLegacy.code === 0 && /\[modèle : sonnet\]/.test(rShowLegacy.out) && !/effort/.test(rShowLegacy.out),
    'legacy : show avec modèle seul, sans tag effort, exit 0');
}

section('backlog — champ epic optionnel du lot (lot #28)');
{
  const repo = path.join(SANDBOX, 'repo-lot-epic');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

  // P1. epic --set : écrit .vibe-agent/epic, plafonné, réutilisable par readEpic
  const rSet = runNode(BKLG, ['epic', '--cwd', repo, '--set', 'x'.repeat(100)]);
  ok(/enregistré/.test(rSet.out), 'epic --set : confirmation');
  ok(lot.readEpic(repo).length === lot.MAX_EPIC, 'epic --set : label tronqué au cap (lu via readEpic)');

  // P2. epic sans --set : lit l'epic courant
  const rGet = runNode(BKLG, ['epic', '--cwd', repo]);
  ok(rGet.out.includes(lot.readEpic(repo)), 'epic sans --set : affiche l\'epic courant');

  // P3. add --epic : champ persisté + réaffiché
  const rAdd = runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot avec epic', '--model', 'sonnet', '--epic', 'Feature X']);
  ok(/\[epic : Feature X\]/.test(rAdd.out), 'add --epic : réaffiché dans la sortie');
  let b = backlogLib.loadBacklog(repo);
  ok(b.lots[0].epic === 'Feature X', 'add --epic : persisté dans backlog.json');

  // P4. add sans --epic : champ absent, pas de crash
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot sans epic', '--model', 'sonnet']);
  b = backlogLib.loadBacklog(repo);
  ok(b.lots[1].epic === null, 'add sans --epic : champ epic = null');

  // P5. show --epic : filtre sur le label du lot
  const rShowFilter = runNode(BKLG, ['show', '--cwd', repo, '--epic', 'Feature X']);
  ok(/Lot avec epic/.test(rShowFilter.out) && !/Lot sans epic/.test(rShowFilter.out),
    'show --epic : ne liste que les lots du label demandé');

  // P6. troncature au cap du champ epic (groupement/filtrage, cf. P5).
  const long = backlogLib.addLot(repo, 'Lot long epic', null, 'sonnet', 'y'.repeat(200));
  ok(!!long && long.epic.length <= backlogLib.MAX_EPIC, 'addLot : epic tronqué au cap');

  // P7. nomenclature complète « [XXX · #Y] PlanTitle · Lot #X · résumé » : #Y = id backlog
  // global (accolé au trigramme), PlanTitle = epic ≤ 3 mots, Lot #X = rang dans le plan
  // (ici 1er lot de son epic), résumé = focus du lot (préfixe métier « Lot X — » retiré).
  const trgN = trigram.deriveTrigram(repo);
  const planLot = backlogLib.addLot(repo, 'Lot E1 — Namespace plugin pmz', null, 'opus', 'Diffusion pmz — marketplace GitHub publique');
  backlogLib.startLot(repo, planLot.id);
  ok(lot.suggestedTitle(repo) === `[${trgN} · #${planLot.id}] Diffusion pmz · Lot #1 · Namespace plugin pmz`,
    'suggestedTitle : [XXX · #Y] <epic 3 mots> · Lot #X · <focus sans préfixe métier>');

  // P8. epic borné à 3 mots quel que soit sa longueur (nom de plan « clair et constant »).
  backlogLib.doneLot(repo, planLot.id);
  const wide = backlogLib.addLot(repo, 'Focus large', null, 'sonnet', 'Un deux trois quatre cinq');
  backlogLib.startLot(repo, wide.id);
  ok(lot.suggestedTitle(repo) === `[${trgN} · #${wide.id}] Un deux trois · Lot #1 · Focus large`,
    'suggestedTitle : nom de plan tronqué à 3 mots');

  // P9. about.js : affiche l'epic du lot en cours (ici `wide`) plutôt que le label global
  const rAbout = runNode(path.join(PKG, 'scripts', 'about.js'), ['--cwd', repo]);
  ok(new RegExp(`Epic : ${wide.epic}`).test(rAbout.out), 'about : epic du lot en cours prioritaire');
}

section('backlog — verify + closed_occupancy (lot #29)');
{
  const repo = path.join(SANDBOX, 'repo-lot-verify');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

  // V1. add --verify : champ persisté + réaffiché
  const rAdd = runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot avec verify', '--model', 'sonnet', '--verify', 'true']);
  ok(/\[verify : true\]/.test(rAdd.out), 'add --verify : réaffiché dans la sortie');
  let b = backlogLib.loadBacklog(repo);
  ok(b.lots[0].verify === 'true', 'add --verify : persisté dans backlog.json');

  // V2. add sans --verify : champ absent, pas de crash
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot sans verify', '--model', 'sonnet']);
  b = backlogLib.loadBacklog(repo);
  ok(b.lots[1].verify === null, 'add sans --verify : champ verify = null');

  // V3. verify --set : édite un lot existant
  const rSet = runNode(BKLG, ['verify', '--cwd', repo, '--id', String(b.lots[1].id), '--set', 'exit 1']);
  ok(/enregistrée/.test(rSet.out), 'verify --set : confirmation');
  b = backlogLib.loadBacklog(repo);
  ok(b.lots[1].verify === 'exit 1', 'verify --set : persisté');

  // V4. verify sans --set : lecture
  const rGet = runNode(BKLG, ['verify', '--cwd', repo, '--id', String(b.lots[1].id)]);
  ok(rGet.out.includes('exit 1'), 'verify sans --set : affiche la commande courante');

  // V5. troncature au cap
  const long = backlogLib.addLot(repo, 'Lot long verify', null, 'sonnet', null, 'x'.repeat(300));
  ok(!!long && long.verify.length <= backlogLib.MAX_VERIFY, 'addLot : verify tronqué au cap');

  // V6. close-batch : verify OK → ligne "OK", jamais bloquant (exit 0)
  const lotOk = backlogLib.addLot(repo, 'Lot verify OK', null, 'sonnet', null, 'true');
  backlogLib.startLot(repo, lotOk.id);
  const rCloseOk = runNode(path.join(PKG, 'scripts', 'close-batch.js'), ['--cwd', repo]);
  ok(rCloseOk.code === 0, 'close-batch : exit 0 même avec verify posée');
  ok(/Verify \(`true`\) : OK/.test(rCloseOk.out), 'close-batch : verify réussie → OK');
  backlogLib.doneLot(repo, lotOk.id);

  // V7. close-batch : verify en échec → ligne "ÉCHEC", refus doux, toujours exit 0
  const lotFail = backlogLib.addLot(repo, 'Lot verify KO', null, 'sonnet', null, 'exit 1');
  backlogLib.startLot(repo, lotFail.id);
  const rCloseFail = runNode(path.join(PKG, 'scripts', 'close-batch.js'), ['--cwd', repo]);
  ok(rCloseFail.code === 0, 'close-batch : exit 0 même si verify échoue (jamais bloquant)');
  ok(/Verify \(`exit 1`\) : ÉCHEC — refus doux/.test(rCloseFail.out), 'close-batch : verify en échec → ÉCHEC, refus doux');
  backlogLib.dropLot(repo, lotFail.id);

  // V8. close-batch : pas de verify posée → pas de ligne Verify, comportement inchangé
  const lotNone = backlogLib.addLot(repo, 'Lot sans verify posee', null, 'sonnet');
  backlogLib.startLot(repo, lotNone.id);
  const rCloseNone = runNode(path.join(PKG, 'scripts', 'close-batch.js'), ['--cwd', repo]);
  ok(!/Verify \(/.test(rCloseNone.out), 'close-batch : sans verify posée, aucune ligne Verify');
  backlogLib.dropLot(repo, lotNone.id);

  // V9. doneLot(occupancy) : closed_occupancy figé, réaffiché par show
  const lotOcc = backlogLib.addLot(repo, 'Lot occupancy', null, 'sonnet');
  backlogLib.startLot(repo, lotOcc.id);
  const closedOcc = backlogLib.doneLot(repo, lotOcc.id, null, null, 's-occ', 123456);
  ok(closedOcc.closed_occupancy === 123456, 'doneLot(occupancy) : closed_occupancy persisté');
  const rShowOcc = runNode(BKLG, ['show', '--cwd', repo]);
  ok(/occupation à la clôture : 123456/.test(rShowOcc.out), 'show : closed_occupancy réaffiché');

  // V10. doneLot sans occupancy (clôture manuelle CLI) : closed_occupancy reste null
  const lotNoOcc = backlogLib.addLot(repo, 'Lot sans occupancy', null, 'sonnet');
  backlogLib.startLot(repo, lotNoOcc.id);
  const closedNoOcc = backlogLib.doneLot(repo, lotNoOcc.id);
  ok(closedNoOcc.closed_occupancy === null, 'doneLot sans occupancy : closed_occupancy = null');

  // V11. lot legacy sans verify/closed_occupancy : chargé sans crash
  fs.writeFileSync(path.join(repo, '.vibe-agent', 'backlog.json'), JSON.stringify({
    version: 1, next_id: 2, lots: [{ id: 1, title: 'Legacy', status: 'done', closed_commit: 'abc' }],
  }));
  b = backlogLib.loadBacklog(repo);
  ok(b.lots[0].verify === null && b.lots[0].closed_occupancy === null,
    'legacy : verify/closed_occupancy absents → null, pas de crash');
}

// ============================ O. CAPTURE TODOWRITE ============================
section('TodoWrite — snapshot passif (.vibe-agent/todo-snapshot.json)');
{
  const repo = path.join(SANDBOX, 'repo-todos');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const snap = path.join(repo, '.vibe-agent', 'todo-snapshot.json');

  // O1. capture : contenu + statut, activeForm jeté
  runHook('post-tool-use.js', { tool_name: 'TodoWrite', cwd: repo, session_id: 's-td1',
    tool_input: { todos: [
      { content: 'faire A', status: 'in_progress', activeForm: 'Faisant A' },
      { content: 'faire B', status: 'pending', activeForm: 'Faisant B' },
    ] } });
  ok(fs.existsSync(snap), 'TodoWrite → snapshot créé');
  let j = JSON.parse(fs.readFileSync(snap, 'utf8'));
  ok(j.todos.length === 2 && j.todos[0].content === 'faire A' && j.todos[0].status === 'in_progress',
    'snapshot : contenu et statut capturés');
  ok(!('activeForm' in j.todos[0]) && j.session_id === 's-td1', 'snapshot : activeForm jeté, session posée');

  // O2. écrasement intégral à chaque appel (liste complète transmise par l'outil)
  runHook('post-tool-use.js', { tool_name: 'TodoWrite', cwd: repo, session_id: 's-td1',
    tool_input: { todos: [{ content: 'faire C', status: 'completed' }] } });
  j = JSON.parse(fs.readFileSync(snap, 'utf8'));
  ok(j.todos.length === 1 && j.todos[0].content === 'faire C', 'snapshot : écrasé intégralement à chaque appel');

  // O3. caps 30 items / 120 chars
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ content: 'i'.repeat(300), status: 'pending' });
  runHook('post-tool-use.js', { tool_name: 'TodoWrite', cwd: repo, tool_input: { todos: many } });
  j = JSON.parse(fs.readFileSync(snap, 'utf8'));
  ok(j.todos.length === 30 && j.todos[0].content.length <= 120, 'snapshot : caps 30 items / 120 chars');

  // O4. todos malformés → exit 0, snapshot intact
  const before = fs.readFileSync(snap, 'utf8');
  ok(runHook('post-tool-use.js', { tool_name: 'TodoWrite', cwd: repo, tool_input: { todos: 'nimporte' } }).code === 0,
    'todos malformés → exit 0');
  ok(fs.readFileSync(snap, 'utf8') === before, 'todos malformés → snapshot intact');

  // O5. hors git → rien créé
  const dirNo = path.join(SANDBOX, 'todos-nogit');
  fs.mkdirSync(dirNo, { recursive: true });
  runHook('post-tool-use.js', { tool_name: 'TodoWrite', cwd: dirNo, tool_input: { todos: [{ content: 'x', status: 'pending' }] } });
  ok(!fs.existsSync(path.join(dirNo, '.vibe-agent')), 'TodoWrite hors git → rien créé');

  // O6. lecteur (consommé par le handoff au lot A3)
  const r = backlogLib.readTodoSnapshot(repo);
  ok(!!r && Array.isArray(r.todos) && r.todos.length === 30, 'readTodoSnapshot : dernier état lu');
}

// ============================ P. SUIVI PASSIF DU BACKLOG ============================
section('Backlog — auto-clôture au Stop, handoff enrichi, titre de session');
{
  const repo = path.join(SANDBOX, 'repo-backlog-flow');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const empty = path.join(SANDBOX, 'empty.jsonl');
  const sid = 'sess-bf1';
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Premier périmètre', '--scope', 'fait quand : X vert', '--model', 'sonnet']);
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Deuxième périmètre', '--model', 'opus']);
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Troisième périmètre', '--model', 'sonnet']);
  runNode(BKLG, ['start', '--cwd', repo, '--id', '1']);
  const trgBf = trigram.deriveTrigram(repo);

  // P1. titre de session = focus du lot en cours (1er touch : pas de « (partie N) »)
  ok(lot.suggestedTitle(repo) === `[${trgBf} · #1] Session Libre · Premier périmètre`, 'suggestedTitle : titre = focus du lot en cours (sans epic -> Session Libre)');

  // P2. lot ouvert → rappel de clôture (comportement existant intact)
  fs.writeFileSync(path.join(repo, 'w.txt'), 'x');
  const r1 = runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empty });
  ok(/close-batch/.test(r1.out), 'lot ouvert : rappel de clôture inchangé');

  // P3. handoff auto enrichi : plan de lots + todos
  runHook('post-tool-use.js', { tool_name: 'TodoWrite', cwd: repo, session_id: sid,
    tool_input: { todos: [
      { content: 'étape en cours', status: 'in_progress' },
      { content: 'étape suivante', status: 'pending' },
    ] } });
  runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empty });
  const hf = fs.readFileSync(path.join(repo, '.vibe-agent', 'handoff.md'), 'utf8');
  ok(/Plan de lots : 0\/3 faits/.test(hf) && /#1/.test(hf), 'handoff : bloc plan de lots');
  ok(/Tâches en cours \(TodoWrite/.test(hf) && /étape en cours/.test(hf), 'handoff : bloc todos (in_progress d\'abord)');

  // P4. commit → auto-clôture du cas univoque + message n/y, sans promotion auto
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'lot 1 fini']);
  const r2 = runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empty });
  let msg = '';
  try { msg = JSON.parse(r2.out).systemMessage || ''; } catch (_) {}
  ok(/Lot « Premier périmètre » clos \(1\/3\)/.test(msg), 'auto-clôture : message « clos (n/y) »');
  ok(/Suivant : « Deuxième périmètre »/.test(msg), 'auto-clôture : lot suivant annoncé');
  const b1 = backlogLib.loadBacklog(repo);
  const done1 = b1.lots.find((l) => l.id === 1);
  ok(done1.status === 'done' && !!done1.closed_commit && Number.isFinite(done1.lot_number),
    'auto-clôture : done + commit + lot_number posés');
  ok(backlogLib.currentLot(b1) === null, 'auto-clôture : pas de promotion automatique du suivant');
  ok(lot.suggestedTitle(repo) === `[${trgBf} · #1] Session Libre · Premier périmètre`,
    'suggestedTitle après clôture : titre = dernier lot CLOS (pas « Deuxième périmètre », le suivant à faire)');

  // P5. handoff après clôture : avancement à jour
  runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empty });
  const hf2 = fs.readFileSync(path.join(repo, '.vibe-agent', 'handoff.md'), 'utf8');
  ok(/1\/3 faits/.test(hf2) && /Suivants : #2/.test(hf2), 'handoff : avancement mis à jour après clôture');

  // P6. cas ambigu (deux in_progress forgés) → aucune clôture auto, backlog intact
  const forged = backlogLib.loadBacklog(repo);
  forged.lots.find((l) => l.id === 2).status = 'in_progress';
  forged.lots.find((l) => l.id === 3).status = 'in_progress';
  backlogLib.saveBacklog(repo, forged);
  fs.writeFileSync(path.join(repo, 'w.txt'), 'y');
  runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empty });
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'commit ambigu']);
  const r3 = runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empty });
  let msg3 = '';
  try { msg3 = JSON.parse(r3.out).systemMessage || ''; } catch (_) {}
  ok(!/clos \(/.test(msg3), 'ambigu : aucun message de clôture');
  const b2 = backlogLib.loadBacklog(repo);
  ok(b2.lots.filter((l) => l.status === 'done').length === 1, 'ambigu : backlog non touché (un seul done)');
}

// ============================ P1bis. LE NUMÉRO DU TITRE SUIT L'ID BACKLOG, PAS lot-counter =====
section('suggestedTitle : le numéro affiché suit l\'ID backlog même si lot-counter a dérivé');
{
  // lot-counter.json avance à chaque transition working-tree sale -> propre (y compris
  // des commits de bookkeeping de clôture backlog qui n'ajoutent aucun lot) : il peut
  // donc être très en avance sur l'ID backlog réel. Le titre doit rester fidèle à l'ID
  // backlog (le référentiel que l'utilisateur voit dans `backlog.js show`), jamais au
  // compteur interne.
  const repo = path.join(SANDBOX, 'repo-lotnum-driftguard');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Huitième périmètre', '--model', 'sonnet']);
  runNode(BKLG, ['start', '--cwd', repo, '--id', '1']);
  // Simule la dérive : plusieurs commits de bookkeeping ont fait avancer lot-counter
  // bien au-delà de l'ID backlog (ici #1).
  lot.incrementLot(repo);
  lot.incrementLot(repo);
  lot.incrementLot(repo);
  lot.incrementLot(repo);
  ok(lot.getLotCounter(repo) === 4, 'précondition : lot-counter a dérivé à 4 (≠ ID backlog 1)');
  const trgDrift = trigram.deriveTrigram(repo);
  ok(lot.suggestedTitle(repo) === `[${trgDrift} · #1] Session Libre · Huitième périmètre`,
    'lot en cours : titre = focus du lot backlog, jamais lié au compteur lot-counter dérivé');

  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Neuvième périmètre', '--model', 'sonnet']);
  runNode(BKLG, ['done', '--cwd', repo, '--id', '1']);
  runNode(BKLG, ['start', '--cwd', repo, '--id', '2']);
  ok(lot.suggestedTitle(repo) === `[${trgDrift} · #2] Session Libre · Neuvième périmètre`,
    'lot suivant démarré : titre passe au focus du nouveau lot, indépendamment du compteur');
}

// ==================== P1ter. lot_number SALE NE FIGE PLUS LA SÉLECTION DU DERNIER LOT CLOS ====
section('suggestedTitle : lot_number null/recyclé ne fige plus la sélection sur un vieil id');
{
  // Reproduit le profil observé sur un projet réel (japlan-app) : le plus grand lot_number
  // (7) est porté par un VIEUX lot, les lots plus récents ont un lot_number null ou recyclé
  // (héritage d'anciennes clôtures legacy). Avant le fix, lastDoneLot triait par lot_number
  // décroissant et retombait donc éternellement sur ce vieux lot 7 — « toujours Lot 7 » en
  // renommage de session. Après le fix : tri par **id** décroissant (monotone, jamais recyclé
  // ni sale, contrairement à lot_number ET closed_at) → id 4.
  const repo = path.join(SANDBOX, 'repo-lastdone-lotnum-corrupt');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  for (const t of ['Settings scindes', 'CRUD voyage', 'Etapes du trajet', 'Conformite Liquid Glass']) {
    runNode(BKLG, ['add', '--cwd', repo, '--title', t, '--model', 'sonnet']);
  }
  const b = backlogLib.loadBacklog(repo);
  const byId = (id) => b.lots.find((l) => l.id === id);
  [[1, 7, '2026-07-01T10:00:00Z'], [2, null, '2026-07-02T10:00:00Z'],
    [3, 4, '2026-07-03T10:00:00Z'], [4, 5, '2026-07-04T10:00:00Z']].forEach(([id, ln, at]) => {
    const l = byId(id);
    l.status = 'done'; l.closed_at = at; l.lot_number = ln; l.closed_commit = 'deadbee';
  });
  backlogLib.saveBacklog(repo, b);
  const trgLdn = trigram.deriveTrigram(repo);
  ok(lot.suggestedTitle(repo) === `[${trgLdn} · #4] Session Libre · Conformite Liquid Glass`,
    'lastDoneLot : dernier clos = closed_at le plus récent (id 4), PAS le plus grand lot_number (id 1)');

  // Clôtures legacy sans closed_at exploitable : l'id monotone tranche, jamais lot_number.
  const b2 = backlogLib.loadBacklog(repo);
  b2.lots.forEach((l) => { l.closed_at = null; });
  backlogLib.saveBacklog(repo, b2);
  ok(lot.suggestedTitle(repo) === `[${trgLdn} · #4] Session Libre · Conformite Liquid Glass`,
    'lastDoneLot : sans closed_at, le plus grand id tranche (pas le lot_number recyclé)');
}

// == P1quater. ATTRIBUTION PAR SESSION : 3 sessions → 3 titres distincts (bug japlan #34 figé) ==
section('suggestedTitle : chaque session est titrée par LE lot qu\'elle a clos (attribution closed_session_id)');
{
  // Reproduit le bug observé sur japlan-app : 3 sessions successives nommées EXACTEMENT
  // pareil (« #34 Quick wins »). Cause : lastDoneLot triait par closed_at (horodatage sale,
  // clôtures dans le désordre) et renvoyait toujours le même vieux lot, sans distinguer ce
  // que CHAQUE session avait clos. Fix : attribution par closed_session_id.
  const repo = path.join(SANDBOX, 'repo-attrib-3sessions');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'règles');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const empty = path.join(SANDBOX, 'empty.jsonl');
  const trg = trigram.deriveTrigram(repo);

  // 3 lots, chacun clos par une session distincte. On plante des closed_at DANS LE DÉSORDRE
  // (lot #1 le plus récent) pour prouver que l'attribution ne dépend PAS de closed_at.
  for (const t of ['Lot un', 'Lot deux', 'Lot trois']) {
    runNode(BKLG, ['add', '--cwd', repo, '--title', t, '--model', 'sonnet']);
  }
  const closeBy = (id, sid) => {
    runNode(BKLG, ['start', '--cwd', repo, '--id', String(id)]);
    const b = backlogLib.loadBacklog(repo);
    const l = b.lots.find((x) => x.id === id);
    l.status = 'done'; l.closed_session_id = sid;
    l.closed_at = id === 1 ? '2026-07-12T23:59:00.000Z' : '2026-07-12T20:0' + id + ':00.000Z';
    backlogLib.saveBacklog(repo, b);
  };
  closeBy(1, 'sess-1'); closeBy(2, 'sess-2'); closeBy(3, 'sess-3');

  // Session précédente = sess-1 → titre du lot #1 (pas le repli, pas le closed_at max).
  const stEach = require(path.join(PKG, 'lib', 'state'));
  const setPrev = (sid) => stEach.saveSessionState(repo, Object.assign(stEach.loadSessionState(repo, null), { session_id: sid }));
  setPrev('sess-1');
  const t1 = lot.suggestedTitle(repo);
  setPrev('sess-2');
  const t2 = lot.suggestedTitle(repo);
  setPrev('sess-3');
  const t3 = lot.suggestedTitle(repo);
  // #1 a le closed_at MAX (23:59) et l'id le plus PETIT : l'attribution le sélectionne pour
  // sess-1 sans dépendre ni du closed_at max, ni du repli id-desc (qui donnerait #3).
  ok(t1 === `[${trg} · #1] Session Libre · Lot un`, 'sess-1 → lot #1 (attribution, indépendante de closed_at/id)');
  ok(t2 === `[${trg} · #2] Session Libre · Lot deux`, 'sess-2 → titre du lot #2 clos par sess-2');
  ok(t3 === `[${trg} · #3] Session Libre · Lot trois`, 'sess-3 → titre du lot #3 clos par sess-3');
  ok(t1 !== t2 && t2 !== t3, '3 sessions successives → 3 titres DISTINCTS (plus de titre figé)');
}

// ============================ P2. TITRE DE SESSION QUAND TOUT LE PLAN EST FAIT ============================
section('suggestedTitle : plan entièrement clos (aucun in_progress ni todo)');
{
  const repo = path.join(SANDBOX, 'repo-backlog-alldone');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Correctifs socle', '--model', 'sonnet']);
  runNode(BKLG, ['start', '--cwd', repo, '--id', '1']);
  runNode(BKLG, ['done', '--cwd', repo, '--id', '1']);
  const b = backlogLib.loadBacklog(repo);
  ok(backlogLib.currentLot(b) === null && backlogLib.nextLot(b) === null,
    'plan sans lot in_progress/todo (précondition du test)');
  ok(lot.suggestedTitle(repo) === `[${trigram.deriveTrigram(repo)} · #1] Session Libre · Correctifs socle`,
    'suggestedTitle : titre = dernier lot clos même sans lot en cours/à faire (avant le fix : titre nu)');
}

// ============================ P3. suggestedTitle NE MENT PAS SUR LA SESSION PRÉCÉDENTE ============================
section('suggestedTitle : un lot clos par une session plus ancienne ne doit pas être attribué à la précédente');
{
  const repo = path.join(SANDBOX, 'repo-backlog-sessionmismatch');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'règles'); // + ledger -> isFullyInitialized
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const empty = path.join(SANDBOX, 'empty.jsonl');

  // Session A : ouvre puis clôt le lot #1 (auto-clôture au Stop, sid tracé).
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Travail session A', '--model', 'sonnet']);
  runNode(BKLG, ['start', '--cwd', repo, '--id', '1']);
  fs.writeFileSync(path.join(repo, 'w.txt'), 'x');
  runHook('stop.js', { session_id: 'sess-A', cwd: repo, transcript_path: empty }); // arme closure_reminded_for_batch
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'lot 1 fini']);
  runHook('stop.js', { session_id: 'sess-A', cwd: repo, transcript_path: empty }); // auto-clôture, closed_session_id = sess-A

  const bA = backlogLib.loadBacklog(repo);
  ok(bA.lots.find((l) => l.id === 1).closed_session_id === 'sess-A',
    'doneLot (auto-clôture) : closed_session_id posé au sid de la session qui clôt');
  const trgMismatch = trigram.deriveTrigram(repo);
  ok(lot.suggestedTitle(repo) === `[${trgMismatch} · #1] Session Libre · Travail session A`,
    'juste après clôture par sess-A : titre visible (session précédente = sess-A, ça matche)');

  // Session B (no-op, ne clôt rien) démarre : session-start.js estampille son propre id
  // dans session-state.json AVANT que la session C ne démarre.
  runHook('session-start.js', { source: 'startup', session_id: 'sess-B', cwd: repo, transcript_path: empty });

  // "Session C" (ce test) : la session précédente est désormais sess-B, qui n'a rien
  // clos -> le lot fermé par sess-A ne doit plus être suggéré (clôture plus ancienne).
  ok(lot.suggestedTitle(repo) !== `[${trgMismatch} · #1] Session Libre · Travail session A`,
    'après une session B sans activité de lot : le lot de sess-A n\'est plus suggéré (mismatch détecté)');
  ok(lot.suggestedTitle(repo) === `[${trgMismatch}] Session Libre`,
    'titre retombe sur la forme nue « Session Libre » plutôt que de mentir sur ce qui vient de se passer');
}

// ============================ P4. suggestedTitle DÉDUIT UN TITRE SANS PLAN DE LOTS ============================
section('suggestedTitle : déduction depuis CHANGELOG/git quand le plan n\'a aucun titre à offrir');
{
  // Pas de backlog du tout + CHANGELOG.md avec un résumé descriptif en parenthèse
  // finale du dernier titre « ## » -> déduit comme intitulé de session.
  const repo = path.join(SANDBOX, 'repo-deduce-changelog');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'),
    '# Changelog\n\n## 2026-07-11 (chore — /pmz/ ignoré)\n\ntexte\n\n## 2026-07-10 (ancien)\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  ok(/^\[.{3}\] Session Libre · chore — \/pmz\/ ignoré$/.test(lot.suggestedTitle(repo)),
    'pas de backlog : « Session Libre » + résumé déduit du dernier CHANGELOG');
}
{
  // CHANGELOG présent mais parenthèse = simple marqueur « (lot N) », pas descriptif
  // -> ignoré, on retombe sur le sujet du dernier commit.
  const repo = path.join(SANDBOX, 'repo-deduce-git');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '## 2026-07-11 (lot 3)\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'fix: corrige le calcul du quota']);
  ok(/^\[.{3}\] Session Libre · fix: corrige le calcul du quota$/.test(lot.suggestedTitle(repo)),
    '« (lot N) » écarté (non descriptif) : résumé déduit du sujet du dernier commit');
}
{
  // Ni CHANGELOG ni commit exploitable -> titre nu (comportement inchangé, non-régression).
  const repo = path.join(SANDBOX, 'repo-deduce-none');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  ok(lot.suggestedTitle(repo) === `[${trigram.deriveTrigram(repo)}] Session Libre`,
    'aucune info disponible : « Session Libre » nu (pas de déduction possible)');
}
{
  // Backlog.json présent mais lots vides ([]) -> même déduction que backlog absent.
  const repo = path.join(SANDBOX, 'repo-deduce-emptybacklog');
  fs.mkdirSync(path.join(repo, '.vibe-agent'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, '.vibe-agent', 'backlog.json'),
    JSON.stringify({ version: 1, next_id: 1, lots: [] }));
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'chore: mise en place du socle']);
  ok(/^\[.{3}\] Session Libre · chore: mise en place du socle$/.test(lot.suggestedTitle(repo)),
    'backlog.json avec lots:[] traité comme « pas de titre dans le plan » -> déduction');
}
{
  // Backlog non vide mais rien d'exploitable pour CETTE session (lot clos périmé,
  // rien à faire ensuite) : la déduction NE DOIT PAS s'appliquer (un titre existe dans
  // le plan, il est juste tu à raison — cf. P3) même si CHANGELOG/git offrent un texte.
  const repo = path.join(SANDBOX, 'repo-deduce-notstale-skip');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'règles');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const empty = path.join(SANDBOX, 'empty.jsonl');
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Travail session A', '--model', 'sonnet']);
  runNode(BKLG, ['start', '--cwd', repo, '--id', '1']);
  fs.writeFileSync(path.join(repo, 'w.txt'), 'x');
  runHook('stop.js', { session_id: 'sess-A2', cwd: repo, transcript_path: empty });
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'fix: ceci ne doit PAS apparaître dans le titre']);
  runHook('stop.js', { session_id: 'sess-A2', cwd: repo, transcript_path: empty });
  runHook('session-start.js', { source: 'startup', session_id: 'sess-B2', cwd: repo, transcript_path: empty });
  const t = lot.suggestedTitle(repo);
  ok(!/ceci ne doit PAS apparaître/.test(t) && !/Travail session A$/.test(t),
    'lot clos périmé sans lot suivant : pas de repli sur git/CHANGELOG (ça mentirait)');
}

// ============================ Q. CONTINUITÉ — PRECOMPACT & SESSIONSTART ============================
section('Continuité — PreCompact sauve le handoff, compact réinjecte le lot, fallback backlog');
{
  const repo = path.join(SANDBOX, 'repo-continuite');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'règles'); // isFullyInitialized avec le ledger
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const hf = path.join(repo, '.vibe-agent', 'handoff.md');
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot continuité', '--scope', 'fait quand : OK', '--model', 'sonnet']);
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot suivant', '--model', 'opus']);
  runNode(BKLG, ['start', '--cwd', repo, '--id', '1']);
  runHook('post-tool-use.js', { tool_name: 'TodoWrite', cwd: repo, session_id: 's-q1',
    tool_input: { todos: [
      { content: 'étape active', status: 'in_progress' },
      { content: 'étape 2', status: 'pending' },
      { content: 'étape 3', status: 'pending' },
      { content: 'étape 4', status: 'pending' },
    ] } });

  // Q1. PreCompact écrit le handoff enrichi (sans attendre un Stop)
  ok(!fs.existsSync(hf), 'avant PreCompact : pas de handoff');
  const rPc = runHook('pre-compact.js', { cwd: repo, session_id: 's-q1' });
  ok(rPc.code === 0 && fs.existsSync(hf), 'PreCompact → handoff écrit');
  const c = fs.readFileSync(hf, 'utf8');
  ok(/Plan de lots : 0\/2 faits/.test(c) && /étape active/.test(c), 'PreCompact : handoff porte plan + todos');

  // Q2. PreCompact ne touche jamais un handoff manuel non consommé
  fs.writeFileSync(hf, handoff.MANUAL_MARKER + '\nRICHE-Q');
  runHook('pre-compact.js', { cwd: repo, session_id: 's-q1' });
  ok(/RICHE-Q/.test(fs.readFileSync(hf, 'utf8')), 'PreCompact : handoff manuel préservé');
  fs.unlinkSync(hf);

  // Q2b. PreCompact MANUEL (/compact) : rappel chiffré VISIBLE (systemMessage), non bloquant.
  const rPcM = runHook('pre-compact.js', { cwd: repo, session_id: 's-q1', trigger: 'manual' });
  let sysM = '';
  try { sysM = JSON.parse(rPcM.out).systemMessage || ''; } catch (_) {}
  ok(rPcM.code === 0 && /Compaction manuelle/.test(sysM) && /\/fresh-session/.test(sysM),
    'PreCompact manuel → systemMessage chiffré vers fresh-session, exit 0');
  // Q2c. PreCompact AUTO : pas de nudge (compaction subie).
  const rPcA = runHook('pre-compact.js', { cwd: repo, session_id: 's-q1', trigger: 'auto' });
  ok(rPcA.code === 0 && !/Compaction manuelle/.test(rPcA.out || ''), 'PreCompact auto : aucun nudge');
  fs.existsSync(hf) && fs.unlinkSync(hf);

  // Q3. SessionStart compact : réinjection minimale du lot en cours (≤ 300 chars)
  const rC = runHook('session-start.js', { source: 'compact', cwd: repo, session_id: 's-q2' });
  let ctxC = '';
  try { ctxC = JSON.parse(rC.out).hookSpecificOutput.additionalContext || ''; } catch (_) {}
  ok(/Après compaction/.test(ctxC) && /Lot continuité/.test(ctxC) && /1\/2|0\/2/.test(ctxC),
    'compact : lot en cours réinjecté');
  ok(/étape active/.test(ctxC) && ctxC.length <= 300, 'compact : todos inclus, cap 300 chars');
  ok(!/Promptimizer actif/.test(ctxC) && !/Titre de session/.test(ctxC) && !/handoff/i.test(ctxC),
    'compact : ni MSG_ACTIF, ni titre, ni handoff (minimal)');

  // Q4. compact sans lot en cours → rien
  runNode(BKLG, ['done', '--cwd', repo, '--id', '1']);
  const rC2 = runHook('session-start.js', { source: 'compact', cwd: repo, session_id: 's-q3' });
  ok(rC2.code === 0 && !(rC2.out || '').trim(), 'compact sans in_progress → aucune injection');

  // Q5. fallback startup sans handoff : le plan de lots sert de filet
  const rS = runHook('session-start.js', { source: 'startup', cwd: repo, session_id: 's-q4' });
  let ctxS = '';
  try { ctxS = JSON.parse(rS.out).hookSpecificOutput.additionalContext || ''; } catch (_) {}
  ok(/Plan de lots : 1\/2 faits/.test(ctxS) && /Prochain lot : « Lot suivant »/.test(ctxS),
    'fallback : plan injecté quand aucun handoff (prochain lot + start --id)');

  // Q6. compact hors repo git → passThrough
  const dirNo = path.join(SANDBOX, 'continuite-nogit');
  fs.mkdirSync(dirNo, { recursive: true });
  const rNo = runHook('session-start.js', { source: 'compact', cwd: dirNo, session_id: 's-q5' });
  ok(rNo.code === 0 && !(rNo.out || '').trim(), 'compact hors git → passThrough');

  // Q7. source=clear : le handoff EST injecté (preuve du correctif de matcher du lot A0 —
  // le hook gérait clear mais n'était jamais déclenché dessus).
  const empty = path.join(SANDBOX, 'empty.jsonl');
  runHook('stop.js', { session_id: 's-q6', cwd: repo, transcript_path: empty }); // réécrit le handoff auto
  const rClear = runHook('session-start.js', { source: 'clear', cwd: repo, session_id: 's-q7' });
  let ctxClear = '';
  try { ctxClear = JSON.parse(rClear.out).hookSpecificOutput.additionalContext || ''; } catch (_) {}
  ok(/Handoff de la session précédente/.test(ctxClear) && /Plan de lots/.test(ctxClear),
    'clear : handoff (plan compris) réinjecté après /clear');
}

// ============================ R. COUCHE EXPLICITE ============================
section('Couche explicite — MSG_LARGE v2, audit/close-batch avec plan de lots');
{
  const repo = path.join(SANDBOX, 'repo-explicite');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

  // R1. broad sans plan → consigne de découpage persisté
  const r1 = runHook('user-prompt-submit.js', { cwd: repo, prompt: 'refactor complet du projet', session_id: 's-r1' });
  let m1 = '';
  try { m1 = JSON.parse(r1.out).hookSpecificOutput.additionalContext || ''; } catch (_) {}
  ok(/2 à 5 lots/.test(m1) && /backlog\.js add/.test(m1), 'broad sans plan : consigne de découpage persisté');

  // R2. broad avec plan → rattacher au lot en cours, pas de redécoupage
  runNode(BKLG, ['add', '--cwd', repo, '--title', 'Lot R', '--model', 'sonnet']);
  runNode(BKLG, ['start', '--cwd', repo, '--id', '1']);
  const r2 = runHook('user-prompt-submit.js', { cwd: repo, prompt: 'refactor complet du projet', session_id: 's-r2' });
  let m2 = '';
  try { m2 = JSON.parse(r2.out).hookSpecificOutput.additionalContext || ''; } catch (_) {}
  ok(/plan de lots existe déjà/.test(m2) && /Lot R/.test(m2), 'broad avec plan : rattachement au lot en cours');

  // R3. audit-batch --json expose le plan (null-safe)
  let jA = {};
  try { jA = JSON.parse(runNode(AUDIT, ['--cwd', repo, '--json']).out); } catch (_) {}
  ok(!!jA.backlog && jA.backlog.total === 1 && jA.backlog.current && jA.backlog.current.id === 1,
    'audit-batch : bloc backlog exposé');

  // R4. close-batch : bloc plan + étape done --id pré-remplie
  const CLOSE = path.join(PKG, 'scripts', 'close-batch.js');
  const rC = runNode(CLOSE, ['--cwd', repo]);
  ok(/Plan de lots/.test(rC.out) && /done --id 1/.test(rC.out), 'close-batch : bloc plan + done --id pré-rempli');

  // R5. close-batch sans plan : sortie historique inchangée
  const repo2 = path.join(SANDBOX, 'repo-explicite-vide');
  fs.mkdirSync(repo2, { recursive: true });
  execFileSync('git', ['init', '-q', repo2]);
  fs.writeFileSync(path.join(repo2, 'a.txt'), '1');
  execFileSync('git', ['-C', repo2, 'add', '.']);
  execFileSync('git', ['-C', repo2, 'commit', '-q', '-m', 'init']);
  const rC2 = runNode(CLOSE, ['--cwd', repo2]);
  ok(!/Plan de lots/.test(rC2.out) && /Clôture du lot/.test(rC2.out), 'close-batch sans plan : sortie historique');
}

// ============================ S. COÛT PAR FICHIER + GASPILLAGE RÉEL (B1) ============================
section('Coût par fichier — gaspillage réel (relecture complète d\'un fichier inchangé)');
const AUDIT_CTX = path.join(PKG, 'scripts', 'audit-context.js');
{
  const repo = path.join(SANDBOX, 'repo-waste');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const big = path.join(repo, 'big.js');
  fs.writeFileSync(big, 'x'.repeat(4000)); // 4000 octets → est_tokens ≈ 1000
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

  const readBig = (extra) => runHook('post-tool-use.js', {
    tool_name: 'Read', tool_input: Object.assign({ file_path: big }, extra || {}), cwd: repo,
  });
  const ctxLedger = () => JSON.parse(fs.readFileSync(path.join(repo, '.vibe-agent', 'context-ledger.json'), 'utf8'));

  readBig(); // 1re lecture : coût justifié, aucun gaspillage
  ok((ctxLedger().estimated_context_waste || 0) === 0, 'B1 : 1re lecture complète → aucun gaspillage');

  readBig(); // 2e lecture complète, fichier inchangé → gaspillage
  readBig(); // 3e idem
  const cl1 = ctxLedger();
  ok(cl1.estimated_context_waste === 2000, 'B1 : 2 relectures complètes inchangées → waste = 2000 (2×1000)');
  const wasteKeys = Object.entries(cl1.waste_by_file || {}).filter(([k]) => /big\.js$/.test(k));
  ok(wasteKeys.length === 1 && wasteKeys[0][1] === 2000, 'B1 : waste_by_file ventilé par fichier (2000 sur big.js)');

  readBig({ offset: 1 }); // relecture PARTIELLE → coût justifié, pas de gaspillage
  ok(ctxLedger().estimated_context_waste === 2000, 'B1 : relecture partielle → pas de gaspillage ajouté');

  // Fichier MODIFIÉ entre deux lectures : mtime différent → relecture justifiée.
  const future = new Date(Date.now() + 60000);
  fs.writeFileSync(big, 'y'.repeat(4000));
  fs.utimesSync(big, future, future);
  readBig();
  ok(ctxLedger().estimated_context_waste === 2000, 'B1 : fichier modifié (mtime≠) → pas de gaspillage');

  // audit-context.js affiche le gaspillage trié par coût.
  const audit = runNode(AUDIT_CTX, ['--cwd', repo]);
  ok(/Gaspillage estimé/.test(audit.out), 'B1 : audit affiche la section « Gaspillage estimé »');
  ok(/≈ 2\.0k tokens sur 1 fichier/.test(audit.out), 'B1 : audit affiche le total ≈ 2.0k sur 1 fichier');
  ok(/big\.js ≈ 2\.0k/.test(audit.out), 'B1 : audit liste big.js avec son coût');

  // Projet sans gaspillage : mention « aucun détecté ».
  const repoClean = path.join(SANDBOX, 'repo-waste-clean');
  fs.mkdirSync(repoClean, { recursive: true });
  execFileSync('git', ['init', '-q', repoClean]);
  fs.writeFileSync(path.join(repoClean, 'a.txt'), 'a');
  execFileSync('git', ['-C', repoClean, 'add', '.']);
  execFileSync('git', ['-C', repoClean, 'commit', '-q', '-m', 'init']);
  runHook('post-tool-use.js', { tool_name: 'Read', tool_input: { file_path: path.join(repoClean, 'a.txt') }, cwd: repoClean });
  const auditClean = runNode(AUDIT_CTX, ['--cwd', repoClean]);
  ok(/Gaspillage estimé :\n- \(aucun détecté\)/.test(auditClean.out), 'B1 : sans gaspillage → « aucun détecté »');
}

// ============================ B3. STATUT CHIFFRÉ EN TOKENS RÉELS ============================
section('Statut d\'économie chiffré en tokens réels (occupation + fallback annoncé)');
{
  const ledger = require(path.join(PKG, 'lib', 'ledger'));
  // Repo initialisé (un Read via le hook bootstrappe .vibe-agent), puis on pose une
  // occupation token via le miroir que le hook Stop écrit normalement (recordOccupancy).
  const mkRepo = (name) => {
    const repo = path.join(SANDBOX, name);
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
    runHook('post-tool-use.js', { tool_name: 'Read', tool_input: { file_path: path.join(repo, 'a.txt') }, cwd: repo });
    return repo;
  };
  const statutLine = (out) => (out.match(/^Statut : .*/m) || [''])[0];

  // Vert : occupation sous le palier orange (300k).
  const rVert = mkRepo('repo-b3-vert');
  ledger.recordOccupancy(rVert, { occ: 100000, delta: 5000, sessionId: 'b3-v' });
  const aVert = runNode(AUDIT_CTX, ['--cwd', rVert]);
  ok(/^Statut : vert /.test(statutLine(aVert.out)), 'B3 : occ 100k → statut vert');
  ok(/≈ 100\.0k tokens de contexte/.test(aVert.out), 'B3 : affiche l\'occupation token réelle');
  ok(/dernier tour \+5\.0k/.test(aVert.out), 'B3 : affiche le delta du dernier tour');

  // Orange : occupation dans [300k, 500k).
  const rOrange = mkRepo('repo-b3-orange');
  ledger.recordOccupancy(rOrange, { occ: 350000, delta: 0, sessionId: 'b3-o' });
  const aOrange = runNode(AUDIT_CTX, ['--cwd', rOrange]);
  ok(/^Statut : orange /.test(statutLine(aOrange.out)), 'B3 : occ 350k → statut orange');

  // Rouge : occupation ≥ 500k.
  const rRouge = mkRepo('repo-b3-rouge');
  ledger.recordOccupancy(rRouge, { occ: 600000, delta: 90000, sessionId: 'b3-r' });
  const aRouge = runNode(AUDIT_CTX, ['--cwd', rRouge]);
  ok(/^Statut : rouge /.test(statutLine(aRouge.out)), 'B3 : occ 600k → statut rouge');

  // Fallback annoncé : aucune occupation token (jamais passé par un Stop) → comptage relectures.
  const rFallback = mkRepo('repo-b3-fallback');
  const aFallback = runNode(AUDIT_CTX, ['--cwd', rFallback]);
  ok(/données tokens absentes/.test(aFallback.out), 'B3 : sans occupation token → fallback annoncé explicitement');
  ok(!/tokens de contexte/.test(aFallback.out), 'B3 : fallback n\'affiche aucun chiffre tokens fantôme');
}

// ============================ B2. MÉTROLOGIE PAR TOUR ============================
section('Métrologie par tour (turnstats : delta, anti-spam, baseline, resync, busts)');
{
  const ts = require(path.join(PKG, 'lib', 'turnstats'));
  const tsPath = (n) => path.join(SANDBOX, n);
  const stop = (file, line, sid) => { fs.appendFileSync(file, line + '\n'); return ts.computeTurn(file, sid); };

  // 1) Delta sur 2 Stops consécutifs. Le 1er Stop établit la baseline (delta null),
  //    le 2e mesure le tour écoulé en ne scannant que l'offset ajouté.
  const t1 = tsPath('ts1.jsonl');
  const r1 = stop(t1, usageLine(2000, 118000, 0, 500), 'ts-A'); // occ 120k
  ok(r1 && r1.delta === null && r1.occ === 120000, 'B2 : 1er Stop = baseline (delta null, occ 120k)');
  ok(r1.alerts.costly === false && r1.busts.length === 0, 'B2 : baseline -> aucune alerte, aucun bust');
  const r2 = stop(t1, usageLine(3000, 197000, 0, 3000), 'ts-A'); // occ 200k
  ok(r2 && r2.delta === 80000 && r2.occ === 200000, 'B2 : 2e Stop = delta +80k (200k - 120k)');
  ok(r2.out === 3000 && r2.req === 1, 'B2 : out=3000, req=1 sur le seul tour écoulé');
  ok(r2.alerts.costly === true, 'B2 : delta>=50k -> tour coûteux');

  // 2) Anti-spam : 1 alerte coûteuse, puis silence 2 tours, puis réalerte au 3e.
  const t2 = tsPath('ts2.jsonl');
  stop(t2, usageLine(2000, 118000, 0, 100), 'ts-spam'); // baseline occ 120k
  const a2 = stop(t2, usageLine(2000, 178000, 0, 100), 'ts-spam'); // +60k
  const a3 = stop(t2, usageLine(2000, 238000, 0, 100), 'ts-spam'); // +60k
  const a4 = stop(t2, usageLine(2000, 298000, 0, 100), 'ts-spam'); // +60k
  const a5 = stop(t2, usageLine(2000, 358000, 0, 100), 'ts-spam'); // +60k
  ok(a2.alerts.costly === true, 'B2 anti-spam : 1er tour coûteux alerte');
  ok(a3.alerts.costly === false && a4.alerts.costly === false, 'B2 anti-spam : silence 2 tours suivants');
  ok(a5.alerts.costly === true, 'B2 anti-spam : réalerte après 3 tours');

  // 3) Baseline invalide : transcript remplacé plus court (offset > taille) -> reset.
  const t3 = tsPath('ts3.jsonl');
  fs.writeFileSync(t3, [usageLine(2000, 300000, 0, 100), usageLine(2000, 400000, 0, 100)].join('\n') + '\n');
  ts.computeTurn(t3, 'ts-trunc'); // offset = grande taille
  fs.writeFileSync(t3, usageLine(2000, 50000, 0, 100) + '\n'); // remplacé, plus court
  const r3 = ts.computeTurn(t3, 'ts-trunc');
  ok(r3 && r3.baselineReset === true && r3.delta === null, 'B2 : offset>taille -> baselineReset, delta null');
  ok(!r3.alerts.costly && !r3.alerts.intraBust && !r3.alerts.pause && r3.busts.length === 0,
    'B2 : baselineReset -> aucune alerte/bust parasite');

  // 4) Delta très négatif (compaction) -> resync du palier d'occupation, sans parasite.
  const t4 = tsPath('ts4.jsonl');
  fs.writeFileSync(t4, usageLine(2000, 398000, 0, 100) + '\n'); // occ 400k baseline
  ts.computeTurn(t4, 'ts-neg');
  fs.appendFileSync(t4, usageLine(2000, 248000, 0, 100) + '\n'); // occ 250k
  const r4 = ts.computeTurn(t4, 'ts-neg');
  ok(r4 && r4.delta === -150000 && r4.alerts.resync === true, 'B2 : delta -150k -> resync');
  ok(r4.alerts.costly === false, 'B2 : delta négatif -> pas de tour coûteux parasite');
  // resyncBucket (appelé par stop.js quand alerts.resync) réécrit le palier courant.
  occupancy.resyncBucket('ts-neg', r4.occ);
  ok(fs.readFileSync(occupancy.stateFileFor('ts-neg'), 'utf8').trim() === String(occupancy.bucketIndex(250000)),
    'B2 : resyncBucket réécrit le palier au bucket courant (250k)');

  // 5a) Cache-bust au 1er appel du tour (pause/TTL) : first=true, alerte 1×/session.
  const t5 = tsPath('ts5.jsonl');
  fs.writeFileSync(t5, usageLine(2000, 298000, 0, 100) + '\n'); // occ 300k baseline
  ts.computeTurn(t5, 'ts-pause');
  fs.appendFileSync(t5, usageLine(10000, 10000, 290000, 100) + '\n'); // read effondré au 1er appel
  const r5 = ts.computeTurn(t5, 'ts-pause');
  ok(r5.busts.length === 1 && r5.busts[0].first === true, 'B2 : bust 1er appel -> first=true (pause/TTL)');
  ok(r5.alerts.pause === true && r5.alerts.intraBust === false, 'B2 : first bust -> alerte pause, pas intra');
  fs.appendFileSync(t5, usageLine(10000, 10000, 290000, 100) + '\n');
  const r5b = ts.computeTurn(t5, 'ts-pause');
  ok(r5b.alerts.pause === false, 'B2 : pause signalée 1×/session (2e occurrence muette)');

  // 5b) Cache-bust EN PLEIN tour (2e requête) : first=false, alerte intra.
  const t6 = tsPath('ts6.jsonl');
  fs.writeFileSync(t6, usageLine(2000, 298000, 0, 100) + '\n'); // occ 300k baseline
  ts.computeTurn(t6, 'ts-intra');
  fs.appendFileSync(t6, [
    usageLine(3000, 307000, 0, 200),     // occ 310k, read fort -> pas de bust
    usageLine(5000, 20000, 295000, 200), // occ 320k, read effondré vs 310k -> bust intra
  ].join('\n') + '\n');
  const r6 = ts.computeTurn(t6, 'ts-intra');
  ok(r6.busts.length === 1 && r6.busts[0].first === false, 'B2 : bust 2e requête -> first=false (intra-tour)');
  ok(r6.alerts.intraBust === true && r6.alerts.pause === false, 'B2 : bust intra -> alerte intraBust');
}

// ============================ B4. ADVISORY INTRA-TOUR (relecture redondante) ============================
section('Advisory intra-tour (PostToolUse : relecture complète redondante, lot B4)');
{
  const advisoryText = (r) => {
    if (!r.out.trim()) return null;
    try { return JSON.parse(r.out).hookSpecificOutput.additionalContext || null; } catch (_) { return null; }
  };
  const mkRepo = (name) => {
    const repo = path.join(SANDBOX, name);
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    return repo;
  };
  const commitFile = (repo, rel, bytes) => {
    const p = path.join(repo, rel);
    fs.writeFileSync(p, 'x'.repeat(bytes));
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
    return p;
  };

  // 1-4) Plafonds 1×/fichier ET 3×/session, sur 4 fichiers distincts >= 16 Ko d'un même repo/session.
  const repo = mkRepo('repo-b4-advisory');
  const big1 = path.join(repo, 'big1.js');
  const big2 = path.join(repo, 'big2.js');
  const big3 = path.join(repo, 'big3.js');
  const big4 = path.join(repo, 'big4.js');
  [big1, big2, big3, big4].forEach((p) => fs.writeFileSync(p, 'x'.repeat(20000)));
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const readFile = (fp, sid, extra, env) => runHook('post-tool-use.js', {
    tool_name: 'Read', tool_input: Object.assign({ file_path: fp }, extra || {}), cwd: repo, session_id: sid,
  }, env);

  const r1 = readFile(big1, 'b4-s1');
  ok(advisoryText(r1) === null, 'B4 : 1re lecture → aucune advisory (rien à comparer encore)');

  const r2 = readFile(big1, 'b4-s1');
  const t2 = advisoryText(r2);
  ok(!!t2 && /big1\.js/.test(t2) && /20 Ko/.test(t2), 'B4 : relecture complète redondante → advisory nommant fichier + taille');
  ok(!/permissionDecision/.test(r2.out), 'B4 : jamais de permissionDecision sur Read (informatif uniquement)');

  ok(advisoryText(readFile(big1, 'b4-s1')) === null, 'B4 : plafond 1×/fichier → silence dès la 3e lecture du même fichier');

  readFile(big2, 'b4-s1');
  ok(/big2\.js/.test(advisoryText(readFile(big2, 'b4-s1')) || ''), 'B4 : 2e fichier distinct redondant → advisory #2 de la session');

  readFile(big3, 'b4-s1');
  ok(/big3\.js/.test(advisoryText(readFile(big3, 'b4-s1')) || ''), 'B4 : 3e fichier distinct redondant → advisory #3 (plafond session atteint)');

  readFile(big4, 'b4-s1');
  ok(advisoryText(readFile(big4, 'b4-s1')) === null, 'B4 : plafond 3×/session atteint → 4e fichier distinct redondant reste silencieux');

  // 5) Relecture PARTIELLE (offset) d'un fichier déjà lu et inchangé → pas d'advisory.
  const repoPartial = mkRepo('repo-b4-partial');
  const bigP = commitFile(repoPartial, 'big.js', 20000);
  const readPartial = (sid, extra) => runHook('post-tool-use.js', {
    tool_name: 'Read', tool_input: Object.assign({ file_path: bigP }, extra || {}), cwd: repoPartial, session_id: sid,
  });
  readPartial('b4-partial');
  ok(advisoryText(readPartial('b4-partial', { offset: 1 })) === null, 'B4 : relecture PARTIELLE (offset) → pas d\'advisory même si inchangé');

  // 6) Fichier sous le seuil de 16 Ko : jamais d'advisory même redondant.
  const repoSmall = mkRepo('repo-b4-small');
  const smallP = commitFile(repoSmall, 'small.js', 4000);
  const readSmall = (sid) => runHook('post-tool-use.js', {
    tool_name: 'Read', tool_input: { file_path: smallP }, cwd: repoSmall, session_id: sid,
  });
  readSmall('b4-small');
  ok(advisoryText(readSmall('b4-small')) === null, 'B4 : fichier < 16 Ko → jamais d\'advisory même redondant');

  // 7) Fichier marqué modifié (files_modified) entre deux lectures à mtime identique →
  //    garde-fou explicite en plus du mtime (spec : "mtime + hors files_modified").
  const repoMod = mkRepo('repo-b4-modified');
  const bigM = commitFile(repoMod, 'big.js', 20000);
  const readMod = (sid) => runHook('post-tool-use.js', {
    tool_name: 'Read', tool_input: { file_path: bigM }, cwd: repoMod, session_id: sid,
  });
  readMod('b4-mod');
  runHook('post-tool-use.js', { tool_name: 'Edit', tool_input: { file_path: bigM }, cwd: repoMod, session_id: 'b4-mod' });
  ok(advisoryText(readMod('b4-mod')) === null, 'B4 : fichier marqué modifié (files_modified) → pas d\'advisory même à mtime identique');

  // 8) Opt-out PMZ_NO_ADVISORY=1 : silence, et ne consomme pas le plafond.
  const repoOptout = mkRepo('repo-b4-optout');
  const bigO = commitFile(repoOptout, 'big.js', 20000);
  const readOptout = (sid, env) => runHook('post-tool-use.js', {
    tool_name: 'Read', tool_input: { file_path: bigO }, cwd: repoOptout, session_id: sid,
  }, env);
  readOptout('b4-optout');
  ok(advisoryText(readOptout('b4-optout', { PMZ_NO_ADVISORY: '1' })) === null, 'B4 : PMZ_NO_ADVISORY=1 → silence même si redondant');
  ok(advisoryText(readOptout('b4-optout')) !== null, 'B4 : opt-out n\'a pas consommé le plafond (advisory dispo juste après)');
}

// ============================ B5. NUDGES HAUTE OCCUPATION ============================
section('Nudges haute occupation (UserPromptSubmit >=500k, SessionStart resume >=300k, lot B5)');
{
  const ctxOf = (r) => {
    if (!r.out.trim()) return null;
    try { return JSON.parse(r.out).hookSpecificOutput.additionalContext || null; } catch (_) { return null; }
  };

  // -- UserPromptSubmit : additionalContext 2 lignes, 1x/palier (clé occ_<bucket>) --
  const repo = path.join(SANDBOX, 'repo-b5-nudge');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  project.ensureLedger(repo); // .vibe-agent présent -> anti-spam (prompt_reminders) persistant

  const promptAt = (occInput, sid) => {
    const t = writeTranscript(`b5-prompt-${sid}.jsonl`, [usageLine(occInput, 0, 0)]);
    return runHook('user-prompt-submit.js', { cwd: repo, prompt: 'question anodine', session_id: sid, transcript_path: t });
  };

  const rBelow = promptAt(400000, 'b5-below'); // < 500k
  ok(ctxOf(rBelow) === null, 'B5 : occ < 500k -> silence (UserPromptSubmit)');

  const sid = 'b5-high';
  const t1 = ctxOf(promptAt(520000, sid)); // bucket 3
  ok(!!t1 && t1.split('\n').length === 2 && /520k/.test(t1), 'B5 : occ >= 500k -> nudge additionalContext de 2 lignes');

  ok(ctxOf(promptAt(521000, sid)) === null, 'B5 : même palier, même session -> silence (anti-spam 1x/palier)');

  const t3 = ctxOf(promptAt(760000, sid)); // bucket 4 (>=750k)
  ok(!!t3 && /760k/.test(t3), 'B5 : ré-escalade au palier suivant -> nouveau nudge');

  // -- SessionStart resume : systemMessage (zéro token), jamais additionalContext --
  const repoR = path.join(SANDBOX, 'repo-b5-resume');
  fs.mkdirSync(repoR, { recursive: true });
  execFileSync('git', ['init', '-q', repoR]);
  fs.writeFileSync(path.join(repoR, 'a.txt'), '1');
  execFileSync('git', ['-C', repoR, 'add', '.']);
  execFileSync('git', ['-C', repoR, 'commit', '-q', '-m', 'init']);

  const tLowR = writeTranscript('b5-resume-low.jsonl', [usageLine(100000, 0, 0)]); // 100k < 300k
  const rLow = runHook('session-start.js', { source: 'resume', cwd: repoR, session_id: 'b5-resume-low', transcript_path: tLowR });
  ok(rLow.code === 0 && !(rLow.out || '').trim(), 'B5 : resume sous 300k -> silence total');

  const tHiR = writeTranscript('b5-resume-hi.jsonl', [usageLine(320000, 0, 0)]); // 320k >= 300k
  const rHi = runHook('session-start.js', { source: 'resume', cwd: repoR, session_id: 'b5-resume-hi', transcript_path: tHiR });
  let sysMsg = null;
  try { sysMsg = JSON.parse(rHi.out).systemMessage || null; } catch (_) {}
  ok(!!sysMsg && /320k/.test(sysMsg), 'B5 : resume >= 300k -> systemMessage nommant l\'occupation');
  ok(!/additionalContext/.test(rHi.out), 'B5 : resume -> jamais additionalContext (zéro token injecté)');

  // -- Non-régression startup : le nouveau branchement resume ne touche pas au flux normal --
  const repoS = path.join(SANDBOX, 'repo-b5-startup');
  fs.mkdirSync(repoS, { recursive: true });
  execFileSync('git', ['init', '-q', repoS]);
  fs.writeFileSync(path.join(repoS, 'CLAUDE.md'), 'règles');
  fs.writeFileSync(path.join(repoS, 'a.txt'), '1');
  execFileSync('git', ['-C', repoS, 'add', '.']);
  execFileSync('git', ['-C', repoS, 'commit', '-q', '-m', 'init']);
  project.ensureLedger(repoS); // + CLAUDE.md -> isFullyInitialized
  const rStart = runHook('session-start.js', { source: 'startup', cwd: repoS, session_id: 'b5-startup' });
  ok(/Promptimizer actif/.test(ctxOf(rStart) || ''), 'B5 : non-régression — startup inchangé (MSG_ACTIF en additionalContext)');
}

// ============================ LOT T2 — TRIM INJECTION SESSIONSTART ============================
section('Trim injection SessionStart (titre compressé + slim si règles dans CLAUDE.md, lot T2)');
{
  const ctxOf = (r) => {
    if (!r.out.trim()) return null;
    try { return JSON.parse(r.out).hookSpecificOutput.additionalContext || null; } catch (_) { return null; }
  };

  // -- sessionTitleMessage compressé : <= 400 o pour un titre réaliste, protocole intact --
  const t = messages.sessionTitleMessage('promptimiser — Lot 25 : Lot T1 — Nudge anti-compaction chiffré');
  ok(Buffer.byteLength(t, 'utf8') <= 400, 'T2 : sessionTitleMessage <= 400 o (titre réaliste)');
  ok(t.includes('PRÉCÉDENTE'), 'T2 : cible la session PRÉCÉDENTE');
  ok(/en clair/i.test(t), 'T2 : proposition en clair (pas seulement le dialogue)');
  ok(/question à choix IMMÉDIATE/.test(t), 'T2 : exige le dialogue de validation immédiat');
  ok(/AVANT la demande/.test(t) && /1er tour/.test(t), 'T2 : au tout début du 1er tour, avant la demande');
  ok(/jamais en fin de tour/.test(t), 'T2 : interdit le renommage repoussé en fin de tour');
  ok(/jamais la courante/.test(t), 'T2 : jamais la session courante');
  ok(/réussi|échec/.test(t) && /jamais muet/.test(t), 'T2 : accusé de résultat explicite');

  // -- MSG_ACTIF_SLIM : ne répète plus les règles d'économie, garde le protocole de clôture --
  ok(!/réduire les relectures/.test(messages.MSG_ACTIF_SLIM), 'T2 : slim ne répète pas les règles d\'économie');
  ok(/pmz:rules/.test(messages.MSG_ACTIF_SLIM), 'T2 : slim pointe vers le bloc pmz:rules du CLAUDE.md');
  ok(/close-batch/.test(messages.MSG_ACTIF_SLIM), 'T2 : slim garde le protocole de clôture (absent de pmz-rules.md)');

  // -- Gating : CLAUDE.md porteur du bloc pmz:rules -> slim ; sinon -> plein --
  const mkRepo = (name, claudeBody) => {
    const r = path.join(SANDBOX, name);
    fs.mkdirSync(r, { recursive: true });
    execFileSync('git', ['init', '-q', r]);
    fs.writeFileSync(path.join(r, 'CLAUDE.md'), claudeBody);
    fs.writeFileSync(path.join(r, 'a.txt'), '1');
    execFileSync('git', ['-C', r, 'add', '.']);
    execFileSync('git', ['-C', r, 'commit', '-q', '-m', 'init']);
    project.ensureLedger(r);
    return r;
  };

  const repoRules = mkRepo('repo-t2-rules', '# projet\n<!-- pmz:rules:start -->\nrègles\n<!-- pmz:rules:end -->\n');
  const ctxRules = ctxOf(runHook('session-start.js', { source: 'startup', cwd: repoRules, session_id: 't2-rules' })) || '';
  ok(/pmz:rules/.test(ctxRules) && !/réduire les relectures/.test(ctxRules), 'T2 : CLAUDE.md porteur -> rappel slim injecté');

  const repoPlain = mkRepo('repo-t2-plain', '# projet sans règles PMZ\n');
  const ctxPlain = ctxOf(runHook('session-start.js', { source: 'startup', cwd: repoPlain, session_id: 't2-plain' })) || '';
  ok(/réduire les relectures/.test(ctxPlain), 'T2 : CLAUDE.md non porteur -> rappel plein (MSG_ACTIF)');
}

section('pmz:skip parsé dans le handoff -> avoid_reread_notes semé dès le tour 1 (lot T3)');
{
  const ledgerT3 = require(path.join(PKG, 'lib', 'ledger'));
  const handoffT3 = require(path.join(PKG, 'lib', 'handoff'));

  // parseSkipPaths : extraction, ignore les lignes malformées/vides
  ok(handoffT3.parseSkipPaths(null).length === 0, 'T3 : texte absent -> tableau vide');
  const parsed = handoffT3.parseSkipPaths(
    '## Handoff\npmz:skip: lib/a.js\nligne normale\npmz:skip:   lib/b.js  \npmz:skip:\n'
  );
  ok(parsed.length === 2 && parsed[0] === 'lib/a.js' && parsed[1] === 'lib/b.js',
    'T3 : parseSkipPaths extrait les chemins, ignore ligne vide/malformée');

  const repo = path.join(SANDBOX, 'repo-t3-skip');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'règles');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  project.ensureLedger(repo);
  const hf = path.join(repo, '.vibe-agent', 'handoff.md');

  // Handoff manuel avec des lignes pmz:skip
  fs.writeFileSync(hf, handoffT3.MANUAL_MARKER + '\n## Handoff\npmz:skip: backlog.json\npmz:skip: CHANGELOG.md\n');
  runHook('session-start.js', { source: 'startup', cwd: repo, session_id: 't3-skip' });
  const rl = ledgerT3.loadReadLedger(repo);
  ok(rl.avoid_reread_notes.includes('backlog.json') && rl.avoid_reread_notes.includes('CHANGELOG.md'),
    'T3 : avoid_reread_notes semé dès SessionStart depuis les lignes pmz:skip du handoff');

  // Handoff manuel sans pmz:skip : ne casse rien, n'ajoute rien
  const repo2 = path.join(SANDBOX, 'repo-t3-noskip');
  fs.mkdirSync(repo2, { recursive: true });
  execFileSync('git', ['init', '-q', repo2]);
  fs.writeFileSync(path.join(repo2, 'CLAUDE.md'), 'règles');
  fs.writeFileSync(path.join(repo2, 'a.txt'), '1');
  execFileSync('git', ['-C', repo2, 'add', '.']);
  execFileSync('git', ['-C', repo2, 'commit', '-q', '-m', 'init']);
  project.ensureLedger(repo2);
  const hf2 = path.join(repo2, '.vibe-agent', 'handoff.md');
  fs.writeFileSync(hf2, handoffT3.MANUAL_MARKER + '\n## Handoff\nnotes sans marqueur skip\n');
  const r2 = runHook('session-start.js', { source: 'startup', cwd: repo2, session_id: 't3-noskip' });
  ok(r2.code === 0, 'T3 : handoff manuel sans pmz:skip -> fail-open, hook toujours vert');
  ok(ledgerT3.loadReadLedger(repo2).avoid_reread_notes.length === 0, 'T3 : rien semé sans ligne pmz:skip');
}

// ============================ VERSION PMZ + COMMANDE ABOUT (LOT 17) ============================
section('Version PMZ historisée + commande about');
{
  const version = require(path.join(PKG, 'lib', 'version'));
  const ABOUT = path.join(PKG, 'scripts', 'about.js');

  ok(/^\d+\.\d+\.\d+$/.test(String(version.readVersion())), 'version.js : VERSION du dépôt lisible, semver');

  const repoAbout = path.join(SANDBOX, 'repo-about');
  fs.mkdirSync(repoAbout, { recursive: true });
  execFileSync('git', ['init', '-q', repoAbout]);
  fs.writeFileSync(path.join(repoAbout, 'a.txt'), 'a');
  execFileSync('git', ['-C', repoAbout, 'add', '.']);
  execFileSync('git', ['-C', repoAbout, 'commit', '-q', '-m', 'init']);

  // Hors projet initialisé : version affichée quand même, epic/lot annoncés absents.
  const aBare = runNode(ABOUT, ['--cwd', repoAbout]);
  ok(/^Version : \d+/m.test(aBare.out), 'about : affiche la version même sans backlog');
  ok(/non initialisé/.test(aBare.out), 'about : projet non initialisé annoncé explicitement');

  // Projet initialisé avec un plan de lots : epic + progression + lot en cours/prochain.
  const backlog = require(path.join(PKG, 'lib', 'backlog'));
  const project = require(path.join(PKG, 'lib', 'project'));
  project.ensureLedger(repoAbout);
  fs.writeFileSync(path.join(repoAbout, '.vibe-agent', 'epic'), 'mon-epic-test\n');
  backlog.addLot(repoAbout, 'Premier lot', 'scope test', null);
  const aPlan = runNode(ABOUT, ['--cwd', repoAbout]);
  ok(/Epic : mon-epic-test/.test(aPlan.out), 'about : affiche l\'epic du projet');
  ok(/Progression : 0\/1 lots faits/.test(aPlan.out), 'about : affiche la progression du backlog');
  ok(/Prochain lot : #\d+ Premier lot/.test(aPlan.out), 'about : affiche le prochain lot todo');

  const b = backlog.loadBacklog(repoAbout);
  backlog.startLot(repoAbout, b.lots[0].id);
  const aInProgress = runNode(ABOUT, ['--cwd', repoAbout]);
  ok(/Lot en cours : #\d+ Premier lot/.test(aInProgress.out), 'about : affiche le lot in_progress');

  // Fail-open : dossier hors-git -> jamais de throw, exit 0.
  const outside = path.join(SANDBOX, 'no-git-about');
  fs.mkdirSync(outside, { recursive: true });
  const aOutside = runNode(ABOUT, ['--cwd', outside]);
  ok(aOutside.code === 0, 'about : hors-git -> exit 0 (fail-open)');
  ok(/non initialisé/.test(aOutside.out), 'about : hors-git -> statut non initialisé annoncé');
}

section('Commande help : liste dérivée des commandes réellement installées');
{
  const HELP = path.join(PKG, 'scripts', 'help.js');
  const cmdDir = path.join(PKG, 'commands');
  const realCmds = fs.readdirSync(cmdDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

  const hHelp = runNode(HELP, []);
  ok(hHelp.code === 0, 'help : exit 0');
  for (const name of realCmds) {
    ok(new RegExp('\\*\\*' + name + '\\*\\*').test(hHelp.out), 'help : liste la commande ' + name);
  }
  ok(/help — /.test(hHelp.out) === false || /\*\*help\*\* — /.test(hHelp.out), 'help : se liste elle-même avec sa description');

  // Fail-open : dossier commands/ absent -> jamais de throw, exit 0, sortie de repli.
  const sbxHelp = path.join(SANDBOX, 'help-no-commands');
  fs.mkdirSync(path.join(sbxHelp, 'scripts'), { recursive: true });
  fs.copyFileSync(HELP, path.join(sbxHelp, 'scripts', 'help.js'));
  const hMissing = runNode(path.join(sbxHelp, 'scripts', 'help.js'), []);
  ok(hMissing.code === 0, 'help : commands/ absent -> exit 0 (fail-open)');
  ok(/liste indisponible/.test(hMissing.out), 'help : commands/ absent -> repli annoncé');
}

section('claude-dir — résolution CLAUDE_CONFIG_DIR (portabilité, lot A)');
{
  // Fonctions call-time : je pose/retire l'env AVANT chaque appel, sans recharger le module.
  const cdir = require(path.join(PKG, 'lib', 'claude-dir.js'));
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  const home = os.homedir();

  // 1. Variable absente → repli ~/.claude, dérivés cohérents.
  delete process.env.CLAUDE_CONFIG_DIR;
  ok(cdir.claudeDir() === path.join(home, '.claude'),
    'claude-dir : sans CLAUDE_CONFIG_DIR → ~/.claude');
  ok(cdir.stateDir() === path.join(home, '.claude', 'promptimizer', 'state'),
    'claude-dir : stateDir dérive de ~/.claude');
  ok(cdir.settingsPath() === path.join(home, '.claude', 'settings.json'),
    'claude-dir : settingsPath dérive de ~/.claude');

  // 2. Variable posée → tout pointe dessous.
  const relocated = path.join(SANDBOX, 'relocated-config');
  process.env.CLAUDE_CONFIG_DIR = relocated;
  ok(cdir.claudeDir() === relocated,
    'claude-dir : CLAUDE_CONFIG_DIR posée → utilisée telle quelle');
  ok(cdir.hooksDir() === path.join(relocated, 'promptimizer', 'hooks'),
    'claude-dir : hooksDir sous CLAUDE_CONFIG_DIR');
  ok(cdir.settingsPath() === path.join(relocated, 'settings.json'),
    'claude-dir : settingsPath sous CLAUDE_CONFIG_DIR');

  // 3. Vide/espaces → repli ~/.claude (jamais un dossier "   ").
  process.env.CLAUDE_CONFIG_DIR = '   ';
  ok(cdir.claudeDir() === path.join(home, '.claude'),
    'claude-dir : CLAUDE_CONFIG_DIR vide → repli ~/.claude');

  // Restaure l'env pour ne pas polluer les tests suivants.
  if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedCfg;

  // 4. Bout-en-bout : merge-settings sans arg chemin écrit sous CLAUDE_CONFIG_DIR
  //    et fige HOOK_BASE (commandes des hooks) sous ce même dossier relocalisé.
  const relocMs = path.join(SANDBOX, 'reloc-ms');
  fs.mkdirSync(relocMs, { recursive: true });
  const rMs = runNode(MS, [], { CLAUDE_CONFIG_DIR: relocMs });
  ok(rMs.code === 0, 'merge-settings : install sous CLAUDE_CONFIG_DIR → exit 0');
  const writtenSettings = path.join(relocMs, 'settings.json');
  ok(fs.existsSync(writtenSettings),
    'merge-settings : settings.json écrit sous CLAUDE_CONFIG_DIR (pas ~/.claude)');
  if (fs.existsSync(writtenSettings)) {
    const raw = fs.readFileSync(writtenSettings, 'utf8');
    ok(raw.indexOf(path.join(relocMs, 'promptimizer', 'hooks')) !== -1,
      'merge-settings : HOOK_BASE des commandes pointe sous CLAUDE_CONFIG_DIR');
  }
}

section('claude-dir — mode plugin (découplage CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA, lot D2)');
{
  const cdir = require(path.join(PKG, 'lib', 'claude-dir.js'));
  const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const savedData = process.env.CLAUDE_PLUGIN_DATA;
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  const home = os.homedir();
  delete process.env.CLAUDE_CONFIG_DIR;

  const fakeRoot = path.join(SANDBOX, 'plugin-root');
  const fakeData = path.join(SANDBOX, 'plugin-data');

  // 1. CLAUDE_PLUGIN_ROOT posée → pmzDir() = racine du plugin, hooksDir() dessous.
  process.env.CLAUDE_PLUGIN_ROOT = fakeRoot;
  delete process.env.CLAUDE_PLUGIN_DATA;
  ok(cdir.pmzDir() === fakeRoot,
    'claude-dir : CLAUDE_PLUGIN_ROOT posée → pmzDir = racine plugin');
  ok(cdir.hooksDir() === path.join(fakeRoot, 'hooks'),
    'claude-dir : hooksDir sous CLAUDE_PLUGIN_ROOT');

  // 2. Découplage clé : ROOT posée mais DATA absente → l'état NE vit PAS sous la racine
  //    du plugin (sinon il serait effacé à chaque update). Repli install manuelle.
  ok(cdir.stateDir() === path.join(home, '.claude', 'promptimizer', 'state'),
    'claude-dir : stateDir découplé de pmzDir (pas sous CLAUDE_PLUGIN_ROOT)');

  // 3. CLAUDE_PLUGIN_DATA posée → stateDir() = <data>/state (persistant, survit aux updates).
  process.env.CLAUDE_PLUGIN_DATA = fakeData;
  ok(cdir.stateDir() === path.join(fakeData, 'state'),
    'claude-dir : CLAUDE_PLUGIN_DATA posée → stateDir sous data');

  // 4. Sans aucune variable plugin → repli install manuelle (pas de régression).
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_DATA;
  ok(cdir.pmzDir() === path.join(home, '.claude', 'promptimizer'),
    'claude-dir : sans variable plugin → pmzDir = install manuelle');
  ok(cdir.stateDir() === path.join(home, '.claude', 'promptimizer', 'state'),
    'claude-dir : sans variable plugin → stateDir = install manuelle');

  // Restaure l'env.
  if (savedRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
  if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = savedData;
  if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
}

// ============================ P. INSTALLEUR NODE (lot B) ============================
section('install.js — bout-en-bout cross-platform (bac à sable, source sans .git)');
{
  // On stage une copie de la source SANS .git : install.js n'ira donc pas toucher le
  // core.hooksPath du vrai dépôt, et on exerce copie + purge + merge + doctor de bout en bout.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-inst-'));
  fs.mkdirSync(path.join(stage, 'skills'), { recursive: true });
  fs.cpSync(PKG, path.join(stage, 'promptimizer'), { recursive: true });
  const skillSrc = path.join(REPO, 'skills', 'promptimizer');
  if (fs.existsSync(skillSrc)) fs.cpSync(skillSrc, path.join(stage, 'skills', 'promptimizer'), { recursive: true });

  const INSTALL = path.join(stage, 'promptimizer', 'install', 'install.js');
  const fakeClaude = path.join(stage, 'claude-home');
  const rInst = runNode(INSTALL, ['--no-pause'], { CLAUDE_CONFIG_DIR: fakeClaude, PMZ_STATE_DIR: path.join(stage, 'state') });
  ok(rInst.code === 0, 'install.js : exit 0 (bac à sable)');
  ok(fs.existsSync(path.join(fakeClaude, 'promptimizer', 'hooks', 'session-start.js')),
    'install.js : hooks copiés sous CLAUDE_CONFIG_DIR');
  ok(fs.existsSync(path.join(fakeClaude, 'skills', 'promptimizer', 'SKILL.md')),
    'install.js : skill copiée');
  ok(fs.existsSync(path.join(fakeClaude, 'commands', 'budget.md')),
    'install.js : slash commands copiées');
  const instSettings = path.join(fakeClaude, 'settings.json');
  ok(fs.existsSync(instSettings), 'install.js : settings.json créé');
  if (fs.existsSync(instSettings)) {
    const s = JSON.parse(fs.readFileSync(instSettings, 'utf8'));
    const cmds = [].concat(...Object.values(s.hooks || {}))
      .flatMap((e) => (e && e.hooks) || []).map((h) => h.command || '');
    ok(cmds.filter((c) => c.includes('promptimizer/hooks/')).length === 6,
      'install.js : 6 hooks PMZ fusionnés');
    ok(cmds.some((c) => c.includes(path.join(fakeClaude, 'promptimizer', 'hooks'))),
      'install.js : HOOK_BASE pointe sous CLAUDE_CONFIG_DIR');
  }

  // Purge : un sous-dossier obsolète est retiré à la réinstallation, mais state/ est préservé.
  fs.mkdirSync(path.join(fakeClaude, 'promptimizer', 'state'), { recursive: true });
  fs.writeFileSync(path.join(fakeClaude, 'promptimizer', 'state', 'keep.json'), '{}');
  fs.writeFileSync(path.join(fakeClaude, 'promptimizer', 'hooks', 'obsolete-xyz.js'), '// vieux');
  const rInst2 = runNode(INSTALL, ['--no-pause'], { CLAUDE_CONFIG_DIR: fakeClaude, PMZ_STATE_DIR: path.join(stage, 'state') });
  ok(rInst2.code === 0, 'install.js : réinstall exit 0 (idempotent)');
  ok(!fs.existsSync(path.join(fakeClaude, 'promptimizer', 'hooks', 'obsolete-xyz.js')),
    'install.js : purge le fichier obsolète du sous-dossier hooks');
  ok(fs.existsSync(path.join(fakeClaude, 'promptimizer', 'state', 'keep.json')),
    'install.js : state/ préservé à la réinstallation');
  if (fs.existsSync(instSettings)) {
    const s = JSON.parse(fs.readFileSync(instSettings, 'utf8'));
    const n = [].concat(...Object.values(s.hooks || {})).flatMap((e) => (e && e.hooks) || [])
      .filter((h) => (h.command || '').includes('promptimizer/hooks/')).length;
    ok(n === 6, 'install.js : réinstall → toujours 6 hooks (pas de doublon)');
  }
  fs.rmSync(stage, { recursive: true, force: true });
}

// ============================ Q. VERSIONING D'UPGRADE (lot C) ============================
section("install.js/doctor.js — versioning d'upgrade (bac à sable)");
{
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-ver-'));
  fs.mkdirSync(path.join(stage, 'skills'), { recursive: true });
  fs.cpSync(PKG, path.join(stage, 'promptimizer'), { recursive: true });
  const skillSrc = path.join(REPO, 'skills', 'promptimizer');
  if (fs.existsSync(skillSrc)) fs.cpSync(skillSrc, path.join(stage, 'skills', 'promptimizer'), { recursive: true });

  const INSTALL = path.join(stage, 'promptimizer', 'install', 'install.js');
  const DOCTOR = path.join(stage, 'promptimizer', 'install', 'doctor.js');
  const fakeClaude = path.join(stage, 'claude-home');
  const env = { CLAUDE_CONFIG_DIR: fakeClaude, PMZ_STATE_DIR: path.join(stage, 'state') };

  // vN : première installation.
  fs.writeFileSync(path.join(stage, 'promptimizer', 'VERSION'), '3.0.0\n');
  const r1 = runNode(INSTALL, ['--no-pause'], env);
  ok(r1.code === 0, 'install.js : première install vN → exit 0');
  ok(/première installation \(v3\.0\.0\)/.test(r1.out),
    'install.js : première install annonce "première installation (v3.0.0)"');

  const d1 = runNode(DOCTOR, ['--no-pause'], env);
  ok(/Version installée : 3\.0\.0/.test(d1.out), 'doctor.js : affiche la version installée (3.0.0)');

  // vM > vN : mise à jour.
  fs.writeFileSync(path.join(stage, 'promptimizer', 'VERSION'), '5.0.0\n');
  const r2 = runNode(INSTALL, ['--no-pause'], env);
  ok(r2.code === 0, 'install.js : mise à jour vN→vM → exit 0');
  ok(/mise à jour v3\.0\.0 → v5\.0\.0/.test(r2.out), 'install.js : annonce "mise à jour v3.0.0 → v5.0.0"');

  const d2 = runNode(DOCTOR, ['--no-pause'], env);
  ok(/Version installée : 5\.0\.0/.test(d2.out), 'doctor.js : version installée mise à jour (5.0.0)');

  // Réinstallation de la même version.
  const r3 = runNode(INSTALL, ['--no-pause'], env);
  ok(r3.code === 0, 'install.js : réinstall même version → exit 0');
  ok(/réinstallation \(v5\.0\.0\)/.test(r3.out), 'install.js : annonce "réinstallation (v5.0.0)"');

  // Downgrade.
  fs.writeFileSync(path.join(stage, 'promptimizer', 'VERSION'), '2.0.0\n');
  const r4 = runNode(INSTALL, ['--no-pause'], env);
  ok(r4.code === 0, 'install.js : downgrade → exit 0');
  ok(/downgrade v5\.0\.0 → v2\.0\.0/.test(r4.out), 'install.js : annonce "downgrade v5.0.0 → v2.0.0"');

  // Format legacy pré-semver (entier) toujours présent côté installé : non comparable ->
  // traité comme première installation, jamais un crash (fail-open, lot D3).
  fs.writeFileSync(path.join(stage, 'promptimizer', 'VERSION'), '6.0.0\n');
  fs.writeFileSync(path.join(fakeClaude, 'promptimizer', 'VERSION'), '5\n');
  const r5 = runNode(INSTALL, ['--no-pause'], env);
  ok(r5.code === 0, 'install.js : version installée legacy (entier) non comparable → exit 0');
  ok(/première installation \(v6\.0\.0\)/.test(r5.out),
    'install.js : version legacy non-semver → traité comme première installation, pas de crash');

  fs.rmSync(stage, { recursive: true, force: true });
}

// ============================ T. AUTONOMIE DU PACKAGE (lot D) ============================
section('Autonomie du package — package.js → unzip hors dépôt → install → doctor vert, sans repo/git');
{
  const workOut = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-pkgout-')); // hors dépôt : sortie du zip
  const rPkg = runNode(path.join(PKG, 'install', 'package.js'), [workOut, '--no-pause']);
  ok(rPkg.code === 0, 'package.js : exit 0');
  const zips = fs.readdirSync(workOut).filter((f) => f.endsWith('.zip'));
  ok(zips.length === 1, 'package.js : une archive .zip produite');
  const zipPath = zips[0] ? path.join(workOut, zips[0]) : null;

  if (zipPath) {
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-unzip-')); // hors dépôt
    const rUnzip = spawnSync('unzip', ['-q', zipPath, '-d', extractDir]);
    ok(!rUnzip.error && rUnzip.status === 0, "unzip de l'archive : OK (outil système, hors dépôt)");

    // Contenu sous un dossier Promptimizer-vX-YYYYMMDD/
    const stageDirs = fs.readdirSync(extractDir).filter((f) => fs.statSync(path.join(extractDir, f)).isDirectory());
    const stageRoot = stageDirs.length ? path.join(extractDir, stageDirs[0]) : extractDir;
    const installedInstall = path.join(stageRoot, 'promptimizer', 'install', 'install.js');
    ok(fs.existsSync(installedInstall), 'archive décompressée : install.js présent (hors dépôt, sans .git)');
    ok(!fs.existsSync(path.join(stageRoot, '.git')), 'archive décompressée : aucun .git (autonomie confirmée)');

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-fakehome-'));
    const fakeClaude = path.join(fakeHome, '.claude');
    const env = { CLAUDE_CONFIG_DIR: fakeClaude, PMZ_STATE_DIR: path.join(fakeHome, 'state'), HOME: fakeHome };
    const rInst = runNode(installedInstall, ['--no-pause'], env);
    ok(rInst.code === 0, 'install.js (package décompressé) : exit 0, sans dépôt source ni git');

    const installedDoctor = path.join(fakeClaude, 'promptimizer', 'install', 'doctor.js');
    const rDoc = runNode(installedDoctor, ['--no-pause'], env);
    ok(/Statut : vert/.test(rDoc.out), 'doctor.js (package installé) : statut vert, sans dépôt source ni git');

    // Grep de garde : aucune référence au chemin du dépôt SOURCE dans l'arbre installé.
    const needle = REPO;
    const leaked = [];
    (function walk(dir) {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        if (st.isDirectory()) { walk(p); continue; }
        if (st.size > 2 * 1024 * 1024) continue; // ignore gros binaires improbables
        let content;
        try { content = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
        if (content.includes(needle)) leaked.push(p);
      }
    })(path.join(fakeClaude, 'promptimizer'));
    ok(leaked.length === 0,
      'grep de garde : 0 référence au chemin du dépôt source dans $DEST/promptimizer (' + leaked.length + ' trouvée(s))');

    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
  fs.rmSync(workOut, { recursive: true, force: true });
}

// ============================ Q. ASSEMBLEUR PLUGIN (lot D2) ============================
section('build-plugin.js — assemble le plugin Claude Code (layout conventionnel + réécriture chemins)');
{
  const BUILD = path.join(PKG, 'install', 'build-plugin.js');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-plugin-'));
  const r = runNode(BUILD, [out], {});
  ok(r.code === 0, 'build-plugin : exit 0');

  const plugin = path.join(out, 'marketplace', 'promptimizer');
  // Emplacements conventionnels imposés par le format plugin (racine du plugin).
  ok(fs.existsSync(path.join(plugin, '.claude-plugin', 'plugin.json')), 'build-plugin : .claude-plugin/plugin.json à la racine');
  ok(fs.existsSync(path.join(plugin, 'hooks', 'hooks.json')), 'build-plugin : hooks/hooks.json à la racine');
  ok(fs.existsSync(path.join(plugin, 'skills', 'promptimizer', 'SKILL.md')), 'build-plugin : skills/promptimizer/SKILL.md à la racine (hors miroir source)');
  ok(fs.existsSync(path.join(plugin, 'commands', 'close-batch.md')), 'build-plugin : commands/ présentes');
  // Garde-fou (v1.1.3) : les commandes /pmz:* attendues sont TOUTES portées par le plugin.
  for (const c of ['budget.md', 'check-context.md', 'close-batch.md', 'fresh-session.md',
    'about.md', 'init.md', 'scope.md']) {
    ok(fs.existsSync(path.join(plugin, 'commands', c)), 'build-plugin : commande requise présente — ' + c);
  }
  ok(fs.existsSync(path.join(plugin, 'bin', 'pmz-hook')), 'build-plugin : bin/pmz-hook présent');
  ok(fs.existsSync(path.join(plugin, 'lib', 'claude-dir.js')), 'build-plugin : lib/ présent (require voisin)');
  // Installeur manuel EXCLU du plugin (obsolète en mode plugin).
  ok(!fs.existsSync(path.join(plugin, 'install')), 'build-plugin : install/ exclu du plugin');

  // Manifeste : JSON valide, version alignée sur VERSION (semver direct, lot D3).
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')); } catch (_) { /* laissé null */ }
  ok(manifest && manifest.name === 'pmz', 'build-plugin : plugin.json valide, name=pmz (lot E1)');
  const vfile = (fs.readFileSync(path.join(PKG, 'VERSION'), 'utf8') || '').trim();
  ok(manifest && manifest.version === vfile, 'build-plugin : version manifeste alignée sur VERSION');

  // Réécriture des chemins : plus de ~/.claude/promptimizer, un ${CLAUDE_PLUGIN_ROOT} à la place.
  const cmd = fs.readFileSync(path.join(plugin, 'commands', 'close-batch.md'), 'utf8');
  ok(cmd.indexOf('~/.claude/promptimizer') === -1, 'build-plugin : commands sans ~/.claude/promptimizer (réécrit)');
  ok(cmd.indexOf('${CLAUDE_PLUGIN_ROOT}') !== -1, 'build-plugin : commands avec ${CLAUDE_PLUGIN_ROOT}');
  const skill = fs.readFileSync(path.join(plugin, 'skills', 'promptimizer', 'SKILL.md'), 'utf8');
  ok(skill.indexOf('~/.claude/promptimizer') === -1, 'build-plugin : skill sans ~/.claude/promptimizer (réécrit)');

  // Marketplace locale : source = string relative (cf. D1).
  let market = null;
  try { market = JSON.parse(fs.readFileSync(path.join(out, 'marketplace', '.claude-plugin', 'marketplace.json'), 'utf8')); } catch (_) { /* null */ }
  ok(market && market.plugins && market.plugins[0] && market.plugins[0].source === './promptimizer',
    'build-plugin : marketplace.json source = "./promptimizer" (string relative)');
  ok(market && market.plugins && market.plugins[0] && market.plugins[0].name === 'pmz',
    'build-plugin : marketplace.json plugins[0].name = "pmz" (lot E1)');

  fs.rmSync(out, { recursive: true, force: true });
}

// ===== build-plugin.js — garde-fou : une commande requise absente fait ÉCHOUER le build (v1.1.3) =====
section('build-plugin.js — commande requise supprimée -> build refusé (anti-régression 7533d72)');
{
  // Copie autonome du package (source), amputée d'une commande requise : on ne touche jamais
  // au vrai PKG. build-plugin résout sa source via __dirname, donc on le lance depuis la copie.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-build-guard-'));
  const srcCopy = path.join(stage, 'promptimizer');
  fs.cpSync(PKG, srcCopy, { recursive: true });
  fs.mkdirSync(path.join(stage, 'skills'), { recursive: true });
  fs.cpSync(path.join(PKG, '..', 'skills', 'promptimizer'), path.join(stage, 'skills', 'promptimizer'), { recursive: true });
  fs.rmSync(path.join(srcCopy, 'commands', 'scope.md'), { force: true });

  const r = runNode(path.join(srcCopy, 'install', 'build-plugin.js'), [path.join(stage, 'dist')], {});
  ok(r.code !== 0, 'build-plugin : exit non-0 quand une commande requise manque');
  ok(/scope\.md/.test(r.err || ''), 'build-plugin : nomme la commande manquante dans l\'erreur');
  ok(/REQUIRED_COMMANDS/.test(r.err || ''), 'build-plugin : indique la marche à suivre (REQUIRED_COMMANDS / restaurer)');

  fs.rmSync(stage, { recursive: true, force: true });
}

// ============================ U. VERSION SEMVER (lot D3) ============================
section('lib/version.js — compareSemver / bumpVersion (semver, lot D3)');
{
  const version = require(path.join(PKG, 'lib', 'version'));

  ok(version.compareSemver('1.2.3', '1.2.3') === 0, 'compareSemver : égalité');
  ok(version.compareSemver('1.2.3', '1.3.0') === -1, 'compareSemver : mineure supérieure');
  ok(version.compareSemver('2.0.0', '1.9.9') === 1, 'compareSemver : majeure supérieure');
  ok(version.compareSemver('1.2.10', '1.2.9') === 1, 'compareSemver : composant à 2 chiffres, pas de tri lexical');
  ok(version.compareSemver('3', '3.0.0') === null, 'compareSemver : format legacy (entier) -> null, pas un crash');
  ok(version.compareSemver('1.2.3', 'x.y.z') === null, 'compareSemver : garbage -> null');

  // bumpVersion isolé : n'écrit jamais le VERSION du dépôt réel dans ce test. version.js
  // résout VERSION_FILE en path.join(__dirname, '..', 'VERSION') -> même disposition lib/+VERSION.
  const tmpVersionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-verbump-'));
  fs.mkdirSync(path.join(tmpVersionDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tmpVersionDir, 'lib', 'version.js'),
    fs.readFileSync(path.join(PKG, 'lib', 'version.js'), 'utf8'));
  fs.writeFileSync(path.join(tmpVersionDir, 'VERSION'), '1.2.3\n');
  const vIso = require(path.join(tmpVersionDir, 'lib', 'version.js'));
  ok(vIso.bumpVersion() === '1.2.4', 'bumpVersion() : patch par défaut');
  ok(vIso.bumpVersion('minor') === '1.3.0', 'bumpVersion(minor) : mineure incrémentée, patch remis à 0');
  ok(vIso.bumpVersion('major') === '2.0.0', 'bumpVersion(major) : majeure incrémentée, mineure/patch remis à 0');
  fs.rmSync(tmpVersionDir, { recursive: true, force: true });
}

// ============================ V. MIGRATION MANUEL -> PLUGIN (lot D3) ============================
section('migrate-to-plugin.js — retire les hooks legacy, restaure le sidecar (bac à sable)');
{
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-migrate-'));
  fs.mkdirSync(path.join(stage, 'skills'), { recursive: true });
  fs.cpSync(PKG, path.join(stage, 'promptimizer'), { recursive: true });
  const skillSrc = path.join(REPO, 'skills', 'promptimizer');
  if (fs.existsSync(skillSrc)) fs.cpSync(skillSrc, path.join(stage, 'skills', 'promptimizer'), { recursive: true });

  const INSTALL = path.join(stage, 'promptimizer', 'install', 'install.js');
  const MIGRATE = path.join(stage, 'promptimizer', 'install', 'migrate-to-plugin.js');
  const fakeClaude = path.join(stage, 'claude-home');
  const env = { CLAUDE_CONFIG_DIR: fakeClaude, PMZ_STATE_DIR: path.join(stage, 'state') };

  // Rien d'installé : no-op propre.
  const rNoop = runNode(MIGRATE, ['--no-pause'], env);
  ok(rNoop.code === 0, 'migrate-to-plugin.js : sans install préalable -> exit 0 (no-op)');
  ok(/rien à migrer/i.test(rNoop.out), 'migrate-to-plugin.js : annonce explicitement rien à migrer');

  // Install manuelle réelle (bac à sable), puis migration.
  const rInst = runNode(INSTALL, ['--no-pause'], env);
  ok(rInst.code === 0, 'migrate-to-plugin.js (setup) : install manuelle -> exit 0');
  const settingsPath = path.join(fakeClaude, 'settings.json');
  const before = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const cmdsBefore = [].concat(...Object.values(before.hooks || {})).flatMap((e) => (e && e.hooks) || []);
  ok(cmdsBefore.some((h) => (h.command || '').includes('promptimizer/hooks/')),
    'migrate-to-plugin.js (setup) : hooks PMZ legacy bien présents avant migration');

  const rMig = runNode(MIGRATE, ['--no-pause'], env);
  ok(rMig.code === 0, 'migrate-to-plugin.js : exit 0');
  ok(/legacy retirés/.test(rMig.out), 'migrate-to-plugin.js : annonce le retrait des hooks legacy');
  ok(/build-plugin\.js/.test(rMig.out), 'migrate-to-plugin.js : rappelle les commandes d\'install du plugin');

  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const cmdsAfter = [].concat(...Object.values(after.hooks || {})).flatMap((e) => (e && e.hooks) || []);
  ok(!cmdsAfter.some((h) => (h.command || '').includes('promptimizer/hooks/')),
    'migrate-to-plugin.js : plus aucun hook PMZ legacy dans settings.json');

  // Fichiers conservés par défaut, purgés seulement avec --purge.
  ok(fs.existsSync(path.join(fakeClaude, 'promptimizer')),
    'migrate-to-plugin.js : fichiers PMZ legacy conservés par défaut');

  // Ré-installer pour tester --purge indépendamment.
  runNode(INSTALL, ['--no-pause'], env);
  const rMigPurge = runNode(MIGRATE, ['--no-pause', '--purge'], env);
  ok(rMigPurge.code === 0, 'migrate-to-plugin.js --purge : exit 0');
  ok(!fs.existsSync(path.join(fakeClaude, 'promptimizer')),
    'migrate-to-plugin.js --purge : fichiers PMZ legacy supprimés');
  ok(!fs.existsSync(path.join(fakeClaude, 'skills', 'promptimizer')),
    'migrate-to-plugin.js --purge : skill supprimée');

  fs.rmSync(stage, { recursive: true, force: true });
}

// ============================ W. DOCTOR — DOUBLE INSTALL (lot D3) ============================
section('doctor.js — détection double installation (plugin + canal manuel legacy)');
{
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-doubleinst-'));
  fs.mkdirSync(path.join(stage, 'skills'), { recursive: true });
  fs.cpSync(PKG, path.join(stage, 'promptimizer'), { recursive: true });
  const skillSrc = path.join(REPO, 'skills', 'promptimizer');
  if (fs.existsSync(skillSrc)) fs.cpSync(skillSrc, path.join(stage, 'skills', 'promptimizer'), { recursive: true });

  const INSTALL = path.join(stage, 'promptimizer', 'install', 'install.js');
  const fakeClaude = path.join(stage, 'claude-home');
  const env = { CLAUDE_CONFIG_DIR: fakeClaude, PMZ_STATE_DIR: path.join(stage, 'state') };
  runNode(INSTALL, ['--no-pause'], env);
  const DOCTOR = path.join(fakeClaude, 'promptimizer', 'install', 'doctor.js');

  // Canal manuel seul (pas de CLAUDE_PLUGIN_ROOT, `claude` absent/muet du sandbox test) :
  // pas de double détectée.
  const dManual = runNode(DOCTOR, ['--no-pause'], env);
  ok(!/double installation/.test(dManual.out),
    'doctor.js : canal manuel seul -> pas d\'avertissement de double installation');

  // Simule le scénario A : ce doctor tourne sous CLAUDE_PLUGIN_ROOT alors que les hooks
  // legacy sont toujours câblés dans settings.json (install manuelle jamais retirée).
  const dPluginPlusLegacy = runNode(DOCTOR, ['--no-pause'],
    Object.assign({}, env, { CLAUDE_PLUGIN_ROOT: path.join(stage, 'fake-plugin-root') }));
  ok(/double installation/.test(dPluginPlusLegacy.out),
    'doctor.js : CLAUDE_PLUGIN_ROOT posé + hooks legacy présents -> double installation signalée');
  ok(/Statut : orange/.test(dPluginPlusLegacy.out),
    'doctor.js : double installation -> statut orange (pas de crash, non bloquant)');
  ok(/migrate-to-plugin\.js/.test(dPluginPlusLegacy.out),
    'doctor.js : rappelle l\'outil de migration');

  fs.rmSync(stage, { recursive: true, force: true });
}

section('doctor.js — canal plugin seul (installed_plugins.json) -> vert, plus de faux rouge');
{
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-plugin-only-'));
  const fakeClaude = path.join(stage, 'claude-home');
  fs.mkdirSync(path.join(fakeClaude, 'plugins'), { recursive: true });
  // settings.json valide SANS aucun hook PMZ (canal manuel jamais installé) : c'est l'état
  // laissé par migrate-to-plugin.js. Historiquement, faute de hooks manuels, le doctor criait
  // « rouge » ici — le fix 2026-07-12 doit rendre « vert ».
  fs.writeFileSync(path.join(fakeClaude, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'pmz@pmz-local': true } }, null, 2));
  // Le plugin est installé : installed_plugins.json pointe vers le CODE réel (PKG porte
  // hooks/ + scripts/), pour que le dry-run du hook et la détection de projet s'exercent.
  fs.writeFileSync(path.join(fakeClaude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'pmz@pmz-local': [{ scope: 'user', installPath: PKG, version: '1.0.0' }] } }, null, 2));

  const DOCTOR = path.join(PKG, 'install', 'doctor.js');
  const env = { CLAUDE_CONFIG_DIR: fakeClaude };
  const d = runNode(DOCTOR, ['--no-pause'], env);
  ok(/Canal : plugin/.test(d.out), 'doctor.js : canal plugin détecté via installed_plugins.json');
  ok(/fournis par le plugin/.test(d.out), 'doctor.js : hooks/skill annoncés comme fournis par le plugin');
  ok(!/double installation/.test(d.out),
    'doctor.js : plugin seul (aucun hook legacy) -> pas d\'avertissement de double installation');
  ok(/Statut : vert/.test(d.out), 'doctor.js : plugin seul et sain -> statut vert (plus de faux rouge)');
  ok(!/dérive de version/.test(d.out), 'doctor.js : versions alignées -> pas d\'alerte de dérive');

  fs.rmSync(stage, { recursive: true, force: true });
}

// ============== doctor.js — dérive de version source ↔ plugin installé (v1.1.2) ==============
section('doctor.js — dérive de version : cache plugin en retard sur la source -> orange');
{
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-plugin-drift-'));
  const fakeClaude = path.join(stage, 'claude-home');
  fs.mkdirSync(path.join(fakeClaude, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(fakeClaude, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'pmz@pmz-local': true } }, null, 2));
  // Cache plugin = copie du package avec une VERSION artificiellement en retard : exactement
  // l'état du post-mortem v1.1.1 (fixes committés côté source, cache figé sur l'ancien code).
  const staleCache = path.join(stage, 'cache-pmz');
  fs.cpSync(PKG, staleCache, { recursive: true });
  fs.writeFileSync(path.join(staleCache, 'VERSION'), '0.0.1\n');
  fs.writeFileSync(path.join(fakeClaude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'pmz@pmz-local': [{ scope: 'user', installPath: staleCache, version: '0.0.1' }] } }, null, 2));

  const DOCTOR = path.join(PKG, 'install', 'doctor.js');
  const d = runNode(DOCTOR, ['--no-pause'], { CLAUDE_CONFIG_DIR: fakeClaude });
  ok(/Plugin installé : 0\.0\.1/.test(d.out), 'doctor.js : version du plugin installé affichée (VERSION du cache)');
  ok(/dérive de version/.test(d.out), 'doctor.js : dérive source ↔ cache signalée');
  ok(/build-plugin\.js/.test(d.out) && /plugin update pmz/.test(d.out),
    'doctor.js : marche à suivre indiquée (rebuild + claude plugin update)');
  ok(/Statut : orange/.test(d.out), 'doctor.js : dérive de version -> statut orange');

  fs.rmSync(stage, { recursive: true, force: true });
}

// ============================ Q. RAPPEL DOUBLÉ DU RENOMMAGE (lot #40) ============================
section('Titre suggéré : rappelé aussi au 1er UserPromptSubmit (fiabilité, lot #40)');
{
  const repo = path.join(SANDBOX, 'repo-title-reminder');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'règles');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'premier commit']);
  const addedQ = backlogLib.addLot(repo, 'Lot du rappel doublé', 'fait quand : test', 'sonnet');
  backlogLib.startLot(repo, addedQ.id);

  function ctxOf(r) { try { return JSON.parse(r.out).hookSpecificOutput.additionalContext || ''; } catch (_) { return ''; } }

  // Q1. SessionStart : titre injecté (comportement déjà existant, non régressé)
  const rStart = runHook('session-start.js', { source: 'startup', cwd: repo, session_id: 'sess-q1' });
  const ctxStart = ctxOf(rStart);
  ok(/Titre suggéré \(session PRÉCÉDENTE\)/.test(ctxStart), 'SessionStart : titre suggéré toujours injecté');

  // Q2. 1er UserPromptSubmit de la même session : le titre est RÉAFFICHÉ (2e chance)
  const rPrompt1 = runHook('user-prompt-submit.js', { cwd: repo, session_id: 'sess-q1', prompt: 'bonjour' });
  const ctxPrompt1 = ctxOf(rPrompt1);
  ok(/Titre suggéré \(session PRÉCÉDENTE\)/.test(ctxPrompt1), '1er UserPromptSubmit : titre réaffiché (2e chance)');
  ok(ctxPrompt1.includes('Lot du rappel doublé'), '1er UserPromptSubmit : même titre que celui du SessionStart');

  // Q3. 2e UserPromptSubmit de la même session : anti-spam, pas de répétition
  const rPrompt2 = runHook('user-prompt-submit.js', { cwd: repo, session_id: 'sess-q1', prompt: 'et ensuite ?' });
  ok(!/Titre suggéré/.test(ctxOf(rPrompt2)), '2e UserPromptSubmit : anti-spam, plus de rappel du titre');

  // Q4. Pas de recalcul : suggestedTitle() lu directement ne montre pas « (partie 2) »
  // (touchLot ne doit être incrémenté qu'une fois, par session-start.js — jamais par
  // le rappel de user-prompt-submit.js, qui ne fait que relire l'état persisté).
  ok(!/\(partie 2\)/.test(ctxPrompt1), 'pas de double incrément touchLot via le rappel UserPromptSubmit');
}

// ============================ R. VIGIE MODÈLE RÉEL VS PRÉCONISÉ (lot #42) ============================
section('Vigie modèle réel vs préconisé (UserPromptSubmit, anti-spam 1×/session, lot #42)');
{
  const modelwatch = require(path.join(PKG, 'lib', 'modelwatch'));
  function modelLine(model) {
    return JSON.stringify({ type: 'assistant', message: { model } });
  }

  // R1. readLastModel / modelsDiffer — unités
  const tSonnet = writeTranscript('r-sonnet.jsonl', ['{"type":"user"}', modelLine('claude-sonnet-5')]);
  ok(modelwatch.readLastModel(tSonnet) === 'claude-sonnet-5', 'readLastModel : lit le modèle du dernier message assistant');
  ok(modelwatch.modelsDiffer('sonnet', 'claude-sonnet-5') === false, 'modelsDiffer : hint contenu dans le modèle réel -> pas de diff');
  ok(modelwatch.modelsDiffer('opus', 'claude-sonnet-5') === true, 'modelsDiffer : hint absent du modèle réel -> diff');
  ok(modelwatch.readLastModel(null) === null, 'readLastModel : transcript_path absent -> null, fail-open');
  ok(modelwatch.readLastModel(path.join(SANDBOX, 'inexistant.jsonl')) === null, 'readLastModel : fichier absent -> null, fail-open');

  // R2. bout-en-bout via le hook
  const repo = path.join(SANDBOX, 'repo-model-watch');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'règles');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'premier commit']);
  const lotMW = backlogLib.addLot(repo, 'Lot vigie modèle', 'fait quand : test', 'opus');
  backlogLib.startLot(repo, lotMW.id);

  function ctxOf(r) { try { return JSON.parse(r.out).hookSpecificOutput.additionalContext || ''; } catch (_) { return ''; } }

  // R2a. modèle réel != model_hint ('opus' attendu, 'sonnet' détecté) -> nudge présent
  const tMismatch = writeTranscript('r-mismatch.jsonl', [modelLine('claude-sonnet-5')]);
  const rMismatch = runHook('user-prompt-submit.js', { cwd: repo, session_id: 'sess-mw1', prompt: 'bonjour', transcript_path: tMismatch });
  const ctxMismatch = ctxOf(rMismatch);
  ok(/Modèle réel.*≠.*préconisé/.test(ctxMismatch), 'mismatch : nudge injecté');
  ok(ctxMismatch.includes('Lot vigie modèle') && ctxMismatch.includes('claude-sonnet-5'), 'mismatch : nomme le lot et le modèle réel');

  // R2b. anti-spam : 2e prompt de la même session -> pas de répétition
  const rMismatch2 = runHook('user-prompt-submit.js', { cwd: repo, session_id: 'sess-mw1', prompt: 'et ensuite ?', transcript_path: tMismatch });
  ok(!/Modèle réel/.test(ctxOf(rMismatch2)), 'anti-spam : pas de 2e nudge dans la même session');

  // R2c. modèle réel == model_hint -> pas de nudge (nouvelle session)
  const tMatch = writeTranscript('r-match.jsonl', [modelLine('claude-opus-4-8')]);
  const rMatch = runHook('user-prompt-submit.js', { cwd: repo, session_id: 'sess-mw2', prompt: 'bonjour', transcript_path: tMatch });
  ok(!/Modèle réel/.test(ctxOf(rMatch)), 'modèle conforme au hint -> pas de nudge');

  // R2d. transcript illisible -> fail-open, exit 0, pas de crash
  const rNoTranscript = runHook('user-prompt-submit.js', { cwd: repo, session_id: 'sess-mw3', prompt: 'bonjour', transcript_path: path.join(SANDBOX, 'absent.jsonl') });
  ok(rNoTranscript.code === 0, 'transcript illisible -> fail-open, exit 0');
  ok(!/Modèle réel/.test(ctxOf(rNoTranscript)), 'transcript illisible -> pas de nudge (rien à comparer)');
}

// ============================ S. COÛT RÉEL PAR LOT (lot #43) ============================
section('Coût réel par lot (agrégation cost_tokens + alerte ~300k, lot #43)');
{
  // S1. addCost — unités : n'accumule que sur un lot in_progress, ignore <= 0, agrège.
  const repoU = path.join(SANDBOX, 'repo-cost-unit');
  fs.mkdirSync(repoU, { recursive: true });
  execFileSync('git', ['init', '-q', repoU]);
  const lU = backlogLib.addLot(repoU, 'Lot coût', 'fait quand : test', 'opus');
  ok(lU.cost_tokens === 0, 'addLot : cost_tokens initialisé à 0');
  ok(backlogLib.addCost(repoU, lU.id, 5000) === null, 'addCost : refusé sur un lot à faire (pas in_progress)');
  backlogLib.startLot(repoU, lU.id);
  ok(backlogLib.addCost(repoU, lU.id, 5000).cost_tokens === 5000, 'addCost : accumule sur le lot en cours');
  ok(backlogLib.addCost(repoU, lU.id, 3000).cost_tokens === 8000, 'addCost : agrège (5000 + 3000)');
  ok(backlogLib.addCost(repoU, lU.id, 0).cost_tokens === 8000, 'addCost : tokens=0 -> no-op (inchangé)');
  ok(backlogLib.addCost(repoU, lU.id, -100).cost_tokens === 8000, 'addCost : tokens<0 -> no-op (inchangé)');
  backlogLib.doneLot(repoU, lU.id, 'abc1234');
  ok(backlogLib.addCost(repoU, lU.id, 9000) === null, 'addCost : refusé sur un lot clos');
  ok(backlogLib.loadBacklog(repoU).lots[0].cost_tokens === 8000, 'clôture : cost_tokens figé et préservé');

  // S2. loadBacklog : lot legacy sans champ cost_tokens -> normalisé à 0 (pas de crash).
  const legacy = { version: 1, next_id: 2, lots: [{ id: 1, title: 'Legacy', status: 'done' }] };
  const repoL = path.join(SANDBOX, 'repo-cost-legacy');
  fs.mkdirSync(path.join(repoL, '.vibe-agent'), { recursive: true });
  execFileSync('git', ['init', '-q', repoL]);
  fs.writeFileSync(path.join(repoL, '.vibe-agent', 'backlog.json'), JSON.stringify(legacy));
  ok(backlogLib.loadBacklog(repoL).lots[0].cost_tokens === 0, 'loadBacklog : cost_tokens absent -> 0 (rétrocompat)');

  // S3. show CLI : affiche le coût quand > 0.
  const showOut = runNode(BKLG, ['show', '--cwd', repoU]).out;
  ok(/coût ~8k tokens de sortie/.test(showOut), 'show : coût cumulé affiché (« coût ~8k tokens de sortie »)');

  // S4. bout-en-bout via stop.js : agrégation par tour + alerte 1×/lot·session + réarmement.
  const repo = path.join(SANDBOX, 'repo-cost-e2e');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  // .vibe-agent/.gitignore comme le bootstrap : les ledgers réécrits chaque tour restent
  // ignorés (sinon, une fois suivis, leur churn ferait échouer la détection de tree propre).
  fs.mkdirSync(path.join(repo, '.vibe-agent'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.vibe-agent', '.gitignore'), '*\n!.gitignore\n!backlog.json\n!rules.yaml\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const lE = backlogLib.addLot(repo, 'Gros lot', 'fait quand : test', 'opus');
  backlogLib.startLot(repo, lE.id);
  const sidC = 'sess-cost';
  const tC = path.join(SANDBOX, 'cost.jsonl');
  fs.writeFileSync(tC, '');
  const sysMsg = (r) => { try { return JSON.parse(r.out).systemMessage || ''; } catch (_) { return ''; } };
  fs.writeFileSync(path.join(repo, 'w.txt'), 'x'); // lot ouvert (tree sale)

  // Tour 1 = baseline (out ignoré, pas d'accumulation), rappel de clôture attendu.
  fs.appendFileSync(tC, usageLine(2000, 118000, 0, 500) + '\n');
  const c1 = runHook('stop.js', { session_id: sidC, cwd: repo, transcript_path: tC });
  ok(backlogLib.loadBacklog(repo).lots[0].cost_tokens === 0, 'e2e : tour baseline -> aucune accumulation (out=0)');
  ok(!/tokens de sortie cumulés/.test(sysMsg(c1)), 'e2e : baseline -> pas d\'alerte coût');

  // Tour 2 = sortie 260k -> cost_tokens=260k >= 250k -> alerte « en approche ».
  fs.appendFileSync(tC, usageLine(3000, 197000, 0, 260000) + '\n');
  const c2 = runHook('stop.js', { session_id: sidC, cwd: repo, transcript_path: tC });
  ok(backlogLib.loadBacklog(repo).lots[0].cost_tokens === 260000, 'e2e : sortie du tour agrégée sur le lot (260k)');
  ok(/Gros lot.*260k tokens de sortie cumulés/.test(sysMsg(c2)), 'e2e : alerte coût injectée (nomme le lot + le cumul)');
  ok(/en approche du budget ~300k/.test(sysMsg(c2)), 'e2e : 260k < 300k -> message « en approche »');

  // Tour 3 = encore de la sortie -> cumul monte mais anti-spam 1×/lot·session.
  fs.appendFileSync(tC, usageLine(3000, 197000, 0, 5000) + '\n');
  const c3 = runHook('stop.js', { session_id: sidC, cwd: repo, transcript_path: tC });
  ok(backlogLib.loadBacklog(repo).lots[0].cost_tokens === 265000, 'e2e : accumulation continue (265k)');
  ok(!/tokens de sortie cumulés/.test(sysMsg(c3)), 'e2e : anti-spam -> pas de 2e alerte dans la même session');

  // Tour 4 = working tree propre -> auto-clôture + réarmement du flag de coût.
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'lot fini']);
  runHook('stop.js', { session_id: sidC, cwd: repo, transcript_path: tC });
  const bDone = backlogLib.loadBacklog(repo);
  ok(bDone.lots[0].status === 'done' && bDone.lots[0].cost_tokens === 265000, 'e2e : clôture -> cost_tokens conservé (265k)');
  const stAfter = JSON.parse(fs.readFileSync(path.join(repo, '.vibe-agent', 'session-state.json'), 'utf8'));
  ok(stAfter.cost_reminded_for_batch === false, 'e2e : tree propre -> alerte de coût réarmée pour le prochain lot');

  // S5. fail-open : stop.js ne casse jamais même si le lot n'existe pas / pas de transcript.
  const repoF = path.join(SANDBOX, 'repo-cost-failopen');
  fs.mkdirSync(repoF, { recursive: true });
  execFileSync('git', ['init', '-q', repoF]);
  fs.writeFileSync(path.join(repoF, 'a.txt'), '1');
  execFileSync('git', ['-C', repoF, 'add', '.']);
  execFileSync('git', ['-C', repoF, 'commit', '-q', '-m', 'init']);
  const cF = runHook('stop.js', { session_id: 'sess-cf', cwd: repoF, transcript_path: path.join(SANDBOX, 'nope.jsonl') });
  ok(cF.code === 0, 'e2e : aucun lot + transcript absent -> exit 0 (fail-open)');
}

// ============================ T. CLÔTURE PROUVÉE (verify auto + garde-fou changelog, lot #44) ============================
section('Clôture prouvée : verify à l\'auto-clôture + garde-fou CHANGELOG (lot #44)');
{
  // T1. runVerify — unités : succès, échec (avec tail), non-terminaison dans le délai (timedOut).
  const repoV = path.join(SANDBOX, 'repo-verify-unit');
  fs.mkdirSync(repoV, { recursive: true });
  const vOk = project.runVerify(repoV, 'node -e "process.exit(0)"', 2000);
  ok(vOk.ok === true, 'runVerify : commande qui réussit -> ok');
  const vFail = project.runVerify(repoV, 'node -e "console.error(\'boom\');process.exit(1)"', 2000);
  ok(vFail.ok === false && vFail.timedOut === false && /boom/.test(vFail.tail), 'runVerify : échec -> !ok, !timedOut, tail capturé');
  const vTimeout = project.runVerify(repoV, 'node -e "setTimeout(function(){}, 5000)"', 300);
  ok(vTimeout.ok === false && vTimeout.timedOut === true, 'runVerify : dépassement du délai court -> timedOut (pas un échec)');

  // T2. closureProofMessage — unités : chaque branche + null quand rien à dire.
  ok(/Verify du lot \(`x`\) : OK\./.test(messages.closureProofMessage({ cmd: 'x', ok: true }, false)), 'closureProofMessage : verify OK');
  ok(/non terminée dans le délai court/.test(messages.closureProofMessage({ cmd: 'x', ok: false, timedOut: true }, false)), 'closureProofMessage : verify timeout -> pas « ÉCHEC »');
  ok(/ÉCHEC.*à corriger/s.test(messages.closureProofMessage({ cmd: 'x', ok: false, timedOut: false, tail: 'zut' }, false)), 'closureProofMessage : verify échec');
  ok(/Rappel doux.*CHANGELOG\.md/s.test(messages.closureProofMessage(null, true)), 'closureProofMessage : garde-fou CHANGELOG seul');
  ok(messages.closureProofMessage(null, false) === null, 'closureProofMessage : rien à dire -> null');

  // Fabrique un repo bootstrappé (ledgers ignorés) + helper d'auto-clôture (dirty -> arme le
  // flag, puis commit -> transition tree propre = auto-clôture au Stop suivant).
  const sysMsg = (r) => { try { return JSON.parse(r.out).systemMessage || ''; } catch (_) { return ''; } };
  function bootRepo(name) {
    const repo = path.join(SANDBOX, name);
    fs.mkdirSync(path.join(repo, '.vibe-agent'), { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    fs.writeFileSync(path.join(repo, '.vibe-agent', '.gitignore'), '*\n!.gitignore\n!backlog.json\n!rules.yaml\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), '1');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
    return repo;
  }
  const empT = path.join(SANDBOX, 'empty-t.jsonl');
  fs.writeFileSync(empT, '');

  // T3. e2e : verify du lot PASSE + commit de clôture SANS CHANGELOG -> « OK. » + « Rappel doux ».
  {
    const repo = bootRepo('repo-proof-ok');
    const l = backlogLib.addLot(repo, 'Lot prouvé', 'fait quand : vert', 'opus', null, 'node -e "process.exit(0)"');
    backlogLib.startLot(repo, l.id);
    const sid = 'sess-proof-ok';
    fs.writeFileSync(path.join(repo, 'w.txt'), 'x');
    runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empT }); // arme closure_reminded
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'lot fini (sans changelog)']);
    const r = runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empT });
    const m = sysMsg(r);
    ok(backlogLib.loadBacklog(repo).lots[0].status === 'done', 'e2e : lot auto-clôturé');
    ok(/Lot « Lot prouvé » clos/.test(m), 'e2e : message de clôture présent');
    ok(/Verify du lot \(`node -e "process\.exit\(0\)"`\) : OK\./.test(m), 'e2e : verify exécutée à l\'auto-clôture, résultat OK visible');
    ok(/Rappel doux.*CHANGELOG\.md/s.test(m), 'e2e : commit de clôture sans CHANGELOG -> rappel doux');
  }

  // T4. e2e : commit de clôture QUI touche CHANGELOG.md -> pas de rappel doux ; verify en ÉCHEC visible.
  {
    const repo = bootRepo('repo-proof-changelog');
    const l = backlogLib.addLot(repo, 'Lot échec', 'fait quand : vert', 'opus', null, 'node -e "process.exit(1)"');
    backlogLib.startLot(repo, l.id);
    const sid = 'sess-proof-cl';
    fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changelog\n');
    fs.writeFileSync(path.join(repo, 'w.txt'), 'y');
    runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empT });
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'lot fini (avec changelog)']);
    const r = runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empT });
    const m = sysMsg(r);
    ok(!/Rappel doux/.test(m), 'e2e : commit de clôture touchant CHANGELOG -> aucun rappel doux');
    ok(/Verify du lot.*ÉCHEC/s.test(m), 'e2e : verify en échec -> visible (clôture non bloquée)');
    ok(backlogLib.loadBacklog(repo).lots[0].status === 'done', 'e2e : verify en échec ne bloque pas la clôture');
  }

  // T5. fail-open : lot SANS verify + commande impossible n'importe où -> exit 0, lot clôturé.
  {
    const repo = bootRepo('repo-proof-noverify');
    const l = backlogLib.addLot(repo, 'Lot sans verify', 'fait quand : X', 'opus');
    backlogLib.startLot(repo, l.id);
    const sid = 'sess-proof-nv';
    fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changelog\n');
    fs.writeFileSync(path.join(repo, 'w.txt'), 'z');
    runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empT });
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'lot fini']);
    const r = runHook('stop.js', { session_id: sid, cwd: repo, transcript_path: empT });
    ok(r.code === 0, 'e2e : lot sans verify -> exit 0 (fail-open)');
    ok(!/Verify du lot/.test(sysMsg(r)), 'e2e : lot sans verify -> aucune ligne verify');
    ok(backlogLib.loadBacklog(repo).lots[0].status === 'done', 'e2e : lot sans verify auto-clôturé');
  }
}

// ============================ U. STATUSLINE OPT-IN (lot #45) ============================
section('Statusline opt-in : rendu + merge-settings (préserve tierce, retrait propre, lot #45)');
{
  const STL = path.join(PKG, 'scripts', 'statusline.js');
  function runStatusline(inputObj, env) {
    const input = typeof inputObj === 'string' ? inputObj : JSON.stringify(inputObj);
    try {
      const out = execFileSync(process.execPath, [STL], {
        input, encoding: 'utf8', env: Object.assign({}, process.env, env || {}),
      });
      return { code: 0, out };
    } catch (e) { return { code: e.status == null ? 1 : e.status, out: (e.stdout || '').toString() }; }
  }

  // U1. statusLineText — pure : assemblage complet, saut des parties absentes, toujours « PMZ ».
  ok(messages.statusLineText({ version: '9.9.9', epic: 'E', lot: { id: 7, title: 'T' }, done: 2, total: 5, occ: 320000 })
    === 'PMZ v9.9.9 · E · lot #7 T · 2/5 · ctx 320k', 'statusLineText : ligne complète assemblée');
  ok(messages.statusLineText({ version: '1.0.0' }) === 'PMZ v1.0.0', 'statusLineText : version seule (aucun séparateur orphelin)');
  ok(messages.statusLineText({}) === 'PMZ', 'statusLineText : vide -> « PMZ »');
  ok(messages.statusLineText({ version: '1.0.0', occ: 0 }) === 'PMZ v1.0.0', 'statusLineText : occ 0 -> pas de ctx');
  ok(!/\/\d/.test(messages.statusLineText({ version: '1.0.0', done: 1 })), 'statusLineText : total manquant -> pas de progression');

  // U2. Renderer — fail-open sur stdin vide/malformé/{} : toujours exit 0, exactement 1 ligne.
  for (const inp of ['', '{bad json', {}]) {
    const r = runStatusline(inp);
    ok(r.code === 0, `statusline.js : stdin ${JSON.stringify(inp).slice(0, 12)} -> exit 0`);
    ok(r.out.split('\n').filter((l) => l.length).length <= 1, 'statusline.js : au plus une ligne');
  }
  // U2bis. Kill-switch : PMZ_DISABLE=1 -> ligne vide.
  ok(runStatusline({}, { PMZ_DISABLE: '1' }).out.trim() === '', 'statusline.js : PMZ_DISABLE=1 -> muet');
  // U2ter. Rendu réel : transcript à 320k (hors-git) -> version + « ctx 320k » sur une ligne.
  {
    const r = runStatusline({ transcript_path: tA, cwd: SANDBOX });
    ok(r.code === 0 && /^PMZ\b/.test(r.out) && /ctx 320k/.test(r.out), 'statusline.js : rendu réel -> PMZ … ctx 320k');
  }

  // U3. merge-settings --statusline sur settings vierge -> pose NOTRE statusLine.
  writeSettings({ permissions: { allow: ['Read'] } });
  runNode(MS, [SP, '--statusline'], { PMZ_STATE_DIR: STATE });
  let s = readSettings();
  ok(s.statusLine && /promptimizer\/scripts\/statusline\.js/.test(s.statusLine.command), '--statusline : statusLine PMZ posée');
  ok(s.permissions && s.permissions.allow[0] === 'Read', '--statusline : permissions préservées');

  // U4. --statusline sur une statusLine TIERCE -> préservée, non remplacée.
  writeSettings({ statusLine: { type: 'command', command: 'my-own-statusline.sh' } });
  const rThird = runNode(MS, [SP, '--statusline'], { PMZ_STATE_DIR: STATE });
  s = readSettings();
  ok(s.statusLine.command === 'my-own-statusline.sh', '--statusline : statusLine tierce NON remplacée');
  ok(/tierce/i.test(rThird.out), '--statusline : note « tierce préservée »');

  // U5. --statusline-remove ne retire JAMAIS une tierce.
  runNode(MS, [SP, '--statusline-remove'], { PMZ_STATE_DIR: STATE });
  s = readSettings();
  ok(s.statusLine && s.statusLine.command === 'my-own-statusline.sh', '--statusline-remove : tierce préservée');

  // U6. --statusline-remove retire NOTRE statusLine, et elle seule.
  writeSettings({});
  runNode(MS, [SP, '--statusline'], { PMZ_STATE_DIR: STATE });
  runNode(MS, [SP, '--statusline-remove'], { PMZ_STATE_DIR: STATE });
  s = readSettings();
  ok(!s.statusLine, '--statusline-remove : statusLine PMZ retirée');

  // U7. --check rapporte l'état statusline (none / pmz / third-party).
  writeSettings({});
  ok(JSON.parse(runNode(MS, [SP, '--check'], { PMZ_STATE_DIR: STATE }).out).statusline === 'none', '--check : statusline none');
  runNode(MS, [SP, '--statusline'], { PMZ_STATE_DIR: STATE });
  ok(JSON.parse(runNode(MS, [SP, '--check'], { PMZ_STATE_DIR: STATE }).out).statusline === 'pmz', '--check : statusline pmz');
  writeSettings({ statusLine: { type: 'command', command: 'x.sh' } });
  ok(JSON.parse(runNode(MS, [SP, '--check'], { PMZ_STATE_DIR: STATE }).out).statusline === 'third-party', '--check : statusline third-party');

  // U8. Désinstallation (--remove) nettoie NOTRE statusline mais pas une tierce.
  writeSettings({});
  runNode(MS, [SP, '--statusline'], { PMZ_STATE_DIR: STATE });
  runNode(MS, [SP], { PMZ_STATE_DIR: STATE }); // install hooks par-dessus
  runNode(MS, [SP, '--remove'], { PMZ_STATE_DIR: STATE });
  s = readSettings();
  ok(!s.statusLine, '--remove : statusLine PMZ nettoyée à la désinstallation');
  writeSettings({ statusLine: { type: 'command', command: 'keep.sh' } });
  runNode(MS, [SP, '--remove'], { PMZ_STATE_DIR: STATE });
  s = readSettings();
  ok(s.statusLine && s.statusLine.command === 'keep.sh', '--remove : statusLine tierce préservée');
}

// ============================ RÉSUMÉ ============================
console.log(`\n${'='.repeat(50)}`);
console.log(`Résultat : ${pass} OK · ${fail} échec(s)`);
if (fail) { console.log('Échecs :'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
