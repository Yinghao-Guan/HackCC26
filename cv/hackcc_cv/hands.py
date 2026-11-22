"""Hand tracking with MediaPipe (Tasks API; `mp.solutions.hands` no longer exists in 1.x)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

from .hand_pose import Hand

MAX_HANDS = 2  # two hands are needed for zoom and reset
MIN_CONFIDENCE = 0.5


class HandTracker:
    """Finds up to two hands per frame. Use it from one thread only."""

    def __init__(self, landmarker: Any) -> None:
        self._landmarker = landmarker
        self._last_timestamp = -1

    @classmethod
    def from_model(cls, model_path: Path) -> HandTracker:
        options = vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(model_path)),
            running_mode=vision.RunningMode.VIDEO,  # tracks between frames: faster, steadier
            num_hands=MAX_HANDS,
            min_hand_detection_confidence=MIN_CONFIDENCE,
            min_hand_presence_confidence=MIN_CONFIDENCE,
            min_tracking_confidence=MIN_CONFIDENCE,
        )
        return cls(vision.HandLandmarker.create_from_options(options))

    def detect(self, image_bgr: np.ndarray, timestamp_ms: int) -> list[Hand]:
        # VIDEO mode needs strictly increasing timestamps.
        timestamp_ms = max(int(timestamp_ms), self._last_timestamp + 1)
        self._last_timestamp = timestamp_ms

        height, width = image_bgr.shape[:2]
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        result = self._landmarker.detect_for_video(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp_ms
        )
        hands = []
        for points, labels in zip(result.hand_landmarks, result.handedness):
            landmarks = np.array([(p.x * width, p.y * height) for p in points], dtype=np.float64)
            best = labels[0]
            hands.append(Hand(label=best.category_name, landmarks=landmarks, score=float(best.score)))
        return hands

    def close(self) -> None:
        self._landmarker.close()
