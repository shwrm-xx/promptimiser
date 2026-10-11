// Bande epicmaster au-dessus de la saisie (lot #137, variante C « compacte dépliable »).
// Source : .vibe-agent/epicmaster-live.json (lot #136), lu par $.fs ; rafraîchie par un sondage
// léger (2 s) qui ne redessine que si le fichier change (+ une fois par minute pour les durées).
// Fail-open absolu : hors epicmaster, fichier absent / illisible / invalide -> next(e), rien d'affiché.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { EpicmasterBandDismissed } from '../types'

import {
  LIVE_PATH, failedLabel, finishedLabel, parseLive, pendingLine, runningLine,
  type LiveLot,
} from './live'

const expanded = atom({ plugin: 'pmz', key: 'expanded' } as const, false)
const dismissed = atom({ plugin: 'pmz', key: 'dismissed' } as const, null as EpicmasterBandDismissed)

const POLL_MS = 2000
const MINUTE_TICKS = 30 // 30 × 2 s : redessin périodique des temps écoulés
const MAX_SEGMENTS = 40

const SEG: Record<LiveLot['status'], { glyph: string; color: string }> = {
  done: { glyph: '■', color: 'success' },
  running: { glyph: '■', color: 'warning' },
  pending: { glyph: '□', color: 'inactive' },
  failed: { glyph: '■', color: 'error' },
}

export const register: Register = on => {
  let lastText: string | null = null
  let ticks = 0

  // Sondage : seule façon d'être réveillé par un fichier modifié hors session (pas de watch fs).
  on('session.start', async ($, e, next) => {
    try {
      if (e.surface !== null) {
        $.clock.every(POLL_MS, () => {
          $.fs.read(LIVE_PATH)
            .then(t => (typeof t === 'string' ? t : null), () => null)
            .then(text => {
              ticks = (ticks + 1) % MINUTE_TICKS
              if (text !== lastText || (text !== null && ticks === 0)) {
                lastText = text
                $.ui.invalidate('ui.render')
              }
            })
            .catch(() => undefined)
        })
      }
    } catch (_) { /* fail-open */ }
    return next(e)
  })

  // Critère 6 : le récap « terminé » disparaît à la saisie suivante.
  on('prompt.submit', async ($, e, next) => {
    try {
      const text = await $.fs.read(LIVE_PATH).catch(() => null)
      const view = parseLive(text, await $.clock.now())
      if (view && view.finished) {
        await update($, dismissed, () => view.signature)
        await update($, expanded, () => false)
      }
    } catch (_) { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => next(e)) // jamais de refus : la saisie passe toujours

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const text = await $.fs.read(LIVE_PATH).catch(() => null)
      const now = await $.clock.now()
      const view = parseLive(text, now)
      if (!view) return next(e)
      if (view.finished && (await read($, dismissed)) === view.signature) return next(e)
      const isOpen = !view.finished && (await read($, expanded))
      const { Box, Text, Button } = $.ui.resolve(e)

      if (view.finished) {
        return (
          <Box key="em-band" flexDirection="row">
            <Text key="em-done" color="success" wrap="truncate">{finishedLabel(view)}</Text>
            {view.failed.length ? <Text key="em-failed" color="error" wrap="truncate">{'  ' + failedLabel(view.failed)}</Text> : null}
          </Box>
        )
      }

      const shown = view.lots.slice(0, MAX_SEGMENTS)
      const more = view.lots.length - shown.length
      const head = `◆ ${view.epic}${view.wave ? ` · vague ${view.wave.current}/${view.wave.total}` : ''} `
      const counts = ` ✓${view.done} ⟳${view.running} ⧗${view.pending}`

      const line = (
        <Box key="em-line" flexDirection="row">
          <Text key="em-head" bold wrap="truncate">{head}</Text>
          <Text key="em-bar">
            {shown.map(l => <Text key={`seg-${l.id}`} color={SEG[l.status].color}>{SEG[l.status].glyph}</Text>)}
            {more > 0 ? <Text key="seg-more" dimColor>{`+${more}`}</Text> : null}
          </Text>
          <Text key="em-counts">{counts}</Text>
          {view.failed.length ? <Text key="em-failed" color="error" bold>{'  ' + failedLabel(view.failed)}</Text> : null}
          <Text key="em-gap"> </Text>
          <Button
            key="em-toggle"
            label={isOpen ? 'Masquer' : 'Détails'}
            onPress={() => update($, expanded, v => !v)}
          />
        </Box>
      )
      if (!isOpen) return line

      const rows = [
        ...view.lots.filter(l => l.status === 'running').map(l => (
          <Text key={`run-${l.id}`} color="warning" wrap="truncate">{'  ⟳ ' + runningLine(l, now)}</Text>
        )),
        ...view.failed.map(l => (
          <Text key={`red-${l.id}`} color="error" wrap="truncate">{`  ✗ #${l.id} ${l.title} · verify rouge`}</Text>
        )),
        ...view.lots.filter(l => l.status === 'pending').map(l => (
          <Text key={`wait-${l.id}`} dimColor wrap="truncate">{'  ⧗ ' + pendingLine(l)}</Text>
        )),
      ]
      return (
        <Box key="em-band" flexDirection="column">
          {line}
          {rows}
          <Text key="em-note" dimColor wrap="truncate">  durées et tokens : estimation indicative</Text>
        </Box>
      )
    } catch (_) {
      return next(e)
    }
  })
}

