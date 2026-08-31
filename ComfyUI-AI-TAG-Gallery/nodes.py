import time
import hashlib
import tempfile
import math
import random
import re
import threading
import json
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image
import numpy as np
import torch
from requests.adapters import HTTPAdapter


REQUEST_TIMEOUT = (10, 60)
JSON_CACHE_TTL = 60 * 30
DOWNLOAD_CACHE_TTL = 60 * 60 * 24 * 7
GALLERY_PAGE_CACHE_TTL = 60 * 3
GALLERY_META_CACHE_TTL = 60 * 10
RANDOM_WORK_POOL_TTL = 60 * 10
WORK_DETAIL_CACHE_TTL = 60 * 30
USER_AGENT = "ComfyUI-Gallery/1.0"
GALLERY_PAGE_SIZE = 60
RANDOM_WORK_POOL_MAX_ITEMS = 240

CACHE_ROOT = Path(__file__).resolve().parent / ".gallery_cache"
IMAGE_CACHE_DIR = CACHE_ROOT / "images"
IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
MAX_IMAGE_CACHE_FILES = 500

_ai_json_cache = {}
_gallery_page_cache = {}
_gallery_meta_cache = {}
_random_work_pool_cache = {}
_work_detail_cache = {}
_bad_image_path_cache = {}
_last_random_draw_cache = {}
_random_page_limit_cache = {}
_session_local = threading.local()


def _now():
    return time.time()


def _is_cache_valid(item, ttl):
    if not item:
        return False
    return (_now() - item.get("ts", 0)) < ttl


def _cache_get(cache, key, ttl):
    item = cache.get(key)
    if _is_cache_valid(item, ttl):
        return item.get("data")
    if item:
        cache.pop(key, None)
    return None


def _cache_set(cache, key, data):
    cache[key] = {
        "ts": _now(),
        "data": data
    }


def _sha1(text: str):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _requests_session():
    session = getattr(_session_local, "session", None)
    if session is not None:
        return session

    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Referer": "https://aitag.win/",
    })
    adapter = HTTPAdapter(pool_connections=16, pool_maxsize=32, max_retries=0)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    _session_local.session = session
    return session


