'use strict';
// Notifications OS opt-in (lot #75) — sur événement grave (zone rouge / clôture de lot),
// une notification native (mac/linux/win) relaie le signal en dehors du terminal (utile
// quand la fenêtre n'est pas au premier plan). Opt-in strict (PMZ_NOTIFY=1) : par défaut
// aucune notification n'est envoyée, le systemMessage reste le seul canal. Fail-open total :
// toute erreur (outil absent, spawn qui échoue, plateforme non gérée) -> no-op silencieux,
// jamais d'exception vers le hook appelant.

function enabled() {
  return process.env.PMZ_NOTIFY === '1';
}

// Échappe pour AppleScript (guillemets doubles) et PowerShell (guillemets simples doublés) —
// les deux syntaxes entourent notre texte de leur propre type de guillemet.
function escDouble(s) {
  return String(s).replace(/"/g, '\\"');
}
function escSingle(s) {
  return String(s).replace(/'/g, "''");
}

function winScript(title, body) {
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$textNodes = $template.GetElementsByTagName('text')",
    `$textNodes.Item(0).AppendChild($template.CreateTextNode('${escSingle(title)}')) > $null`,
    `$textNodes.Item(1).AppendChild($template.CreateTextNode('${escSingle(body)}')) > $null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Promptimizer').Show($toast)",
  ].join('\n');
}

// Renvoie { cmd, args } pour la plateforme donnée, ou null si non gérée (repli silencieux
// côté send() — pas de liste de plateformes supportées à maintenir ailleurs).
function commandFor(platform, title, body) {
  if (platform === 'darwin') {
    return { cmd: 'osascript', args: ['-e', `display notification "${escDouble(body)}" with title "${escDouble(title)}"`] };
  }
  if (platform === 'linux') {
    return { cmd: 'notify-send', args: [title, body] };
  }
  if (platform === 'win32') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', winScript(title, body)] };
  }
  return null;
}

// spawnImpl injectable (lot #75 : « lanceurs stubés ») — les tests passent un stub pour
// vérifier cmd/args sans jamais déclencher de vraie notification OS.
function send(title, body, opts) {
  const o = opts || {};
  try {
    if (!enabled()) return false;
    const platform = o.platform || process.platform;
    const c = commandFor(platform, title, body);
    if (!c) return false;
    const spawnImpl = o.spawn || require('child_process').spawn;
    const child = spawnImpl(c.cmd, c.args, { detached: true, stdio: 'ignore' });
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch (_) {
    return false; // fail-open : jamais d'exception vers le hook appelant
  }
}

function notifyRedZone(opts) {
  return send('Promptimizer — zone rouge', 'Contexte proche de la limite : clôture + handoff recommandés avant compaction.', opts);
}

function notifyLotClosed(lot, opts) {
  const label = lot && lot.title ? `#${lot.id} — ${lot.title}` : 'lot';
  return send('Promptimizer — lot clôturé', label, opts);
}

// Vigies de vague (lot #80, D3 §Signal) — relaient hors terminal les frontières de la
// réintégration : un lot fille prêt à merger, et une vague entièrement close.
function notifyLotReady(lot, opts) {
  const label = lot && lot.title ? `#${lot.id} — ${lot.title}` : 'lot';
  return send('Promptimizer — lot prêt à merger', label, opts);
}

function notifyWaveClosed(wave, opts) {
  const n = wave && Number.isFinite(wave.count) ? wave.count : null;
  const branch = wave && wave.branch ? ` sur ${wave.branch}` : '';
  const body = n != null ? `${n} lot(s) réintégré(s)${branch} — vague close.` : `Vague close${branch}.`;
  return send('Promptimizer — vague close', body, opts);
}

module.exports = { enabled, send, commandFor, notifyRedZone, notifyLotClosed, notifyLotReady, notifyWaveClosed };
