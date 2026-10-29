#!/usr/bin/env python
"""
extract_moments.py
==================

Builds `moments.json` (+ one preview PNG per moment) for the football decision
game from the DFL / IDSSE open dataset (7 Bundesliga matches 2022/23, tracking
at 25 fps + events, CC-BY 4.0; Bassek et al. 2025, Scientific Data,
doi:10.1038/s41597-025-04505-y).

A "moment" is two consecutive open-play passes by the same team:
    pass 1: A -> B            (the incoming ball)
    pass 2: B -> ?            (made <= 3 s after B receives; the decision we test)

Run (one command):
    pip install kloppy matplotlib numpy
    python extract_moments.py                    # data in ./RawData/28196177 (or ./data)

Useful options:
    --data DIR        folder with the DFL XML files (matchinformation / events_raw /
                      positions_raw_observed per match)
    --n 30            number of moments to keep
    --seed 7          selection seed (selection is deterministic for a given seed)
    --workers 2       parallel processes for parsing the (400 MB) tracking files
    --cache DIR       where parsed tracking arrays are cached (.npz); delete to re-parse

Pipeline
--------
1. kloppy (sportec module) loads events and tracking.  Tracking is converted to
   compact numpy arrays per period and cached, because each XML takes ~80 s to parse.
2. Candidate pass pairs come from the event feed.  The event clock and the
   tracking clock are aligned via absolute UTC timestamps, and then the exact kick /
   reception frames are refined from the tracking itself (ball-to-player distance).
3. Each valid candidate gets its options scored (see `option_value`) and a
   difficulty (see `difficulty`).
4. ~30 moments are picked with a greedy, quota-based selection that spreads them
   over matches and mixes difficulty, outcome and "pro != best".
5. moments.json, previews/*.png and a printed summary are written.

The scoring and difficulty functions are deliberately at the top of the file so
they are easy to tweak.
"""

import argparse
import json
import math
import os
import random
import re
import sys
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from glob import glob

import numpy as np

PITCH_X, PITCH_Y = 105.0, 68.0
FPS_RAW = 25          # DFL tracking frame rate
FPS_OUT = 10          # frame rate written to moments.json

# ----------------------------------------------------------------------------
# Moment rules
# ----------------------------------------------------------------------------
MAX_HOLD_S = 3.0          # B must release pass 2 within this many seconds of receiving
MAX_PASS1_S = 4.0         # pass 1 longer than this (kick -> reception) is ignored
TOUCH_M = 1.5             # ball within this distance (2D) of a player = "at his feet"
DEF_THIRD_X = PITCH_X / 3 # B receiving at x < this (after normalisation) = own defensive third
AFTER_RECEPTION_S = 0.5   # frames written after reception
LEAD_IN_S = 2.0           # frames written before the pass 1 kick (build-up; game scan time)
MIN_PASS2_M = 8.0         # pass 2 shorter than this is not an interesting decision
TAKEOVER_MAX_S = 8.0      # follow the ball after pass 2 at most this long to find who took it over
CONTROL_S = 0.5           # ball staying at a player's feet this long = he has it
TURN_DEG = 25.0           # ...or a touch that turns the ball by more than this
SPEED_RATIO = 0.6         # ...or slows it to less than this share of its speed (or speeds it up 1/x)
RUN_FPS = 5               # sampling rate of the taker's run written to moments.json
LOFTED_Z = 1.8            # pass 2 whose ball rose above this (m) counts as lofted
PLAY_AFTER_S = 1.5        # plays.json: keep following the play this long after the takeover...
PLAY_MAX_S = 9.0          # ...but at most this long after the reception

# Selection
MAX_PER_MATCH = 6
NOTBEST_SHARE = 0.30      # share of selected moments where the pro's pass != best option
FAILED_SHARE = 0.20       # share of selected moments where pass 2 failed

# "Pressure" preference used during selection
PREF_TEAMMATES_RADIUS_M = 35.0
PREF_MIN_TEAMMATES = 3
PREF_PRESSURE_RADIUS_M = 8.0


# ----------------------------------------------------------------------------
# Option value: tweak here
# ----------------------------------------------------------------------------
VALUE_PARAMS = dict(
    w_lane=0.30,             # weight of an open passing lane
    w_progress=0.50,         # weight of moving the ball towards the opponent goal
    w_space=0.20,            # weight of the receiver having time/space
    lane_full_m=5.0,         # lane_open >= this counts as a fully open lane
    lane_block_m=2.0,        # lane_open below this scales the WHOLE score down linearly
                             #   (a defender standing on the line kills the option)
    space_full_m=6.0,        # receiver_space >= this counts as fully free
    progress_min_m=-10.0,    # progress <= this scores 0 (clear backward pass)
    progress_max_m=25.0,     # progress >= this scores 1
    long_pass_from_m=25.0,   # passes longer than this are penalised...
    long_pass_pts_per_m=0.5, # ...by this many points per extra metre...
    long_pass_max_pts=15.0,  # ...up to this maximum
)


def _clip01(v):
    return max(0.0, min(1.0, v))


def option_value(dist, lane_open, progress, receiver_space, p=VALUE_PARAMS):
    """Score one passing option on 0-100 (higher = better).

        lane     = clip(lane_open      / lane_full_m)
        space    = clip(receiver_space / space_full_m)
        prog     = clip((progress - progress_min_m) / (progress_max_m - progress_min_m))
        base     = 100 * (w_lane*lane + w_progress*prog + w_space*space)
        blocked  = clip(lane_open / lane_block_m)          # 0 = defender on the line
        penalty  = min(long_pass_max_pts, long_pass_pts_per_m * max(0, dist - long_pass_from_m))
        value    = clip(base * blocked - penalty, 0, 100)
    """
    lane = _clip01(lane_open / p['lane_full_m'])
    space = _clip01(receiver_space / p['space_full_m'])
    prog = _clip01((progress - p['progress_min_m']) / (p['progress_max_m'] - p['progress_min_m']))
    base = 100.0 * (p['w_lane'] * lane + p['w_progress'] * prog + p['w_space'] * space)
    blocked = _clip01(lane_open / p['lane_block_m'])
    penalty = min(p['long_pass_max_pts'], p['long_pass_pts_per_m'] * max(0.0, dist - p['long_pass_from_m']))
    return max(0.0, min(100.0, base * blocked - penalty))


DIRECTION_MIN_M = 3.0         # |progress| below this is always 'sideways'
FORWARD_OPEN_LANE_M = 2.0     # a forward option with lane_open >= this counts as "open"
OFFSIDE_TOL_M = 0.5           # tracking noise allowance: offside only if this far beyond the line


def offside_line(def_x, ball_x):
    """x beyond which an attacker is offside (attack -> +x), or None in his own half.

    Law 11: in the opponents' half and nearer to their goal line than both the ball and the
    second-last opponent.  Judged at the moment you would pass (the reception frame).
    Returns max(second-last defender x, ball x, halfway line) + OFFSIDE_TOL_M.
    """
    second_last = sorted(def_x, reverse=True)[1]
    return max(second_last, ball_x, PITCH_X / 2) + OFFSIDE_TOL_M


def pass_direction(dist, progress):
    """'forward' | 'sideways' | 'backward', by the angle to the opponent goal line.

    forward  = progress >= DIRECTION_MIN_M and within 60° of straight ahead (progress >= dist/2)
    backward = progress <= -DIRECTION_MIN_M and within 60° of straight back
    sideways = everything else
    """
    if progress >= DIRECTION_MIN_M and progress >= dist / 2:
        return 'forward'
    if progress <= -DIRECTION_MIN_M and -progress >= dist / 2:
        return 'backward'
    return 'sideways'


