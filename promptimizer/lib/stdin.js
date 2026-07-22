'use strict';
// Lecture/parse fail-silent du JSON stdin d'un hook. Ne jette jamais.
const fs = require('fs');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function parseHookInput() {
  try {
    const raw = readStdin();
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

module.exports = { readStdin, parseHookInput };
