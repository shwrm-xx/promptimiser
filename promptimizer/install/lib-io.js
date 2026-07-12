'use strict';
// Lecture synchrone d'une ligne sur stdin, partagée par les cores d'install
// (install/doctor/uninstall/package). Stdlib seule, cross-platform.
// N'est appelée qu'en contexte interactif (TTY) ; en test/pipe, les appelants
// court-circuitent via isTTY et ne l'invoquent pas.
const fs = require('fs');

function readLineSync() {
  const buf = Buffer.alloc(1024);
  let s = '';
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      // EAGAIN : stdin non bloquant (pipe) → on réessaie une fois, sinon on rend ce qu'on a.
      if (e && e.code === 'EAGAIN') { continue; }
      break;
    }
    if (n === 0) break;
    s += buf.toString('utf8', 0, n);
    if (s.indexOf('\n') !== -1) break;
  }
  return s.replace(/\r?\n[\s\S]*$/, '').trim();
}

module.exports = { readLineSync };
