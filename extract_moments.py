#!/usr/bin/env python
"""
extract_moments.py
==================

Builds drop-in moment files for the football decision game from the DFL / IDSSE open dataset
(7 Bundesliga matches 2022/23, tracking at 25 fps + events, CC-BY 4.0; Bassek et al. 2025,
Scientific Data, doi:10.1038/s41597-025-04505-y).

A "moment" is two consecutive open-play passes by the same team:
    pass 1: A -> B            (the incoming ball)
    pass 2: B -> ?            (made <= 3 s after B receives; the decision we test)

Run (needs node + `npm install` for the game's checker):
    pip install kloppy matplotlib numpy
    python extract_moments.py --n 30          # data in ./RawData/28196177 (or ./data)

Useful options:
    --out DIR         where <id>.json + <id>.play.json go (default public/moments, the app itself,
                      whose manifest is then refreshed); moments already there are never re-picked
    --clean           delete the moment files in --out first (regenerate everything)
    --n 30            number of moments to add
    --seed 7          selection seed (selection is deterministic for a given seed)
    --data DIR        folder with the DFL XML files (matchinformation / events_raw /
                      positions_raw_observed per match)
    --workers 2       parallel processes for parsing the (400 MB) tracking files
    --cache DIR       where parsed tracking arrays are cached (.npz); delete to re-parse
    --rejected DIR    candidates that failed the game's checks, with the reason (default rejected/)

Pipeline
--------
1. kloppy (sportec module) loads events and tracking.  Tracking is converted to
   compact numpy arrays per period and cached, because each XML takes ~80 s to parse.
2. Candidate pass pairs come from the event feed.  The event clock and the
   tracking clock are aligned via absolute UTC timestamps, and then the exact kick /
   reception frames are refined from the tracking itself (ball-to-player distance).
3. Every candidate becomes a moment file holding raw facts only (the data contract,
   src/data/moment.schema.json): frames, the real pass and its outcome, context, names.
4. Candidates are checked in batches by the GAME's own code (scripts/check_moments.ts, run
   with node): validation, the race / expected-value model, simulated taps and its assertions.
   Failures go to rejected/ with the reason. Checking continues until the passing ones can fill
   --n with a balanced difficulty mix (difficulty computed by the game's model), spread over the
   matches, with some failed passes.
5. <id>.json + <id>.play.json, previews/<id>.png and a printed summary are written.

Nothing here judges a pass: values, the best option and difficulty all come from the game.
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
FPS_OUT = 10          # frame rate of the moment files
SCHEMA_VERSION = 1    # data contract version (src/data/moment.schema.json)

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
RUN_FPS = 5               # sampling rate of the taker's run in the moment file
PLAY_AFTER_S = 1.5        # <id>.play.json: keep following the play this long after the takeover...
PLAY_MAX_S = 9.0          # ...but at most this long after the reception

# Selection
FAILED_SHARE = 0.20       # share of selected moments where pass 2 failed
MIN_GAP_S = 20.0          # no two moments from the same match within this many seconds
CHECK_BATCH = 60          # candidates checked by the game per node run

# "Pressure" preference used during selection
PREF_TEAMMATES_RADIUS_M = 35.0
PREF_MIN_TEAMMATES = 3
PREF_PRESSURE_RADIUS_M = 8.0


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
    # measured ball height during pass 2 (kick to takeover); the game decides what counts as lofted
    zs = ball[kick2:take_k + 1, 2]
    max_z = float(np.nanmax(zs)) if np.isfinite(zs).any() else 0.0

    # --- the decision moment (reception frame): only what selection needs as a preference
    #     (the game computes options, pressure and difficulty itself)
    defs = np.array([norm(xy[rec, c]) for c in def_cols])
    pressure = float(np.min(np.linalg.norm(defs - b_pos, axis=1)))
    mates_35 = sum(1 for c in att_cols if c != cb and np.linalg.norm(norm(xy[rec, c]) - b_pos) <= PREF_TEAMMATES_RADIUS_M)

    def pid_of(c):
        return ('A' if tr.teams[c] == team else 'D') + str(tr.jerseys[c])

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
    # stable id: match + the DFL tracking frame number (N) of the reception
    stable_id = f'{m.match_id}-{tr.n0[per] + rec}'
    # --- match context: teams, score at that moment, and who is who (DFL match information)
    now = (per, p1.timestamp.total_seconds())
    home_goals = sum(1 for g in m.goals if g[:2] < now and g[2] == m.home_id)
    away_goals = sum(1 for g in m.goals if g[:2] < now and g[2] != m.home_id)
    context = dict(m.facts, attacking='home' if team == m.home_id else 'away',
                   score=f'{home_goals}:{away_goals}', minute=secs // 60 + 1)
    names = {pid_of(c): m.people.get(tr.pids[c], dict(name=None, pos=None)) for c in cols}
    # public fields = the data contract (src/data/moment.schema.json): raw facts only
    return dict(
        schema_version=SCHEMA_VERSION, id=stable_id,
        match_id=m.match_id, period=per, clock=f'{secs // 60:02d}:{secs % 60:02d}',
        frames=frames, you_pid=pid_of(cb), passer_pid=pid_of(ca),
        pass1_frame_index=pass1_idx, reception_frame_index=n_before, hold_s=round(hold, 2),
        actual=dict(target_pid=pid_of(tr.col[target]) if target else None,
                    intended_pid=intended,
                    end=dict(x=round(float(take_pos[0]), 1), y=round(float(take_pos[1]), 1)),
                    length=round(length, 1), success=bool(success),
                    outcome=outcome, taker=taker,
                    ball_max_z=round(max_z, 1)),
        context=context, names=names,
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
        _play=dict(schema_version=SCHEMA_VERSION, id=stable_id, frames=play, kick_index=round((kick2 - rec) / step, 1),
                   take_index=round((take_k - rec) / step, 1)),
        _frame=int(tr.n0[per] + rec),
    )


# ----------------------------------------------------------------------------
# Selection
# ----------------------------------------------------------------------------
def public(c):
    """The moment file: the data contract's fields only."""
    return {k: v for k, v in c.items() if not k.startswith('_')}