def apply_forward_first(options, respect_offside=True):
    """Forward-first rule: a backward pass may only be the best option when every
    forward lane is blocked.  If any forward option has lane_open >= FORWARD_OPEN_LANE_M,
    each backward option's value is capped 1 point below the best such forward option.
    """
    open_fwd = [o['value'] for o in options
                if o['direction'] == 'forward' and o['lane_open'] >= FORWARD_OPEN_LANE_M
                and not (respect_offside and o['offside'])]
    if not open_fwd:
        return
    cap = max(0.0, max(open_fwd) - 1.0)
    for o in options:
        if o['direction'] == 'backward' and o['value'] > cap:
            o['value'] = round(cap, 1)


def difficulty(option_values, pressure_m):
    """'easy' | 'medium' | 'hard'.

    n_close  = options whose value is within 10 points of the best (best included)
    points   = min(n_close - 1, 2)                 # 0: one obvious option ... 2: 3+ options
             + (2 if pressure_m < 2.5 else 1 if pressure_m < 5 else 0)
    easy     = one obvious option and points <= 1
    hard     = points >= 3
    medium   = everything else
    """
    best = max(option_values)
    n_close = sum(1 for v in option_values if v >= best - 10)
    pts = min(n_close - 1, 2) + (2 if pressure_m < 2.5 else 1 if pressure_m < 5 else 0)
    if n_close == 1 and pts <= 1:
        return 'easy', n_close
    if pts >= 3:
        return 'hard', n_close
    return 'medium', n_close


def lane_open_m(src, dst, defenders):
    """Minimum distance from any defender to the pass segment src->dst.

    Defenders *behind* the passer (projection onto the pass direction < 0) are
    ignored: they cannot intercept a ball travelling away from them, and otherwise
    a single presser next to B would make every lane look closed.
    """
    d = dst - src
    L2 = float(d @ d)
    if L2 < 1e-6 or len(defenders) == 0:
        return 30.0
    t = (defenders - src) @ d / L2
    ahead = t >= 0
    if not ahead.any():
        return 30.0
    t = np.clip(t[ahead], 0.0, 1.0)
    proj = src + t[:, None] * d
    return float(min(30.0, np.min(np.linalg.norm(defenders[ahead] - proj, axis=1))))


# ----------------------------------------------------------------------------
# Data discovery and loading
# ----------------------------------------------------------------------------
class Match:
    def __init__(self, key, info, events, positions):
        self.key = key                       # e.g. DFL-COM-000001_DFL-MAT-J03WMX
        self.match_id = key.split('_')[-1]   # e.g. DFL-MAT-J03WMX
        self.info, self.events, self.positions = info, events, positions


# DFL playing-position codes (German) -> common English abbreviations
POSITIONS = {'TW': 'GK', 'IVL': 'CB', 'IVR': 'CB', 'IVZ': 'CB', 'LV': 'LB', 'RV': 'RB',
             'DML': 'DM', 'DMR': 'DM', 'DMZ': 'DM', 'DLM': 'LM', 'DRM': 'RM', 'HL': 'CM', 'HR': 'CM',
             'LM': 'LM', 'RM': 'RM', 'OLM': 'LM', 'ORM': 'RM', 'ZO': 'AM', 'LA': 'LW', 'RA': 'RW',
             'STL': 'ST', 'STR': 'ST', 'STZ': 'ST'}


def load_match_info(match):
    """Match facts and {PersonId: {name, pos}} from the match-information XML."""
    import xml.etree.ElementTree as ET
    root = ET.parse(match.info).getroot()
    gen = root.find('.//General').attrib
    env = root.find('.//Environment')
    facts = dict(competition=gen.get('CompetitionName'), season=gen.get('Season'),
                 matchday=int(gen.get('MatchDay', 0)), date=gen.get('KickoffTime', '')[:10],
                 home=gen.get('HomeTeamName'), away=gen.get('GuestTeamName'), result=gen.get('Result'),
                 stadium=env.attrib.get('StadiumName') if env is not None else None)
    people = {}
    for p in root.iter('Player'):
        a = p.attrib
        name = a.get('Shortname') or f"{a.get('FirstName', '')} {a.get('LastName', '')}".strip()
        code = a.get('PlayingPosition')
        people[a['PersonId']] = dict(name=name, pos=POSITIONS.get(code, code))
    return facts, gen.get('HomeTeamId'), people


def discover_matches(data_dir):
    """Match files by their shared DFL-COM-..._DFL-MAT-... suffix."""
    matches = []
    for info in sorted(glob(os.path.join(data_dir, '*matchinformation*.xml'))):
        key = re.search(r'matchinformation_(.+)\.xml$', os.path.basename(info)).group(1)
        ev = glob(os.path.join(data_dir, f'*events_raw_{key}.xml'))
        pos = glob(os.path.join(data_dir, f'*positions_raw_observed_{key}.xml'))
        if not ev or not pos:
            print(f'  ! {key}: missing events or positions file, skipped')
            continue
        matches.append(Match(key, info, ev[0], pos[0]))
    return matches


def section_clock(pos_path):
    """{period: (N, unix_time)} for one frame of each half, read from the raw XML.

    kloppy keeps frame numbers but not the absolute wall-clock time of tracking
    frames; we need it to align tracking with the (absolute) event timestamps.
    Frames are exactly 1/25 s apart within a half, so one (N, T) pair per half is enough.
    """
    want = {b'firstHalf': 1, b'secondHalf': 2}
    out, section = {}, None
    with open(pos_path, 'rb') as fh:
        for line in fh:
            line = line.lstrip()
            if line.startswith(b'<FrameSet'):
                section = re.search(rb'GameSection="(\w+)"', line).group(1)
            elif section is not None and line.startswith(b'<Frame '):
                per = want.get(section)
                if per and per not in out:
                    n = int(re.search(rb' N="(\d+)"', line).group(1))
                    t = re.search(rb' T="([^"]+)"', line).group(1).decode()
                    out[per] = (n, datetime.fromisoformat(t).timestamp())
                section = None
                if len(out) == len(want):
                    break
    return out


def parse_tracking(match, cache_dir):
    """Load tracking with kloppy and convert it to numpy arrays (cached as .npz).

    Coordinates: kloppy's 'sportec' system is metres, origin at the centre spot,
    y pointing up.  We shift to origin bottom-left (x 0-105, y 0-68).
    """
    cache = os.path.join(cache_dir, f'{match.match_id}.npz')
    if os.path.exists(cache):
        return cache
    from kloppy import sportec
    from kloppy.domain import BallState

    tr = sportec.load_tracking(meta_data=match.info, raw_data=match.positions, coordinates='sportec')
    players = [p for team in tr.metadata.teams for p in team.players]
    col = {p.player_id: i for i, p in enumerate(players)}
    by_period = defaultdict(list)
    for fr in tr.frames:
        by_period[fr.period.id].append(fr)

    arrays = {}
    for per, frs in by_period.items():
        n0 = min(f.frame_id for f in frs)
        n = max(f.frame_id for f in frs) - n0 + 1
        ball = np.full((n, 3), np.nan, np.float32)
        alive = np.zeros(n, bool)
        xy = np.full((n, len(players), 2), np.nan, np.float32)
        for f in frs:
            i = f.frame_id - n0
            b = f.ball_coordinates
            if b is not None and b.x is not None:
                ball[i] = (b.x + PITCH_X / 2, b.y + PITCH_Y / 2, b.z or 0.0)
            alive[i] = f.ball_state == BallState.ALIVE
            for pl, pd in f.players_data.items():
                c = pd.coordinates
                if c is not None and pl.player_id in col:
                    xy[i, col[pl.player_id]] = (c.x + PITCH_X / 2, c.y + PITCH_Y / 2)
        arrays[f'p{per}_n0'] = np.array(n0)
        arrays[f'p{per}_ball'] = ball
        arrays[f'p{per}_alive'] = alive
        arrays[f'p{per}_xy'] = xy

    clock = section_clock(match.positions)
    meta = dict(
        player_ids=[p.player_id for p in players],
        team_ids=[p.team.team_id for p in players],
        jerseys=[int(p.jersey_no) if p.jersey_no is not None else -1 for p in players],
        periods=sorted(by_period),
        clock={str(k): v for k, v in clock.items()},
    )
    os.makedirs(cache_dir, exist_ok=True)
    tmp = cache + '.tmp.npz'
    np.savez_compressed(tmp, meta=np.array(json.dumps(meta)), **arrays)
    os.replace(tmp, cache)
    return cache


