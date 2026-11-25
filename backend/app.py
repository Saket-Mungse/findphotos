"""
Steps 8–11: FastAPI app — /ingest, /identify, /webhook/drive, /health

Environment variables (set in Render dashboard or .env):
    QDRANT_URL           Qdrant cluster URL (e.g. https://xyz.qdrant.io)
    QDRANT_API_KEY       Qdrant API key
    QDRANT_COLLECTION    Collection name (default: faces)
    GOOGLE_SA_JSON       Full contents of service_account.json as a string
    DRIVE_FOLDER_ID      Root Google Drive folder ID to ingest
    DET_THRESHOLD        Face detection confidence threshold (default: 0.5)
    SIM_THRESHOLD        Clustering similarity threshold (default: 0.40)

Run locally:
    uvicorn app:app --reload --port 8000

Then test:
    curl http://localhost:8000/health
    curl -X POST http://localhost:8000/ingest
    curl -X POST http://localhost:8000/identify -F "file=@selfie.jpg"
"""

import io
import json
import logging
import os
import re
import threading
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# Load .env from project root (one level up from backend/)
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)

import cv2
import numpy as np
from fastapi import BackgroundTasks, Body, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import pydantic
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from insightface.app import FaceAnalysis
from database import (
    init_db,
    register_photographer,
    authenticate_photographer,
    create_event_record,
    get_photographer_events,
    verify_event_access,
)
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, FieldCondition, Filter, MatchAny, PointStruct, VectorParams

# ── Config ────────────────────────────────────────────────────────────────────

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY", "") or None
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "faces")
GOOGLE_SA_JSON = os.environ.get("GOOGLE_SA_JSON", "")      # JSON string
DRIVE_FOLDER_ID = os.environ.get("DRIVE_FOLDER_ID", "")
DET_THRESHOLD = float(os.environ.get("DET_THRESHOLD", "0.5"))
# SIM_THRESHOLD is now read from config.json (fallback to 0.40)
EMBEDDING_DIM = 512
WORKER_THREADS = int(os.environ.get("WORKER_THREADS", "1"))  # 1 thread prevents OOM on 512MB free tiers
IMAGE_MIMETYPES = {"image/jpeg", "image/png", "image/webp", "image/bmp", "image/heic", "image/heif"}
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("face-api")


# ── Config Management ─────────────────────────────────────────────────────────

CONFIG_PATH = Path("config.json")

def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text())
        except Exception as e:
            logger.error(f"Failed to load config.json: {e}")
    return {"sim_threshold": 0.40}

def save_config(conf: dict):
    CONFIG_PATH.write_text(json.dumps(conf, indent=2))

# ── Shared state ──────────────────────────────────────────────────────────────

class AppState:
    face_app: FaceAnalysis = None
    qdrant: QdrantClient = None
    drive_service = None
    config: dict = {}
    # Ingestion progress tracking
    ingestion_running: bool = False
    ingestion_total: int = 0
    ingestion_processed: int = 0
    ingestion_faces: int = 0
    ingestion_folder_id: str = ""
    ingestion_event_id: str = ""


state = AppState()

# ── Photo cache (in-memory, per server session) ───────────────────────────────
# Keeps recently-served Drive images in RAM so the same file isn't re-downloaded
# every time a new browser tab or incognito window requests it.
# Uses an OrderedDict as a simple FIFO — oldest entry evicted when cap is hit.
# Cap at 200 files: at ~3 MB avg that's ≈600 MB peak RAM.  Tune via env var.

from collections import OrderedDict as _OD

PHOTO_CACHE_DIR = Path(__file__).resolve().parent / "photo_cache"
PHOTO_CACHE_DIR.mkdir(exist_ok=True)

_PHOTO_CACHE_MAX = int(os.environ.get("PHOTO_CACHE_MAX", "200"))
_photo_cache: _OD[str, bytes] = _OD()
_photo_cache_lock = threading.Lock()


