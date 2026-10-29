"""Calibrate the pass-success curve of the game's expected-value model on real DFL passes.

The game (src/game/space.ts + value.ts) turns a race margin into P(success) with a logistic
curve (Spearman 2017):  P = 1 / (1 + exp(-pi / (sqrt(3) * sigma) * (slack + bias))).
`slack` = how much later than the ball (or, at the target, than the receiver) the quickest
opponent can get to the ball's path, with the game's race settings (reaction 0.5 s opponents /
0.4 s teammates, 7 m/s sprint, 15 m/s ball, 1 m reach; a pass whose measured height went above
1.8 m flies a 30° arc, reachable only below 2 m, +0.5 s to control it); an opponent already
within reach of the path when the ball passes him (a static blocker) gives BLOCKED_SLACK.

This script measures that slack for every real pass 2 the pipeline finds (state at the moment
the pass was played), and fits bias and sigma to whether the ball really reached a teammate:
  - completed (a teammate took it over): target = where he collected it, receiver = him;
  - lost (an opponent took it / out): target = the intended teammate's position (if known).

Usage: python calibrate_pass_model.py [--data DIR] [--cache cache]
Prints the fit and writes pass_model_calibration.json.
"""
import argparse
import json
import math
import os
from collections import Counter

import numpy as np

import extract_moments as em

# race settings: keep in step with RACE in src/game/space.ts
BALL_SPEED = 15.0
LOFT_ANGLE, LOFT_REACH_Z, LOFT_CONTROL_S, G = math.pi / 6, 2.0, 0.5, 9.81   # space.ts flight()
LOFTED_Z = 1.8   # a real pass is lofted when its measured ball height went above this
REACT_OPP, REACT_MATE, RUN_SPEED, REACH = 0.5, 0.4, 7.0, 1.0
START_M, STEP_M, FPS_RAW = 1.5, 0.5, 25
BLOCKER_SLACKS = [None, -3.0, -2.0, -1.5, -1.0, -0.5, 0.0]   # tried for space.ts BLOCKED_SLACK (None = no rule)


def flight(L, lofted):
    """space.ts flight(): ball time t(s), height z(s), reachable(s), arrival and control time."""
    if not lofted:
        return (lambda s: s / BALL_SPEED, lambda s: 0.0, lambda s: s >= START_M, L / BALL_SPEED, 0.0)
    v0 = math.sqrt(L * G / math.sin(2 * LOFT_ANGLE))
    vx = v0 * math.cos(LOFT_ANGLE)
    z = lambda s: max(0.0, s * math.tan(LOFT_ANGLE) * (1 - s / L))
    return (lambda s: s / vx, z, lambda s: s >= START_M and z(s) < LOFT_REACH_Z, L / vx, LOFT_CONTROL_S)


def slack_of(cal, target, recv):
    """passRisk() of space.ts: min over opponents and path points of (their time - ball/receiver time)."""
    pos = np.array([np.asarray(p, float) for p in cal['pos']])
    prev = np.array([np.asarray(p, float) for p in cal['prev']])
    att = np.array(cal['att'])
    vel = (pos - prev) * (FPS_RAW / 5)                     # m/s over the last 0.2 s
    react = np.where(att, REACT_MATE, REACT_OPP)
    start = pos + vel * react[:, None]
    you = pos[cal['passer']]
    target = np.asarray(target, float)
    L = float(np.linalg.norm(target - you))
    if L < 1e-3:
        return None

    def time_to(i, q):
        return react[i] + max(0.0, float(np.linalg.norm(q - start[i])) - REACH) / RUN_SPEED

    t_of, _, reachable, arrive, control = flight(L, cal['max_z'] > LOFTED_Z)
    t_end = (max(arrive, time_to(recv, target)) if recv is not None else arrive) + control
    u = (target - you) / L
    best = None
    for i in np.flatnonzero(~att):
        s = min(START_M, L)
        while s <= L + 1e-6:
            if not reachable(s) and s < L - STEP_M:   # over his head
                s += STEP_M
                continue
            q = you + u * s
            t_ball = t_of(s)
            tb = max(t_ball, t_end) if s >= L - STEP_M else t_ball
            sl = time_to(i, q) - tb   # (static blockers are applied in fit(), with a fitted slack)
            best = sl if best is None or sl < best else best
            s += STEP_M
    return best


def static_gap(cal, target):
    """Closest any opponent (drifting with his velocity while he reacts) is to the ball as it passes (m)."""
    pos = np.array([np.asarray(p, float) for p in cal['pos']])
    prev = np.array([np.asarray(p, float) for p in cal['prev']])
    att = np.array(cal['att'])
    vel = (pos - prev) * (FPS_RAW / 5)
    you = pos[cal['passer']]
    target = np.asarray(target, float)
    L = float(np.linalg.norm(target - you))
    if L < 1e-3:
        return None
    u = (target - you) / L
    t_of, _, reachable, _, _ = flight(L, cal['max_z'] > LOFTED_Z)
    best = None
    for i in np.flatnonzero(~att):
        s = min(START_M, L)
        while s <= L + 1e-6:
            if not reachable(s):
                s += STEP_M
                continue
            q = you + u * s
            d = float(np.linalg.norm(q - pos[i] - vel[i] * min(t_of(s), REACT_OPP)))
            best = d if best is None or d < best else best
            s += STEP_M
    return best


