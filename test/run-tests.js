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
const { execFileSync } = require('child_process');

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
section('Fail-open des 5 hooks (stdin vide / malformé / valide → exit 0)');
const ALL_HOOKS = ['session-start.js', 'user-prompt-submit.js', 'pre-tool-use.js', 'post-tool-use.js', 'stop.js'];
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
function usageLine(input, read, create) {
  return JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create } } });
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
ok(hookCmds(s).filter((c) => c.includes('promptimizer/hooks/')).length === 5, 'install → 5 hooks PMZ');
ok(hookCmds(s).every((c) => /^"[^"]+\/node" /.test(c) || /^"[^"]*node" /.test(c)), 'hooks câblés avec node en chemin absolu quoté');

// D3. Idempotence
runNode(MS, [SP], { PMZ_STATE_DIR: STATE });
s = readSettings();
ok(hookCmds(s).filter((c) => c.includes('promptimizer/hooks/')).length === 5, 'réinstall → toujours 5 (idempotent)');

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
ok(hookCmds(s).filter((c) => c.includes('promptimizer/hooks/')).length === 5, 'strip legacy : 5 hooks PMZ (pas de doublon)');

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
{
  const repo = path.join(SANDBOX, 'repo-lot');
  fs.mkdirSync(path.join(repo, '.vibe-agent'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '## 2026-06-16 (lot 3)\n\ntexte\n\n## 2026-06-11 (lot 1)\n');
  const epic = path.basename(repo);
  ok(lot.getLotCounter(repo) === 3, 'seed depuis CHANGELOG : plus grand (lot N) trouvé = 3');
  ok(lot.suggestedTitle(repo) === `${epic} — Lot 4`, 'titre suggéré = nom du dossier — Lot 4');
  ok(lot.incrementLot(repo) === 4, 'incrementLot : 3 → 4');
  ok(lot.getLotCounter(repo) === 4, 'compteur persisté = 4');
  ok(lot.suggestedTitle(repo) === `${epic} — Lot 5`, 'titre suggéré suit le compteur : Lot 5');
  fs.writeFileSync(path.join(repo, '.vibe-agent', 'epic'), 'MonEpic\n');
  ok(lot.readEpic(repo) === 'MonEpic', 'epic configurable via .vibe-agent/epic');
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
  ok(!fs.existsSync(path.join(repo, 'CLAUDE.md')), 'projet mature sans /pmz-init → CLAUDE.md toujours NON créé automatiquement');
}

// ============================ RÉSUMÉ ============================
console.log(`\n${'='.repeat(50)}`);
console.log(`Résultat : ${pass} OK · ${fail} échec(s)`);
if (fail) { console.log('Échecs :'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