def _get_photo_bytes(file_id: str) -> bytes:
    """Return raw photo bytes, using the in-memory cache to avoid re-downloading."""
    with _photo_cache_lock:
        if file_id in _photo_cache:
            # Move to end (most-recently used) — keep cache warm
            _photo_cache.move_to_end(file_id)
            return _photo_cache[file_id]

    disk_file = PHOTO_CACHE_DIR / f"{file_id}.img"
    if disk_file.exists():
        try:
            raw = disk_file.read_bytes()
            with _photo_cache_lock:
                if len(_photo_cache) >= _PHOTO_CACHE_MAX:
                    _photo_cache.popitem(last=False)
                _photo_cache[file_id] = raw
            return raw
        except Exception:
            pass

    import time
    last_err = None
    raw = None
    for attempt in range(3):
        try:
            raw = _download_drive_file(file_id)
            try:
                disk_file.write_bytes(raw)
            except Exception:
                pass
            break
        except Exception as e:
            last_err = e
            time.sleep(0.3 * (attempt + 1))

    if raw is None:
        logger.error(f"Error fetching photo {file_id}: {last_err}")
        raise last_err or HTTPException(status_code=500, detail="Failed to fetch image")

    with _photo_cache_lock:
        if file_id not in _photo_cache:
            if len(_photo_cache) >= _PHOTO_CACHE_MAX:
                _photo_cache.popitem(last=False)  # evict oldest
            _photo_cache[file_id] = raw
    return raw

# Per-thread Drive service — httplib2 is NOT thread-safe, so each worker
# gets its own authenticated client via threading.local().
_thread_local = threading.local()


def _get_thread_drive_service():
    """Return (or lazily create) a Drive service for the calling thread."""
    if not hasattr(_thread_local, "service") or _thread_local.service is None:
        _thread_local.service = _build_drive_service(GOOGLE_SA_JSON)
    return _thread_local.service


# ── Lifespan (startup/shutdown) ───────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info("Database tables initialized ✅")
    state.config = load_config()
    logger.info(f"Loaded config: {state.config}")

    logger.info("Loading InsightFace model...")
    state.face_app = FaceAnalysis(name="buffalo_sc", providers=["CPUExecutionProvider"])
    state.face_app.prepare(ctx_id=0, det_size=(480, 480))  # 480 is faster; bump to 640 if small faces are missed
    logger.info("InsightFace ready ✅")

    try:
        if QDRANT_URL.lower() in ("local", "embedded", ":memory:") or not QDRANT_URL:
            db_path = str(Path(__file__).resolve().parent / "qdrant_storage")
            state.qdrant = QdrantClient(path=db_path)
            logger.info(f"Qdrant running in embedded local mode at {db_path} ✅")
        else:
            state.qdrant = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY, timeout=3.0)
            state.qdrant.get_collections()
            logger.info(f"Qdrant server connected at {QDRANT_URL} ✅")
        _ensure_collection(state.qdrant)
        logger.info("Qdrant ready ✅")
    except Exception as e:
        logger.warning(f"Qdrant connection to '{QDRANT_URL}' failed ({e}). Falling back to local embedded storage.")
        db_path = str(Path(__file__).resolve().parent / "qdrant_storage")
        state.qdrant = QdrantClient(path=db_path)
        _ensure_collection(state.qdrant)
        logger.info(f"Embedded Qdrant ready at {db_path} ✅")

    sa_local = Path(__file__).resolve().parent / "service_account.json"
    sa_root = Path(__file__).resolve().parent.parent / "service_account.json"
    if GOOGLE_SA_JSON or sa_local.exists() or sa_root.exists():
        state.drive_service = _build_drive_service(GOOGLE_SA_JSON)
        logger.info("Google Drive service ready ✅")
    else:
        logger.warning("GOOGLE_SA_JSON not set — Drive ingestion disabled")

    # Register HEIC/HEIF support via pillow-heif if available
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
        logger.info("HEIC/HEIF support enabled ✅")
    except ImportError:
        logger.info("pillow-heif not installed — HEIC files will be skipped (pip install pillow-heif)")

    yield  # app runs here

    logger.info("Shutting down")


