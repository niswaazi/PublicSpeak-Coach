"""Local FastAPI service for PublicSpeak Coach camera analysis."""

from __future__ import annotations

import asyncio
import math
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

import cv2
import mediapipe as mp
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / ".cache" / "mediapipe"
MAX_FRAME_BYTES = 1_500_000
MAX_FRAME_PIXELS = 1_500_000
MAX_FRAME_SIDE = 960
MODEL_URLS = {
    "face": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    "pose": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    "hands": "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
}

_landmarkers: dict[str, Any] = {}
_model_errors: dict[str, str] = {}
_analysis_lock = threading.Lock()
_models_loading = False


def estimate_gaze(face: list[Any]) -> int | None:
    if len(face) <= 473:
        return None
    ratios = []
    for start, end, iris in ((33, 133, 468), (362, 263, 473)):
        left = min(face[start].x, face[end].x)
        right = max(face[start].x, face[end].x)
        ratios.append((face[iris].x - left) / max(right - left, 0.001))
    deviation = sum(abs(ratio - 0.5) for ratio in ratios) / len(ratios)
    return round(max(0, min(100, 100 - deviation * 300)))


def estimate_smile(categories: list[Any]) -> int:
    scores = {item.category_name: item.score for item in categories}
    return round((scores.get("mouthSmileLeft", 0) + scores.get("mouthSmileRight", 0)) * 50)


def landmark_visible(point: Any) -> bool:
    visibility = getattr(point, "visibility", None)
    return visibility is None or visibility > 0.45


def estimate_posture(pose: list[Any]) -> int | None:
    if len(pose) <= 24 or not all(landmark_visible(pose[index]) for index in (11, 12, 23, 24)):
        return None
    shoulder_mid = (pose[11].x + pose[12].x) / 2
    hip_mid = (pose[23].x + pose[24].x) / 2
    shoulder_width = max(abs(pose[11].x - pose[12].x), 0.03)
    hip_y = (pose[23].y + pose[24].y) / 2
    shoulder_y = (pose[11].y + pose[12].y) / 2
    torso_height = max(abs(hip_y - shoulder_y), 0.05)
    shoulder_tilt = abs(pose[11].y - pose[12].y) / shoulder_width
    torso_lean = abs(shoulder_mid - hip_mid) / torso_height
    return round(max(0, min(100, 100 - shoulder_tilt * 38 - torso_lean * 48)))


def _download_model(name: str, url: str) -> Path:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    target = MODEL_DIR / f"{name}.task"
    if target.is_file() and target.stat().st_size > 100_000:
        return target

    partial = target.with_suffix(".task.part")
    try:
        with urlopen(url, timeout=45) as response, partial.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if partial.stat().st_size <= 100_000:
            raise ValueError("Berkas model yang diunduh tidak lengkap.")
        partial.replace(target)
    except (OSError, URLError, ValueError) as error:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Model {name} tidak dapat dimuat: {error}") from error
    return target


def _create_landmarkers() -> None:
    options = mp.tasks.vision
    base = mp.tasks.BaseOptions
    factories = {
        "face": lambda path: options.FaceLandmarker.create_from_options(
            options.FaceLandmarkerOptions(
                base_options=base(model_asset_path=str(path)),
                running_mode=options.RunningMode.IMAGE,
                output_face_blendshapes=True,
                num_faces=1,
            )
        ),
        "pose": lambda path: options.PoseLandmarker.create_from_options(
            options.PoseLandmarkerOptions(
                base_options=base(model_asset_path=str(path)),
                running_mode=options.RunningMode.IMAGE,
                num_poses=1,
            )
        ),
        "hands": lambda path: options.HandLandmarker.create_from_options(
            options.HandLandmarkerOptions(
                base_options=base(model_asset_path=str(path)),
                running_mode=options.RunningMode.IMAGE,
                num_hands=2,
            )
        ),
    }
    for name, url in MODEL_URLS.items():
        try:
            _landmarkers[name] = factories[name](_download_model(name, url))
        except Exception as error:
            _model_errors[name] = str(error)


def _load_models() -> None:
    global _models_loading
    try:
        _create_landmarkers()
    except Exception as error:
        _model_errors["startup"] = str(error)
    finally:
        _models_loading = False


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _models_loading
    _models_loading = True
    loading_task = asyncio.create_task(asyncio.to_thread(_load_models))
    yield
    await loading_task
    for landmarker in _landmarkers.values():
        landmarker.close()
    _landmarkers.clear()


