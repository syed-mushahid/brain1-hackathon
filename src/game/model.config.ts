// Every tunable number of the game's football model, in one place. The data files hold raw facts
// only; the game derives everything (race, chance to arrive, expected value, best / brave option,
// risk, offside, difficulty, scores, feedback wording) from them with these numbers, at load time.
//
// Changing a value here changes every moment, old and new: run `npm run check` afterwards.
// The EPV grid is a separate data file with its own licence (epvGrid.ts).
//
// Sources:
//   [S17]   Spearman (2017), "Physics-based modeling of pass probabilities in soccer" (MIT Sloan SAC)
//   [LOT]   Laurie Shaw, LaurieOnTracking (Metrica_PitchControl.py, Metrica_EPV.py), MIT licence
//   [CAL]   calibrate_pass_model.py on 991 real DFL passes -> pass_model_calibration.json
//   [FIT]   game/fitRiskAversion.ts: fitted so the pros' real passes come within 5 points of the
//           best option in about half the moments
//   [LAW11] IFAB Laws of the Game, Law 11 (offside)
//   [GAME]  design choice for the game (playtested), no external source

export const MODEL = {
  /** The race to the ball (space.ts). Everyone keeps running for `react` s, then sprints straight at
   *  runSpeed and controls the ball within `reach` m. [S17]/[LOT] structure; values [GAME], checked
   *  against the real outcomes: with the pro's pass as the tap the right team wins it in 28 / 37. */
  race: {
    /** m/s, a firm ground pass */
    ballSpeed: 15,
    /** m: a tap further than this is lofted (and a pro pass without measured height counts as lofted beyond it) */
    loftFrom: 30,
    /** s, opponents: they have to read the pass first [LOT uses 0.7] */
    react: 0.5,
    /** s, your teammates: they expect it (they make the run) */
    reactMates: 0.4,
    /** m/s top sprint speed [LOT: 5 m/s; DFL tracking peaks ~9 m/s] */
    runSpeed: 7,
    /** m, control radius */
    reach: 1,
  },

  /** Ball flight (space.ts flight()). */
  flight: {
    /** a measured pass that went above this height (m) counts as lofted (moment.actual.ball_max_z) */
    loftedZ: 1.8,
    /** launch angle of a lofted pass (degrees); the ground speed follows from the distance */
    loftAngleDeg: 30,
    /** a lofted ball can only be reached where it is below this height (m): just after the kick, and as it lands */
    reachZ: 2.0,
    /** s extra for the receiver to control a dropping ball [CAL] */
    controlS: 0.5,
    /** m: the first part of the path is still at your feet (nobody intercepts it there) */
    startM: 1.5,
    /** m: resolution of the path search */
    stepM: 0.5,
  },

  /** P(success) = 1 / (1 + exp(-pi / (sqrt 3 * sigma) * (slack + bias))) of the race margin (value.ts). [S17] form, fitted [CAL]:
   *  log-loss 0.275 vs 0.375 for the base rate, AUC 0.88. */
  passModel: {
    /** time-to-intercept uncertainty (s) [CAL; S17/LOT use 0.45] */
    sigma: 0.9,
    /** shift of the race margin (s) [CAL]: the race model gets defenders there about a second too early */
    bias: 1.1,
    /** margin used when no opponent can get near the pass at all (P ~ 1) */
    noOpponentS: 3,
    /**
     * A defender standing in the lane (at the reception within race.reach of the ball's path, where
     * the ball can be reached and short of the receiver) gets at most this margin (s), whatever his
     * reaction time, so the pass doesn't arrive through him: -1.5 s -> P = 31 %. [GAME] rule: on the
     * 991 real passes every blocker margin cost a little log-loss ([CAL]: none 0.299, -1 s 0.307,
     * -3 s 0.331) - 73 % of real passes with an opponent within 0.5 m of the path still arrived,
     * because real defenders often face the wrong way - but the game must never show a pass rolling
     * through a defender. Must stay below -passModel.bias (P < 50 %). null = rule off.
     */
    blockerSlack: -1.5 as number | null,
  },

  /** Expected value of a pass (value.ts):
   *  EV = P * (EPV(target) - EPV(ball)) - (1 - P) * k * EPV_opponent(target), shown on 0-100. [LOT] */
  value: {
    /** risk aversion: a lost ball hurts k times its plain EPV [FIT] */
    k: 5,
    /** display scale: EV lo -> 0 points, hi -> 100 (2nd / 98th percentile of all options and searched spots at this k) [FIT] */
    lo: -0.058,
    hi: 0.0248,
  },

  /** The best pass and the brave option (best.ts). */
  best: {
    /** the "best" label needs at least this chance to arrive; a higher value below it is the brave option [GAME] */
    minP: 0.6,
    /** the brave option must beat the best by at least this many points [GAME] */
    braveGain: 3,
    /** a pass into space must beat the best pass to feet by this many points to be the best (harder to time) [FIT] */
    spaceGain: 20,
    /** a running teammate is only searched ahead of his run, within this half-angle (degrees); null = all round [FIT] */
    runConeDeg: 60 as number | null,
    /** m/s: faster than this counts as running */
    runSpeedMin: 2,
    /** spots searched around every onside teammate: rings (m) x directions. Every spot must be further than
     *  taps.snapM from all teammates (a tap there is a pass to feet), so the first ring is just beyond it */
    ringsM: [6, 9, 12],
    dirs: 8,
    /** two passes are the same when they reach the same player within this distance (m)... */
    samePassM: 5,
    /** ...and score within this many points of each other */
    sameValue: 5,
  },

  /** Risk levels from the race margin (s), relative to the pros: of their completed passes, about a
   *  quarter were tighter than highS and two thirds tighter than mediumS [GAME]. */
  risk: {
    highS: -0.5,
    mediumS: 0.3,
  },

  /** Plain geometry. */
  geometry: {
    /** |progress| below this (m) is always 'sideways'; forward / backward also need to be within 60° of the goal line's normal */
    directionMinM: 3,
    /** offside only when this far beyond the line (m): tracking noise [LAW11 + GAME] */
    offsideTolM: 0.5,
    /** "through ball" only when the receiver collects it this much (m) ahead of where he stood, behind the deepest outfield defender */
    throughBallM: 2,
  },

  /** Reading a tap (evaluate.ts). [GAME] */
  taps: {
    /** a tap this close (m) to a teammate is a pass to his feet; anywhere else the ball goes where you tapped */
    snapM: 5,
    /** a pass into space aimed this close (m) to where the pro's completed pass was collected = the pro's pass (real outcome) */
    proSnapM: 5,
    /** aim assist: a pass into space that would be lost is also tried this far (m) around the tap */
    aimR: 2.5,
    /** memory for a pass into space: where your teammate would be after at most this long (s) */
    memoryLookaheadS: 2.5,
  },

  /** Feedback wording by chance to arrive (evaluate.ts / explain.ts). [GAME] */
  feedback: {
    /** "close race" only between these chances to arrive */
    closeRaceLo: 0.4,
    closeRaceHi: 0.6,
    /** "with time to spare" from this chance on */
    comfortableP: 0.85,
    /** Decision score for a "good pass into space" / an "ok" tone */
    goodDecision: 75,
    okDecision: 70,
  },

  /** Difficulty (difficulty.ts): points = min(n_close - 1, 2) + pressure points + (best option's chance
   *  to arrive below safeP ? 1 : 0); easy = one obvious option and points <= 1, hard = points >= hardPoints. [GAME] */
  difficulty: {
    /** passes within this many points of the best are "close" options */
    closePoints: 10,
    /** nearest opponent closer than this (m): +2 points; closer than mediumM: +1 */
    pressureHardM: 2.5,
    pressureMediumM: 5,
    /** the best option arrives with less than this chance: +1 point (it has to be played precisely) */
    safeP: 0.8,
    hardPoints: 3,
  },

  /** Scores (scoring.ts). [GAME] */
  scoring: {
    weights: { decision: 0.5, scan: 0.25, memory: 0.25 },
    /** looks in the last recentS (s) before reception count as fresh */
    recentS: 1.5,
    /** Scan = timing (fresh look / only earlier) + target (best option seen fresh / only earlier) */
    scan: { timingFresh: 60, timingEarly: 15, targetFresh: 40, targetEarly: 20 },
    /** Memory, pass to feet: tap distance (m) for full marks / zero */
    memory: { perfectM: 1.5, zeroM: 6 },
    /** Memory, pass into space: distance from where your teammate was heading (m) */
    spaceMemory: { perfectM: 3, zeroM: 12 },
    /** share squares: green from, yellow from */
    squares: { green: 75, yellow: 50 },
  },
}

export type ModelConfig = typeof MODEL