app = FastAPI(title="Face Recognition API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restrict in production
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_drive_service(sa_json_str: str):
    info = None
    if sa_json_str and os.path.isfile(sa_json_str):
        with open(sa_json_str, "r", encoding="utf-8") as f:
            info = json.load(f)
    elif sa_json_str and sa_json_str.strip().startswith("{"):
        info = json.loads(sa_json_str)
    else:
        sa_file = Path(__file__).resolve().parent / "service_account.json"
        sa_file_root = Path(__file__).resolve().parent.parent / "service_account.json"
        if sa_file.exists():
            with open(sa_file, "r", encoding="utf-8") as f:
                info = json.load(f)
        elif sa_file_root.exists():
            with open(sa_file_root, "r", encoding="utf-8") as f:
                info = json.load(f)
        elif sa_json_str:
            info = json.loads(sa_json_str)
    if not info:
        raise ValueError("No service account credentials found")
    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("drive", "v3", credentials=creds)


def _ensure_collection(client: QdrantClient):
    existing = [c.name for c in client.get_collections().collections]
    if QDRANT_COLLECTION not in existing:
        client.create_collection(
            collection_name=QDRANT_COLLECTION,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
        logger.info(f"Created Qdrant collection '{QDRANT_COLLECTION}'")

    # Qdrant requires a payload index on any field used in a filter.
    # create_payload_index is idempotent — safe to call every startup.
    try:
        client.create_payload_index(
            collection_name=QDRANT_COLLECTION,
            field_name="cluster_id",
            field_schema="keyword",
        )
        client.create_payload_index(
            collection_name=QDRANT_COLLECTION,
            field_name="event_id",
            field_schema="keyword",
        )
        logger.info("Payload index on 'cluster_id' and 'event_id' ready ✅")
    except Exception as e:
        logger.warning(f"Could not create payload index: {e}")


def _parse_drive_folder_id(link: str) -> str:
    """
    Extract a Google Drive folder ID from various URL formats:
      - https://drive.google.com/drive/folders/FOLDER_ID
      - https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing
      - https://drive.google.com/drive/u/0/folders/FOLDER_ID
      - Or just the raw folder ID string itself
    """
    link = link.strip()
    match = re.search(r'/folders/([a-zA-Z0-9_-]+)', link)
    if match:
        return match.group(1)
    # If no URL pattern found, treat the whole string as a folder ID
    if re.fullmatch(r'[a-zA-Z0-9_-]+', link):
        return link
    raise ValueError(f"Cannot extract folder ID from: {link}")


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    a = a / (np.linalg.norm(a) + 1e-8)
    b = b / (np.linalg.norm(b) + 1e-8)
    return float(np.dot(a, b))


def _bytes_to_cv2(image_bytes: bytes) -> Optional[np.ndarray]:
    """Decode image bytes to an OpenCV BGR array. Falls back to Pillow for HEIC/HEIF."""
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is not None:
        return img
    # Pillow fallback: handles HEIC (when pillow-heif is installed), TIFF, etc.
    try:
        from PIL import Image as PILImage
        pil_img = PILImage.open(io.BytesIO(image_bytes)).convert("RGB")
        return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def _extract_embeddings(img: np.ndarray) -> list[np.ndarray]:
    faces = state.face_app.get(img)
    return [f.embedding for f in faces if f.det_score >= DET_THRESHOLD]


def _assign_cluster(embedding: np.ndarray, event_id: str) -> str:
    """
    Quick cluster assignment: search Qdrant for nearest neighbour within this event.
    If score > sim_threshold, reuse that cluster_id; else new cluster.
    """
    filter_cond = Filter(must=[FieldCondition(key="event_id", match=MatchAny(any=[event_id]))])
    results = state.qdrant.query_points(
        collection_name=QDRANT_COLLECTION,
        query=embedding.tolist(),
        query_filter=filter_cond,
        limit=1,
        with_payload=True,
    ).points
    sim = state.config.get("sim_threshold", 0.40)
    if results and results[0].score >= sim:
        return results[0].payload.get("cluster_id", f"face_{uuid.uuid4().hex[:6]}")
    return f"face_{uuid.uuid4().hex[:6]}"


def _upsert_faces_batch(pairs: list[tuple]):
    """Upsert all face vectors for one image in a single HTTP call."""
    points = [
        PointStruct(id=str(uuid.uuid4()), vector=emb.tolist(), payload=payload)
        for emb, payload in pairs
    ]
    if points:
        state.qdrant.upsert(collection_name=QDRANT_COLLECTION, points=points)


def _list_drive_images(folder_id: str, subfolder: str = "") -> list[dict]:
    svc = _get_thread_drive_service()
    results, page_token = [], None
    while True:
        resp = svc.files().list(
            q=f"'{folder_id}' in parents and trashed=false",
            fields="nextPageToken, files(id, name, mimeType)",
            pageToken=page_token,
        ).execute()
        for item in resp.get("files", []):
            if item["mimeType"] == "application/vnd.google-apps.folder":
                results.extend(_list_drive_images(item["id"], subfolder=item["name"]))
            elif item["mimeType"] in IMAGE_MIMETYPES:
                item["subfolder_name"] = subfolder or "root"
                results.append(item)
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return results


def _download_drive_file(file_id: str) -> bytes:
    # Use a per-thread service so concurrent workers don't share httplib2 state
    svc = _get_thread_drive_service()
    request = svc.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue()


def _process_drive_file(file_id: str, filename: str, subfolder: str, event_id: str) -> int:
    """Download, detect, embed, cluster, batch-upsert. Returns # faces processed."""
    try:
        raw = _download_drive_file(file_id)
        img = _bytes_to_cv2(raw)
        if img is None:
            return 0
        embeddings = _extract_embeddings(img)
        pairs = []
        for emb in embeddings:
            cluster_id = _assign_cluster(emb, event_id)
            pairs.append((emb, {
                "drive_file_id": file_id,
                "subfolder_name": subfolder,
                "photo_url": f"https://drive.google.com/uc?id={file_id}",
                "cluster_id": cluster_id,
                "event_id": event_id,
                "filename": filename,
            }))
        _upsert_faces_batch(pairs)  # single HTTP call for all faces in this image
        
        # Aggressive garbage collection to keep 512MB RAM instances from crashing
        del raw, img, embeddings, pairs
        import gc
        gc.collect()
        
        return len(pairs)
    except Exception as e:
        logger.error(f"Error processing {filename}: {e}")
        import gc
        gc.collect()
        return 0


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    """Render keep-alive ping."""
    return {"status": "ok", "model": "buffalo_l", "collection": QDRANT_COLLECTION}


@app.post("/ingest")
async def ingest(
    background_tasks: BackgroundTasks,
    drive_link: str = Body(..., embed=True, description="Google Drive folder URL or folder ID"),
    event_id: str = Body(..., embed=True, description="Unique ID for this event"),
):
    """
    Accept a Google Drive folder link, parse the folder ID,
    and trigger batch ingestion in the background.
    Returns immediately; processing continues async.

    Request body:
        {"drive_link": "https://drive.google.com/drive/folders/FOLDER_ID"}
    """
    if not state.drive_service:
        raise HTTPException(status_code=503, detail="Google Drive service not configured")

    try:
        folder_id = _parse_drive_folder_id(drive_link)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    _lock = threading.Lock()

    def _run_ingest():
        state.ingestion_running = True
        state.ingestion_processed = 0
        state.ingestion_faces = 0
        state.ingestion_folder_id = folder_id
        state.ingestion_event_id = event_id
        try:
            logger.info(f"Starting Drive ingestion for folder {folder_id} (Event: {event_id})...")
            files = _list_drive_images(folder_id)
            state.ingestion_total = len(files)
            logger.info(f"Found {len(files)} images — using {WORKER_THREADS} parallel workers")

            with ThreadPoolExecutor(max_workers=WORKER_THREADS) as pool:
                futures = {
                    pool.submit(_process_drive_file, f["id"], f["name"], f["subfolder_name"], event_id): f
                    for f in files
                }
                for future in as_completed(futures):
                    fname = futures[future]["name"]
                    try:
                        n = future.result()
                    except Exception as exc:
                        logger.error(f"  {fname}: failed — {exc}")
                        n = 0
                    with _lock:
                        state.ingestion_faces += n
                        state.ingestion_processed += 1
                    logger.info(f"  {fname}: {n} face(s) [{state.ingestion_processed}/{state.ingestion_total}]")

            logger.info(f"Ingestion complete — {state.ingestion_faces} faces upserted")
        finally:
            state.ingestion_running = False

    background_tasks.add_task(_run_ingest)
    return {"status": "ingestion_started", "folder_id": folder_id}


@app.get("/ingest/status")
def ingest_status():
    """Return current ingestion progress."""
    return {
        "running": state.ingestion_running,
        "folder_id": state.ingestion_folder_id,
        "total_images": state.ingestion_total,
        "processed": state.ingestion_processed,
        "faces_found": state.ingestion_faces,
    }


@app.post("/ingest/preview")
async def ingest_preview(
    drive_link: str = Body(..., embed=True, description="Google Drive folder URL or folder ID"),
):
    """
    Preview the folder structure without ingesting.
    Returns subfolder names and image counts.
    """
    if not state.drive_service:
        raise HTTPException(status_code=503, detail="Google Drive service not configured")

    try:
        folder_id = _parse_drive_folder_id(drive_link)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    files = _list_drive_images(folder_id)
    subfolders: dict[str, list[str]] = {}
    for f in files:
        sub = f["subfolder_name"]
        subfolders.setdefault(sub, []).append(f["name"])

    return {
        "folder_id": folder_id,
        "total_images": len(files),
        "subfolders": subfolders,
    }


@app.post("/identify")
async def identify(
    file: UploadFile = File(...),
    event_id: Optional[str] = Query(default=None, description="Event ID to search within"),
):
    """
    Accept a selfie image, return ALL matching photos from Qdrant.

    Strategy:
      1. Extract face embedding from the selfie.
      2. Query Qdrant for the 10 nearest vectors to find which cluster this
         face belongs to (using SIM_THRESHOLD as the confidence gate).
      3. Fetch EVERY photo in that cluster (no top_k cap) so the attendee
         sees all their photos, not just the closest 50 vectors.
      4. If no cluster is confident enough, fall back to the raw top-50
         nearest-neighbour results.
    """
    image_bytes = await file.read()
    img = _bytes_to_cv2(image_bytes)
    if img is None:
        raise HTTPException(status_code=400, detail="Cannot decode image")

    embeddings = _extract_embeddings(img)
    if not embeddings:
        return {"faces_detected": 0, "matches": [], "cluster_ids": []}

    query_emb = embeddings[0]

    # ── Step 1: find which cluster(s) this face belongs to ────────────────────
    
    event_filter = None
    if event_id:
        event_filter = Filter(must=[FieldCondition(key="event_id", match=MatchAny(any=[event_id]))])

    seed = state.qdrant.query_points(
        collection_name=QDRANT_COLLECTION,
        query=query_emb.tolist(),
        query_filter=event_filter,
        limit=10,
        with_payload=True,
    ).points

    cluster_ids: list[str] = []
    seen_clusters: set[str] = set()
    
    sim_threshold = state.config.get("sim_threshold", 0.40)
    
    for hit in seed:
        if hit.score >= sim_threshold:
            cid = hit.payload.get("cluster_id")
            if cid and cid not in seen_clusters:
                seen_clusters.add(cid)
                cluster_ids.append(cid)

    # ── Step 2a: cluster found — fetch ALL photos in that cluster ─────────────
    if cluster_ids:
        must_conditions = [FieldCondition(key="cluster_id", match=MatchAny(any=cluster_ids))]
        if event_id:
            must_conditions.append(FieldCondition(key="event_id", match=MatchAny(any=[event_id])))
            
        cluster_filter = Filter(must=must_conditions)
        
        seen_files: dict[str, dict] = {}
        next_offset = None
        while True:
            batch, next_offset = state.qdrant.scroll(
                collection_name=QDRANT_COLLECTION,
                scroll_filter=cluster_filter,
                limit=500,
                offset=next_offset,
                with_payload=True,
                with_vectors=False,
            )
            for point in batch:
                fid = point.payload.get("drive_file_id")
                if fid and fid not in seen_files:
                    seen_files[fid] = {
                        "photo_url": point.payload.get("photo_url"),
                        "drive_file_id": fid,
                        "filename": point.payload.get("filename", ""),
                        "subfolder_name": point.payload.get("subfolder_name"),
                        "cluster_id": point.payload.get("cluster_id"),
                        "score": 1.0,  # full cluster match
                    }
            if next_offset is None:
                break

        matches = list(seen_files.values())
        logger.info(f"/identify: cluster match — {len(cluster_ids)} cluster(s), {len(matches)} unique photos")
        return {"faces_detected": len(embeddings), "matches": matches, "cluster_ids": cluster_ids}

    # ── Step 2b: no confident cluster — fall back to raw top-50 results ───────
    logger.info("/identify: no cluster above threshold — returning raw top-50 neighbours")
    fallback = state.qdrant.query_points(
        collection_name=QDRANT_COLLECTION,
        query=query_emb.tolist(),
        query_filter=event_filter,
        limit=50,
        with_payload=True,
    ).points
    matches = [
        {
            "photo_url": hit.payload.get("photo_url"),
            "drive_file_id": hit.payload.get("drive_file_id"),
            "filename": hit.payload.get("filename", ""),
            "subfolder_name": hit.payload.get("subfolder_name"),
            "cluster_id": hit.payload.get("cluster_id"),
            "score": round(hit.score, 4),
        }
        for hit in fallback
        if hit.score >= 0.3
    ]
    return {"faces_detected": len(embeddings), "matches": matches, "cluster_ids": []}


@app.get("/stats")
def stats(event_id: Optional[str] = Query(default=None)):
    """Return how many faces and unique photos are currently indexed in Qdrant for a specific event."""
    if not state.qdrant or not event_id:
        return {"total_vectors": 0, "collection": QDRANT_COLLECTION}
    try:
        count = state.qdrant.count(
            collection_name=QDRANT_COLLECTION,
            count_filter=Filter(must=[FieldCondition(key="event_id", match=MatchAny(any=[event_id]))]),
            exact=True,
        )
        return {
            "total_vectors": count.count,
            "collection": QDRANT_COLLECTION,
        }
    except Exception as e:
        return {"total_vectors": 0, "collection": QDRANT_COLLECTION, "error": str(e)}


@app.get("/photos")
def list_photos(
    page: int = Query(default=0, ge=0), 
    per_page: int = Query(default=24, ge=1, le=100),
    event_id: Optional[str] = Query(default=None)
):
    """
    Return paginated list of unique photos indexed in Qdrant for a specific event.
    Deduplicates by drive_file_id so each photo appears once even if it has multiple faces.
    Requires event_id to prevent leaking photos across events/users.
    """
    if not state.qdrant or not event_id:
        return {"total": 0, "page": page, "per_page": per_page, "photos": []}

    event_filter = Filter(must=[FieldCondition(key="event_id", match=MatchAny(any=[event_id]))])

    seen: dict[str, dict] = {}
    next_offset = None
    while True:
        batch, next_offset = state.qdrant.scroll(
            collection_name=QDRANT_COLLECTION,
            scroll_filter=event_filter,
            limit=500,
            offset=next_offset,
            with_payload=True,
            with_vectors=False,
        )
        for point in batch:
            fid = point.payload.get("drive_file_id")
            if fid and fid not in seen:
                seen[fid] = {
                    "drive_file_id": fid,
                    "filename": point.payload.get("filename", ""),
                    "subfolder_name": point.payload.get("subfolder_name", ""),
                }
        if next_offset is None:
            break

    photos = list(seen.values())
    total = len(photos)
    start = page * per_page
    end = start + per_page
    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "photos": photos[start:end],
    }

# ── Download Zip ──────────────────────────────────────────────────────────────

class ZipDownloadItem(pydantic.BaseModel):
    drive_file_id: str
    filename: str

class ZipDownloadRequest(pydantic.BaseModel):
    photos: list[ZipDownloadItem]

@app.post("/download-zip")
def download_zip(payload: ZipDownloadRequest):
    """
    Given a list of drive_file_ids and filenames, download them from Drive
    (or cache), bundle them into a ZIP file, and return as a stream.
    """
    if not payload.photos:
        raise HTTPException(status_code=400, detail="No photos provided for download")

    zip_buffer = io.BytesIO()
    seen_names = set()

    def _fetch_item(item):
        try:
            raw = _get_photo_bytes(item.drive_file_id)
            name = item.filename.strip() if item.filename else f"photo_{item.drive_file_id[:8]}.jpg"
            if not os.path.splitext(name)[1]:
                name = f"{name}.jpg"
            return (item.drive_file_id, name, raw)
        except Exception as e:
            logger.error(f"Failed to fetch photo {item.drive_file_id} for ZIP: {e}")
            return None

    with ThreadPoolExecutor(max_workers=5) as pool:
        fetched = list(pool.map(_fetch_item, payload.photos))

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for res in fetched:
            if not res:
                continue
            fid, name, raw = res
            if name in seen_names:
                base, ext = os.path.splitext(name)
                name = f"{base}_{fid[:6]}{ext}"
            seen_names.add(name)
            zf.writestr(name, raw)

    zip_bytes = zip_buffer.getvalue()
    headers = {
        "Content-Disposition": 'attachment; filename="event_photos.zip"',
        "Access-Control-Expose-Headers": "Content-Disposition",
        "Content-Length": str(len(zip_bytes))
    }
    return Response(content=zip_bytes, media_type="application/zip", headers=headers)

    pass
    if False:
        for item in payload.photos:
            try:
                photo_bytes = _get_photo_bytes(item.drive_file_id)
                # Ensure unique filenames in zip to prevent overwrites
                name = item.filename
                if name in seen_names:
                    base, ext = os.path.splitext(name)
                    name = f"{base}_{item.drive_file_id[:8]}{ext}"
                seen_names.add(name)
                
                zf.writestr(name, photo_bytes)
            except Exception as e:
                logger.error(f"Failed to fetch photo {item.drive_file_id} for ZIP: {e}")
                # We skip failed downloads so the rest of the zip succeeds

    zip_buffer.seek(0)
    
    headers = {
        "Content-Disposition": 'attachment; filename="event_photos.zip"',
        "Access-Control-Expose-Headers": "Content-Disposition"
    }
    
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers=headers
    )