def fetch_json(url: str, timeout=REQUEST_TIMEOUT, retries=2):
    last_err = None
    for i in range(retries + 1):
        try:
            resp = _requests_session().get(url, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            last_err = e
            if i < retries:
                time.sleep(0.6 * (i + 1))
    raise RuntimeError(f"fetch_json failed: {url} -> {last_err}")


def fetch_ai_json_cached(url: str, ttl=JSON_CACHE_TTL):
    cached = _cache_get(_ai_json_cache, url, ttl)
    if cached is not None:
        return cached
    data = fetch_json(url)
    _cache_set(_ai_json_cache, url, data)
    return data


def get_cached_image_file(url: str, suffix=".img"):
    h = _sha1(url)
    return IMAGE_CACHE_DIR / f"{h}{suffix}"


def _gallery_page_cache_key(page, search_query="", sort_mode="new", time_range="all", page_size=GALLERY_PAGE_SIZE):
    return f"{int(page)}|{int(page_size)}|{sort_mode}|{time_range}|{search_query}"


def prune_image_cache(max_files=MAX_IMAGE_CACHE_FILES):
    try:
        files = [p for p in IMAGE_CACHE_DIR.iterdir() if p.is_file() and p.suffix != ".tmp"]
    except FileNotFoundError:
        return

    overflow = len(files) - max_files
    if overflow <= 0:
        return

    files.sort(key=lambda p: p.stat().st_mtime)
    for path in files[:overflow]:
        try:
            path.unlink()
        except OSError:
            pass


def _detect_suffix_from_url(url: str):
    lower = url.lower()
    for ext in [".png", ".jpg", ".jpeg", ".webp", ".bmp"]:
        if ext in lower:
            return ext
    return ".img"


def download_file_cached(url: str, ttl=DOWNLOAD_CACHE_TTL, timeout=REQUEST_TIMEOUT, force=False):
    suffix = _detect_suffix_from_url(url)
    final_path = get_cached_image_file(url, suffix=suffix)

    if final_path.exists() and not force:
        age = _now() - final_path.stat().st_mtime
        if age < ttl:
            final_path.touch()
            return final_path

    final_path.parent.mkdir(parents=True, exist_ok=True)

    resp = _requests_session().get(url, timeout=timeout, stream=True)
    resp.raise_for_status()

    with tempfile.NamedTemporaryFile(
        delete=False,
        dir=str(final_path.parent),
        suffix=".tmp",
        buffering=1024 * 1024,
    ) as tmp:
        tmp_path = Path(tmp.name)
        for chunk in resp.iter_content(chunk_size=1024 * 256):
            if chunk:
                tmp.write(chunk)

    tmp_path.replace(final_path)
    prune_image_cache()
    return final_path


def is_not_found_error(error):
    response = getattr(error, "response", None)
    return getattr(response, "status_code", None) == 404


def is_bad_request_error(error):
    response = getattr(error, "response", None)
    return getattr(response, "status_code", None) == 400


def pil_to_tensor(image: Image.Image):
    image = image.convert("RGB")
    arr = np.array(image).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def load_image_from_local(path: Path):
    with Image.open(path) as img:
        img = img.copy()
    return pil_to_tensor(img)


def normalize_asset_path(image_path: str):
    path = str(image_path or "").strip().replace("\\", "/")
    if not path:
        return ""

    parsed = urlparse(path)
    if parsed.scheme and parsed.netloc:
        path = parsed.path

    path = path.lstrip("/")
    marker = "www/pixiv_ai_tag/"
    if marker in path:
        path = path.split(marker, 1)[1]
    elif path.startswith("pixiv_ai_tag/"):
        path = path[len("pixiv_ai_tag/"):]

    return path.lstrip("/")


def build_asset_url(asset_base_url: str, image_path: str):
    normalized_path = normalize_asset_path(image_path)
    return f"{asset_base_url.rstrip('/')}/{normalized_path}"


def normalize_gallery_query(search_query="", sort_mode="new", time_range="all"):
    normalized_query = str(search_query or "").strip()
    normalized_sort = str(sort_mode or "new").strip() or "new"
    normalized_time_range = str(time_range or "all").strip() or "all"

    if normalized_query and normalized_sort != "new":
        normalized_sort = "new"
        if normalized_time_range in {"current", "older"} or re.fullmatch(r"m\d+", normalized_time_range):
            normalized_time_range = "all"

    return normalized_query, normalized_sort, normalized_time_range


def fetch_gallery_page_raw(page, search_query="", sort_mode="new", time_range="all", page_size=GALLERY_PAGE_SIZE):
    search_query, sort_mode, time_range = normalize_gallery_query(search_query, sort_mode, time_range)
    page = max(1, int(page or 1))
    page_size = max(GALLERY_PAGE_SIZE, int(page_size or GALLERY_PAGE_SIZE))
    cache_key = _gallery_page_cache_key(page, search_query, sort_mode, time_range, page_size)
    cached = _cache_get(_gallery_page_cache, cache_key, GALLERY_PAGE_CACHE_TTL)
    if cached is not None:
        return cached

    if sort_mode == "monthly":
        if time_range in {"all", "current"}:
            url = "http://aitag.win/api/rank/monthly/real"
            params = {"page": page, "page_size": page_size}
        elif time_range.startswith("m"):
            url = "http://aitag.win/api/rank/monthly/fixed"
            params = {"page": page, "page_size": page_size, "month": time_range[1:]}
        elif time_range == "older":
            url = "http://aitag.win/api/rank/monthly/fixed"
            params = {"page": page, "page_size": page_size, "month": "older"}
        else:
            url = "http://aitag.win/api/rank/monthly/real"
            params = {"page": page, "page_size": page_size}
    else:
        url = "http://aitag.win/api/ai_works_search"
        params = {
            "page": page,
            "page_size": page_size,
            "sort": sort_mode,
            "time_range": time_range,
        }
        if search_query:
            params["q"] = search_query

    resp = _requests_session().get(url, params=params, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    _cache_set(_gallery_page_cache, cache_key, data)
    return data


def fetch_work_detail_cached(work_id, ttl=WORK_DETAIL_CACHE_TTL):
    work_id = str(work_id or "").strip()
    if not work_id:
        return {}

    cached = _cache_get(_work_detail_cache, work_id, ttl)
    if cached is not None:
        return cached

    detail = fetch_json(f"http://aitag.win/api/work/{work_id}")
    _cache_set(_work_detail_cache, work_id, detail)
    return detail


def get_gallery_random_meta(search_query="", sort_mode="new", time_range="all"):
    search_query, sort_mode, time_range = normalize_gallery_query(search_query, sort_mode, time_range)
    query_key = f"{search_query}|{sort_mode}|{time_range}"
    cached = _cache_get(_gallery_meta_cache, query_key, GALLERY_META_CACHE_TTL)
    if cached is not None:
        return cached

    first_page_data = fetch_gallery_page_raw(
        1,
        search_query=search_query,
        sort_mode=sort_mode,
        time_range=time_range,
    )
    first_page_items = first_page_data.get("items", []) if isinstance(first_page_data, dict) else []
    total_count = max(len(first_page_items), int(first_page_data.get("total") or 0)) if isinstance(first_page_data, dict) else 0

    if total_count <= 0:
        raise ValueError("No items found for current gallery filters")

    total_pages = max(1, math.ceil(total_count / GALLERY_PAGE_SIZE))
    cached_page_limit = _cache_get(_random_page_limit_cache, query_key, GALLERY_META_CACHE_TTL)
    if cached_page_limit:
        total_pages = max(1, min(total_pages, int(cached_page_limit)))

    meta = {
        "query_key": query_key,
        "search_query": search_query,
        "sort_mode": sort_mode,
        "time_range": time_range,
        "first_page_items": first_page_items,
        "total_count": total_count,
        "total_pages": total_pages,
    }
    _cache_set(_gallery_meta_cache, query_key, meta)
    return meta


def _update_random_page_limit(query_key, random_page):
    page_limit = max(1, int(random_page) - 1)
    cached_page_limit = _cache_get(_random_page_limit_cache, query_key, GALLERY_META_CACHE_TTL)
    if cached_page_limit:
        page_limit = min(page_limit, int(cached_page_limit))
    _cache_set(_random_page_limit_cache, query_key, page_limit)
    _gallery_meta_cache.pop(query_key, None)
    return page_limit


def _get_random_work_pool(query_key):
    pool = _cache_get(_random_work_pool_cache, query_key, RANDOM_WORK_POOL_TTL)
    if isinstance(pool, list):
        return pool
    return []


def _set_random_work_pool(query_key, pool):
    random.shuffle(pool)
    _cache_set(_random_work_pool_cache, query_key, pool[:RANDOM_WORK_POOL_MAX_ITEMS])


def get_random_work_candidate(meta):
    query_key = meta["query_key"]
    pool = _get_random_work_pool(query_key)
    while pool:
        work = pool.pop()
        _cache_set(_random_work_pool_cache, query_key, pool)
        if isinstance(work, dict) and work.get("id"):
            return work

    total_pages = max(1, int(meta.get("total_pages") or 1))
    random_page = random.randint(1, total_pages)
    page_items = meta.get("first_page_items") or []

    if random_page != 1:
        try:
            page_data = fetch_gallery_page_raw(
                random_page,
                search_query=meta["search_query"],
                sort_mode=meta["sort_mode"],
                time_range=meta["time_range"],
            )
            page_items = page_data.get("items", []) if isinstance(page_data, dict) else []
        except requests.HTTPError as error:
            if not is_bad_request_error(error):
                raise

            _update_random_page_limit(query_key, random_page)
            page_items = meta.get("first_page_items") or []

    if not page_items:
        if random_page != 1:
            _update_random_page_limit(query_key, random_page)
        raise ValueError(f"Random page {random_page} has no items")

    pool = [item for item in page_items if isinstance(item, dict) and item.get("id")]
    if not pool:
        raise ValueError(f"Random page {random_page} has no usable items")

    random.shuffle(pool)
    work = pool.pop()
    if pool:
        existing_pool = _get_random_work_pool(query_key)
        _set_random_work_pool(query_key, existing_pool + pool)
    return work


def _serialize_ai_json(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _parse_ai_json(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    text = value.strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _extract_sd_parameters_prompt(parameters):
    text = str(parameters or "").strip()
    if not text:
        return ""

    match = re.search(r"(?:^|\r?\n)(?:Negative prompt|Steps):", text)
    if match:
        return text[:match.start()].strip()
    return text


def _first_string_field(data, keys):
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def extract_prompt_text(ai_json):
    data = _parse_ai_json(ai_json)
    if not data:
        return _extract_sd_parameters_prompt(ai_json)

    parameters_prompt = _extract_sd_parameters_prompt(data.get("parameters"))
    if parameters_prompt:
        return parameters_prompt

    prompt = _first_string_field(data, (
        "prompt",
        "Prompt",
        "positive_prompt",
        "positive",
        "Description",
        "description",
        "text",
    ))
    if prompt:
        return prompt

    comment = data.get("Comment")
    if isinstance(comment, dict):
        prompt = _first_string_field(comment, ("prompt", "Prompt", "positive_prompt", "positive"))
        if prompt:
            return prompt

    return ""


def resolve_prompt_text(prompt_text, ai_json):
    prompt = _extract_sd_parameters_prompt(prompt_text)
    return prompt if prompt else extract_prompt_text(ai_json)


def mark_bad_image_path(image_path, reason=""):
    normalized_path = normalize_asset_path(image_path)
    if normalized_path:
        _cache_set(_bad_image_path_cache, normalized_path, reason or "unavailable")


def is_bad_image_path(image_path):
    normalized_path = normalize_asset_path(image_path)
    if not normalized_path:
        return False
    return _cache_get(_bad_image_path_cache, normalized_path, WORK_DETAIL_CACHE_TTL) is not None


def _select_output_images(detail, work):
    images = detail.get("images", []) if isinstance(detail, dict) else []
    if not images:
        return []

    cover_path = normalize_asset_path(work.get("cover_image_path") or "")
    ordered_images = []
    seen_paths = set()

    if cover_path:
        for image in images:
            image_path = normalize_asset_path(image.get("image_path") or "")
            if image_path == cover_path and image_path not in seen_paths and not is_bad_image_path(image_path):
                ordered_images.append(image)
                seen_paths.add(image_path)

    for image in images:
        image_path = normalize_asset_path(image.get("image_path") or "")
        if image_path and image_path not in seen_paths and not is_bad_image_path(image_path):
            ordered_images.append(image)
            seen_paths.add(image_path)

    return ordered_images


def resolve_random_gallery_selection(search_query="", sort_mode="new", time_range="all", attempts=8):
    search_query, sort_mode, time_range = normalize_gallery_query(search_query, sort_mode, time_range)
    query_key = f"{search_query}|{sort_mode}|{time_range}"
    last_image_path = _last_random_draw_cache.get(query_key)
    last_error = None
    meta = get_gallery_random_meta(
        search_query=search_query,
        sort_mode=sort_mode,
        time_range=time_range,
    )
    total_count = int(meta.get("total_count") or 0)

    for _ in range(max(1, attempts)):
        try:
            work = get_random_work_candidate(meta)
        except ValueError as error:
            last_error = error
            refreshed_meta = get_gallery_random_meta(
                search_query=search_query,
                sort_mode=sort_mode,
                time_range=time_range,
            )
            meta = refreshed_meta
            total_count = int(meta.get("total_count") or total_count)
            continue

        work_id = work.get("id")
        if not work_id:
            last_error = ValueError("Random work item is missing id")
            continue

        detail = fetch_work_detail_cached(work_id)
        candidate_images = _select_output_images(detail, work)
        if not candidate_images:
            last_error = ValueError(f"Work {work_id} has no selectable images")
            continue
        image = random.choice(candidate_images)

        image_path = normalize_asset_path(image.get("image_path") or "")
        if not image_path:
            last_error = ValueError(f"Work {work_id} image path is empty")
            continue

        if last_image_path and image_path == last_image_path and total_count > 1:
            last_error = ValueError("Random draw repeated the previous image")
            continue

        _last_random_draw_cache[query_key] = image_path
        return {
            "user_id": str(image.get("author_id") or work.get("userId") or ""),
            "image_id": str(image.get("work_id") or work_id or ""),
            "ai_type": image.get("image_type") or work.get("AI_type") or "SD",
            "image_path": image_path,
            "ai_json": _serialize_ai_json(image.get("ai_json")),
            "prompt_text": str(image.get("prompt_text") or ""),
        }

    if last_error:
        raise last_error
    raise RuntimeError("Failed to resolve random gallery selection")


class GalleryImageLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "user_id": ("STRING", {"default": ""}),
                "image_id": ("STRING", {"default": ""}),
                "ai_type": ("STRING", {"default": "SD"}),
                "image_path": ("STRING", {"default": ""}),
                "ai_json": ("STRING", {"default": ""}),
                "prompt_text": ("STRING", {"default": ""}),
                "draw_enabled": ("BOOLEAN", {"default": False}),
                "search_query": ("STRING", {"default": ""}),
                "sort_mode": ("STRING", {"default": "new"}),
                "time_range": ("STRING", {"default": "all"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("image", "ai_json", "prompt_text")
    FUNCTION = "load_image"
    CATEGORY = "gallery"

    @classmethod
    def IS_CHANGED(cls, user_id, image_id, ai_type, image_path, ai_json, prompt_text, draw_enabled, search_query, sort_mode, time_range):
        if draw_enabled:
            return f"draw:{time.time_ns()}|{search_query}|{sort_mode}|{time_range}"
        return f"{user_id}|{image_id}|{ai_type}|{image_path}|{ai_json}|{prompt_text}|{search_query}|{sort_mode}|{time_range}"

    def load_image(self, user_id, image_id, ai_type, image_path, ai_json, prompt_text, draw_enabled, search_query, sort_mode, time_range):
        config = fetch_ai_json_cached(
            "http://aitag.win/api/config",
            ttl=JSON_CACHE_TTL
        )
        asset_base_url = config.get("asset_base_url", "https://ai-img.10118899.xyz/")

        if draw_enabled:
            last_error = None
            for _ in range(12):
                selection = resolve_random_gallery_selection(
                    search_query=search_query,
                    sort_mode=sort_mode,
                    time_range=time_range,
                )
                user_id = selection["user_id"]
                image_id = selection["image_id"]
                ai_type = selection["ai_type"]
                image_path = normalize_asset_path(selection["image_path"])
                ai_json = selection["ai_json"]
                prompt_text = selection["prompt_text"]

                if not image_path:
                    last_error = ValueError("Random draw selected an empty image_path")
                    continue

                full_url = build_asset_url(asset_base_url, image_path)
                try:
                    local_path = download_file_cached(full_url, ttl=DOWNLOAD_CACHE_TTL)
                    image_tensor = load_image_from_local(local_path)
                    ai_json_output = ai_json or ""
                    return (image_tensor, ai_json_output, resolve_prompt_text(prompt_text, ai_json_output))
                except requests.HTTPError as error:
                    last_error = error
                    if is_not_found_error(error):
                        mark_bad_image_path(image_path, str(error))
                        continue
                    raise

            if last_error:
                raise RuntimeError(f"Random draw could not find a downloadable image after retries: {last_error}") from last_error
            raise RuntimeError("Random draw could not find a downloadable image after retries")

        image_path = normalize_asset_path(image_path)
        if not image_path:
            raise ValueError("image_path is empty")

        full_url = build_asset_url(asset_base_url, image_path)

        local_path = download_file_cached(full_url, ttl=DOWNLOAD_CACHE_TTL)
        image_tensor = load_image_from_local(local_path)

        ai_json_output = ai_json or ""
        return (image_tensor, ai_json_output, resolve_prompt_text(prompt_text, ai_json_output))


NODE_CLASS_MAPPINGS = {
    "GalleryImageLoader": GalleryImageLoader
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GalleryImageLoader": "🎨 P站画廊AI TAG Prompt Art Gallery"
}
