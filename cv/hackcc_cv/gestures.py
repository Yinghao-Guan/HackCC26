"""The agreed hand gestures (docs/02-technical-design.md, section 5), frame by frame.

1. Thumb + index double tap in the air  -> {"type": "gesture", "name": "double_tap"}
2. Fist, move, open                     -> {"type": "pan", "phase": start|move|end, dx, dy}
3. Pinch and hold, move                 -> {"type": "rotate", "phase": ..., dx, dy}
4. Pinch with both hands                -> {"type": "zoom", "phase": ..., "scale", cx, cy}
5. Both hands open, still for 2 s       -> {"type": "reset_progress", "progress"} then
                                           {"type": "gesture", "name": "reset"}

Positions in events are board px (through `to_board`). Nothing fires while the finger
touches the board, and the drawing hand (index out, the rest curled) is never a gesture.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from .hand_pose import Hand, HandPose, classify, palm_and_size

TAP_MAX_S = 0.35  # a pinch this short is a tap
DOUBLE_TAP_GAP_S = 0.45  # the second tap must start this soon after the first ends
HOLD_S = 0.45  # a pinch held this long starts rotating
FIST_S = 0.15  # a fist held this long starts moving the board
FIST_RELEASE_S = 0.15  # the hand must stay open this long to stop (ignores flicker)
LOST_S = 0.25  # a hand missing this long has left: its gestures end
RESET_S = 2.0
RESET_STILL = 0.6  # open palms may drift this much (hand units) during the countdown
PROGRESS_EVERY_S = 0.1
MATCH_GATE = 1.5  # a hand matches last frame's hand within this many hand sizes
LABEL_MISMATCH_COST = 0.25  # Left/Right only breaks ties: labels can flip
ZOOM_MIN_GAP = 1.0  # the two pinches must be this many hand sizes apart to start
ZOOM_LIMITS = (0.1, 10.0)

Mapper = Callable[[np.ndarray], np.ndarray]


def _identity(points: np.ndarray) -> np.ndarray:
    return points


@dataclass
class _Track:
    """What the engine remembers about one hand between frames."""

    last_seen: float
    palm: np.ndarray | None = None
    pinched: bool = False
    dropped: bool = False  # the hand went missing during this pinch
    pinch_start: float = 0.0
    pinch_in_zoom: bool = False  # this pinch is part of a two-hand zoom
    tap_end: float | None = None  # end of a first tap waiting for a second
    rotating: bool = False
    rotate_last: np.ndarray | None = None
    fist_since: float | None = None
    open_since: float | None = None  # when a fist opened while moving the board
    panning: bool = False
    pan_last: np.ndarray | None = None


@dataclass
class _Zoom:
    hands: tuple[str, str]
    start_distance: float
    scale: float = 1.0


class GestureEngine:
    def __init__(self, to_board: Mapper = _identity) -> None:
        self._to_board = to_board
        self._tracks: dict[str, _Track] = {}
        self._zoom: _Zoom | None = None
        self._reset_start: float | None = None
        self._reset_anchor: dict[str, np.ndarray] = {}
        self._reset_last_emit: float | None = None
        self._reset_done = False
        self._next_id = 1
        self.last_poses: dict[str, HandPose] = {}  # for debug views

    # -- public ---------------------------------------------------------------

    def update(self, hands: list[Hand], t: float, touching: bool = False) -> list[dict[str, Any]]:
        """Feed one frame's hands; get the gesture events it causes."""
        events: list[dict[str, Any]] = []
        if touching:
            self._end_everything(t, events)
            return events
        poses = self._classify(hands)
        self._forget_lost_hands(poses, t, events)
        for key, pose in poses.items():
            track = self._tracks.setdefault(key, _Track(last_seen=t))
            track.last_seen, track.palm = t, pose.palm
        for key, track in self._tracks.items():
            if key not in poses and track.pinched:
                track.dropped = True
        self.last_poses = poses
        self._update_zoom(poses, t, events)
        for key, pose in poses.items():
            self._update_pinch(key, pose, t, events)
            self._update_fist(key, pose, t, events)
        self._update_reset(poses, t, events)
        return events

    # -- helpers --------------------------------------------------------------

    def _board(self, point: np.ndarray) -> np.ndarray | None:
        mapped = np.asarray(self._to_board(np.asarray(point, dtype=np.float64).reshape(1, 2)))
        mapped = mapped.reshape(-1)[:2]
        return mapped if np.all(np.isfinite(mapped)) else None

    def _classify(self, hands: list[Hand]) -> dict[str, HandPose]:
        """Match each hand to last frame's hands by palm position (MediaPipe's order and
        Left/Right labels can flip), then classify it with that hand's pinch history."""
        found = [(hand, *palm_and_size(hand.landmarks)) for hand in hands]
        pairs = sorted(
            (
                float(np.linalg.norm(palm - track.palm)) / size
                + (0.0 if hand.label == key.split("#")[0] else LABEL_MISMATCH_COST),
                i,
                key,
            )
            for i, (hand, palm, size) in enumerate(found)
            for key, track in self._tracks.items()
            if track.palm is not None
        )
        keys: dict[int, str] = {}
        for cost, i, key in pairs:
            if cost <= MATCH_GATE and i not in keys and key not in keys.values():
                keys[i] = key
        poses: dict[str, HandPose] = {}
        for i, (hand, _, _) in enumerate(found):
            key = keys.get(i) or self._new_key(hand.label, set(keys.values()) | set(poses))
            track = self._tracks.get(key)
            poses[key] = classify(hand, was_pinched=track.pinched if track else False)
        return poses

    def _new_key(self, label: str, taken: set[str]) -> str:
        if label not in self._tracks and label not in taken:
            return label
        self._next_id += 1
        return f"{label}#{self._next_id}"

    def _end_everything(self, t: float, events: list[dict[str, Any]]) -> None:
        for key in list(self._tracks):
            self._end_hand(key, t, events)
        self._tracks.clear()
        self._end_zoom(t, events)
        self._cancel_reset(t, events)

    def _forget_lost_hands(self, poses: dict[str, HandPose], t: float, events: list[dict[str, Any]]) -> None:
        for key in [k for k, tr in self._tracks.items() if k not in poses and t - tr.last_seen > LOST_S]:
            self._end_hand(key, t, events)
            if self._zoom and key in self._zoom.hands:
                self._end_zoom(t, events)
            del self._tracks[key]

    def _end_hand(self, key: str, t: float, events: list[dict[str, Any]]) -> None:
        self._end_rotate(key, t, events)
        track = self._tracks[key]
        if track.panning:
            track.panning = False
            events.append(_motion("pan", "end", track.pan_last, t, key))

    # -- 4. zoom ----------------------------------------------------------------

    def _update_zoom(self, poses: dict[str, HandPose], t: float, events: list[dict[str, Any]]) -> None:
        pinching = [k for k, p in poses.items() if p.pinched]
        if len(pinching) < 2:
            self._end_zoom(t, events)
            return
        a, b = pinching[0], pinching[1]
        if self._zoom is None:
            camera_gap = float(np.linalg.norm(poses[a].pinch_point - poses[b].pinch_point))
            if camera_gap < ZOOM_MIN_GAP * (poses[a].size + poses[b].size) / 2:
                # Too close to measure a stretch: wait, and don't let either pinch rotate.
                self._tracks[a].pinch_in_zoom = self._tracks[b].pinch_in_zoom = True
                return
        pa, pb = self._board(poses[a].pinch_point), self._board(poses[b].pinch_point)
        if pa is None or pb is None:
            return
        distance, centre = float(np.linalg.norm(pa - pb)), (pa + pb) / 2
        if self._zoom is None:
            for key in (a, b):
                self._end_rotate(key, t, events)
                self._tracks[key].pinch_in_zoom = True
            self._zoom = _Zoom(hands=(a, b), start_distance=max(distance, 1e-6))
            events.append(_zoom_event("start", 1.0, centre, t))
        else:
            low, high = ZOOM_LIMITS
            self._zoom.scale = min(high, max(low, distance / self._zoom.start_distance))
            events.append(_zoom_event("move", self._zoom.scale, centre, t))

    def _end_zoom(self, t: float, events: list[dict[str, Any]]) -> None:
        if self._zoom is not None:
            events.append(_zoom_event("end", self._zoom.scale, None, t))
            self._zoom = None

    # -- 1 and 3. pinch: tap, double tap, hold to rotate ------------------------

    def _update_pinch(self, key: str, pose: HandPose, t: float, events: list[dict[str, Any]]) -> None:
        track = self._tracks[key]
        if pose.pinched and not track.pinched:
            track.pinched, track.pinch_start, track.dropped = True, t, False
        elif not pose.pinched and track.pinched:
            track.pinched = False
            if track.rotating:
                self._end_rotate(key, t, events)
            elif not track.pinch_in_zoom and not track.dropped and t - track.pinch_start <= TAP_MAX_S:
                self._tap(key, track, t, events)
            track.pinch_in_zoom = False
        elif pose.pinched and not track.pinch_in_zoom:
            point = self._board(pose.pinch_point)
            if point is None:
                return
            if track.rotating and track.rotate_last is not None:
                events.append(_motion("rotate", "move", point, t, key, point - track.rotate_last))
                track.rotate_last = point
            elif not track.rotating and t - track.pinch_start >= HOLD_S:
                track.rotating, track.rotate_last, track.tap_end = True, point, None
                events.append(_motion("rotate", "start", point, t, key))

    def _tap(self, key: str, track: _Track, t: float, events: list[dict[str, Any]]) -> None:
        if track.tap_end is not None and track.pinch_start - track.tap_end <= DOUBLE_TAP_GAP_S:
            events.append({"type": "gesture", "name": "double_tap", "hand": key, "t": t})
            track.tap_end = None
        else:
            track.tap_end = t

    def _end_rotate(self, key: str, t: float, events: list[dict[str, Any]]) -> None:
        track = self._tracks.get(key)
        if track is not None and track.rotating:
            track.rotating = False
            events.append(_motion("rotate", "end", track.rotate_last, t, key))

    # -- 2. fist to move the board ------------------------------------------------

    def _update_fist(self, key: str, pose: HandPose, t: float, events: list[dict[str, Any]]) -> None:
        track = self._tracks[key]
        if pose.pose != "fist":
            track.fist_since = None
            if track.panning:
                track.open_since = track.open_since if track.open_since is not None else t
                if t - track.open_since >= FIST_RELEASE_S:
                    track.panning = False
                    events.append(_motion("pan", "end", track.pan_last, t, key))
            return
        track.open_since = None
        track.fist_since = track.fist_since if track.fist_since is not None else t
        palm = self._board(pose.palm)
        if palm is None:
            return
        if track.panning and track.pan_last is not None:
            events.append(_motion("pan", "move", palm, t, key, palm - track.pan_last))
            track.pan_last = palm
        elif not track.panning and t - track.fist_since >= FIST_S:
            track.panning, track.pan_last = True, palm
            events.append(_motion("pan", "start", palm, t, key))

    # -- 5. reset: both hands open and still for 2 s ------------------------------

    def _update_reset(self, poses: dict[str, HandPose], t: float, events: list[dict[str, Any]]) -> None:
        open_hands = {k: p for k, p in poses.items() if p.pose == "open"}
        if len(open_hands) < 2:
            self._cancel_reset(t, events)
            self._reset_done = False  # re-armed once the palms come down
            return
        if self._reset_done:
            return
        moved = any(
            k not in self._reset_anchor
            or np.linalg.norm(p.palm - self._reset_anchor[k]) / p.size > RESET_STILL
            for k, p in open_hands.items()
        )
        if self._reset_start is None or moved:
            self._cancel_reset(t, events)
            self._reset_start = t
            self._reset_anchor = {k: p.palm.copy() for k, p in open_hands.items()}
            return
        progress = min(1.0, (t - self._reset_start) / RESET_S)
        if progress >= 1.0:
            events.append(_progress_event(1.0, t))
            events.append({"type": "gesture", "name": "reset", "t": t})
            self._reset_done = True
            self._reset_start, self._reset_last_emit = None, None
        elif self._reset_last_emit is None or t - self._reset_last_emit >= PROGRESS_EVERY_S:
            events.append(_progress_event(progress, t))
            self._reset_last_emit = t

    def _cancel_reset(self, t: float, events: list[dict[str, Any]]) -> None:
        if self._reset_last_emit is not None:
            events.append(_progress_event(0.0, t))  # tells the page to hide the ring
        self._reset_start, self._reset_last_emit = None, None
        self._reset_anchor = {}


# -- event builders -----------------------------------------------------------------


def _round_point(point: np.ndarray | None) -> tuple[float | None, float | None]:
    if point is None:
        return None, None
    return round(float(point[0]), 1), round(float(point[1]), 1)


def _motion(
    kind: str, phase: str, point: np.ndarray | None, t: float, hand: str,
    delta: np.ndarray | None = None,
) -> dict[str, Any]:
    x, y = _round_point(point)
    event: dict[str, Any] = {"type": kind, "phase": phase, "x": x, "y": y, "hand": hand, "t": t}
    if delta is not None:
        event.update(dx=round(float(delta[0]), 2), dy=round(float(delta[1]), 2))
    return event


def _zoom_event(phase: str, scale: float, centre: np.ndarray | None, t: float) -> dict[str, Any]:
    cx, cy = _round_point(centre)
    safe_scale = round(scale, 4) if math.isfinite(scale) else 1.0
    return {"type": "zoom", "phase": phase, "scale": safe_scale, "cx": cx, "cy": cy, "t": t}


def _progress_event(progress: float, t: float) -> dict[str, Any]:
    return {"type": "reset_progress", "progress": round(progress, 3), "t": t}
