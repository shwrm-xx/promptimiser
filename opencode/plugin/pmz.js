// Loader PMZ pour OpenCode — déployé dans <config opencode>/plugin/pmz.js par
// install-opencode.js. Fin par contrat : résout l'implémentation CJS (…/pmz/impl)
// et lui délègue tout. Fail-open absolu : la moindre erreur rend un plugin sans
// hooks — jamais de throw, jamais de session cassée. Kill-switch : PMZ_DISABLE=1.
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

export const PmzPlugin = async (input) => {
  try {
    if (process.env.PMZ_DISABLE === "1") return {}
    const here = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.join(here, "..", "pmz", "impl", "index.js"), // layout installé
      path.join(here, "impl", "index.js"), // source du dépôt (dev)
    ]
    const impl = candidates.find((f) => fs.existsSync(f))
    if (!impl) return {}
    const require = createRequire(import.meta.url)
    return await require(impl).createHooks(input)
  } catch (_) {
    return {}
  }
}
