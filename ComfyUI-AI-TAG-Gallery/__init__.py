import asyncio
import json
import time
from pathlib import Path
from urllib.parse import urlencode

WEB_DIRECTORY = "."

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from . import nodes
    NODE_CLASS_MAPPINGS = nodes.NODE_CLASS_MAPPINGS
    NODE_DISPLAY_NAME_MAPPINGS = nodes.NODE_DISPLAY_NAME_MAPPINGS
    print("✅ Gallery Plugin: nodes.py imported successfully")
except Exception as e:
    print(f"❌ Gallery Plugin: Failed to import nodes: {e}")
    import traceback
    traceback.print_exc()

import server
from aiohttp import web
import aiohttp

_WORK_ENRICH_CACHE = {}
_WORK_ENRICH_TTL = 1800
_PROXY_PAGE_CACHE = {}
_PROXY_PAGE_CACHE_TTL = 180
_WORK_DETAIL_CACHE = {}
_WORK_DETAIL_TTL = 1800
_CONFIG_CACHE = {"ts": 0, "data": None}
_CONFIG_TTL = 1800
_PENDING_PROXY_REQUESTS = {}
_PENDING_WORK_DETAIL_REQUESTS = {}
_PENDING_CONFIG_REQUEST = None
_AIOHTTP_SESSION = None
_AIOHTTP_CONNECTOR = None
_BLACKLIST_FILE = Path(__file__).resolve().parent / ".gallery_cache" / "title_blacklist.json"


def _normalize_blacklist_title(title):
    return " ".join(str(title or "").strip().split())


def _normalize_blacklist_user_id(user_id):
    return str(user_id or "").strip()


def _normalize_blacklist_entry(entry):
    if isinstance(entry, str):
        title = _normalize_blacklist_title(entry)
        return {"title": title, "userId": ""} if title else None

    if not isinstance(entry, dict):
        return None

    title = _normalize_blacklist_title(entry.get("title", ""))
    user_id = _normalize_blacklist_user_id(
        entry.get("userId")
        or entry.get("user_id")
        or entry.get("userid")
        or entry.get("authorId")
        or entry.get("author_id")
        or ""
    )
    return {"title": title, "userId": user_id} if title else None


def _blacklist_entry_key(entry):
    normalized = _normalize_blacklist_entry(entry)
    if not normalized:
        return ""
    return f"{normalized['title'].casefold()}\0{normalized['userId']}"


def _normalize_blacklist(entries):
    if not isinstance(entries, list):
        return []

    seen = set()
    result = []
    for raw_entry in entries:
        entry = _normalize_blacklist_entry(raw_entry)
        key = _blacklist_entry_key(entry)
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(entry)
    return result


def _read_title_blacklist():
    try:
        if not _BLACKLIST_FILE.exists():
            return []
        data = json.loads(_BLACKLIST_FILE.read_text(encoding="utf-8"))
        return _normalize_blacklist(data.get("items", data) if isinstance(data, dict) else data)
    except Exception as e:
        print(f"Gallery Plugin: failed to read title blacklist: {e}")
        return []


