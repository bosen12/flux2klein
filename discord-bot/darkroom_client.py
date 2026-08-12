"""跟暗房（darkroom/preview_ui.py）講話的小工具。只透過 HTTP 打它現有的 API，
不 import darkroom/ 底下任何檔案——這支機器人是完全獨立的常駐行程，跟
preview_ui.py 分開跑，耦合只透過網路這一層。

用 aiohttp（discord.py 本來就依賴它）而不是 urllib，因為這裡是在 discord.py 的
asyncio event loop 裡跑，urllib 是同步阻塞呼叫，會卡住整個 bot 的事件迴圈
（包括其他使用者同時打的指令）。
"""
from __future__ import annotations

import aiohttp


class DarkroomError(Exception):
    """暗房 API 回錯誤，或連不上。訊息已經是可以直接回覆給 Discord 使用者的文字。"""


async def _get_json(session: aiohttp.ClientSession, url: str) -> dict:
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            data = await resp.json()
    except aiohttp.ClientError:
        raise DarkroomError("暗房伺服器連不上，確認 preview_ui.py 有在跑")
    if resp.status >= 400:
        raise DarkroomError(str(data.get("error") or f"暗房回傳錯誤（HTTP {resp.status}）"))
    return data


async def _post_json(session: aiohttp.ClientSession, url: str, payload: dict) -> dict:
    try:
        async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            data = await resp.json()
    except aiohttp.ClientError:
        raise DarkroomError("暗房伺服器連不上，確認 preview_ui.py 有在跑")
    if resp.status >= 400:
        raise DarkroomError(str(data.get("error") or f"暗房回傳錯誤（HTTP {resp.status}）"))
    return data


async def get_loras(session: aiohttp.ClientSession, base_url: str) -> dict:
    """回傳 /api/loras 原始格式：{"items": [...], "counts": {...}, "folders": [...]}。"""
    return await _get_json(session, f"{base_url}/api/loras")


async def get_checkpoints(session: aiohttp.ClientSession, base_url: str) -> dict:
    """回傳 /api/checkpoints 原始格式：{"items": [...], "current": str|None}。"""
    return await _get_json(session, f"{base_url}/api/checkpoints")


async def set_checkpoint(session: aiohttp.ClientSession, base_url: str, file: str) -> dict:
    """回傳 {"ok": True, "checkpoint": file}；不合法的 file 會讓 DarkroomError 帶暗房原文錯誤訊息。"""
    return await _post_json(session, f"{base_url}/api/checkpoint", {"file": file})


async def agent_draw(session: aiohttp.ClientSession, base_url: str, n: int,
                      loras: list[dict] | None = None) -> dict:
    """回傳 {"ok": True, "items": [{"id", "rel", "name"}, ...], "loras": [[name, strength], ...]}。
    loras 是 None 時完全不帶這個欄位（讓暗房套伺服器端自己的預設 LoRA），跟明確傳
    空陣列（不套任何 LoRA）是兩種不同語意，呼叫端要分清楚。"""
    payload: dict = {"n": n}
    if loras is not None:
        payload["loras"] = loras
    return await _post_json(session, f"{base_url}/api/agent-draw", payload)


async def gen_status(session: aiohttp.ClientSession, base_url: str, ids: list[str]) -> dict:
    """回傳 {id: {"status": "pending"|"queued"|"running"|"done"|"error", ...}, ...}。"""
    ids_param = ",".join(ids)
    return await _get_json(session, f"{base_url}/api/gen-status?ids={ids_param}")


async def gen_result_bytes(session: aiohttp.ClientSession, base_url: str, gen_id: str) -> bytes:
    """回傳完成生成的 webp 圖片 bytes。只有 status done 的 id 拿得到。"""
    url = f"{base_url}/api/gen-result?id={gen_id}"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status >= 400:
                raise DarkroomError(f"取圖失敗（HTTP {resp.status}）")
            return await resp.read()
    except aiohttp.ClientError:
        raise DarkroomError("暗房伺服器連不上，確認 preview_ui.py 有在跑")