@app.get("/photo/{file_id}")
def get_photo(file_id: str):
    """
    Proxy a Google Drive image through the backend.
    - JPEG, PNG, WebP: served as-is (browsers render natively).
    - HEIC, BMP, TIFF, and any other format: converted to JPEG via Pillow
      so the browser always receives a renderable image (never a download).
    Response is cached by the browser for 24 hours.
    """
    try:
        raw = _get_photo_bytes(file_id)  # served from cache if previously fetched

        # Identify browser-safe formats by magic bytes
        is_jpeg = raw[:2] == b'\xff\xd8'
        is_png  = raw[:8] == b'\x89PNG\r\n\x1a\n'
        is_webp = len(raw) > 12 and raw[8:12] == b'WEBP'

        if is_jpeg:
            return Response(content=raw, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=86400"})
        if is_png:
            return Response(content=raw, media_type="image/png",
                            headers={"Cache-Control": "public, max-age=86400"})
        if is_webp:
            return Response(content=raw, media_type="image/webp",
                            headers={"Cache-Control": "public, max-age=86400"})

        # Non-browser-safe format (HEIC, BMP, TIFF …) → convert to JPEG via Pillow.
        # pillow-heif is registered at startup so HEIC/HEIF open transparently.
        from PIL import Image as PILImage
        pil_img = PILImage.open(io.BytesIO(raw)).convert("RGB")
        buf = io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=85, optimize=True)
        return Response(
            content=buf.getvalue(),
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except Exception as e:
        logger.error(f"Error serving proxy for {file_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch image")


@app.delete("/photo/{file_id}")
def delete_photo(file_id: str):
    """
    Delete a specific photo from the Qdrant index by its drive_file_id.
    """
    try:
        if not state.qdrant:
            raise HTTPException(status_code=500, detail="Qdrant not connected")
        
        state.qdrant.delete(
            collection_name=QDRANT_COLLECTION,
            points_selector=Filter(
                must=[FieldCondition(key="drive_file_id", match=MatchAny(any=[file_id]))]
            ),
        )
        return {"status": "deleted", "drive_file_id": file_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



@app.post("/webhook/drive")
async def webhook_drive(request: Request):
    """
    Receive Google Drive push notifications.
    Drive sends a POST with headers:
      X-Goog-Resource-Id    → file ID of changed resource
      X-Goog-Resource-State → 'add', 'update', 'remove', 'sync'
    """
    resource_state = request.headers.get("X-Goog-Resource-State", "")
    resource_id = request.headers.get("X-Goog-Resource-Id", "")
    changed_id = request.headers.get("X-Goog-Changed", resource_id)

    logger.info(f"Drive webhook: state={resource_state}, id={changed_id}")

    # 'sync' is a verification ping — just acknowledge
    if resource_state == "sync":
        return {"status": "sync_acknowledged"}

    if resource_state not in ("add", "update"):
        return {"status": "ignored", "state": resource_state}

    if not changed_id:
        return {"status": "no_file_id"}

    # Fetch file metadata
    try:
        meta = state.drive_service.files().get(
            fileId=changed_id,
            fields="id, name, mimeType, parents"
        ).execute()
    except Exception as e:
        logger.error(f"Cannot fetch Drive metadata for {changed_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    if meta.get("mimeType") not in IMAGE_MIMETYPES:
        return {"status": "not_an_image", "mimeType": meta.get("mimeType")}

    subfolder = "root"
    parents = meta.get("parents", [])
    if parents:
        try:
            parent_meta = state.drive_service.files().get(
                fileId=parents[0], fields="name"
            ).execute()
            subfolder = parent_meta.get("name", "root")
        except Exception:
            pass

    # Webhooks don't naturally know which event they belong to.
    # For now, we will associate it with the currently ingesting event,
    # or a default fallback if no ingestion is active.
    event_id = state.ingestion_event_id or "webhook_default"
    n = _process_drive_file(changed_id, meta["name"], subfolder, event_id)
    logger.info(f"Webhook processed {meta['name']}: {n} face(s) upserted")

    return {"status": "processed", "filename": meta["name"], "faces_upserted": n}


# ── Settings & Events Endpoints ───────────────────────────────────────────────

class ConfigUpdate(pydantic.BaseModel):
    sim_threshold: float

@app.get("/config")
def get_config_endpoint():
    """Retrieve global organizer settings."""
    return state.config

@app.post("/config")
def update_config(config: ConfigUpdate):
    """Update global organizer settings."""
    state.config["sim_threshold"] = config.sim_threshold
    save_config(state.config)
    return {"status": "updated", "config": state.config}


@app.delete("/events")
def delete_all_events():
    """Wipe all photos/vectors across ALL events."""
    try:
        # Simplest way to clear everything is to recreate the collection
        state.qdrant.delete_collection(QDRANT_COLLECTION)
        _ensure_collection(state.qdrant)
        return {"status": "deleted_all"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/events/{event_id}")
def delete_event(event_id: str):
    """Wipe all photos/vectors for a specific event namespace."""
    try:
        res = state.qdrant.delete(
            collection_name=QDRANT_COLLECTION,
            points_selector=Filter(
                must=[FieldCondition(key="event_id", match=MatchAny(any=[event_id]))]
            ),
        )
        return {"status": "deleted", "event_id": event_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Photographer & Events Database Endpoints ─────────────────────────────────

class RegisterRequest(pydantic.BaseModel):
    name: str
    email: str
    password: str

class LoginRequest(pydantic.BaseModel):
    email: str
    password: str

class CreateEventRequest(pydantic.BaseModel):
    photographer_id: int
    name: str
    event_password: Optional[str] = ""
    drive_link: Optional[str] = ""
    event_id: Optional[str] = ""

class VerifyEventRequest(pydantic.BaseModel):
    event_identifier: str
    event_password: str

@app.post("/events/verify")
def api_verify_event(payload: VerifyEventRequest):
    evt = verify_event_access(payload.event_identifier, payload.event_password)
    if not evt:
        raise HTTPException(status_code=401, detail="Invalid event name or password.")
    return {
        "valid": True,
        "event_id": evt.event_id,
        "name": evt.name,
    }

@app.get("/events/info")
def api_get_event_info(event_id: str = Query(...)):
    from database import SessionLocal, Event
    db = SessionLocal()
    try:
        evt = db.query(Event).filter(Event.event_id == event_id.strip()).first()
        if not evt:
            return {"event_id": event_id, "name": event_id}
        return {"event_id": evt.event_id, "name": evt.name}
    finally:
        db.close()

@app.post("/auth/register")
def api_register(payload: RegisterRequest):
    try:
        user = register_photographer(payload.name, payload.email, payload.password)
        return {"id": user.id, "name": user.name, "email": user.email}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Registration failed: {e}")

@app.post("/auth/login")
def api_login(payload: LoginRequest):
    user = authenticate_photographer(payload.email, payload.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {"id": user.id, "name": user.name, "email": user.email}

@app.post("/db/events")
def api_create_event(payload: CreateEventRequest):
    try:
        folder_id = ""
        if payload.drive_link:
            try:
                folder_id = _parse_drive_folder_id(payload.drive_link)
            except Exception:
                folder_id = payload.drive_link
        evt = create_event_record(
            photographer_id=payload.photographer_id,
            name=payload.name,
            event_password=payload.event_password or "",
            drive_folder_id=folder_id,
            event_id=payload.event_id or ""
        )
        return {
            "id": evt.id,
            "event_id": evt.event_id,
            "photographer_id": evt.photographer_id,
            "name": evt.name,
            "event_password": evt.event_password or "",
            "drive_folder_id": evt.drive_folder_id,
            "created_at": evt.created_at.isoformat() if evt.created_at else None,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save event: {e}")

@app.get("/db/events")
def api_get_events(photographer_id: int = Query(...)):
    events = get_photographer_events(photographer_id)
    return [
        {
            "id": e.id,
            "event_id": e.event_id,
            "photographer_id": e.photographer_id,
            "name": e.name,
            "event_password": e.event_password or "",
            "drive_folder_id": e.drive_folder_id,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in events
    ]

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
