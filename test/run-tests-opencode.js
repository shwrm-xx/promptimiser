#!/usr/bin/env node
'use strict';
// Harnais de test PMZ pour OpenCode — zéro dépendance (Node stdlib), bac à sable auto.
// Couvre (lot OC1) : install sandbox (arbo, idempotence, état préservé), chargement du
// plugin avec client mock (hooks présents, aucun throw sur payloads vides/malformés/valides),
// instrumentation (journal + toast), kill-switch PMZ_DISABLE, doctor, uninstall.
// Usage : node test/run-tests-opencode.js   (exit 0 si tout passe, 1 sinon)
// Invoqué aussi par test/run-tests.js (section OpenCode).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..');
const OC = path.join(REPO, 'opencode');
const INSTALL = path.join(OC, 'install', 'install-opencode.js');
const UNINSTALL = path.join(OC, 'install', 'uninstall-opencode.js');
const DOCTOR = path.join(OC, 'install', 'doctor-opencode.js');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-oc-test-'));
const TARGET = path.join(SANDBOX, 'config', 'opencode');
const PROJ = path.join(SANDBOX, 'proj');
fs.mkdirSync(PROJ, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; failures.push(label); console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n— ' + name + ' —'); }
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
// Empreinte du contenu installé (chemins relatifs + sha1), state/ exclu (muable par design).
function treeSnapshot(dir) {
  const map = {};
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const rel = path.relative(dir, full);
      if (rel === path.join('pmz', 'state') || rel.startsWith(path.join('pmz', 'state') + path.sep)) continue;
      if (entry.isDirectory()) walk(full);
      else map[rel] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
    }
  })(dir);
  return map;
}
function sameSnapshot(a, b) {
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

(async function main() {
  // ============ A. INSTALL SANDBOX ============
  section('Install sandbox — arbo attendue');
  let r = runNode(INSTALL, ['--target', TARGET, '--json']);
  ok(r.code === 0, 'install : exit 0');
  let summary = null;
  try { summary = JSON.parse(r.out); } catch (_) {}
  ok(summary && summary.ok === true && /^\d+\.\d+\.\d+$/.test(summary.version), 'install : résumé JSON ok + version semver');
  for (const f of [
    ['plugin', 'pmz.js'], ['pmz', 'VERSION'], ['pmz', 'impl', 'index.js'],
    ['pmz', 'impl', 'oc-dir.js'], ['pmz', 'impl', 'bridge.js'],
    ['pmz', 'lib', 'backlog.js'], ['pmz', 'lib', 'bash-guard.js'], ['pmz', 'lib', 'ledger.js'],
    ['pmz', 'scripts', 'backlog.js'], ['pmz', 'templates', 'rules.yaml'],
    ['command', 'pmz', 'about.md'], ['command', 'pmz', 'help.md'],
    ['command', 'pmz', 'init.md'], ['command', 'pmz', 'check-context.md'],
  ]) {
    ok(fs.existsSync(path.join(TARGET, ...f)), 'arbo : ' + f.join('/'));
  }
  ok(!fs.existsSync(path.join(TARGET, 'opencode.json')), 'install : ne crée jamais opencode.json');
  ok(summary && summary.commands === 4, 'install : résumé JSON — 4 commandes /pmz vendorées');

  section('Commande /pmz help — dérivée des commandes réellement installées (layout OpenCode)');
  const helpOut = runNode(path.join(TARGET, 'pmz', 'scripts', 'help.js'), []);
  ok(helpOut.code === 0, 'help.js : exit 0 sous le layout OpenCode');
  for (const name of ['about', 'help', 'init', 'check-context']) {
    ok(helpOut.out.includes(`**${name}**`), 'help.js : liste la commande ' + name);
  }

  section('Install — idempotence (2× sans diff) + état préservé + tiers intouchés');
  const snap1 = treeSnapshot(TARGET);
  // Un état utilisateur et un plugin/une commande tiers doivent survivre à la réinstall.
  fs.mkdirSync(path.join(TARGET, 'pmz', 'state'), { recursive: true });
  fs.writeFileSync(path.join(TARGET, 'pmz', 'state', 'marker.txt'), 'préservé');
  fs.writeFileSync(path.join(TARGET, 'plugin', 'tiers.js'), '// plugin tiers');
  fs.mkdirSync(path.join(TARGET, 'command', 'autre'), { recursive: true });
  fs.writeFileSync(path.join(TARGET, 'command', 'autre', 'x.md'), 'commande tierce');
  r = runNode(INSTALL, ['--target', TARGET, '--json']);
  ok(r.code === 0, 'réinstall : exit 0');
  const snap2 = treeSnapshot(TARGET);
  delete snap2[path.join('plugin', 'tiers.js')];
  delete snap2[path.join('command', 'autre', 'x.md')];
  ok(sameSnapshot(snap1, snap2), 'réinstall : arbo strictement identique (state exclu)');
  ok(fs.readFileSync(path.join(TARGET, 'pmz', 'state', 'marker.txt'), 'utf8') === 'préservé',
    'réinstall : pmz/state/ préservé');
  ok(fs.existsSync(path.join(TARGET, 'plugin', 'tiers.js')), 'réinstall : plugin tiers intouché');
  ok(fs.existsSync(path.join(TARGET, 'command', 'autre', 'x.md')), 'réinstall : commande tierce intouchée');

  // ============ B. CHARGEMENT DU PLUGIN (client mock) ============
  section('Plugin — chargement, hooks présents, aucun throw (payloads vides/malformés/valides)');
  const toasts = [];
  const client = { tui: { showToast: async (o) => { toasts.push(o); return true; } } };
  const input = { client, project: {}, directory: PROJ, worktree: PROJ, serverUrl: null, $: null };
  let mod = null; let hooks = null;
  try {
    mod = await import(pathToFileURL(path.join(TARGET, 'plugin', 'pmz.js')).href);
    hooks = await mod.PmzPlugin(input);
  } catch (e) { console.log('  (import : ' + e.message + ')'); }
  ok(mod && typeof mod.PmzPlugin === 'function', 'loader : export PmzPlugin');
  const EXPECTED = ['event', 'chat.message', 'tool.execute.before', 'tool.execute.after',
    'permission.ask', 'experimental.session.compacting'];
  ok(hooks && EXPECTED.every((h) => typeof hooks[h] === 'function'),
    'hooks : les 6 points d\'accroche cibles sont branchés');

  if (hooks) {
    let threw = null;
    const payloads = {
      'event': [[], [{}], [{ event: null }], [{ event: { type: 42 } }], [{ event: { type: 'session.idle' } }]],
      'chat.message': [[], [null, null], [{ sessionID: 's1', model: { providerID: 'ollama', modelID: 'qwen3.5:9b' } }, { message: {}, parts: [] }]],
      'tool.execute.before': [[], [null, null], [{ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: { command: 'ls' } }]],
      'tool.execute.after': [[], [{ tool: 'read' }, { title: '', output: '', metadata: {} }]],
      'permission.ask': [[], [{}, { status: 'ask' }]],
      'experimental.session.compacting': [[], [{ sessionID: 's1' }, { context: [] }]],
    };
    for (const [hook, calls] of Object.entries(payloads)) {
      for (const args of calls) {
        try { await hooks[hook].apply(null, args); } catch (e) { threw = hook + ' : ' + e.message; }
      }
    }
    ok(!threw, 'fail-open : aucun handler ne throw (' + (threw || 'ok') + ')');

    section('Instrumentation — journal + toast session.created');
    await hooks.event({ event: { type: 'session.created' } });
    ok(toasts.length === 1 && toasts[0].body && /PMZ v\d+\.\d+\.\d+ actif/.test(toasts[0].body.message),
      'toast : « PMZ v<version> actif » émis sur session.created');
    const logFile = path.join(TARGET, 'pmz', 'state', 'plugin.log');
    let lines = [];
    try { lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch (_) {}
    ok(lines.some((l) => l.hook === 'plugin.loaded' && /^\d+\.\d+\.\d+$/.test(l.version)), 'journal : plugin.loaded + version');
    ok(lines.some((l) => l.hook === 'event' && l.type === 'session.created'), 'journal : event session.created');
    ok(lines.some((l) => l.hook === 'chat.message' && l.model === 'ollama/qwen3.5:9b'), 'journal : chat.message + modèle');
    ok(lines.some((l) => l.hook === 'tool.execute.before' && l.tool === 'bash'), 'journal : tool.execute.before');
    ok(lines.every((l) => l.hook !== 'event' || /^(session\.|permission\.|file\.edited|command\.executed)/.test(l.type)),
      'journal : seuls les événements de la whitelist sont journalisés');

    section('Fail-open — client toast cassé, journal indisponible');
    const badClient = { tui: { showToast: async () => { throw new Error('boom'); } } };
    const hooksBad = await mod.PmzPlugin(Object.assign({}, input, { client: badClient }));
    let threwBad = false;
    try { await hooksBad.event({ event: { type: 'session.created' } }); } catch (_) { threwBad = true; }
    ok(!threwBad, 'toast en échec : avalé, pas de throw');
    // Journal rendu inutilisable (un dossier à la place du fichier) → toujours pas de throw.
    fs.rmSync(logFile, { force: true });
    fs.mkdirSync(logFile, { recursive: true });
    let threwLog = false;
    try { await hooks.event({ event: { type: 'session.idle' } }); } catch (_) { threwLog = true; }
    ok(!threwLog, 'journal inutilisable : avalé, pas de throw');
    fs.rmSync(logFile, { recursive: true, force: true });
  }

  // ============ B2. GARDE BASH — lot OC2 ============
  if (hooks) {
    section('Garde Bash — matrice deny/ask/allow (tool.execute.before + permission.ask)');
    async function before(cmd) {
      let threw = null;
      try { await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: { command: cmd } }); }
      catch (e) { threw = e; }
      return threw;
    }
    async function ask(cmd, initialStatus) {
      const out = { status: initialStatus || 'allow' };
      await hooks['permission.ask']({ type: 'bash', metadata: { command: cmd }, sessionID: 's1' }, out);
      return out.status;
    }
    // DENY — catastrophique : bloqué en amont, jamais exécuté.
    ok(await before('rm -rf /') !== null, 'deny : rm -rf / -> throw (tool.execute.before)');
    ok(await before('rm -rf ~') !== null, 'deny : rm -rf ~ -> throw (tool.execute.before)');
    ok(await before('mkfs.ext4 /dev/sda1') !== null, 'deny : mkfs -> throw (tool.execute.before)');
    ok(await ask('rm -rf /', 'allow') === 'deny', 'deny : rm -rf / -> status deny (permission.ask)');
    // ASK — destructif non catastrophique : jamais bloqué en amont (pas de canal synchrone),
    // mais resserré en ask côté permission.ask si un contrôle de permission se déclenche.
    ok(await before('rm -rf ./build') === null, 'ask : rm -rf ./build -> pas de throw (tool.execute.before)');
    ok(await before('git reset --hard HEAD~1') === null, 'ask : git reset --hard -> pas de throw (tool.execute.before)');
    ok(await ask('rm -rf ./build', 'allow') === 'ask', 'ask : rm -rf ./build -> status ask (permission.ask)');
    ok(await ask('git reset --hard', 'allow') === 'ask', 'ask : git reset --hard -> status ask (permission.ask)');
    ok(await ask('git reset --hard', 'ask') === 'ask', 'ask : ne dégrade jamais un statut déjà strict');
    // ALLOW — commande anodine : jamais touchée.
    ok(await before('ls -la') === null, 'allow : ls -la -> pas de throw');
    ok(await before('npm test') === null, 'allow : npm test -> pas de throw');
    ok(await ask('ls -la', 'allow') === 'allow', 'allow : ls -la -> status inchangé (permission.ask)');

    section('Ledgers — lecture/édition simulées (tool.execute.after)');
    const vibeDir = path.join(PROJ, '.vibe-agent');
    fs.rmSync(vibeDir, { recursive: true, force: true });
    const sample = path.join(PROJ, 'sample.txt');
    fs.writeFileSync(sample, 'contenu');
    ok(!fs.existsSync(vibeDir), 'préalable : .vibe-agent absent avant lecture');
    await hooks['tool.execute.after'](
      { tool: 'read', sessionID: 's1', callID: 'c1', args: { filePath: sample } },
      { title: '', output: 'contenu', metadata: {} }
    );
    ok(fs.existsSync(vibeDir), 'ledger : une lecture crée .vibe-agent/');
    let readLedger = null;
    try { readLedger = JSON.parse(fs.readFileSync(path.join(vibeDir, 'read-ledger.json'), 'utf8')); } catch (_) {}
    ok(readLedger && readLedger.reads.some((r) => r.path === 'sample.txt'), 'ledger : read-ledger.json référence sample.txt');
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: 's1', callID: 'c2', args: { filePath: sample } },
      { title: '', output: '', metadata: {} }
    );
    let ctxLedger = null;
    try { ctxLedger = JSON.parse(fs.readFileSync(path.join(vibeDir, 'context-ledger.json'), 'utf8')); } catch (_) {}
    ok(ctxLedger && Object.prototype.hasOwnProperty.call(ctxLedger.files_modified, 'sample.txt'),
      'ledger : context-ledger.json référence sample.txt modifié');
    await hooks['tool.execute.after'](
      { tool: 'todowrite', sessionID: 's1', callID: 'c3', args: { todos: [{ content: 'x', status: 'pending' }] } },
      { title: '', output: '', metadata: {} }
    );
    let snap = null;
    try { snap = JSON.parse(fs.readFileSync(path.join(vibeDir, 'todo-snapshot.json'), 'utf8')); } catch (_) {}
    ok(snap && Array.isArray(snap.todos) && snap.todos.length === 1, 'ledger : todowrite -> todo-snapshot.json');
    fs.rmSync(vibeDir, { recursive: true, force: true });
    fs.rmSync(sample, { force: true });

    section('Fail-open — garde Bash sur payloads vides/malformés');
    let threwGuard = null;
    try {
      await hooks['tool.execute.before']({}, {});
      await hooks['tool.execute.before'](null, null);
      await hooks['tool.execute.after']({}, {});
      await hooks['permission.ask']({}, {});
    } catch (e) { threwGuard = e; }
    ok(!threwGuard, 'garde Bash : payloads vides/malformés -> aucun throw hors deny volontaire');
  }

  section('Kill-switch PMZ_DISABLE=1');
  process.env.PMZ_DISABLE = '1';
  const disabled = mod ? await mod.PmzPlugin(input) : null;
  ok(disabled && Object.keys(disabled).length === 0, 'PMZ_DISABLE : le loader rend un plugin sans hooks');
  if (hooks) {
    const before = toasts.length;
    await hooks.event({ event: { type: 'session.created' } });
    ok(toasts.length === before, 'PMZ_DISABLE : les handlers déjà branchés deviennent inertes');
  }
  delete process.env.PMZ_DISABLE;

  // ============ C. DOCTOR + UNINSTALL ============
  section('Doctor');
  r = runNode(DOCTOR, ['--target', TARGET, '--json']);
  let diag = null;
  try { diag = JSON.parse(r.out); } catch (_) {}
  ok(r.code === 0 && diag && diag.ok === true, 'doctor : ok sur une install saine');
  r = runNode(DOCTOR, ['--target', path.join(SANDBOX, 'vide'), '--json']);
  try { diag = JSON.parse(r.out); } catch (_) { diag = null; }
  ok(r.code === 1 && diag && diag.ok === false, 'doctor : échec (exit 1) sur cible vide');

  section('Uninstall — ne retire que le périmètre PMZ');
  r = runNode(UNINSTALL, ['--target', TARGET, '--json']);
  ok(r.code === 0, 'uninstall : exit 0');
  ok(!fs.existsSync(path.join(TARGET, 'plugin', 'pmz.js')) && !fs.existsSync(path.join(TARGET, 'pmz')) &&
    !fs.existsSync(path.join(TARGET, 'command', 'pmz')), 'uninstall : plugin/pmz.js, pmz/, command/pmz retirés');
  ok(fs.existsSync(path.join(TARGET, 'plugin', 'tiers.js')) && fs.existsSync(path.join(TARGET, 'command', 'autre', 'x.md')),
    'uninstall : plugin et commande tiers préservés');

  // ============ RÉSUMÉ ============
  console.log(`\n${'='.repeat(50)}`);
  console.log(`OpenCode — Résultat : ${pass} OK · ${fail} échec(s)`);
  if (fail) { console.log('Échecs :'); failures.forEach((f) => console.log('  - ' + f)); }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Harnais OpenCode en échec :', e); process.exit(1); });
