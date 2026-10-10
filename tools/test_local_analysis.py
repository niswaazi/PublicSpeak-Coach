"""Tests for frame validation and metric calculations in the local API."""

from types import SimpleNamespace
import unittest

import cv2
import numpy as np
from fastapi import HTTPException

from server import analyze_jpeg, estimate_gaze, estimate_posture, estimate_smile


def point(x: float, y: float, visibility: float = 1) -> SimpleNamespace:
    return SimpleNamespace(x=x, y=y, visibility=visibility)


class LocalAnalysisTests(unittest.TestCase):
    def test_gaze_is_centered_when_irises_are_centered(self) -> None:
        face = [point(0.5, 0.5) for _ in range(478)]
        for start, end, iris in ((33, 133, 468), (362, 263, 473)):
            face[start] = point(0.3, 0.4)
            face[end] = point(0.5, 0.4)
            face[iris] = point(0.4, 0.4)

        self.assertEqual(estimate_gaze(face), 100)
        self.assertIsNone(estimate_gaze(face[:400]))

    def test_posture_checks_visible_shoulders_and_hips(self) -> None:
        pose = [point(0.5, 0.5) for _ in range(25)]
        pose[11], pose[12] = point(0.35, 0.3), point(0.65, 0.3)
        pose[23], pose[24] = point(0.4, 0.7), point(0.6, 0.7)

        self.assertEqual(estimate_posture(pose), 100)
        pose[12] = point(0.65, 0.3, visibility=0.1)
        self.assertIsNone(estimate_posture(pose))

    def test_smile_uses_both_face_blendshapes(self) -> None:
        categories = [
            SimpleNamespace(category_name="mouthSmileLeft", score=0.4),
            SimpleNamespace(category_name="mouthSmileRight", score=0.2),
        ]

        self.assertEqual(estimate_smile(categories), 30)

    def test_frame_endpoint_input_is_decoded_and_metrics_are_explicit(self) -> None:
        success, encoded = cv2.imencode(".jpg", np.zeros((64, 96, 3), dtype=np.uint8))
        self.assertTrue(success)

        result = analyze_jpeg(encoded.tobytes())

        self.assertEqual(result["width"], 96)
        self.assertEqual(result["height"], 64)
        self.assertEqual(
            set(result["metrics"]),
            {"gaze", "posture", "gesture", "expression"},
        )
        self.assertIsNone(result["metrics"]["gaze"])
        self.assertEqual(result["hands"], [])

    def test_rejects_invalid_frame_bytes(self) -> None:
        with self.assertRaises(HTTPException) as error:
            analyze_jpeg(b"not an image")

        self.assertEqual(error.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
