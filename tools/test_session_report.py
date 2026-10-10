"""Tests for the offline session report utility."""

import json
import tempfile
import unittest
from pathlib import Path

from session_report import load_export, render_report


class SessionReportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.export_path = Path(self.temporary_directory.name) / "sessions.json"

    def write_export(self, sessions: list[dict[str, object]]) -> None:
        self.export_path.write_text(
            json.dumps({"schema": "publicspeak.sessions/v1", "sessions": sessions}),
            encoding="utf-8",
        )

    def test_reports_scores_and_duration(self) -> None:
        self.write_export(
            [
                {
                    "topic": "Latihan satu",
                    "duration": 75,
                    "score": 80,
                    "metrics": {"gaze": 80, "posture": 70, "gesture": 90, "expression": 80},
                },
                {
                    "topic": "Latihan dua",
                    "duration": 45,
                    "score": 60,
                    "metrics": {"gaze": 60, "posture": 60, "gesture": None, "expression": 60},
                },
            ]
        )

        report = render_report(load_export(self.export_path))

        self.assertIn("Jumlah sesi: 2", report)
        self.assertIn("Total latihan: 2 menit", report)
        self.assertIn("Rata-rata skor: 70%", report)
        self.assertIn("Gestur: 90%", report)
        self.assertIn("Latihan dua · 45 detik · 60%", report)

    def test_rejects_invalid_score(self) -> None:
        self.write_export([{"topic": "Topik", "duration": 10, "score": 101}])

        with self.assertRaisesRegex(ValueError, "Skor sesi 1"):
            load_export(self.export_path)

    def test_reports_empty_export(self) -> None:
        self.write_export([])

        self.assertEqual(render_report(load_export(self.export_path)), "Belum ada sesi latihan.")


if __name__ == "__main__":
    unittest.main()
