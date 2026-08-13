"""跟暗房（darkroom/preview_ui.py）講話的小工具。只透過 HTTP 打它現有的 API，
不 import darkroom/ 底下任何檔案——這支機器人是完全獨立的常駐行程，跟
preview_ui.py 分開跑，耦合只透過網路這一層。

用 aiohttp（discord.py 本來就依賴它）而不是 urllib，因為這裡是在 discord.py 的
asyncio event loop 裡跑，urllib 是同步阻塞呼叫，會卡住整個 bot 的事件迴圈
（包括其他使用者同時打的指令）。
"""
from __future__ import annotations

from urllib.parse import quote

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
                      loras: list[dict] | None = None, trigger: str | None = None) -> dict:
    """回傳 {"ok": True, "items": [{"id", "rel", "name"}, ...], "loras": [[name, strength], ...]}。
    loras 是 None 時完全不帶這個欄位（讓暗房套伺服器端自己的預設 LoRA），跟明確傳
    空陣列（不套任何 LoRA）是兩種不同語意，呼叫端要分清楚。trigger 不給就讓暗房自己
    用 loras 的 civitai 觸發詞算預設值（見 _default_trigger_for_loras）。"""
    payload: dict = {"n": n}
    if loras is not None:
        payload["loras"] = loras
    if trigger is not None:
        payload["trigger"] = trigger
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


async def gen_cancel(session: aiohttp.ClientSession, base_url: str, ids: list[str]) -> dict:
    """取消還在排隊/沒開始跑的項目（已經送進 ComfyUI 在跑的那張不會被中途打斷，
    但不會再有新的張數啟動）。回傳 {"ok": True, "cancelled_queued": n}。"""
    return await _post_json(session, f"{base_url}/api/gen-cancel", {"ids": ids})


MAX_LORA_PREVIEW_BYTES = 8 * 1024 * 1024   # Discord 附件上限保守抓 8MB（免費伺服器的常見上限）


async def get_lora_preview(session: aiohttp.ClientSession, base_url: str,
                            folder: str, file: str) -> bytes | None:
    """回傳 LoRA 預覽圖 bytes；沒有預覽圖、抓取失敗、或圖片太大（超過 Discord 附件上限，
    實測踩過一顆 228MB 的「縮圖」——LoRA Manager 掃描進來的素材品質不保證）都回 None
    （呼叫端拿不到圖時就不顯示縮圖，不是要中斷整個選擇流程的錯誤）。"""
    url = f"{base_url}/api/lora-preview?folder={quote(folder)}&file={quote(file)}"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            if resp.content_length is not None and resp.content_length > MAX_LORA_PREVIEW_BYTES:
                return None
            return await resp.read()
    except aiohttp.ClientError:
        return None
