#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
暗房 Discord 互動機器人
=======================
獨立常駐的 Discord 機器人，讓使用者直接在 Discord 用 slash command 操作暗房
（darkroom/preview_ui.py），不透過 AI agent 中介。跟 preview_ui.py 是完全分開
的行程，只透過 HTTP 打它現有的 API（見 darkroom_client.py）。

設計文件：docs/superpowers/specs/2026-08-13-darkroom-discord-bot-design.md

跑法：
    python bot.py
需要先複製 config.example.json 成 config.json（已 gitignore）並填好
bot_token / guild_id / gacha_output_channel_id。
"""
from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands

import darkroom_client as dc

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
LORA_CATEGORIES = ["style", "Character", "HENTAI", "illus"]
LORA_STRENGTH = 0.8   # 比照暗房 AGENT_DRAW_DEFAULT_LORAS 的既有慣例，不開放調整
GACHA_MAX_N = 100
POLL_INTERVAL_S = 1.0
EMBED_COLOR = 0xEAAD57   # 跟 agent_draw.py 的 DISCORD_EMBED_COLOR 一致


def load_config() -> dict:
    if not CONFIG_PATH.is_file():
        raise SystemExit(
            f"找不到 {CONFIG_PATH}，先複製 config.example.json 成 config.json 並填好設定"
        )
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def save_selected_lora(entry: dict | None) -> None:
    """讀-改-寫，只動 selected_lora 這個欄位，不動使用者手動填的其他設定值。"""
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    cfg["selected_lora"] = entry
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


CONFIG = load_config()
BASE_URL = str(CONFIG.get("darkroom_base_url") or "http://127.0.0.1:7860").rstrip("/")

intents = discord.Intents.default()
bot = commands.Bot(command_prefix="!", intents=intents)
http_session: aiohttp.ClientSession | None = None


def _lora_choice_label(item: dict) -> str:
    title = item.get("title") or item.get("name") or item.get("file")
    return title[:100]


def _lora_choice_value(item: dict) -> str:
    # folder 可能自己帶 "/"（子資料夾），file 不會，所以用 rsplit 還原時從最後一個
    # "/" 切開是安全的。
    return f"{item['folder']}/{item['file']}"


@bot.event
async def on_ready() -> None:
    global http_session
    http_session = aiohttp.ClientSession()
    guild_id = CONFIG.get("guild_id")
    if guild_id:
        guild = discord.Object(id=int(guild_id))
        bot.tree.copy_global_to(guild=guild)
        await bot.tree.sync(guild=guild)
    else:
        await bot.tree.sync()
    print(f"[bot] 已登入 {bot.user}，暗房 API：{BASE_URL}")


@bot.tree.command(name="intro", description="這個機器人能做什麼")
async def intro(interaction: discord.Interaction) -> None:
    embed = discord.Embed(
        title="暗房機器人",
        description="直接在 Discord 操作暗房詞庫抽卡與生成設定。",
        color=EMBED_COLOR,
    )
    embed.add_field(name="/gacha n:<1~100>", value="抽卡生圖，逐張生完就送圖", inline=False)
    embed.add_field(name="/lora category:<分類> query:<搜尋>", value="切換抽卡套用的 LoRA（全局共用）", inline=False)
    embed.add_field(name="/chkp file:<搜尋>", value="切換底模 checkpoint（全局共用）", inline=False)
    await interaction.response.send_message(embed=embed)


@app_commands.command(name="lora", description="切換抽卡套用的 LoRA")
@app_commands.describe(category="LoRA 分類", query="輸入關鍵字搜尋檔名/標題")
@app_commands.choices(category=[app_commands.Choice(name=c, value=c) for c in LORA_CATEGORIES])
async def lora_cmd(interaction: discord.Interaction, category: app_commands.Choice[str], query: str) -> None:
    assert http_session is not None
    try:
        data = await dc.get_loras(http_session, BASE_URL)
    except dc.DarkroomError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return
    match = next(
        (it for it in data.get("items", [])
         if it.get("category") == category.value and _lora_choice_value(it) == query),
        None,
    )
    if match is None:
        await interaction.response.send_message(
            "找不到符合的 LoRA，請從輸入時跳出的自動完成清單裡選一個，不要自己打完整路徑",
            ephemeral=True,
        )
        return
    save_selected_lora({"folder": match["folder"], "file": match["file"]})
    await interaction.response.send_message(f"LoRA 已設為 `{_lora_choice_label(match)}`")


@lora_cmd.autocomplete("query")
async def lora_query_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    assert http_session is not None
    category = interaction.namespace.category
    if not category:
        return []
    try:
        data = await dc.get_loras(http_session, BASE_URL)
    except dc.DarkroomError:
        return []
    needle = current.lower()
    out = []
    for it in data.get("items", []):
        if it.get("category") != category:
            continue
        haystack = f"{it.get('file', '')} {it.get('title', '')} {it.get('name', '')}".lower()
        if needle and needle not in haystack:
            continue
        out.append(app_commands.Choice(name=_lora_choice_label(it), value=_lora_choice_value(it)))
        if len(out) >= 25:
            break
    return out


bot.tree.add_command(lora_cmd)


@app_commands.command(name="chkp", description="切換底模 checkpoint")
@app_commands.describe(file="輸入關鍵字搜尋檔名")
async def chkp_cmd(interaction: discord.Interaction, file: str) -> None:
    assert http_session is not None
    try:
        data = await dc.get_checkpoints(http_session, BASE_URL)
    except dc.DarkroomError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return
    if file not in data.get("items", []):
        await interaction.response.send_message(
            "找不到符合的 checkpoint，請從輸入時跳出的自動完成清單裡選一個",
            ephemeral=True,
        )
        return
    try:
        await dc.set_checkpoint(http_session, BASE_URL, file)
    except dc.DarkroomError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return
    await interaction.response.send_message(f"checkpoint 已設為 `{file}`")


@chkp_cmd.autocomplete("file")
async def chkp_file_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    assert http_session is not None
    try:
        data = await dc.get_checkpoints(http_session, BASE_URL)
    except dc.DarkroomError:
        return []
    needle = current.lower()
    out = []
    for name in data.get("items", []):
        if needle and needle not in name.lower():
            continue
        out.append(app_commands.Choice(name=name[:100], value=name))
        if len(out) >= 25:
            break
    return out


bot.tree.add_command(chkp_cmd)


async def _run_gacha(interaction: discord.Interaction, n: int) -> None:
    assert http_session is not None
    output_channel_id = CONFIG.get("gacha_output_channel_id")
    if not output_channel_id:
        await interaction.response.send_message(
            "還沒設定 gacha_output_channel_id，請先在 config.json 填好圖片要送去哪個頻道",
            ephemeral=True,
        )
        return
    output_channel = bot.get_channel(int(output_channel_id))
    if output_channel is None:
        await interaction.response.send_message(
            f"機器人拿不到頻道 id {output_channel_id}（不在同一個伺服器，或機器人沒被邀進去）",
            ephemeral=True,
        )
        return

    selected = CONFIG.get("selected_lora")
    loras_payload = None
    if selected:
        loras_payload = [{"folder": selected["folder"], "file": selected["file"], "strength": LORA_STRENGTH}]

    await interaction.response.send_message(f"🎴 已排入 {n} 張，開始生成…")
    reply_channel = interaction.channel

    try:
        draw = await dc.agent_draw(http_session, BASE_URL, n, loras=loras_payload)
    except dc.DarkroomError as e:
        await reply_channel.send(str(e))
        return

    items = draw["items"]
    applied_loras = draw.get("loras") or []
    lora_desc = "、".join(f"{name}@{strength}" for name, strength in applied_loras) or "無"

    pending = {it["id"]: it for it in items}
    done_ids: set[str] = set()
    error_ids: set[str] = set()

    while pending:
        try:
            statuses = await dc.gen_status(http_session, BASE_URL, list(pending))
        except dc.DarkroomError as e:
            await reply_channel.send(str(e))
            break
        for gid, st in statuses.items():
            status = st.get("status")
            if status == "done" and gid not in done_ids:
                done_ids.add(gid)
                item = pending.pop(gid, None)
                if item is None:
                    continue
                try:
                    img_bytes = await dc.gen_result_bytes(http_session, BASE_URL, gid)
                except dc.DarkroomError:
                    error_ids.add(gid)
                    continue
                rel = item.get("rel", "")
                folder = rel.rsplit("/", 1)[0] if "/" in rel else "(根目錄)"
                embed = discord.Embed(title=f"{folder} · {item.get('name', rel)}", color=EMBED_COLOR)
                embed.add_field(name="LoRA", value=lora_desc)
                file_obj = discord.File(io.BytesIO(img_bytes), filename="card.webp")
                embed.set_image(url="attachment://card.webp")
                await output_channel.send(embed=embed, file=file_obj)
            elif status == "error" and gid not in error_ids:
                error_ids.add(gid)
                pending.pop(gid, None)
        if pending:
            await asyncio.sleep(POLL_INTERVAL_S)

    ok = len(done_ids)
    msg = f"完成 {ok}/{n} 張"
    if error_ids:
        msg += f"（{len(error_ids)} 張失敗）"
    await reply_channel.send(msg)


@bot.tree.command(name="gacha", description="抽卡生圖")
@app_commands.describe(n=f"抽幾張（1~{GACHA_MAX_N}，不給預設 1）")
async def gacha(interaction: discord.Interaction, n: app_commands.Range[int, 1, GACHA_MAX_N] = 1) -> None:
    await _run_gacha(interaction, n)


def main() -> None:
    token = CONFIG.get("bot_token")
    if not token:
        raise SystemExit(f"{CONFIG_PATH} 裡的 bot_token 是空的，先填好再啟動")
    bot.run(token)


if __name__ == "__main__":
    main()
