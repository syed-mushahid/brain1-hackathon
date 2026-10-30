// Feature flags: switch on when the feature is ready.
export const FEATURES = {
  /** the tutorial (three guided rounds, game/tutorial.ts) on the home screen */
  tutorial: true,
  /** Pro mode: the scan phase in 3D first-person (training). Off for now: no toggle on Home, and a
   *  saved "on" is ignored */
  proMode: false,
  /** the Daily Challenge card on Home (the challenge itself still works when this is switched back on) */
  daily: false,
}