def too_close(c, others):
    """Same match and within MIN_GAP_S of one of `others` ((match_id, frame) pairs)."""
    return any(mid == c['match_id'] and abs(fr - c['_frame']) < MIN_GAP_S * FPS_RAW for mid, fr in others)


def check_with_game(here, batch, work_dir):
    """Write a batch of candidates as moment files and run the game's checker on them.
    Returns {id: report} (report = ok, problems, difficulty, stats; see scripts/check_moments.ts)."""
    for f in glob(os.path.join(work_dir, '*.json')):
        os.remove(f)
    for c in batch:
        with open(os.path.join(work_dir, f"{c['id']}.json"), 'w', encoding='utf-8') as fh:
            json.dump(public(c), fh, ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(work_dir, f"{c['id']}.play.json"), 'w', encoding='utf-8') as fh:
            json.dump(c['_play'], fh, ensure_ascii=False, separators=(',', ':'))
    res = os.path.join(work_dir, 'result.json.out')
    run_node(here, 'scripts/check_moments.ts', work_dir, '--json', res, '--quiet', check=False)
    with open(res, encoding='utf-8') as fh:
        return {r['id']: r for r in json.load(fh)['moments']}


def select(here, cands, matches, n, seed, existing, work_dir, on_reject):
    """Pick n moments that pass the game's checks, with a balanced difficulty mix.

    Candidates are taken in a seeded random order (pressured ones first: >= 3 teammates within 35 m
    and a defender within 8 m), checked by the game in batches, and greedily assigned to quotas:
      - difficulty (the game's model): n / 3 each of easy / medium / hard
      - matches: spread evenly (n / n_matches each, the rest to the matches with most candidates)
      - FAILED_SHARE failed passes
      - never within MIN_GAP_S of another moment of the same match (existing ones included)
    Checking stops as soon as every quota is filled; if the pool runs out the quotas are relaxed
    (failed share, then match spread, then difficulty) to still reach n. Returns the chosen
    candidates with their check reports.
    """
    rng = random.Random(seed)
    by_match = Counter(c['match_id'] for c in cands)
    mids = [m.match_id for m in matches if by_match[m.match_id]]
    order = sorted(mids, key=lambda k: -by_match[k])
    q_match = {k: n // len(mids) + (1 if i < n % len(mids) else 0) for i, k in enumerate(order)}
    q_diff = {d: n // 3 + (1 if i < n % 3 else 0) for i, d in enumerate(('medium', 'hard', 'easy'))}
    q_failed = round(FAILED_SHARE * n)

    pool = [c for c in cands if not too_close(c, existing)]
    rng.shuffle(pool)
    pool.sort(key=lambda c: not c['_pressured'])          # stable: pressured first, shuffled within
    chosen, reports = [], {}
    taken = list(existing)
    cnt_m, cnt_d = Counter(), Counter()
    failed = 0

    def fits(c, r, strict):
        if too_close(c, taken):
            return False
        if strict >= 1 and cnt_d[r['difficulty']] >= q_diff[r['difficulty']]:
            return False
        if strict >= 2 and cnt_m[c['match_id']] >= q_match[c['match_id']]:
            return False
        if strict >= 3:
            if not c['actual']['success'] and failed >= q_failed:
                return False   # enough failed passes
            if c['actual']['success'] and n - len(chosen) <= q_failed - failed:
                return False   # the remaining places are for the failed passes we still need
        return True

    def take(c, r):
        nonlocal failed
        chosen.append(c)
        taken.append((c['match_id'], c['_frame']))
        cnt_m[c['match_id']] += 1
        cnt_d[r['difficulty']] += 1
        failed += not c['actual']['success']

    checked = []   # (candidate, report) that passed, not yet chosen
    i = 0
    while len(chosen) < n and i < len(pool):
        batch = pool[i:i + CHECK_BATCH]
        i += len(batch)
        got = check_with_game(here, batch, work_dir)
        for c in batch:
            r = got.get(c['id'])
            if r is None or not r['ok']:
                on_reject(c, r['problems'] if r else ['checker produced no result'])
                continue
            reports[c['id']] = r
            checked.append(c)
        # failed passes first (scarce), then the rest, strictest quotas first
        for c in sorted(list(checked), key=lambda c: c['actual']['success']):
            if len(chosen) < n and fits(c, reports[c['id']], 3):
                take(c, reports[c['id']])
                checked.remove(c)
        print(f'  checked {i}/{len(pool)} candidates: {len(reports)} passed, chosen {len(chosen)}/{n} '
              f'(easy {cnt_d["easy"]}, medium {cnt_d["medium"]}, hard {cnt_d["hard"]})')
    # pool exhausted: relax the quotas step by step
    for strict in (2, 1, 0):
        for c in list(checked):
            if len(chosen) < n and fits(c, reports[c['id']], strict):
                take(c, reports[c['id']])
                checked.remove(c)
    if len(chosen) < n:
        print(f'  ! only {len(chosen)} moments pass the checks (asked for {n})')
    chosen.sort(key=lambda c: (mids.index(c['match_id']), c['_t']))
    return chosen, reports


# ----------------------------------------------------------------------------
# QA and previews
# ----------------------------------------------------------------------------
def draw_preview(mom, rep, path):
    """Reception frame with the pro's pass (yellow), the game's best option (dashed) and the taker's run."""
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
    best = rep['stats']['best']
    end = mom['actual']['end']
    ax.annotate('', xy=(end['x'], end['y']), xytext=(you['x'], you['y']), zorder=8,
                arrowprops=dict(arrowstyle='-|>', color='#ffd400', lw=2.2))
    ax.annotate('', xy=(best['end']['x'], best['end']['y']), xytext=(you['x'], you['y']), zorder=8,
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
    verdict = 'pro = best' if rep['stats']['proIsBest'] else 'pro ≠ best'
    outcome = ('completed' if mom['actual']['success'] else 'FAILED') + f" ({mom['actual']['outcome']})"
    ax.set_title(f"{mom['id']}  ·  {rep['difficulty']}  ·  {verdict}", fontsize=13, weight='bold')
    space = ' into space' if best['intoSpace'] else ''
    ax.text(0, -2.4, f"{mom['match_id']}  P{mom['period']} {mom['clock']}  ·  you = #{you['num']}  ·  "
                     f"pressure {rep['parts']['pressure']} m  ·  actual pass {outcome}  ·  best #{best['num']}{space} "
                     f"(value {best['value']}, {round(100 * best['p'])}%)   →  attacking", fontsize=8, color='white', va='center')
    from matplotlib.lines import Line2D
    ax.legend(handles=[Line2D([], [], color='#ffd400', lw=2.2, label='actual pass'),
                       Line2D([], [], color='black', lw=1.8, ls='--', label='best option (game)'),
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


def run_node(here, script, *args, check=True):
    """Run one of the game's TypeScript scripts (via tsx), so the pipeline uses the game's own code."""
    import subprocess
    return subprocess.run(['node', '--import', 'tsx', script, *map(str, args)], cwd=here, check=check)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_data = next((d for d in (os.path.join(here, 'data'), os.path.join(here, 'RawData', '28196177'))
                         if glob(os.path.join(d, '*matchinformation*.xml'))), os.path.join(here, 'data'))
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=default_data)
    ap.add_argument('--out', default=os.path.join(here, 'public', 'moments'),
                    help='folder for <id>.json + <id>.play.json (default: the app, public/moments)')
    ap.add_argument('--clean', action='store_true', help='delete the moment files already in --out first')
    ap.add_argument('--rejected', default=os.path.join(here, 'rejected'),
                    help='candidates that failed the game\'s checks, with the reason')
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

    # 4. moments already there (by stable id) are never picked again, nor anything within MIN_GAP_S of them
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.previews, exist_ok=True)
    if args.clean:
        for f in glob(os.path.join(args.out, '*.json')) + glob(os.path.join(args.previews, '*.png')):
            os.remove(f)
    app_dir = os.path.join(here, 'public', 'moments')
    existing = []
    for d in {os.path.abspath(args.out), os.path.abspath(app_dir)}:
        for f in glob(os.path.join(d, '*.json')):
            mm = re.match(r'^(.+)-(\d+)\.json$', os.path.basename(f))
            if mm and not f.endswith('.play.json'):
                existing.append((mm.group(1), int(mm.group(2))))
    if existing:
        print(f'{len(existing)} moments already exist: they and anything within {MIN_GAP_S:g} s of them are skipped')

    #    checked by the game: failures go to --rejected with the reason
    os.makedirs(args.rejected, exist_ok=True)
    for f in glob(os.path.join(args.rejected, '*')):
        os.remove(f)
    work = os.path.join(args.rejected, '.work')
    os.makedirs(work, exist_ok=True)
    reject_reasons = Counter()

    def on_reject(c, problems):
        with open(os.path.join(args.rejected, f"{c['id']}.json"), 'w', encoding='utf-8') as fh:
            json.dump(public(c), fh, ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(args.rejected, f"{c['id']}.play.json"), 'w', encoding='utf-8') as fh:
            json.dump(c['_play'], fh, ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(args.rejected, f"{c['id']}.reason.txt"), 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(problems) + '\n')
        for p in problems:   # tally by kind (numbers and player ids stripped)
            reject_reasons[re.sub(r'#\d+|-?\d+(\.\d+)?%?|\(.*?\)', '…', p.split(': ', 1)[-1])[:90]] += 1

    print(f'Checking candidates with the game (scripts/check_moments.ts), {CHECK_BATCH} at a time...')
    chosen, reports = select(here, cands, matches, args.n, args.seed, existing, work, on_reject)
    import shutil
    shutil.rmtree(work, ignore_errors=True)

    # 5. outputs: one file per moment (the data contract: raw facts only) + its replay data. The game
    #    computes every judgement itself; it finds the files through the manifest (index.json).
    size = 0
    for c in chosen:
        draw_preview(public(c), reports[c['id']], os.path.join(args.previews, f"{c['id']}.png"))
        path = os.path.join(args.out, f"{c['id']}.json")
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(public(c), fh, ensure_ascii=False, separators=(',', ':'))
        size += os.path.getsize(path)
        with open(os.path.join(args.out, f"{c['id']}.play.json"), 'w', encoding='utf-8') as fh:
            json.dump(c['_play'], fh, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(args.out, 'LICENCE.txt'), 'w', encoding='utf-8') as fh:
        fh.write(LICENCE + '\n')
    in_app = os.path.abspath(args.out) == os.path.abspath(app_dir)
    if in_app:   # writing straight into the app: refresh the manifest too
        run_node(here, 'scripts/build_manifest.ts', args.out)

    # summary (judgements from the game's checker)
    out = [reports[c['id']] for c in chosen]
    k = max(1, len(out))
    print('\n================ SUMMARY ================')
    print(f'Wrote {len(chosen)} moments to {args.out} ({size / 1e6:.2f} MB, + <id>.play.json replays); '
          f'previews -> {args.previews}')
    if not in_app:
        print('  drop them in: copy the .json files into public/moments, then npm run manifest && npm run check')
    print('Moments per match:')
    mc = Counter(c['match_id'] for c in chosen)
    for m in matches:
        print(f'  {m.match_id}: {mc[m.match_id]:2d}  (from {per_match_cands[m.match_id]} candidates)')
    dc = Counter(r['difficulty'] for r in out)
    print('Difficulty (game model): ' + ', '.join(f'{d} {dc[d]}' for d in ('easy', 'medium', 'hard')))
    pb = sum(r['stats']['proIsBest'] for r in out)
    w5 = [r for r in out if r['stats']['proValue'] is not None]
    n5 = sum(r['stats']['proValue'] >= r['stats']['best']['value'] - 5 for r in w5)
    print(f'Pro = best (same pass): {pb}/{len(out)} ({100 * pb / k:.0f} %); '
          f'pro within 5 points of the best: {n5}/{len(w5)}')
    sp = sum(r['stats']['best']['intoSpace'] for r in out)
    ps = sum(r['stats']['proIntoSpace'] for r in out)
    lo = sum(r['stats']['proLofted'] for r in out)
    print(f'Best option into space: {sp}/{len(out)}; pro\'s pass into space: {ps}/{len(out)}; pro\'s pass lofted: {lo}/{len(out)}')
    fl = sum(not c['actual']['success'] for c in chosen)
    pr = sum(c['_pressured'] for c in chosen)
    print(f'Failed passes: {fl}/{len(chosen)}   Pressured (pref. filter): {pr}/{len(chosen)}')
    oc = Counter(c['actual']['outcome'] for c in chosen)
    print('Pass 2 outcome (from tracking): ' + ', '.join(f'{o} {oc[o]}' for o in ('received', 'intercepted', 'out', 'loose')))
    print(f'Candidate pass pairs skipped ({sum(skips.values())}):')
    for kk, v in skips.most_common():
        print(f'  {v:5d}  {kk}')
    nrej = len(glob(os.path.join(args.rejected, '*.reason.txt')))
    print(f'Rejected by the game\'s checks: {nrej} candidates (files + reasons in {args.rejected})')
    for kk, v in reject_reasons.most_common(8):
        print(f'  {v:5d}  {kk}')

if __name__ == '__main__':
    main()