def _write_title_blacklist(entries):
    normalized = _normalize_blacklist(entries)
    _BLACKLIST_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = _BLACKLIST_FILE.with_suffix(".tmp")
    tmp_path.write_text(
        json.dumps({"items": normalized}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp_path.replace(_BLACKLIST_FILE)
    return normalized


def get_cached_work_enrich(work_id):
    item = _WORK_ENRICH_CACHE.get(str(work_id))
    if not item:
        return None
    if time.time() - item["ts"] > _WORK_ENRICH_TTL:
        _WORK_ENRICH_CACHE.pop(str(work_id), None)
        return None
    return item["data"]


def set_cached_work_enrich(work_id, data):
    _WORK_ENRICH_CACHE[str(work_id)] = {
        "ts": time.time(),
        "data": data
    }


def _cache_get(cache, key, ttl):
    item = cache.get(key)
    if not item:
        return None
    if time.time() - item["ts"] > ttl:
        cache.pop(key, None)
        return None
    return item["data"]


def _cache_set(cache, key, data):
    cache[key] = {
        "ts": time.time(),
        "data": data
    }


async def get_shared_client_session():
    global _AIOHTTP_SESSION, _AIOHTTP_CONNECTOR

    if _AIOHTTP_SESSION is not None and not _AIOHTTP_SESSION.closed:
        return _AIOHTTP_SESSION

    if _AIOHTTP_CONNECTOR is None or _AIOHTTP_CONNECTOR.closed:
        _AIOHTTP_CONNECTOR = aiohttp.TCPConnector(limit=32, ttl_dns_cache=600)

    _AIOHTTP_SESSION = aiohttp.ClientSession(
        connector=_AIOHTTP_CONNECTOR,
        connector_owner=False,
        headers={"User-Agent": "ComfyUI-Gallery/1.0"},
    )
    return _AIOHTTP_SESSION


async def fetch_json(session, url, timeout=30):
    try:
        async with session.get(url, timeout=timeout) as response:
            return await response.json()
    except Exception as e:
        return {"error": str(e)}


def get_existing_image_count(item):
    if not isinstance(item, dict):
        return None

    for key in ("image_count", "imageCount", "images_count", "image_num", "page_count"):
        try:
            count = int(item.get(key) or 0)
        except (TypeError, ValueError):
            count = 0
        if count > 0:
            return count

    images = item.get("images")
    if isinstance(images, list) and images:
        return len(images)

    return None


async def enrich_work_item(session, item):
    work_id = item.get("id")
    existing_count = get_existing_image_count(item)
    if not work_id:
        item["cover_image_path"] = item.get("cover_image_path", "")
        item["image_count"] = existing_count or 1
        item["image_count_known"] = existing_count is not None
        return item

    cached = get_cached_work_enrich(work_id)
    if cached:
        item["cover_image_path"] = cached.get("cover_image_path", item.get("cover_image_path", ""))
        item["image_count"] = cached.get("image_count", existing_count or 1)
        item["image_count_known"] = True
        return item
    item["cover_image_path"] = item.get("cover_image_path", "")
    item["image_count"] = existing_count or 1
    item["image_count_known"] = existing_count is not None
    return item


async def get_work_detail_cached(session, work_id, ttl=_WORK_DETAIL_TTL):
    cache_key = str(work_id or "").strip()
    if not cache_key:
        return {}

    cached = _cache_get(_WORK_DETAIL_CACHE, cache_key, ttl)
    if cached is not None:
        return cached

    detail = await fetch_json(session, f"http://aitag.win/api/work/{cache_key}", timeout=30)
    if isinstance(detail, dict) and not detail.get("error"):
        images = detail.get("images", []) if isinstance(detail, dict) else []
        enrich_data = {
            "cover_image_path": images[0].get("image_path", "") if images else "",
            "image_count": len(images) if images else 1,
            "image_count_known": True,
        }
        set_cached_work_enrich(cache_key, enrich_data)
        _cache_set(_WORK_DETAIL_CACHE, cache_key, detail)
    return detail


async def fetch_and_enrich_gallery_page(target_url, params):
    session = await get_shared_client_session()
    async with session.get(target_url, params=params, timeout=30) as response:
        base_data = await response.json()

    if not isinstance(base_data, dict):
        return {"error": "Invalid upstream response"}

    items = base_data.get("items", [])
    if items:
        base_data["items"] = [await enrich_work_item(session, item) for item in items]

    return base_data


@server.PromptServer.instance.routes.get("/gallery/api/proxy")
async def proxy_gallery_api(request):
    page = request.query.get("page", "1")
    try:
        page_size = str(max(60, int(request.query.get("page_size", "60") or 60)))
    except ValueError:
        page_size = "60"
    sort = request.query.get("sort", "new")
    time_range = request.query.get("time_range", "all")
    q = request.query.get("q", "")

    params = {"page": page, "page_size": page_size}

    if sort == "monthly":
        if time_range == "all" or time_range == "current":
            target_url = "http://aitag.win/api/rank/monthly/real"
        elif time_range.startswith("m"):
            month_val = time_range[1:]
            target_url = "http://aitag.win/api/rank/monthly/fixed"
            params["month"] = month_val
        elif time_range == "older":
            target_url = "http://aitag.win/api/rank/monthly/fixed"
            params["month"] = "older"
        else:
            target_url = "http://aitag.win/api/rank/monthly/real"
    else:
        target_url = "http://aitag.win/api/ai_works_search"
        params["sort"] = sort
        params["time_range"] = time_range
        if q and q.strip():
            params["q"] = q.strip()

    cache_key = f"{target_url}?{urlencode(sorted(params.items()))}"
    cached_page = _cache_get(_PROXY_PAGE_CACHE, cache_key, _PROXY_PAGE_CACHE_TTL)
    if cached_page is not None:
        return web.json_response(cached_page)

    pending_request = None
    pending_request = _PENDING_PROXY_REQUESTS.get(cache_key)
    if pending_request is not None:
        base_data = await pending_request
        status = 500 if isinstance(base_data, dict) and base_data.get("error") else 200
        return web.json_response(base_data, status=status)

    try:
        pending_request = asyncio.create_task(fetch_and_enrich_gallery_page(target_url, params))
        _PENDING_PROXY_REQUESTS[cache_key] = pending_request
        base_data = await pending_request

        if not isinstance(base_data, dict):
            return web.json_response({"error": "Invalid upstream response"}, status=500)
        if base_data.get("error"):
            return web.json_response(base_data, status=500)

        _cache_set(_PROXY_PAGE_CACHE, cache_key, base_data)
        return web.json_response(base_data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    finally:
        if _PENDING_PROXY_REQUESTS.get(cache_key) is pending_request:
            _PENDING_PROXY_REQUESTS.pop(cache_key, None)


@server.PromptServer.instance.routes.get("/gallery/api/work/{work_id}")
async def proxy_work_detail(request):
    work_id = request.match_info.get("work_id", "")
    cache_key = str(work_id or "").strip()
    pending_request = None
    try:
        session = await get_shared_client_session()
        cached = _cache_get(_WORK_DETAIL_CACHE, cache_key, _WORK_DETAIL_TTL)
        if cached is not None:
            return web.json_response(cached)

        pending_request = _PENDING_WORK_DETAIL_REQUESTS.get(cache_key)
        if pending_request is not None:
            detail = await pending_request
            return web.json_response(detail)

        pending_request = asyncio.create_task(get_work_detail_cached(session, work_id))
        _PENDING_WORK_DETAIL_REQUESTS[cache_key] = pending_request
        detail = await pending_request
        return web.json_response(detail)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    finally:
        if cache_key and _PENDING_WORK_DETAIL_REQUESTS.get(cache_key) is pending_request:
            _PENDING_WORK_DETAIL_REQUESTS.pop(cache_key, None)


@server.PromptServer.instance.routes.get("/gallery/api/config")
async def proxy_config_api(request):
    global _PENDING_CONFIG_REQUEST
    pending_request = None
    try:
        cached = _CONFIG_CACHE.get("data")
        if cached is not None and (time.time() - _CONFIG_CACHE["ts"]) <= _CONFIG_TTL:
            return web.json_response(cached)

        if _PENDING_CONFIG_REQUEST is not None:
            pending_request = _PENDING_CONFIG_REQUEST
            data = await pending_request
            status = 500 if isinstance(data, dict) and data.get("error") else 200
            return web.json_response(data, status=status)

        session = await get_shared_client_session()
        async def fetch_config():
            async with session.get("http://aitag.win/api/config", timeout=30) as response:
                return await response.json()

        pending_request = asyncio.create_task(fetch_config())
        _PENDING_CONFIG_REQUEST = pending_request
        data = await pending_request

        _CONFIG_CACHE["ts"] = time.time()
        _CONFIG_CACHE["data"] = data
        return web.json_response(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    finally:
        if _PENDING_CONFIG_REQUEST is pending_request:
            _PENDING_CONFIG_REQUEST = None


@server.PromptServer.instance.routes.get("/gallery/api/title-blacklist")
async def get_title_blacklist(request):
    return web.json_response({"items": _read_title_blacklist()})


@server.PromptServer.instance.routes.post("/gallery/api/title-blacklist")
async def set_title_blacklist(request):
    try:
        payload = await request.json()
        entries = payload.get("items", payload) if isinstance(payload, dict) else payload
        return web.json_response({"items": _write_title_blacklist(entries)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


print("✅ Gallery Plugin: __init__.py loaded")
__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