def collect(data_dir, cache_dir):
    rows, skips = [], Counter()
    for m in em.discover_matches(data_dir):
        tr = em.Tracking(os.path.join(cache_dir, f'{m.match_id}.npz'))
        evs, ev_start, _, _ = em.load_events(m)
        m.facts, m.home_id, m.people = em.load_match_info(m)
        m.goals = []
        offsets = em.estimate_offsets(tr, evs, ev_start)
        for p1, p2 in em.pass_pairs(evs, skips):
            c = em.build_candidate(m, tr, p1, p2, ev_start, offsets, skips)
            if c is None:
                continue
            cal = c['_calib']
            k = cal['taker']
            if k is not None and cal['att'][k] and k != cal['passer']:
                sl, y = slack_of(cal, cal['take_pos'], k), 1
            elif cal['intended'] is not None:
                sl, y = slack_of(cal, cal['pos'][cal['intended']], None), 0
            else:
                continue
            if sl is not None:
                tgt = cal['take_pos'] if y else cal['pos'][cal['intended']]
                rows.append((sl, y, static_gap(cal, tgt) or 99.0, cal['max_z'] > LOFTED_Z))
        print(f'  {m.match_id}: {len(rows)} passes so far')
    return rows


def fit(rows):
    raw = np.array([r[0] for r in rows])
    lofted = np.array([r[3] for r in rows])
    y = np.array([r[1] for r in rows])
    gaps = np.array([r[2] for r in rows], float)
    blocked = gaps <= REACH
    bins = [0, 0.5, 1.0, 1.5, 2.0, 3.0, 99]
    by_gap = {f'{lo}-{hi} m': (int(((gaps >= lo) & (gaps < hi)).sum()),
                               round(float(y[(gaps >= lo) & (gaps < hi)].mean()), 2) if ((gaps >= lo) & (gaps < hi)).any() else None)
              for lo, hi in zip(bins[:-1], bins[1:])}

    def logloss(bias, sigma, x=None):
        x = raw if x is None else x
        k = math.pi / (math.sqrt(3) * sigma)
        p = np.clip(1 / (1 + np.exp(-k * (x + bias))), 1e-9, 1 - 1e-9)
        return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))

    # static blocker: an opponent within reach of the path gets a fixed slack; fit that value too
    fits = []
    for bs in BLOCKER_SLACKS:
        xx = raw if bs is None else np.where(blocked, np.minimum(raw, bs), raw)
        g = min(((b, s, logloss(b, s, xx)) for b in np.arange(-1.0, 4.01, 0.05) for s in np.arange(0.2, 4.01, 0.05)),
                key=lambda t: t[2])
        fits.append((bs, *g))
        print(f'  blocker slack {bs}: bias {g[0]:.2f} sigma {g[1]:.2f} log-loss {g[2]:.4f}')
    bs, b, s, ll = min(fits, key=lambda f: f[3])
    x = raw if bs is None else np.where(blocked, np.minimum(raw, bs), raw)
    r = y.mean()
    base = float(-(r * math.log(r) + (1 - r) * math.log(1 - r)))
    spearman = logloss(0.0, 0.45, x)
    b45 = min(((bb, logloss(bb, 0.45, x)) for bb in np.arange(-1.0, 4.01, 0.05)), key=lambda g: g[1])
    # how well the slack separates completed from lost passes (AUC, rank-based)
    order = np.argsort(x)
    ranks = np.empty(len(x))
    ranks[order] = np.arange(1, len(x) + 1)
    n1, n0 = y.sum(), len(y) - y.sum()
    auc = float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))
    print('completion rate by the closest static opponent to the path (n, rate):', by_gap)
    return dict(n=int(len(rows)), completed=int(n1), lost=int(n0), base_rate=round(float(r), 3),
                lofted_passes=int(lofted.sum()), lofted_completed=int((lofted & (y == 1)).sum()),
                blocked_passes=int(blocked.sum()), blocked_but_completed=int((blocked & (y == 1)).sum()),
                completion_by_static_gap=by_gap, fit_blocker_slack_s=bs,
                logloss_base_rate=round(base, 3), logloss_spearman_sigma045=round(spearman, 3),
                spearman_sigma045_best_bias=round(float(b45[0]), 2), logloss_spearman_best_bias=round(b45[1], 3),
                fit_bias_s=round(float(b), 2), fit_sigma_s=round(float(s), 2), logloss_fit=round(ll, 3),
                auc_slack=round(auc, 3))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=os.path.join(here, 'RawData', '28196177'))
    ap.add_argument('--cache', default=os.path.join(here, 'cache'))
    args = ap.parse_args()
    rows = collect(args.data, args.cache)
    res = fit(rows)
    print(json.dumps(res, indent=1))
    with open(os.path.join(here, 'pass_model_calibration.json'), 'w', encoding='utf-8') as fh:
        json.dump(res, fh, indent=1)


if __name__ == '__main__':
    main()