class Tracking:
    """Per-period numpy arrays for one match."""

    def __init__(self, path):
        z = np.load(path)
        meta = json.loads(str(z['meta']))
        self.pids = meta['player_ids']
        self.teams = np.array(meta['team_ids'])
        self.jerseys = meta['jerseys']
        self.col = {p: i for i, p in enumerate(self.pids)}
        self.clock = {int(k): tuple(v) for k, v in meta['clock'].items()}
        self.n0, self.ball, self.alive, self.xy = {}, {}, {}, {}
        for per in meta['periods']:
            self.n0[per] = int(z[f'p{per}_n0'])
            self.ball[per] = z[f'p{per}_ball']
            self.alive[per] = z[f'p{per}_alive']
            self.xy[per] = z[f'p{per}_xy']

    def index_at(self, per, unix_t):
        """Array index of the tracking frame at absolute time unix_t."""
        n_ref, t_ref = self.clock[per]
        return int(round((n_ref - self.n0[per]) + (unix_t - t_ref) * FPS_RAW))

    def attack_sign(self, per, team_id):
        """+1 if team attacks left->right (towards x=105) in this period, else -1.

        Measured at kick-off of the period: every player is in his own half.
        """
        alive = np.flatnonzero(self.alive[per])
        k = alive[0] if len(alive) else 0
        xs = self.xy[per][k:k + 10, self.teams == team_id, 0]
        return 1 if np.nanmean(xs) < PITCH_X / 2 else -1


def load_events(match):
    """kloppy events, without DFL 'Delete' placeholder events, sorted by time."""
    from kloppy import sportec
    ds = sportec.load_event(event_data=match.events, meta_data=match.info, coordinates='sportec')
    start = {p.id: p.start_timestamp.timestamp() for p in ds.metadata.periods}
    evs = [e for e in ds.events if e.event_name != 'Delete']
    evs.sort(key=lambda e: (e.period.id, e.timestamp))
    teams = {t.team_id: t for t in ds.metadata.teams}
    # Kick-off events carry TeamLeft: used only to sanity-check attack direction
    team_left = {}
    for e in evs:
        raw = getattr(e, 'raw_event', None) or {}
        if 'TeamLeft' in raw and e.period.id not in team_left:
            team_left[e.period.id] = raw['TeamLeft']
    return evs, start, teams, team_left


# ----------------------------------------------------------------------------
# Candidate extraction
# ----------------------------------------------------------------------------
# Events that may sit between pass 1 and pass 2 without breaking the sequence
IGNORABLE = {'TacklingGame', 'VideoAssistantAction', 'PlayerNotSentOff', 'PenaltyNotAwarded',
             'SpectacularPlay', 'Run', 'OtherPlayerAction'}


def is_open_play_pass(e):
    if e.event_name != 'pass':
        return False
    raw = getattr(e, 'raw_event', None) or {}
    if raw.get('FromOpenPlay') != 'true':
        return False
    return not any(type(q).__name__ == 'SetPieceQualifier' for q in (e.qualifiers or []))


def pass_pairs(evs, skips):
    """Yield (pass1, pass2) event pairs: A -> B completed, then B's next action is a pass."""
    for i, e in enumerate(evs):
        if e.event_name != 'pass' or e.result is None or e.result.name != 'COMPLETE' \
                or e.receiver_player is None or e.player is None:
            continue
        B = e.receiver_player.player_id
        if not is_open_play_pass(e):
            skips['pass 1 not open play (set piece / restart)'] += 1
            continue
        nxt = None
        for f in evs[i + 1:]:
            if f.period.id != e.period.id:
                break
            if f.event_name in IGNORABLE:
                continue
            if f.event_name == 'OtherBallAction' and f.player and f.player.player_id == B:
                continue
            nxt = f
            break
        if nxt is None or nxt.event_name != 'pass' or nxt.player is None \
                or nxt.player.player_id != B:
            skips["receiver's next action is not a pass"] += 1
            continue
        if not is_open_play_pass(nxt):
            skips['pass 2 not open play (set piece / restart)'] += 1
            continue
        yield e, nxt


def estimate_offsets(tr, evs, ev_start, max_shift_s=5.0):
    """Per-period clock offset (in frames) between event times and tracking.

    DFL event timestamps are hand-logged: they carry a per-match/per-half offset of up
    to ~2 s plus noise.  We pick the shift that maximises the number of pass events
    whose passer has the ball at his feet (< TOUCH_M) at event time + shift.
    """
    r = int(max_shift_s * FPS_RAW)
    out = {}
    for per in tr.xy:
        score = np.zeros(2 * r + 1)
        for e in evs:
            if e.period.id != per or e.event_name != 'pass' or e.player is None \
                    or e.player.player_id not in tr.col:
                continue
            i = tr.index_at(per, ev_start[per] + e.timestamp.total_seconds())
            if i - r < 0 or i + r >= len(tr.ball[per]):
                continue
            d = np.linalg.norm(tr.ball[per][i - r:i + r + 1, :2] - tr.xy[per][i - r:i + r + 1, tr.col[e.player.player_id]], axis=1)
            score += d < TOUCH_M
        out[per] = int(np.argmax(score)) - r
    return out


def first_true(mask):
    idx = np.flatnonzero(mask)
    return int(idx[0]) if len(idx) else None


def find_takeover(ball, alive, xy, cols, start, stop, skip_col=None, skip_until=0):
    """Follow the ball from frame `start` and find who took it over.

    A player takes the ball when it is low (< 2.5 m) and within TOUCH_M of him AND it
    either stays at his feet for CONTROL_S, or leaves his reach on a different course
    (turned by > TURN_DEG, or speed changed by SPEED_RATIO): a ball rolling past
    someone's feet untouched does not count. The ball going out of play ends the search.

    Returns (frame, column or None, 'touch' | 'out' | 'loose')."""
    ctrl = int(CONTROL_S * FPS_RAW)
    w = 6                                       # frames used to measure the ball's velocity

    def vel(a, b):
        if a < 0 or b >= len(ball) or np.isnan(ball[[a, b], :2]).any():
            return None
        return (ball[b, :2] - ball[a, :2]) / (b - a)

    j = start
    while j < stop:
        if not alive[j]:
            return j - 1, None, 'out'
        if np.isnan(ball[j]).any() or ball[j, 2] >= 2.5:
            j += 1
            continue
        d = np.linalg.norm(xy[j, cols] - ball[j, :2], axis=1)
        if skip_col is not None and j < skip_until:
            d[cols == skip_col] = np.inf
        if np.all(np.isnan(d)) or np.nanmin(d) >= TOUCH_M:
            j += 1
            continue
        c = int(cols[np.nanargmin(d)])
        # how long does the ball stay within reach?
        e = j
        while e < min(stop, j + ctrl) and alive[e] and \
                np.linalg.norm(ball[e, :2] - xy[e, c]) < TOUCH_M:
            e += 1
        if e - j >= ctrl:
            return j, c, 'touch'                 # controlled
        v_in, v_out = vel(j - w, j), vel(e, e + w)
        if v_in is not None and v_out is not None:
            s_in, s_out = np.linalg.norm(v_in), np.linalg.norm(v_out)
            if s_in > 1e-3 and s_out > 1e-3:
                turn = math.degrees(math.acos(np.clip(v_in @ v_out / (s_in * s_out), -1, 1)))
                if turn > TURN_DEG or not SPEED_RATIO < s_out / s_in < 1 / SPEED_RATIO:
                    k = j + int(np.nanargmin([np.linalg.norm(ball[i, :2] - xy[i, c]) for i in range(j, e)]))
                    return k, c, 'touch'         # deflected / passed on first time
        j = max(e, j + 1)                        # ball ran past him untouched
    return stop - 1, None, 'loose'


