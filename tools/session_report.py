"""Summarize a PublicSpeak Coach session export without third-party packages."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Mapping
from pathlib import Path
from statistics import fmean
from typing import Any

METRIC_LABELS = {
    "gaze": "Kontak mata",
    "posture": "Postur",
    "gesture": "Gestur",
    "expression": "Ekspresi",
}


def load_export(path: Path) -> list[dict[str, Any]]:
    """Read and validate the JSON export produced by the web application."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"Tidak dapat membaca berkas: {error}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"JSON tidak valid pada baris {error.lineno}.") from error

    if not isinstance(document, Mapping) or document.get("schema") != "publicspeak.sessions/v1":
        raise ValueError("Berkas bukan ekspor PublicSpeak Coach versi 1.")

    sessions = document.get("sessions")
    if not isinstance(sessions, list):
        raise ValueError("Properti 'sessions' harus berupa daftar.")

    validated: list[dict[str, Any]] = []
    for index, session in enumerate(sessions, start=1):
        if not isinstance(session, Mapping):
            raise ValueError(f"Sesi {index} harus berupa objek.")
        topic = session.get("topic")
        duration = session.get("duration")
        score = session.get("score")
        metrics = session.get("metrics", {})
        if not isinstance(topic, str) or not topic.strip():
            raise ValueError(f"Sesi {index} tidak memiliki topik.")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
            raise ValueError(f"Durasi sesi {index} harus berupa detik yang valid.")
        if score is not None and (
            isinstance(score, bool)
            or not isinstance(score, (int, float))
            or not math.isfinite(score)
            or not 0 <= score <= 100
        ):
            raise ValueError(f"Skor sesi {index} harus berada dalam rentang 0–100.")
        if not isinstance(metrics, Mapping):
            raise ValueError(f"Metrik sesi {index} harus berupa objek.")

        clean_metrics: dict[str, float | None] = {}
        for key in METRIC_LABELS:
            value = metrics.get(key)
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not 0 <= value <= 100
            ):
                raise ValueError(f"Metrik '{key}' sesi {index} harus berada dalam rentang 0–100.")
            clean_metrics[key] = value

        validated.append(
            {
                "topic": topic.strip(),
                "duration": float(duration),
                "score": float(score) if score is not None else None,
                "metrics": clean_metrics,
            }
        )
    return validated


def format_duration(seconds: float) -> str:
    total_seconds = round(seconds)
    minutes, remaining = divmod(total_seconds, 60)
    if minutes and remaining:
        return f"{minutes} menit {remaining} detik"
    if minutes:
        return f"{minutes} menit"
    return f"{remaining} detik"


def render_report(sessions: list[dict[str, Any]]) -> str:
    """Render a concise, text-only review of exported practice sessions."""
    if not sessions:
        return "Belum ada sesi latihan."

    scored = [session for session in sessions if session["score"] is not None]
    total_duration = sum(session["duration"] for session in sessions)
    lines = [
        "LAPORAN PUBLICSPEAK COACH",
        f"Jumlah sesi: {len(sessions)}",
        f"Total latihan: {format_duration(total_duration)}",
    ]
    if scored:
        lines.append(f"Rata-rata skor: {fmean(session['score'] for session in scored):.0f}%")
    else:
        lines.append("Rata-rata skor: belum ada sesi dengan analisis kamera")

    lines.append("\nSESI TERAKHIR")
    for session in sessions[-5:][::-1]:
        score = f"{session['score']:.0f}%" if session["score"] is not None else "tanpa skor"
        lines.append(f"- {session['topic']} · {format_duration(session['duration'])} · {score}")

    if scored:
        lines.append("\nRATA-RATA METRIK")
        for key, label in METRIC_LABELS.items():
            values = [session["metrics"][key] for session in scored if session["metrics"][key] is not None]
            value = f"{fmean(values):.0f}%" if values else "belum tersedia"
            lines.append(f"- {label}: {value}")
    lines.append("\nMetrik kamera adalah indikator latihan, bukan penilaian pasti.")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Buat ringkasan lokal dari ekspor sesi PublicSpeak Coach."
    )
    parser.add_argument("file", type=Path, help="Berkas publicspeak-sessions.json")
    args = parser.parse_args()
    try:
        print(render_report(load_export(args.file)))
    except ValueError as error:
        print(f"Kesalahan: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
