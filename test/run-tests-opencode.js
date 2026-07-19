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
    ['command', 'pmz', 'budget.md'], ['command', 'pmz', 'scope.md'],
    ['command', 'pmz', 'close-batch.md'], ['command', 'pmz', 'fresh-session.md'],
  ]) {
    ok(fs.existsSync(path.join(TARGET, ...f)), 'arbo : ' + f.join('/'));
  }
  ok(!fs.existsSync(path.join(TARGET, 'opencode.json')), 'install : ne crée jamais opencode.json');
  ok(summary && summary.commands === 8, 'install : résumé JSON — 8 commandes /pmz vendorées');

  section('Commandes /pmz — chemins réécrits vers le layout OpenCode (pas de ~/.claude)');
  for (const name of ['budget', 'scope', 'close-batch', 'fresh-session']) {
    const md = fs.readFileSync(path.join(TARGET, 'command', 'pmz', name + '.md'), 'utf8');
    ok(!/~\/\.claude/.test(md), 'commande ' + name + ' : aucun chemin ~/.claude résiduel');
    ok(!/allowed-tools/.test(md), 'commande ' + name + ' : frontmatter allowed-tools (Claude Code) retiré');
  }
  ok(/~\/\.config\/opencode\/pmz\/scripts\/audit-context\.js/.test(
    fs.readFileSync(path.join(TARGET, 'command', 'pmz', 'budget.md'), 'utf8')),
    'commande budget : pointe vers pmz/scripts/audit-context.js (layout OpenCode)');
  ok(/~\/\.config\/opencode\/pmz\/templates\/handoff-template\.md/.test(
    fs.readFileSync(path.join(TARGET, 'command', 'pmz', 'fresh-session.md'), 'utf8')),
    'commande fresh-session : pointe vers pmz/templates/handoff-template.md');

  section('Commande /pmz help — dérivée des commandes réellement installées (layout OpenCode)');
  const helpOut = runNode(path.join(TARGET, 'pmz', 'scripts', 'help.js'), []);
  ok(helpOut.code === 0, 'help.js : exit 0 sous le layout OpenCode');
  for (const name of ['about', 'help', 'init', 'check-context', 'budget', 'scope', 'close-batch', 'fresh-session']) {
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

  // ============ B3. OC3 — occupation relative + idle + injection ============
  if (mod) {
    // Projet git dédié (writeAutoHandoff a besoin d'un repo + d'un commit).
    const PROJ3 = path.join(SANDBOX, 'proj3');
    fs.mkdirSync(PROJ3, { recursive: true });
    const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    function git3(args) {
      try { execFileSync('git', args, { cwd: PROJ3, stdio: 'pipe', env: Object.assign({}, process.env, gitEnv) }); return true; } catch (_) { return false; }
    }
    git3(['init']); git3(['config', 'user.email', 't@t']); git3(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(PROJ3, 'README.md'), '# proj3\n');
    git3(['add', '-A']); git3(['commit', '-m', 'init']);

    // Client enrichi : catalogue de modèles (fenêtre utile = 120k − 20k = 100k) + API messages.
    const toasts3 = [];
    const renames = [];
    const LIMIT = { context: 120000, output: 20000 }; // useful = 100000
    const client3 = {
      tui: { showToast: async (o) => { toasts3.push(o); return true; } },
      config: { providers: async () => ({ data: { providers: [{ id: 'test', models: { m1: { limit: LIMIT } } }], default: {} } }) },
      session: {
        messages: async ({ path: p }) => {
          const sid = p && p.id;
          if (sid === 'sF') return { data: [{ info: { role: 'assistant', sessionID: 'sF', providerID: 'test', modelID: 'm1', tokens: { input: 60000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } }] };
          return { data: [] };
        },
        update: async ({ path: p, body }) => { renames.push({ id: p && p.id, title: body && body.title }); return { data: {} }; },
      },
    };
    const input3 = { client: client3, project: {}, directory: PROJ3, worktree: PROJ3, serverUrl: null, $: null };
    const hooks3 = await mod.PmzPlugin(input3);
    const occMod = require(path.join(TARGET, 'pmz', 'impl', 'occupancy-oc.js'));

    function occToasts() { return toasts3.filter((t) => t.body && /% de la fenêtre utile/.test(t.body.message)); }
    async function feed(sid, occTokens) {
      await hooks3.event({ event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: sid, providerID: 'test', modelID: 'm1', tokens: { input: occTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } } });
    }
    async function idle3(sid) { await hooks3.event({ event: { type: 'session.idle', properties: { sessionID: sid } } }); }

    section('OC3 — occupation relative : paliers 50/70/85/95 % de la fenêtre utile');
    const before = occToasts().length;
    await feed('sB', 40000); await idle3('sB');
    ok(occToasts().length - before === 0, 'palier : 40 % (< 50 %) -> aucun toast');
    await feed('sB', 55000); await idle3('sB');
    ok(occToasts().length - before === 1, 'palier : franchissement 50 % -> 1 toast');
    await feed('sB', 72000); await idle3('sB');
    await feed('sB', 88000); await idle3('sB');
    await feed('sB', 96000); await idle3('sB');
    ok(occToasts().length - before === 4, 'paliers : 50/70/85/95 % franchis -> 4 toasts au total');
    const lastMsg = occToasts()[occToasts().length - 1].body.message;
    ok(/≈ 96 %/.test(lastMsg), 'palier : le toast rapporte le % relatif (≈ 96 %)');

    section('OC3 — session.idle idempotent (multi-idle sans nouveau message)');
    const n1 = occToasts().length;
    await idle3('sB'); await idle3('sB');
    ok(occToasts().length === n1, 'idle idempotent : re-idle sans nouveau message -> pas de re-toast');

    section('OC3 — handoff écrit à l\'idle (.vibe-agent/handoff.md)');
    const handoffFile = path.join(PROJ3, '.vibe-agent', 'handoff.md');
    ok(fs.existsSync(handoffFile), 'handoff : session.idle écrit .vibe-agent/handoff.md');
    let handoffTxt = '';
    try { handoffTxt = fs.readFileSync(handoffFile, 'utf8'); } catch (_) {}
    ok(/pmz:handoff:auto/.test(handoffTxt), 'handoff : marqueur pmz:handoff:auto présent');

    section('OC3 — renommage de session (client.session.update, 1× par session)');
    const sbRenames = renames.filter((r) => r.id === 'sB');
    ok(sbRenames.length === 1, 'renommage : client.session.update appelé exactement 1× malgré N idles');
    ok(sbRenames.length === 1 && typeof sbRenames[0].title === 'string' && sbRenames[0].title.length > 0,
      'renommage : un titre non vide est passé à session.update');

    section('OC3 — fallback occupation via client.session.messages (pas de message.updated)');
    const nF = occToasts().length;
    await idle3('sF'); // aucun message.updated préalable pour sF -> fallback API
    ok(occToasts().length - nF === 1, 'fallback : 60 % via session.messages -> 1 toast');

    section('OC3 — resync post-compaction réarme les paliers');
    await feed('sC', 96000); await idle3('sC');
    const nC = occToasts().length;
    await hooks3.event({ event: { type: 'session.compacted', properties: { sessionID: 'sC' } } });
    ok(occMod.readRecord('sC') === null, 'compaction : occ enregistrée effacée');
    await feed('sC', 55000); await idle3('sC');
    ok(occToasts().length - nC === 1, 'compaction : palier réarmé -> 55 % re-franchi après compaction');

    section('OC3 — rappel de clôture à l\'idle (tree modifié) + anti-spam par lot');
    const nCl = toasts3.length;
    fs.writeFileSync(path.join(PROJ3, 'work.txt'), 'wip'); // tree devient « meaningful »
    await idle3('sCL');
    const cl1 = toasts3.slice(nCl).filter((t) => t.body && /sans clôture/.test(t.body.message));
    ok(cl1.length === 1, 'clôture : tree modifié -> 1 toast de rappel');
    await idle3('sCL');
    const cl2 = toasts3.slice(nCl).filter((t) => t.body && /sans clôture/.test(t.body.message));
    ok(cl2.length === 1, 'clôture : anti-spam -> pas de 2e rappel pour le même lot');

    section('OC3 — injection différée (session.created -> 1er chat.message)');
    await hooks3.event({ event: { type: 'session.created', properties: { info: { id: 'sI2', title: '' } } } });
    ok(occMod.takePending('sI2') !== null, 'created : injection mise en file');
    // takePending ci-dessus a consommé la file : on re-crée pour tester le flush via chat.message.
    await hooks3.event({ event: { type: 'session.created', properties: { info: { id: 'sI2', title: '' } } } });
    const out1 = { message: { id: 'um1', sessionID: 'sI2' }, parts: [] };
    await hooks3['chat.message']({ sessionID: 'sI2', model: { providerID: 'test', modelID: 'm1' } }, out1);
    ok(out1.parts.length === 1 && out1.parts[0].type === 'text' && out1.parts[0].synthetic === true,
      'injection : 1er chat.message reçoit une part texte synthétique');
    ok(/Promptimizer actif/.test(out1.parts[0].text), 'injection : la gouvernance PMZ est injectée');
    const out2 = { message: { id: 'um2', sessionID: 'sI2' }, parts: [] };
    await hooks3['chat.message']({ sessionID: 'sI2' }, out2);
    ok(out2.parts.length === 0, 'injection : 2e chat.message ne ré-injecte pas (file consommée)');

    section('OC3 — fail-open : catalogue de modèles indisponible');
    const clientBad = { tui: { showToast: async () => true }, config: { providers: async () => { throw new Error('boom'); } } };
    const hooksBad = await mod.PmzPlugin(Object.assign({}, input3, { client: clientBad }));
    let threwOcc = false;
    try {
      await hooksBad.event({ event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: 'sX', providerID: 'test', modelID: 'm1', tokens: { input: 96000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } } });
      await hooksBad.event({ event: { type: 'session.idle', properties: { sessionID: 'sX' } } });
    } catch (_) { threwOcc = true; }
    ok(!threwOcc, 'fail-open : providers() en échec -> aucun throw, pas d\'alerte relative');

    // ============ B4. NUDGES chat.message — lot OC4 ============
    section('OC4 — nudges init/broad/model-mismatch (chat.message)');
    const backlog4 = require(path.join(TARGET, 'pmz', 'lib', 'backlog.js'));
    const PROJ4 = path.join(SANDBOX, 'proj4');
    fs.mkdirSync(PROJ4, { recursive: true });
    function git4(args) {
      try { execFileSync('git', args, { cwd: PROJ4, stdio: 'pipe', env: Object.assign({}, process.env, gitEnv) }); return true; } catch (_) { return false; }
    }
    git4(['init']); git4(['config', 'user.email', 't@t']); git4(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(PROJ4, 'README.md'), '# proj4\n'); // pas de CLAUDE.md -> non « fully initialized »
    git4(['add', '-A']); git4(['commit', '-m', 'init']);
    // Catalogue à 2 modèles anthropic (opus + sonnet) : permet de distinguer un hint résoluble
    // qui diffère du réel (nudge) d'un hint absent du catalogue (ignoré en silence).
    const client4 = {
      tui: { showToast: async () => true },
      config: { providers: async () => ({ data: { providers: [{ id: 'anthropic', models: { 'claude-opus-4-8': { limit: LIMIT }, 'claude-sonnet-5': { limit: LIMIT } } }] } }) },
    };
    const input4 = { client: client4, project: {}, directory: PROJ4, worktree: PROJ4, serverUrl: null, $: null };
    const hooks4 = await mod.PmzPlugin(input4);
    async function feed4(sid, modelID) {
      await hooks4.event({ event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: sid, providerID: 'anthropic', modelID, tokens: { input: 5000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } } });
    }
    async function chat4(sid, text) {
      const out = { message: { id: 'm-' + sid, sessionID: sid }, parts: text ? [{ type: 'text', text }] : [] };
      await hooks4['chat.message']({ sessionID: sid }, out);
      const inj = out.parts.filter((p) => p && p.synthetic);
      return inj.length ? inj[0].text : '';
    }

    // Nudge « demande trop large » (aucun plan encore) + anti-spam 1×/session.
    const tBroad = await chat4('n1', 'refactor complet du projet partout, et aussi le reste');
    ok(/Demande potentiellement large/.test(tBroad), 'broad : nudge de découpage injecté');
    const tBroad2 = await chat4('n1', 'encore un refactor global partout tant qu\'on y est');
    ok(tBroad2 === '', 'broad : anti-spam 1×/session (pas de 2e nudge)');

    // Nudge « init avant code » sur projet non initialisé (pas de CLAUDE.md).
    const tInit = await chat4('n2', 'initialise un nouveau projet from scratch');
    ok(tInit !== '', 'init : nudge injecté sur projet non initialisé + prompt d\'init');

    // Model-mismatch : hint « opus » résoluble (catalogue), réel « sonnet » -> nudge.
    backlog4.addLot(PROJ4, 'Lot mismatch', 'fait quand : ok', 'opus', null, null, 'medium');
    backlog4.startLot(PROJ4, backlog4.loadBacklog(PROJ4).lots[0].id);
    await feed4('n3', 'claude-sonnet-5');
    const tMis = await chat4('n3', 'continue le travail');
    ok(/≠ modèle préconisé/.test(tMis), 'model-mismatch : hint opus résoluble ≠ réel sonnet -> nudge');
    const tMis2 = await chat4('n3', 'toujours');
    ok(!/≠ modèle préconisé/.test(tMis2), 'model-mismatch : anti-spam 1×/session');

    // Réel == préconisé (hint opus, réel opus) -> aucun nudge.
    await feed4('n3b', 'claude-opus-4-8');
    const tMatch = await chat4('n3b', 'continue');
    ok(!/≠ modèle préconisé/.test(tMatch), 'model-mismatch : réel == préconisé -> pas de nudge');

    // Hint non résoluble par le catalogue courant (« gpt-4o » absent) -> ignoré en silence.
    const bfile4 = path.join(PROJ4, '.vibe-agent', 'backlog.json');
    const bj4 = JSON.parse(fs.readFileSync(bfile4, 'utf8'));
    bj4.lots[0].model_hint = 'gpt-4o';
    fs.writeFileSync(bfile4, JSON.stringify(bj4));
    await feed4('n4', 'claude-sonnet-5');
    const tUnres = await chat4('n4', 'continue');
    ok(!/≠ modèle préconisé/.test(tUnres), 'model-mismatch : hint non résoluble (gpt-4o) -> ignoré en silence');

    // ============ B5. OC — coût par lot + preuve à l'auto-clôture (lot #54) ============
    section('OC (#54) — coût réel par lot à l\'idle (watermark anti-double-comptage)');
    const PROJ54 = path.join(SANDBOX, 'proj54');
    fs.mkdirSync(PROJ54, { recursive: true });
    function git54(args) {
      try { execFileSync('git', args, { cwd: PROJ54, stdio: 'pipe', env: Object.assign({}, process.env, gitEnv) }); return true; } catch (_) { return false; }
    }
    git54(['init']); git54(['config', 'user.email', 't@t']); git54(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(PROJ54, 'README.md'), '# proj54\n');
    fs.writeFileSync(path.join(PROJ54, 'CHANGELOG.md'), '# Changelog\n');
    git54(['add', '-A']); git54(['commit', '-m', 'init']);

    const toasts54 = [];
    const client54 = {
      tui: { showToast: async (o) => { toasts54.push(o); return true; } },
      config: { providers: async () => ({ data: { providers: [{ id: 'test', models: { m1: { limit: LIMIT } } }] } }) },
    };
    const input54 = { client: client54, project: {}, directory: PROJ54, worktree: PROJ54, serverUrl: null, $: null };
    const hooks54 = await mod.PmzPlugin(input54);
    const backlog54 = require(path.join(TARGET, 'pmz', 'lib', 'backlog.js'));
    // Un lot in_progress à créditer, doté d'un verify (échouant) rejoué à l'auto-clôture.
    backlog54.addLot(PROJ54, 'Lot coût', 'fait quand : ok', null, null, 'exit 1', 'medium');
    backlog54.startLot(PROJ54, backlog54.loadBacklog(PROJ54).lots[0].id);
    function cost54() { return backlog54.loadBacklog(PROJ54).lots[0].cost_tokens; }
    // Feeder avec tokens de SORTIE + id de message distinct (le watermark anti-double-comptage).
    async function feedOut(sid, mid, outTokens) {
      await hooks54.event({ event: { type: 'message.updated', properties: { info: { id: mid, role: 'assistant', sessionID: sid, providerID: 'test', modelID: 'm1', tokens: { input: 5000, output: outTokens, reasoning: 0, cache: { read: 0, write: 0 } } } } } });
    }
    async function idle54(sid) { await hooks54.event({ event: { type: 'session.idle', properties: { sessionID: sid } } }); }
    function costToasts54() { return toasts54.filter((t) => t.body && /tokens de sortie cumulés/.test(t.body.message)); }

    await feedOut('sK', 'msgA', 30000); await idle54('sK');
    ok(cost54() === 30000, 'coût : 1er idle crédite le lot in_progress de 30k tokens de sortie');
    await idle54('sK'); // double idle SANS nouveau message -> pas de re-comptage (watermark)
    ok(cost54() === 30000, 'coût : double idle sur le même message -> pas de double comptage (watermark)');
    await feedOut('sK', 'msgB', 20000); await idle54('sK');
    ok(cost54() === 50000, 'coût : un nouveau message (id distinct) crédite à nouveau (50k)');

    section('OC (#54) — toast au franchissement du budget 250k, 1×/lot·session');
    const nCost = costToasts54().length;
    await feedOut('sK', 'msgC', 260000); await idle54('sK'); // 50k + 260k = 310k >= 250k
    ok(costToasts54().length - nCost === 1, 'coût : franchissement 250k -> 1 toast budget');
    ok(costToasts54()[costToasts54().length - 1].body.variant === 'warning', 'coût : toast budget en variant warning');
    await feedOut('sK', 'msgD', 10000); await idle54('sK');
    ok(costToasts54().length - nCost === 1, 'coût : anti-spam 1×/lot·session (pas de 2e toast budget)');

    section('OC (#54) — preuve à l\'auto-clôture idle : verify + garde-fou CHANGELOG (non bloquant)');
    // Tree sale -> rappel de clôture (arme closure_reminded_for_batch pour la session sV).
    fs.writeFileSync(path.join(PROJ54, 'work.txt'), 'wip');
    await idle54('sV');
    // Tree propre (commit ne touchant PAS le CHANGELOG) -> auto-clôture univoque -> verify rejoué.
    git54(['add', '-A']); git54(['commit', '-m', 'feat: work']);
    const nProof = toasts54.length;
    await idle54('sV');
    const proofT = toasts54.slice(nProof).filter((t) => t.body && /Verify du lot/.test(t.body.message));
    ok(proofT.length === 1, 'auto-clôture : verify rejoué -> 1 toast de preuve');
    ok(proofT.length === 1 && /ÉCHEC/.test(proofT[0].body.message) && proofT[0].body.variant === 'warning',
      'auto-clôture : verify en échec -> toast distinct (warning)');
    ok(proofT.length === 1 && /CHANGELOG/.test(proofT[0].body.message),
      'auto-clôture : commit sans CHANGELOG -> garde-fou CHANGELOG dans la preuve');
    ok(backlog54.loadBacklog(PROJ54).lots[0].status === 'done',
      'auto-clôture : le lot est marqué done malgré l\'échec du verify (clôture jamais bloquée)');

    section('OC (#54) — fail-open : aucun record de coût (pas de message) -> pas de crash ni crédit');
    const before54 = cost54();
    let threw54 = false;
    try { await idle54('sZ'); } catch (_) { threw54 = true; }
    ok(!threw54 && cost54() === before54, 'coût : idle sans message assistant -> aucun throw, aucun crédit');
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