app = FastAPI(title="PublicSpeak Coach Local Analysis", lifespan=lifespan)
app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")


@app.get("/")
def home() -> FileResponse:
    return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/styles.css")
def stylesheet() -> FileResponse:
    return FileResponse(
        ROOT / "styles.css",
        media_type="text/css",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/app.js")
def javascript() -> FileResponse:
    return FileResponse(
        ROOT / "app.js",
        media_type="text/javascript",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/health")
def health() -> dict[str, Any]:
    available = sorted(_landmarkers)
    if len(available) == len(MODEL_URLS):
        status = "ready"
    elif available:
        status = "degraded"
    elif _models_loading:
        status = "loading"
    else:
        status = "unavailable"
    return {
        "status": status,
        "ready": bool(available),
        "available": available,
        "loading": _models_loading,
        "errors": _model_errors,
        "localOnly": True,
    }


def _point(point: Any) -> dict[str, float]:
    return {"x": float(point.x), "y": float(point.y)}


def analyze_jpeg(data: bytes) -> dict[str, Any]:
    if not data:
        raise HTTPException(status_code=400, detail="Gambar kamera kosong.")
    image_array = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image_array is None:
        raise HTTPException(status_code=400, detail="Format gambar kamera tidak valid.")

    height, width = image_array.shape[:2]
    if height * width > MAX_FRAME_PIXELS:
        scale = math.sqrt(MAX_FRAME_PIXELS / (height * width))
        image_array = cv2.resize(
            image_array,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    height, width = image_array.shape[:2]
    if max(height, width) > MAX_FRAME_SIDE:
        scale = MAX_FRAME_SIDE / max(height, width)
        image_array = cv2.resize(
            image_array,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )

    rgb_image = cv2.cvtColor(image_array, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_image)
    result: dict[str, Any] = {
        "metrics": {"gaze": None, "posture": None, "gesture": None, "expression": None},
        "faceBox": None,
        "posePoints": {},
        "hands": [],
        "width": int(image_array.shape[1]),
        "height": int(image_array.shape[0]),
    }

    with _analysis_lock:
        face_result = _landmarkers["face"].detect(mp_image) if "face" in _landmarkers else None
        pose_result = _landmarkers["pose"].detect(mp_image) if "pose" in _landmarkers else None
        hand_result = _landmarkers["hands"].detect(mp_image) if "hands" in _landmarkers else None

    face = face_result.face_landmarks[0] if face_result and face_result.face_landmarks else None
    if face:
        result["metrics"]["gaze"] = estimate_gaze(face)
        categories = face_result.face_blendshapes[0] if face_result.face_blendshapes else []
        result["metrics"]["expression"] = estimate_smile(categories)
        xs = [point.x for point in face]
        ys = [point.y for point in face]
        result["faceBox"] = {
            "x": min(xs),
            "y": min(ys),
            "width": max(xs) - min(xs),
            "height": max(ys) - min(ys),
        }

    pose = pose_result.pose_landmarks[0] if pose_result and pose_result.pose_landmarks else None
    if pose:
        result["metrics"]["posture"] = estimate_posture(pose)
        result["posePoints"] = {
            str(index): _point(pose[index])
            for index in (11, 12, 13, 14, 15, 16, 23, 24)
            if landmark_visible(pose[index])
        }

    if hand_result and hand_result.hand_landmarks:
        result["hands"] = [
            [_point(point) for point in hand]
            for hand in hand_result.hand_landmarks
        ]
    return result


@app.post("/api/analyze")
async def analyze(request: Request) -> dict[str, Any]:
    if not _landmarkers:
        raise HTTPException(
            status_code=503,
            detail="Model Computer Vision lokal belum siap. Periksa /api/health.",
        )
    content_type = request.headers.get("content-type", "").split(";", maxsplit=1)[0].lower()
    if content_type != "image/jpeg":
        raise HTTPException(status_code=415, detail="Kirim satu frame kamera sebagai image/jpeg.")

    chunks = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_FRAME_BYTES:
            raise HTTPException(status_code=413, detail="Ukuran frame melebihi batas 1,5 MB.")
        chunks.append(chunk)
    return await run_in_threadpool(analyze_jpeg, b"".join(chunks))


@app.get("/api")
def api_root() -> dict[str, str]:
    return {"service": "PublicSpeak Coach", "health": "/api/health", "analysis": "/api/analyze"}
