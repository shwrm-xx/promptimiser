// Contrat d'état de la bande epicmaster (lot #137) : seules valeurs gardées dans $.state.
/** Signature du plan terminé déjà vu à une saisie (il ne s'affiche plus), ou null. */
export type EpicmasterBandDismissed = string | null

declare module 'claude-code' {
  interface PluginState {
    'pmz': {
      /** Bande dépliée (« Détails ») ou repliée (« Masquer »). */
      expanded: boolean
      dismissed: EpicmasterBandDismissed
    }
  }
}