def build_candidate(m, tr, p1, p2, ev_start, offsets, skips):
    """Align a pass pair with tracking, validate it and compute all moment fields.

    Returns a dict, or None (reason counted in `skips`)."""
    per = p1.period.id
    if per not in tr.xy:
        skips['no tracking for period'] += 1
        return None
    ball, alive, xy = tr.ball[per], tr.alive[per], tr.xy[per]
    n = len(ball)
    A, B = p1.player.player_id, p1.receiver_player.player_id
    team = p1.team.team_id
    if A not in tr.col or B not in tr.col:
        skips['player missing in tracking'] += 1
        return None
    ca, cb = tr.col[A], tr.col[B]
    i1 = tr.index_at(per, ev_start[per] + p1.timestamp.total_seconds()) + offsets[per]
    i2 = tr.index_at(per, ev_start[per] + p2.timestamp.total_seconds()) + offsets[per]
    win = int(1.5 * FPS_RAW)    # remaining event-time noise after the offset correction
    if i1 - win < 0 or i2 + 150 >= n:
        skips['missing tracking frames'] += 1
        return None

    def dist_to(col, lo, hi):
        return np.linalg.norm(ball[lo:hi, :2] - xy[lo:hi, col], axis=1)

    # --- kick of pass 1: the ball-at-A's-feet frame nearest the (corrected) event time
    #     within +-1.5 s, then forward to the last frame the ball is still at his feet
    lo = i1 - win
    dA = dist_to(ca, lo, i1 + win + 1)
    touch = np.flatnonzero(dA < TOUCH_M)
    if len(touch) == 0:
        skips['tracking: ball not at passer at pass 1'] += 1
        return None
    k = int(touch[np.argmin(np.abs(touch - win))])
    while k + 1 < len(dA) and dA[k + 1] < TOUCH_M:
        k += 1
    kick1 = lo + k

    # --- reception by B: first frame after kick 1 the ball is at B's feet
    hi = min(n, i2 + int(1.5 * FPS_RAW))
    dB = dist_to(cb, kick1 + 1, hi)
    r = first_true(dB < TOUCH_M)
    if r is None:
        if len(dB) == 0 or np.all(np.isnan(dB)) or np.nanmin(dB) > 2.5:
            skips['tracking: ball never reaches B'] += 1
            return None
        r = int(np.nanargmin(dB))
    rec = kick1 + 1 + r
    if (rec - kick1) / FPS_RAW > MAX_PASS1_S:
        skips['pass 1 too long (> 4 s in the air)'] += 1
        return None

    # --- kick of pass 2: ball leaves B (> 3 m) for good; last frame still at his feet
    dB2 = dist_to(cb, rec, hi)
    leave = first_true(dB2 > 3.0)
    if leave is None:
        skips['B held/dribbled > 3 s'] += 1
        return None
    at_feet = np.flatnonzero(dB2[:leave] <= TOUCH_M)
    kick2 = rec + int(at_feet[-1] if len(at_feet) else 0)
    hold = (kick2 - rec) / FPS_RAW
    if hold > MAX_HOLD_S:
        skips['B held/dribbled > 3 s'] += 1
        return None
    if abs(kick2 - i2) > 1.5 * FPS_RAW:
        skips['event/tracking mismatch at pass 2'] += 1
        return None

    # --- ball in play and complete tracking from pass 1 to reception + 0.5 s (+ B's touch)
    w_end = max(kick2, rec + int(AFTER_RECEPTION_S * FPS_RAW)) + 1
    if not alive[kick1:w_end].all():
        skips['ball out of play during moment'] += 1
        return None
    present = ~np.isnan(xy[rec, :, 0])
    span = xy[kick1:w_end + 1][:, present, 0]
    if np.isnan(span).any() or np.isnan(ball[kick1:w_end + 1]).any():
        skips['missing tracking frames'] += 1
        return None
    att_cols = np.flatnonzero(present & (tr.teams == team))
    def_cols = np.flatnonzero(present & (tr.teams != team))
    if len(att_cols) < 9 or len(def_cols) < 9:
        skips['missing tracking frames'] += 1
        return None

    # --- normalise direction: attacking team always attacks left -> right
    sign = tr.attack_sign(per, team)

    def norm(p):
        p = np.asarray(p, dtype=float)
        return p if sign == 1 else np.array([PITCH_X, PITCH_Y]) - p

    b_pos = norm(xy[rec, cb])
    if b_pos[0] < DEF_THIRD_X:
        skips["B in own defensive third"] += 1
        return None

    # --- first contact after pass 2 (ball within 1.2 m of any other player, or dead).
    #     Used only for the pass length and the intended teammate (selection); the point
    #     shown to players is the takeover below.
    others = np.array([c for c in np.flatnonzero(present) if c != cb])
    seg = slice(kick2 + 2, min(n, kick2 + 5 * FPS_RAW))
    d_oth = np.linalg.norm(xy[seg][:, others] - ball[seg, None, :2], axis=2)
    low = ball[seg, 2] < 2.5
    end_k = None
    for j in range(d_oth.shape[0]):
        if not alive[seg.start + j]:
            end_k = seg.start + j
            break
        if low[j] and np.nanmin(d_oth[j]) < 1.2:
            end_k = seg.start + j
            break
    if end_k is None:
        end_k = seg.stop - 1
    success = p2.result is not None and p2.result.name == 'COMPLETE'
    target = p2.receiver_player.player_id if (success and p2.receiver_player) else None
    if success:
        if target not in tr.col or not present[tr.col[target]] or tr.teams[tr.col[target]] != team:
            skips['pass 2 receiver missing in tracking'] += 1
            return None
        dT = np.linalg.norm(ball[seg, :2] - xy[seg, tr.col[target]], axis=1)
        a = first_true(dT < TOUCH_M)
        if a is not None:
            end_k = seg.start + a
    end_pos = norm(ball[end_k, :2])
    if np.isnan(end_pos).any():
        skips['missing tracking frames'] += 1
        return None

    # --- where the ball was actually taken over, and by whom.
    #     Completed pass: the receiver's first touch (he may have run onto it).
    #     Otherwise: the first real touch by anyone (see find_takeover), or where it went out.
    tseg = slice(kick2 + 2, min(n, kick2 + int(TAKEOVER_MAX_S * FPS_RAW)))
    take_k, take_col, how = None, None, 'touch'
    if success:
        ct = tr.col[target]
        a = first_true(np.linalg.norm(ball[tseg, :2] - xy[tseg, ct], axis=1) < TOUCH_M)
        if a is not None:
            take_k, take_col = tseg.start + a, ct
    if take_k is None:
        take_k, take_col, how = find_takeover(ball, alive, xy, np.flatnonzero(present), tseg.start, tseg.stop,
                                              skip_col=cb, skip_until=kick2 + FPS_RAW)
    take_pos = norm(ball[take_k, :2])
    if np.isnan(take_pos).any():
        take_pos = end_pos
    # measured ball height during pass 2 (kick to takeover): lofted when it rose above LOFTED_Z
    zs = ball[kick2:take_k + 1, 2]
    max_z = float(np.nanmax(zs)) if np.isfinite(zs).any() else 0.0

    # --- options at the reception frame (the frozen decision moment)
    att = {c: norm(xy[rec, c]) for c in att_cols}
    defs = np.array([norm(xy[rec, c]) for c in def_cols])
    pressure = float(np.min(np.linalg.norm(defs - b_pos, axis=1)))

    def pid_of(c):
        return ('A' if tr.teams[c] == team else 'D') + str(tr.jerseys[c])

    off_x = offside_line(defs[:, 0], float(norm(ball[rec, :2])[0]))
    options = []
    for c, p in att.items():
        if c == cb:
            continue
        dist = float(np.linalg.norm(p - b_pos))
        lane = lane_open_m(b_pos, p, defs)
        prog = float(p[0] - b_pos[0])
        space = float(np.min(np.linalg.norm(defs - p, axis=1)))
        options.append(dict(pid=pid_of(c), num=tr.jerseys[c], dist=round(dist, 1),
                            lane_open=round(lane, 1), progress=round(prog, 1),
                            receiver_space=round(space, 1),
                            direction=pass_direction(dist, prog),
                            offside=bool(p[0] > off_x),
                            value=round(option_value(dist, lane, prog, space), 1)))
    # The moment SELECTION still uses the values from before the offside rule existed (keeps the
    # 30 selected moments stable); what is written out (_final, below) has offside options at 0.
    final = [dict(o, value=0.0) if o['offside'] else dict(o) for o in options]
    apply_forward_first(options, respect_offside=False)
    options.sort(key=lambda o: -o['value'])
    best_pid = options[0]['pid']
    diff, n_close = difficulty([o['value'] for o in options], pressure)
    apply_forward_first(final)
    final.sort(key=lambda o: -o['value'])
    f_diff, f_close = difficulty([o['value'] for o in final], pressure)
    mates_35 = sum(1 for o in options if o['dist'] <= PREF_TEAMMATES_RADIUS_M)

    # --- which teammate was the pass meant for?  (= receiver if successful; for failed
    #     passes: the teammate closest to the ball's line of travel, if any)
    start = norm(ball[kick2, :2])
    intended_pos = None
    if target is not None:
        intended = pid_of(tr.col[target])
    else:
        far = norm(ball[min(kick2 + 8, end_k), :2])
        direction = end_pos - start if np.linalg.norm(end_pos - start) > 3 else far - start
        intended = None
        if np.linalg.norm(direction) > 0.5:
            u = direction / np.linalg.norm(direction)
            best_perp = None
            for c in att_cols:
                if c == cb:
                    continue
                v = norm(xy[kick2, c]) - start
                proj = float(v @ u)
                perp = abs(float(v[0] * u[1] - v[1] * u[0]))
                if proj > 3 and perp < max(4.0, 0.25 * proj) and (best_perp is None or perp < best_perp):
                    intended, best_perp, intended_pos = pid_of(c), perp, v + start

    # --- pass 2 length: ball travel for completed passes; for failed passes the
    #     distance to the intended teammate (an early interception shortens the travel)
    length = float(np.linalg.norm(end_pos - start))
    if intended_pos is not None:
        length = max(length, float(np.linalg.norm(intended_pos - start)))
    if length < MIN_PASS2_M:
        skips['pass 2 shorter than 8 m'] += 1
        return None

    # --- who took the ball over, and his run from the decision frame to that spot
    if take_col is None:
        outcome, taker = ('out' if how == 'out' else 'loose'), None
    else:
        outcome = 'received' if tr.teams[take_col] == team else 'intercepted'
        ks = list(range(rec, take_k, FPS_RAW // RUN_FPS)) + [take_k]
        run = [norm(xy[k, take_col]) for k in ks if not np.isnan(xy[k, take_col]).any()]
        taker = dict(pid=pid_of(take_col), t=round((take_k - rec) / FPS_RAW, 1),
                     run=[[round(float(p[0]), 1), round(float(p[1]), 1)] for p in run])

    # --- lead-in before pass 1 (gives the game time to scan): extend back up to
    #     LEAD_IN_S while the ball is in play and everyone on the pitch is tracked
    lead = kick1
    while lead > max(0, kick1 - int(LEAD_IN_S * FPS_RAW)) and alive[lead - 1] \
            and not np.isnan(ball[lead - 1]).any() and not np.isnan(xy[lead - 1][present]).any():
        lead -= 1

    # --- frames at 10 fps, aligned so the reception lands exactly on a frame
    step = FPS_RAW / FPS_OUT
    n_before = int((rec - lead) // step)
    pass1_idx = n_before - int((rec - kick1) // step)
    n_after = int(round(AFTER_RECEPTION_S * FPS_OUT))
    fidx = [rec - step * j for j in range(n_before, 0, -1)] + [rec + step * j for j in range(0, n_after + 1)]
    cols = list(att_cols) + list(def_cols)

    def interp(arr, f):
        lo_ = int(math.floor(f))
        w = f - lo_
        return arr[lo_] * (1 - w) + arr[min(lo_ + 1, len(arr) - 1)] * w

    frames = []
    for j, f in enumerate(fidx):
        bp = norm(interp(ball[:, :2], f))
        pl = []
        for c in cols:
            p = norm(interp(xy[:, c], f))
            pl.append(dict(pid=pid_of(c), num=tr.jerseys[c], team='att' if tr.teams[c] == team else 'def',
                           x=round(float(p[0]), 1), y=round(float(p[1]), 1)))
        frames.append(dict(t=round(j / FPS_OUT, 1), ball=dict(x=round(float(bp[0]), 1), y=round(float(bp[1]), 1)),
                           players=pl))

    # --- the rest of the play for the replays (plays.json): from the reception through pass 2
    #     and the takeover, PLAY_AFTER_S beyond; stops early if the ball goes dead or tracking drops
    play_end = min(n - 1, take_k + int(PLAY_AFTER_S * FPS_RAW), rec + int(PLAY_MAX_S * FPS_RAW))
    play = []
    for j in range(int((play_end - rec) // step) + 1):
        f = rec + step * j
        lo_ = int(math.floor(f))
        hi_ = min(lo_ + 1, n - 1)
        if j > 0 and (not alive[lo_] or not alive[hi_] or np.isnan(ball[lo_:hi_ + 1]).any()
                      or np.isnan(xy[lo_:hi_ + 1][:, cols]).any()):
            break
        b3 = interp(ball, f)
        bp = norm(b3[:2])
        pl = []
        for c in cols:
            p = norm(interp(xy[:, c], f))
            pl.append(dict(pid=pid_of(c), num=tr.jerseys[c], team='att' if tr.teams[c] == team else 'def',
                           x=round(float(p[0]), 1), y=round(float(p[1]), 1)))
        play.append(dict(t=round((n_before + j) / FPS_OUT, 1),
                         ball=dict(x=round(float(bp[0]), 1), y=round(float(bp[1]), 1),
                                   z=round(max(0.0, float(b3[2])), 1)),
                         players=pl))

    secs = int(p1.timestamp.total_seconds()) + (45 * 60 if per == 2 else 0)
    # --- match context: teams, score at that moment, and who is who (DFL match information)
    now = (per, p1.timestamp.total_seconds())
    home_goals = sum(1 for g in m.goals if g[:2] < now and g[2] == m.home_id)
    away_goals = sum(1 for g in m.goals if g[:2] < now and g[2] != m.home_id)
    context = dict(m.facts, attacking='home' if team == m.home_id else 'away',
                   score=f'{home_goals}:{away_goals}', minute=secs // 60 + 1)
    names = {pid_of(c): m.people.get(tr.pids[c], dict(name=None, pos=None)) for c in cols}
    return dict(
        match_id=m.match_id, period=per, clock=f'{secs // 60:02d}:{secs % 60:02d}',
        frames=frames, you_pid=pid_of(cb), passer_pid=pid_of(ca),
        pass1_frame_index=pass1_idx, reception_frame_index=n_before,
        options=options, best_option_pid=best_pid,
        actual=dict(target_pid=pid_of(tr.col[target]) if target else None,
                    intended_pid=intended,
                    end=dict(x=round(float(take_pos[0]), 1), y=round(float(take_pos[1]), 1)),
                    length=round(length, 1), success=bool(success),
                    outcome=outcome, taker=taker,
                    ball_max_z=round(max_z, 1), lofted=bool(max_z > LOFTED_Z)),
        pro_was_best=(intended == best_pid),
        context=context, names=names,
        difficulty=diff, n_close_options=n_close,
        pressure_m=round(pressure, 1), hold_s=round(hold, 2), teammates_within_35m=mates_35,
        # private fields (stripped before writing)
        _pressured=(mates_35 >= PREF_MIN_TEAMMATES and pressure <= PREF_PRESSURE_RADIUS_M),
        _t=p1.timestamp.total_seconds() + per * 10000,
        _sync=(kick1 - i1, kick2 - i2),
        # the state at the moment pass 2 is played, for calibrate_pass_model.py (pass success model)
        _calib=dict(pos=[norm(xy[kick2, c]) for c in cols], prev=[norm(xy[max(0, kick2 - 5), c]) for c in cols],
                    att=[bool(tr.teams[c] == team) for c in cols], passer=cols.index(cb),
                    taker=cols.index(take_col) if take_col is not None and take_col in cols else None,
                    take_pos=take_pos, max_z=max_z,
                    intended=next((k for k, c in enumerate(cols) if pid_of(c) == intended), None)),
        _play=dict(frames=play, kick_index=round((kick2 - rec) / step, 1),
                   take_index=round((take_k - rec) / step, 1)),
        _final=dict(options=final, best_option_pid=final[0]['pid'], pro_was_best=(intended == final[0]['pid']),
                    difficulty=f_diff, n_close_options=f_close),
    )


# ----------------------------------------------------------------------------
# Selection
# ----------------------------------------------------------------------------
def select(cands, matches, n, seed):
    """Greedy, quota-based pick of n moments:
    - spread over matches (n // n_matches each; leftovers to the matches with most
      candidates; never more than MAX_PER_MATCH from one match)
    - hard quotas: NOTBEST_SHARE pro != best, FAILED_SHARE failed passes
    - soft: prefer pressured moments (>= 3 teammates within 35 m, a defender within 8 m),
      ~1/3 each difficulty, best-option direction mix like the candidate pool
    - no two moments from the same match within 20 s of each other
    """
    rng = random.Random(seed)
    by_match = defaultdict(list)
    for c in cands:
        by_match[c['match_id']].append(c)
    mids = [m.match_id for m in matches if by_match[m.match_id]]
    order = sorted(mids, key=lambda k: -len(by_match[k]))
    quota = {k: min(MAX_PER_MATCH, n // len(mids) + (1 if i < n % len(mids) else 0))
             for i, k in enumerate(order)}

    tgt_diff = {'easy': n / 3, 'medium': n / 3, 'hard': n / 3}
    # best-option direction should mirror the candidate pool (otherwise the pro = best
    # quota drags in mostly sideways-best moments, because pros often play it safe)
    pool_dirs = Counter(c['options'][0]['direction'] for c in cands)
    tgt_dir = {d: n * v / len(cands) for d, v in pool_dirs.items()}
    tgt_notbest = round(NOTBEST_SHARE * n)
    tgt_failed = round(FAILED_SHARE * n)
    pool = list(cands)
    rng.shuffle(pool)
    chosen, cnt_m, cnt_d, cnt_dir = [], Counter(), Counter(), Counter()
    notbest = failed = 0
    while len(chosen) < n and pool:
        k = len(chosen)
        # failed passes are scarce and almost always "pro != best", so their quota is
        # filled first; otherwise the other quotas crowd them out
        want_failed = failed < tgt_failed
        best, best_s = None, -1
        for c in pool:
            if cnt_m[c['match_id']] >= quota[c['match_id']]:
                continue
            if c['actual']['success'] == want_failed:
                continue
            # hard quota: exactly tgt_notbest moments with pro != best
            if (notbest >= tgt_notbest) if not c['pro_was_best'] else ((k - notbest) >= n - tgt_notbest):
                continue
            if any(o['match_id'] == c['match_id'] and abs(o['_t'] - c['_t']) < 20 for o in chosen):
                continue
            s = 2.0 * (cnt_d[c['difficulty']] < tgt_diff[c['difficulty']])
            s += 2.0 * (cnt_dir[c['options'][0]['direction']] < tgt_dir[c['options'][0]['direction']])
            s += 3.0 * c['_pressured']
            s += 0.5 * rng.random()
            if s > best_s:
                best, best_s = c, s
        if best is None:
            break
        pool.remove(best)
        chosen.append(best)
        cnt_m[best['match_id']] += 1
        cnt_d[best['difficulty']] += 1
        cnt_dir[best['options'][0]['direction']] += 1
        notbest += not best['pro_was_best']
        failed += not best['actual']['success']
    chosen.sort(key=lambda c: (mids.index(c['match_id']), c['_t']))
    for i, c in enumerate(chosen, 1):
        c['id'] = f'm{i:02d}'
    return chosen


# ----------------------------------------------------------------------------
# QA and previews
# ----------------------------------------------------------------------------
def qa(mom):
    """Return a list of problems found in a finished moment."""
    probs = []
    rf = mom['frames'][mom['reception_frame_index']]
    you = next(p for p in rf['players'] if p['pid'] == mom['you_pid'])
    d = math.hypot(you['x'] - rf['ball']['x'], you['y'] - rf['ball']['y'])
    if d > 2.0:
        probs.append(f'ball {d:.1f} m from B at reception')
    for f in mom['frames']:
        for p in f['players'] + [dict(f['ball'], pid='ball')]:
            if not (-3 <= p['x'] <= PITCH_X + 3 and -3 <= p['y'] <= PITCH_Y + 3):
                probs.append(f"{p['pid']} off pitch at t={f['t']} ({p['x']}, {p['y']})")
    # attacking direction: attackers' deepest player (their GK) must be left of
    # the defenders' deepest player (their GK)
    att_min = min(p['x'] for p in rf['players'] if p['team'] == 'att')
    def_max = max(p['x'] for p in rf['players'] if p['team'] == 'def')
    if not att_min < PITCH_X / 2 < def_max:
        probs.append(f'attacking direction looks wrong (att min x {att_min}, def max x {def_max})')
    if you['x'] < DEF_THIRD_X:
        probs.append('B in own defensive third')
    return sorted(set(probs))


def draw_preview(mom, path):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.patches import Arc, Circle, Rectangle

    fig, ax = plt.subplots(figsize=(10.5, 7.4))
    ax.set_facecolor('#3a7d44')
    lc = dict(color='white', lw=1.4, alpha=0.85)
    ax.add_patch(Rectangle((0, 0), PITCH_X, PITCH_Y, fill=False, **lc))
    ax.plot([PITCH_X / 2] * 2, [0, PITCH_Y], **lc)
    ax.add_patch(Circle((PITCH_X / 2, PITCH_Y / 2), 9.15, fill=False, **lc))
    for x0, s in ((0, 1), (PITCH_X, -1)):
        ax.add_patch(Rectangle((x0, PITCH_Y / 2 - 20.16), s * 16.5, 40.32, fill=False, **lc))
        ax.add_patch(Rectangle((x0, PITCH_Y / 2 - 9.16), s * 5.5, 18.32, fill=False, **lc))
        ax.add_patch(Rectangle((x0, PITCH_Y / 2 - 3.66), -s * 1.5, 7.32, fill=False, **lc))
        ax.add_patch(Arc((x0 + s * 11, PITCH_Y / 2), 18.3, 18.3, theta1=-53 if s == 1 else 127,
                         theta2=53 if s == 1 else 233, **lc))

    rf = mom['frames'][mom['reception_frame_index']]
    # ball path of pass 1
    p1 = slice(mom['pass1_frame_index'], mom['reception_frame_index'] + 1)
    bx = [f['ball']['x'] for f in mom['frames'][p1]]
    by = [f['ball']['y'] for f in mom['frames'][p1]]
    ax.plot(bx, by, color='white', lw=1, ls=':', alpha=0.8, zorder=2)
    for p in rf['players']:
        is_you = p['pid'] == mom['you_pid']
        col = '#1f6fd1' if p['team'] == 'att' else '#d63a2f'
        ax.add_patch(Circle((p['x'], p['y']), 1.25, color=col, ec='white', lw=1, zorder=4))
        if is_you:
            ax.add_patch(Circle((p['x'], p['y']), 2.4, fill=False, ec='#ffd400', lw=2.5, zorder=5))
        ax.text(p['x'], p['y'], str(p['num']), color='white', ha='center', va='center',
                fontsize=6.5, weight='bold', zorder=6)
    ax.add_patch(Circle((rf['ball']['x'], rf['ball']['y']), 0.7, color='white', ec='black', lw=0.8, zorder=7))

    you = next(p for p in rf['players'] if p['pid'] == mom['you_pid'])
    best = next(p for p in rf['players'] if p['pid'] == mom['best_option_pid'])
    end = mom['actual']['end']
    ax.annotate('', xy=(end['x'], end['y']), xytext=(you['x'], you['y']), zorder=8,
                arrowprops=dict(arrowstyle='-|>', color='#ffd400', lw=2.2))
    ax.annotate('', xy=(best['x'], best['y']), xytext=(you['x'], you['y']), zorder=8,
                arrowprops=dict(arrowstyle='-|>', color='black', lw=1.8, ls='--'))
    tk = mom['actual']['taker']
    if tk and len(tk['run']) > 1:
        run_col = '#ffd400' if tk['pid'][0] == 'A' else '#ff8080'
        ax.plot([p[0] for p in tk['run']], [p[1] for p in tk['run']], color=run_col, lw=1.6, ls=':', zorder=8)
        ax.annotate('', xy=tuple(tk['run'][-1]), xytext=tuple(tk['run'][-2]), zorder=8,
                    arrowprops=dict(arrowstyle='-|>', color=run_col, lw=1.6))

    ax.set_xlim(-3, PITCH_X + 3)
    ax.set_ylim(-3, PITCH_Y + 3)
    ax.set_aspect('equal')
    ax.set_xticks([])
    ax.set_yticks([])
    verdict = 'pro = best' if mom['pro_was_best'] else 'pro ≠ best'
    outcome = ('completed' if mom['actual']['success'] else 'FAILED') + f" ({mom['actual']['outcome']})"
    ax.set_title(f"{mom['id']}  ·  {mom['difficulty']}  ·  {verdict}", fontsize=13, weight='bold')
    bo = next(o for o in mom['options'] if o['pid'] == mom['best_option_pid'])
    ax.text(0, -2.4, f"{mom['match_id']}  P{mom['period']} {mom['clock']}  ·  you = #{you['num']}  ·  "
                     f"pressure {mom['pressure_m']} m  ·  actual pass {outcome}  ·  best #{best['num']} "
                     f"(value {bo['value']})   →  attacking", fontsize=8, color='white', va='center')
    from matplotlib.lines import Line2D
    ax.legend(handles=[Line2D([], [], color='#ffd400', lw=2.2, label='actual pass'),
                       Line2D([], [], color='black', lw=1.8, ls='--', label='best option'),
                       Line2D([], [], color='#ff8080', lw=1.6, ls=':', label='taker run'),
                       Line2D([], [], marker='o', ls='', color='#1f6fd1', label='attacking'),
                       Line2D([], [], marker='o', ls='', color='#d63a2f', label='defending')],
              loc='upper left', fontsize=7, framealpha=0.8, ncol=5)
    fig.tight_layout()
    fig.savefig(path, dpi=90)
    plt.close(fig)


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
LICENCE = ('Contains data from the Deutsche Fußball Liga (DFL), published as open data by '
           'Bassek, M. et al. (2025), Scientific Data, doi:10.1038/s41597-025-04505-y. '
           'Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). '
           'Coordinates transformed (attack normalised left to right).')


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_data = next((d for d in (os.path.join(here, 'data'), os.path.join(here, 'RawData', '28196177'))
                         if glob(os.path.join(d, '*matchinformation*.xml'))), os.path.join(here, 'data'))
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=default_data)
    ap.add_argument('--out', default=os.path.join(here, 'moments.json'))
    ap.add_argument('--previews', default=os.path.join(here, 'previews'))
    ap.add_argument('--cache', default=os.path.join(here, 'cache'))
    ap.add_argument('--n', type=int, default=30)
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--workers', type=int, default=2)
    args = ap.parse_args()

    matches = discover_matches(args.data)
    if not matches:
        sys.exit(f'No DFL match files found in {args.data}')
    print(f'Found {len(matches)} matches in {args.data}')

    # 1. tracking -> cached numpy arrays (slow the first time)
    todo = [m for m in matches if not os.path.exists(os.path.join(args.cache, f'{m.match_id}.npz'))]
    if todo:
        print(f'Parsing tracking for {len(todo)} match(es) with kloppy (~1-2 min each)...')
        with ProcessPoolExecutor(max_workers=max(1, args.workers)) as ex:
            for m, _ in zip(todo, ex.map(parse_tracking, todo, [args.cache] * len(todo))):
                print(f'  parsed {m.match_id}')

    # 2-3. candidates
    cands, skips, sync = [], Counter(), []
    per_match_cands = Counter()
    for m in matches:
        tr = Tracking(os.path.join(args.cache, f'{m.match_id}.npz'))
        evs, ev_start, teams, team_left = load_events(m)
        m.facts, m.home_id, m.people = load_match_info(m)
        m.goals = [(e.period.id, e.timestamp.total_seconds(), e.team.team_id) for e in evs
                   if e.result is not None and e.result.name == 'GOAL']
        for per, tl in team_left.items():
            if per in tr.xy and tr.attack_sign(per, tl) != 1:
                print(f'  ! {m.match_id} P{per}: tracking direction disagrees with kick-off TeamLeft')
        offsets = estimate_offsets(tr, evs, ev_start)
        for p1, p2 in pass_pairs(evs, skips):
            c = build_candidate(m, tr, p1, p2, ev_start, offsets, skips)
            if c is not None:
                cands.append(c)
                per_match_cands[m.match_id] += 1
                sync.append(c['_sync'])
        print(f'  {m.match_id}: {per_match_cands[m.match_id]} valid candidate moments '
              f'(event clock offset ' + ', '.join(f'P{p} {o / FPS_RAW:+.2f}s' for p, o in sorted(offsets.items())) + ')')
    if not cands:
        sys.exit('No valid moments found.')
    s1 = np.abs([s[0] for s in sync]) / FPS_RAW
    s2 = np.abs([s[1] for s in sync]) / FPS_RAW
    print(f'Event->tracking sync correction: median {np.median(s1):.2f}s (pass 1), '
          f'{np.median(s2):.2f}s (pass 2)')

    # 4. selection + QA (a moment failing QA is replaced by re-running the selection without it)
    rejected = {}
    while True:
        chosen = select([c for c in cands if id(c) not in rejected], matches, args.n, args.seed)
        bad = {id(c): qa(c) for c in chosen}
        bad = {k: v for k, v in bad.items() if v}
        if not bad:
            break
        for c in chosen:
            if id(c) in bad:
                rejected[id(c)] = (f"{c['match_id']} P{c['period']} {c['clock']}", bad[id(c)])

    # 5. outputs
    os.makedirs(args.previews, exist_ok=True)
    for f in glob(os.path.join(args.previews, 'm*.png')):
        os.remove(f)
    out_moments = []
    for c in chosen:
        draw_preview({**c, **c['_final']}, os.path.join(args.previews, f"{c['id']}.png"))
        mom = {k: v for k, v in c.items() if not k.startswith('_')}
        mom.update(c['_final'])   # offside-aware options / best / difficulty (selection used the old ones)
        out_moments.append(dict(id=mom.pop('id'), **mom))
    doc = dict(
        meta=dict(
            source='DFL/IDSSE open dataset: 7 Bundesliga matches 2022/23, tracking (25 fps) + event data '
                   '(Figshare item 28196177)',
            licence=LICENCE,
            pitch=[PITCH_X, PITCH_Y], fps=FPS_OUT,
            coordinates='metres, origin bottom-left, x 0-105, y 0-68; attacking team always attacks left to right',
            pids='A<jersey> = attacking team, D<jersey> = defending team (per moment; names in moment.names)',
            value_formula=option_value.__doc__.strip(),
            value_params=VALUE_PARAMS,
            forward_first_rule=apply_forward_first.__doc__.strip(),
            game_value_model=dict(
                note='options[].value / best_option_pid here are the heuristic used to SELECT moments. The game '
                     'values every pass by expected value instead (src/game/value.ts): EV = P(success) * '
                     '(EPV(target) - EPV(ball)) - (1 - P(success)) * EPV_opponent(target), shown on 0-100.',
                p_success='Spearman-style logistic of the race margin (src/game/space.ts), bias 1.0 s, sigma 0.95 s, '
                          'fitted on 991 real DFL passes (calibrate_pass_model.py, pass_model_calibration.json)',
                epv_source='Expected Possession Value grid by Laurie Shaw, LaurieOnTracking '
                           '(https://github.com/Friends-of-Tracking-Data-FoTD/LaurieOnTracking, EPV_grid.csv)',
                epv_licence='MIT License, Copyright (c) 2021 Friends-of-Tracking-Data-FoTD (full text in src/game/epvGrid.ts)'),
            offside_rule=offside_line.__doc__.strip() + f' (OFFSIDE_TOL_M = {OFFSIDE_TOL_M}). An offside option has value 0.',
            direction_rule=pass_direction.__doc__.strip(),
            difficulty_rule=difficulty.__doc__.strip(),
            lane_open_rule=lane_open_m.__doc__.strip(),
            notes='actual.intended_pid = receiver for completed passes; for failed passes the teammate closest '
                  'to the ball line (or null). pro_was_best compares intended_pid with best_option_pid. '
                  'Options are measured at reception_frame_index. Frames start up to 2 s before the '
                  'pass 1 kick (pass1_frame_index) and end 0.5 s after reception. '
                  'actual.end = where the ball was taken over (or went out of play); actual.outcome = '
                  'received | intercepted | out | loose; actual.taker = {pid, t: seconds after reception, '
                  f'run: [[x, y], ...] his path from the reception frame to the takeover at {RUN_FPS} fps}} '
                  'or null. context = match facts (DFL match information), the attacking side, the score '
                  '(home:away) just before pass 1 and the match minute. names = {pid: {name, pos}} '
                  '(DFL short name; position from the line-up, English abbreviation, null for substitutes '
                  'without one). Takeover rule: ' + ' '.join(find_takeover.__doc__.split('\n\n')[1].split()),
        ),
        moments=out_moments,
    )
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    # the rest of every play (for the replays), loaded by the game only when a replay is watched
    plays_path = os.path.join(os.path.dirname(args.out), 'plays.json')
    with open(plays_path, 'w', encoding='utf-8') as fh:
        json.dump(dict(meta=dict(licence=LICENCE,
                                 notes='Per moment: frames from the reception (index 0 = moment frame '
                                       'reception_frame_index) through pass 2 and the takeover, '
                                       f'{PLAY_AFTER_S} s beyond, at {FPS_OUT} fps; ball z = height (m). '
                                       'kick_index / take_index: pass 2 kicked / ball taken over, in frames '
                                       'after the reception.'),
                       plays={c['id']: c['_play'] for c in chosen}),
                  fh, ensure_ascii=False, separators=(',', ':'))
    plays_size = os.path.getsize(plays_path)
    size = os.path.getsize(args.out)
    with open(args.out, encoding='utf-8') as fh:   # read back to confirm it is valid
        n_written = len(json.load(fh)['moments'])

    # summary
    print('\n================ SUMMARY ================')
    print(f'Wrote {args.out}: {n_written} moments, {size:,} bytes ({size / 1e6:.2f} MB), '
          f're-read OK; previews -> {args.previews}')
    print(f'Wrote {plays_path}: replay frames for {len(chosen)} moments, {plays_size:,} bytes '
          f'(median {int(np.median([len(c["_play"]["frames"]) for c in chosen]))} frames = '
          f'{np.median([len(c["_play"]["frames"]) for c in chosen]) / FPS_OUT:.1f} s after reception)')
    print('Moments per match:')
    mc = Counter(m['match_id'] for m in out_moments)
    for m in matches:
        print(f'  {m.match_id}: {mc[m.match_id]:2d}  (from {per_match_cands[m.match_id]} candidates)')
    dc = Counter(m['difficulty'] for m in out_moments)
    print('Difficulty: ' + ', '.join(f'{k} {dc[k]}' for k in ('easy', 'medium', 'hard')))
    nb = sum(not m['pro_was_best'] for m in out_moments)
    fl = sum(not m['actual']['success'] for m in out_moments)
    pr = sum(c['_pressured'] for c in chosen)
    print(f'Pro != best: {nb}/{len(out_moments)} ({100 * nb / len(out_moments):.0f} %)')
    print(f'Failed passes: {fl}/{len(out_moments)}   Pressured (pref. filter): {pr}/{len(out_moments)}')
    oc = Counter(m['actual']['outcome'] for m in out_moments)
    print('Pass 2 outcome (from tracking): ' + ', '.join(f'{k} {oc[k]}' for k in ('received', 'intercepted', 'out', 'loose')))
    print('Best-option direction:')
    for label, pool in (('all candidates', cands), ('selected', out_moments)):
        dirs = Counter(c['options'][0]['direction'] for c in pool)
        print(f'  {label:15s} ' + '  '.join(f'{k} {dirs[k]} ({100 * dirs[k] / len(pool):.0f} %)'
                                            for k in ('forward', 'sideways', 'backward')))
    back = [c for c in cands if c['options'][0]['direction'] == 'backward']
    blocked = sum(all(o['lane_open'] < FORWARD_OPEN_LANE_M for o in c['options'] if o['direction'] == 'forward')
                  for c in back)
    print(f'  backward-best moments with every forward lane < {FORWARD_OPEN_LANE_M:g} m: {blocked}/{len(back)}')
    print(f'Candidate pass pairs skipped ({sum(skips.values())}):')
    for k, v in skips.most_common():
        print(f'  {v:5d}  {k}')
    if rejected:
        print('Selected moments rejected by QA and replaced:')
        for desc, probs in rejected.values():
            print(f'  {desc}: {"; ".join(probs)}')
    else:
        print('QA: all selected moments passed (ball at B on reception, players on pitch, direction).')


if __name__ == '__main__':
    main()
