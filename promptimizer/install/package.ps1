# Lanceur Windows — toute la logique est dans package.js (source de vérité unique cross-platform).
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "ERREUR : 'node' introuvable dans le PATH. Installe Node.js (nodejs.org) puis relance."
  Read-Host "Appuie sur Entree pour fermer"
  exit 1
}
& node (Join-Path $dir 'package.js') @args
exit $LASTEXITCODE
