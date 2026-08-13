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
LORA_PAGE_SIZE = 25   # Discord select 單一元件最多 25 個選項
GACHA_MAX_N = 100
POLL_INTERVAL_S = 1.0
EMBED_COLOR = 0xEAAD57   # 跟 agent_draw.py 的 DISCORD_EMBED_COLOR 一致
ERROR_COLOR = 0xE74C3C   # 錯誤訊息用紅色，跟正常訊息的琥珀色一眼分得出來
LORA_VIDEO_EXTS = (".mp4", ".webm")   # 這幾種預覽是短片，Discord embed 縮圖放不了影片，跳過


def _error_embed(message: str) -> discord.Embed:
    return discord.Embed(description=message, color=ERROR_COLOR)


def load_config() -> dict:
    if not CONFIG_PATH.is_file():
        raise SystemExit(
            f"找不到 {CONFIG_PATH}，先複製 config.example.json 成 config.json 並填好設定"
        )
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def save_selected_lora(entry: dict | None) -> None:
    """讀-改-寫，只動 selected_lora 這個欄位，不動使用者手動填的其他設定值。同步更新
    記憶體裡的 CONFIG——CONFIG 只在啟動時讀一次，不會自動反映後續寫檔，/gacha 讀的
    是這份記憶體副本，這裡沒同步的話選了新 LoRA 也不會真的套用到下一次抽卡。"""
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    cfg["selected_lora"] = entry
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    CONFIG["selected_lora"] = entry


CONFIG = load_config()
BASE_URL = str(CONFIG.get("darkroom_base_url") or "http://127.0.0.1:7860").rstrip("/")

intents = discord.Intents.default()
bot = commands.Bot(command_prefix="!", intents=intents)
http_session: aiohttp.ClientSession | None = None


def _lora_label(item: dict) -> str:
    # 跟暗房自己（darkroom.js）的慣例一致：title 優先，沒有才退回 name。Discord select
    # option 的 label 上限 100 字元。
    title = item.get("title") or item.get("name") or item.get("file")
    return title[:100]


async def _fetch_lora_preview(item: dict) -> tuple[bytes, str] | None:
    """回傳 (bytes, 檔名) 給 embed 縮圖用，沒有預覽圖／是短片／抓取失敗都回 None——
    這不是致命錯誤，沒有縮圖就不顯示，不該中斷選擇 LoRA 的流程。"""
    preview = item.get("preview")
    if not preview or preview.lower().endswith(LORA_VIDEO_EXTS):
        return None
    assert http_session is not None
    data = await dc.get_lora_preview(http_session, BASE_URL, item["folder"], item["file"])
    if data is None:
        return None
    ext = Path(preview).suffix or ".png"
    return data, f"preview{ext}"


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
    embed.add_field(name="/lora", value="點選分類/搜尋→選 LoRA→確認，切換抽卡套用的 LoRA（全局共用）", inline=False)
    embed.add_field(name="/chkp", value="點選 checkpoint→確認，切換底模（全局共用）", inline=False)
    await interaction.response.send_message(embed=embed)


LORA_STRENGTH_MIN = 0.0
LORA_STRENGTH_MAX = 1.0
LORA_STRENGTH_STEP = 0.05   # 跟暗房自己的強度滑桿（darkroom.js sInput）同一組上下限與步進


class LoraDetailView(discord.ui.View):
    """按鈕流程最後一步：調強度、勾選要套用的觸發詞段落、確認/取消。
    取消回到剛才那一頁的項目清單——如果是從分類/分頁進來的（category 有值）；
    如果是從 🔍 搜尋結果進來的（category 是 None，沒有「那一頁」可以回去），
    取消就單純清空訊息。"""

    def __init__(self, item: dict, category: str | None = None, items: list[dict] | None = None,
                 page: int = 0, strength: float = LORA_STRENGTH,
                 selected_words: set[int] | None = None,
                 preview: tuple[bytes, str] | None = None) -> None:
        super().__init__(timeout=180)
        self.item = item
        self.category = category
        self.items = items
        self.page = page
        self.strength = strength
        # 縮圖只在第一次選中這個 LoRA 時抓一次（見呼叫端），之後強度/觸發詞變動
        # 重建畫面時原樣帶著走，不用每次點按鈕都重抓一次圖。
        self.preview = preview
        words = item.get("trainedWords") or []
        # 沒指定就預設全選——比照暗房面板選 LoRA 時「自動把觸發詞帶進提示詞框」的既有行為
        self.selected_words = selected_words if selected_words is not None else set(range(len(words)))
        self._build()

    def _trigger_text(self) -> str:
        words = self.item.get("trainedWords") or []
        return ", ".join(words[i] for i in sorted(self.selected_words) if i < len(words))

    def build_embed(self) -> discord.Embed:
        embed = discord.Embed(title=_lora_label(self.item), color=EMBED_COLOR)
        embed.add_field(name="強度", value=f"{self.strength:.2f}", inline=True)
        trigger = self._trigger_text()
        embed.add_field(name="觸發詞", value=trigger or "（不加觸發詞）", inline=False)
        if self.preview:
            embed.set_thumbnail(url=f"attachment://{self.preview[1]}")
        return embed

    def attachments(self) -> list[discord.File]:
        if not self.preview:
            return []
        return [discord.File(io.BytesIO(self.preview[0]), filename=self.preview[1])]

    def _build(self) -> None:
        self.clear_items()
        words = self.item.get("trainedWords") or []
        if words:
            select = discord.ui.Select(
                placeholder="選擇要套用的觸發詞（可複選，不選＝不加觸發詞）",
                min_values=0, max_values=min(len(words), 25), row=0,
                options=[
                    discord.SelectOption(label=w[:100], value=str(i), default=(i in self.selected_words))
                    for i, w in enumerate(words[:25])
                ],
            )
            select.callback = self._on_words_change
            self.add_item(select)

        minus_btn = discord.ui.Button(label=f"➖ {LORA_STRENGTH_STEP:.2f}", style=discord.ButtonStyle.secondary, row=1,
                                       disabled=self.strength <= LORA_STRENGTH_MIN)
        minus_btn.callback = self._make_strength_callback(-LORA_STRENGTH_STEP)
        self.add_item(minus_btn)
        plus_btn = discord.ui.Button(label=f"➕ {LORA_STRENGTH_STEP:.2f}", style=discord.ButtonStyle.secondary, row=1,
                                      disabled=self.strength >= LORA_STRENGTH_MAX)
        plus_btn.callback = self._make_strength_callback(LORA_STRENGTH_STEP)
        self.add_item(plus_btn)

        confirm_btn = discord.ui.Button(label="✅ 確認", style=discord.ButtonStyle.success, row=2)
        confirm_btn.callback = self._on_confirm
        self.add_item(confirm_btn)
        cancel_btn = discord.ui.Button(label="❌ 取消", style=discord.ButtonStyle.danger, row=2)
        cancel_btn.callback = self._on_cancel
        self.add_item(cancel_btn)

    async def _on_words_change(self, interaction: discord.Interaction) -> None:
        selected = {int(v) for v in interaction.data.get("values", [])}
        view = LoraDetailView(self.item, self.category, self.items, self.page, self.strength, selected, self.preview)
        await interaction.response.edit_message(embed=view.build_embed(), view=view, attachments=view.attachments())

    def _make_strength_callback(self, delta: float):
        async def callback(interaction: discord.Interaction) -> None:
            strength = round(min(LORA_STRENGTH_MAX, max(LORA_STRENGTH_MIN, self.strength + delta)), 2)
            view = LoraDetailView(self.item, self.category, self.items, self.page, strength,
                                   self.selected_words, self.preview)
            await interaction.response.edit_message(embed=view.build_embed(), view=view, attachments=view.attachments())
        return callback

    async def _on_confirm(self, interaction: discord.Interaction) -> None:
        save_selected_lora({
            "folder": self.item["folder"], "file": self.item["file"],
            "strength": self.strength, "trigger": self._trigger_text(),
        })
        await interaction.response.edit_message(
            content=f"LoRA 已設為 `{_lora_label(self.item)}`（強度 {self.strength:.2f}）",
            embed=None, view=None,
        )

    async def _on_cancel(self, interaction: discord.Interaction) -> None:
        if self.category is not None and self.items is not None:
            view = LoraItemPageView(self.category, self.items, self.page)
            await interaction.response.edit_message(embed=view.build_embed(), view=view)
        else:
            await interaction.response.edit_message(content="已取消", embed=None, view=None)


class LoraItemPageView(discord.ui.View):
    """單一分類內的分頁下拉選單（每頁最多 25 個，Discord select 的硬上限），
    選單本身支援打字過濾當前頁的選項（Discord 原生能力，不用自己實作搜尋），
    另外配上一頁/下一頁/換分類三顆按鈕。"""

    def __init__(self, category: str, items: list[dict], page: int) -> None:
        super().__init__(timeout=180)
        self.category = category
        self.items = items
        self.page = page
        self._build()

    @property
    def total_pages(self) -> int:
        return max(1, (len(self.items) + LORA_PAGE_SIZE - 1) // LORA_PAGE_SIZE)

    def _page_items(self) -> list[dict]:
        start = self.page * LORA_PAGE_SIZE
        return self.items[start:start + LORA_PAGE_SIZE]

    def build_embed(self) -> discord.Embed:
        return discord.Embed(
            title=f"選擇 LoRA · {self.category}（第 {self.page + 1}/{self.total_pages} 頁，共 {len(self.items)} 筆）",
            color=EMBED_COLOR,
        )

    def _build(self) -> None:
        self.clear_items()
        page_items = self._page_items()
        select = discord.ui.Select(
            placeholder="選擇 LoRA（可在選單內打字過濾這一頁）",
            row=0,
            options=[
                discord.SelectOption(label=_lora_label(it), value=str(i))
                for i, it in enumerate(page_items)
            ],
        )
        select.callback = self._make_select_callback(page_items)
        self.add_item(select)

        prev_btn = discord.ui.Button(label="◀ 上一頁", style=discord.ButtonStyle.secondary,
                                      disabled=self.page <= 0, row=1)
        prev_btn.callback = self._make_page_callback(self.page - 1)
        self.add_item(prev_btn)
        next_btn = discord.ui.Button(label="下一頁 ▶", style=discord.ButtonStyle.secondary,
                                      disabled=self.page >= self.total_pages - 1, row=1)
        next_btn.callback = self._make_page_callback(self.page + 1)
        self.add_item(next_btn)
        back_btn = discord.ui.Button(label="🔙 換分類", style=discord.ButtonStyle.secondary, row=1)
        back_btn.callback = self._back_callback
        self.add_item(back_btn)

    def _make_page_callback(self, page: int):
        async def callback(interaction: discord.Interaction) -> None:
            view = LoraItemPageView(self.category, self.items, page)
            await interaction.response.edit_message(embed=view.build_embed(), view=view)
        return callback

    def _make_select_callback(self, page_items: list[dict]):
        async def callback(interaction: discord.Interaction) -> None:
            idx = int(interaction.data["values"][0])
            item = page_items[idx]
            preview = await _fetch_lora_preview(item)
            view = LoraDetailView(item, self.category, self.items, self.page, preview=preview)
            await interaction.response.edit_message(embed=view.build_embed(), view=view, attachments=view.attachments())
        return callback

    async def _back_callback(self, interaction: discord.Interaction) -> None:
        embed = discord.Embed(title="選擇 LoRA 分類", color=EMBED_COLOR)
        await interaction.response.edit_message(embed=embed, view=LoraCategoryView())


class LoraSearchResultView(discord.ui.View):
    """🔍 搜尋結果：一個下拉選單（最多 25 筆命中），選了直接進詳情畫面。
    category=None 帶進 LoraDetailView，取消時單純清空（沒有「上一頁」可回）。"""

    def __init__(self, matches: list[dict], query: str) -> None:
        super().__init__(timeout=180)
        self.matches = matches
        select = discord.ui.Select(
            placeholder=f"「{query}」的搜尋結果（{len(matches)} 筆）",
            options=[discord.SelectOption(label=_lora_label(it), value=str(i))
                     for i, it in enumerate(matches)],
        )
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction) -> None:
        idx = int(interaction.data["values"][0])
        item = self.matches[idx]
        preview = await _fetch_lora_preview(item)
        view = LoraDetailView(item, preview=preview)
        await interaction.response.edit_message(embed=view.build_embed(), view=view, attachments=view.attachments())


class LoraSearchModal(discord.ui.Modal, title="搜尋 LoRA"):
    query = discord.ui.TextInput(label="關鍵字", placeholder="輸入檔名或標題的一部分", max_length=100)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        assert http_session is not None
        try:
            data = await dc.get_loras(http_session, BASE_URL)
        except dc.DarkroomError as e:
            await interaction.response.send_message(embed=_error_embed(str(e)), ephemeral=True)
            return
        needle = self.query.value.lower()
        matches = []
        for it in data.get("items", []):
            haystack = f"{it.get('file', '')} {it.get('title', '')} {it.get('name', '')}".lower()
            if needle in haystack:
                matches.append(it)
            if len(matches) >= 25:
                break
        if not matches:
            await interaction.response.send_message(
                embed=_error_embed(f"找不到符合「{self.query.value}」的 LoRA"), ephemeral=True,
            )
            return
        embed = discord.Embed(title=f"搜尋「{self.query.value}」", color=EMBED_COLOR)
        await interaction.response.send_message(
            embed=embed, view=LoraSearchResultView(matches, self.query.value), ephemeral=True,
        )


class LoraCategoryView(discord.ui.View):
    """/lora 第一步：4 個分類按鈕＋搜尋＋不套用。"""

    def __init__(self) -> None:
        super().__init__(timeout=180)
        for cat in LORA_CATEGORIES:
            btn = discord.ui.Button(label=cat, style=discord.ButtonStyle.primary)
            btn.callback = self._make_callback(cat)
            self.add_item(btn)
        search_btn = discord.ui.Button(label="🔍 搜尋", style=discord.ButtonStyle.primary)
        search_btn.callback = self._search_callback
        self.add_item(search_btn)
        none_btn = discord.ui.Button(label="🚫 不套用 LoRA", style=discord.ButtonStyle.secondary)
        none_btn.callback = self._no_lora_callback
        self.add_item(none_btn)

    def _make_callback(self, category: str):
        async def callback(interaction: discord.Interaction) -> None:
            assert http_session is not None
            try:
                data = await dc.get_loras(http_session, BASE_URL)
            except dc.DarkroomError as e:
                await interaction.response.edit_message(content=None, embed=_error_embed(str(e)), view=None)
                return
            items = [it for it in data.get("items", []) if it.get("category") == category]
            if not items:
                await interaction.response.edit_message(
                    content=None, embed=_error_embed(f"{category} 分類目前沒有 LoRA"), view=None,
                )
                return
            view = LoraItemPageView(category, items, page=0)
            await interaction.response.edit_message(embed=view.build_embed(), view=view)
        return callback

    async def _search_callback(self, interaction: discord.Interaction) -> None:
        # 跳出輸入框讓使用者打字，送出（Modal.on_submit）之後另開一則訊息顯示
        # 結果選單——不能沿用原本那則訊息，因為送 modal 本身就會消耗掉這次
        # component 互動的回應額度，後續是 modal 提交產生的新一輪互動。
        await interaction.response.send_modal(LoraSearchModal())

    async def _no_lora_callback(self, interaction: discord.Interaction) -> None:
        # 存空陣列，不是 None——None 代表「還沒選過」，/gacha 會落到暗房伺服器端自己的
        # 預設 LoRA；空陣列才是「使用者明確選了不套用」，語意跟 /api/agent-draw 的
        # loras 欄位一致（不帶欄位＝套預設，帶空陣列＝真的不套）。
        save_selected_lora([])
        await interaction.response.edit_message(content="LoRA 已設為：無", embed=None, view=None)


@bot.tree.command(name="lora", description="切換抽卡套用的 LoRA")
async def lora_cmd(interaction: discord.Interaction) -> None:
    embed = discord.Embed(title="選擇 LoRA 分類", color=EMBED_COLOR)
    await interaction.response.send_message(embed=embed, view=LoraCategoryView(), ephemeral=True)


class ChkpConfirmView(discord.ui.View):
    def __init__(self, name: str) -> None:
        super().__init__(timeout=120)
        self.name = name

    @discord.ui.button(label="✅ 確認", style=discord.ButtonStyle.success)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        assert http_session is not None
        try:
            await dc.set_checkpoint(http_session, BASE_URL, self.name)
        except dc.DarkroomError as e:
            await interaction.response.edit_message(content=None, embed=_error_embed(str(e)), view=None)
            return
        await interaction.response.edit_message(content=f"checkpoint 已設為 `{self.name}`", embed=None, view=None)

    @discord.ui.button(label="❌ 取消", style=discord.ButtonStyle.danger)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await interaction.response.edit_message(content="已取消", embed=None, view=None)


class ChkpView(discord.ui.View):
    def __init__(self, items: list[str], current: str | None) -> None:
        super().__init__(timeout=180)
        for name in items:
            style = discord.ButtonStyle.success if name == current else discord.ButtonStyle.secondary
            btn = discord.ui.Button(label=name[:80], style=style)
            btn.callback = self._make_callback(name)
            self.add_item(btn)

    def _make_callback(self, name: str):
        async def callback(interaction: discord.Interaction) -> None:
            embed = discord.Embed(title="確認切換 checkpoint", description=f"`{name}`", color=EMBED_COLOR)
            await interaction.response.edit_message(embed=embed, view=ChkpConfirmView(name))
        return callback


@bot.tree.command(name="chkp", description="切換底模 checkpoint")
async def chkp_cmd(interaction: discord.Interaction) -> None:
    assert http_session is not None
    try:
        data = await dc.get_checkpoints(http_session, BASE_URL)
    except dc.DarkroomError as e:
        await interaction.response.send_message(embed=_error_embed(str(e)), ephemeral=True)
        return
    items = data.get("items", [])
    if not items:
        await interaction.response.send_message(embed=_error_embed("找不到任何 checkpoint"), ephemeral=True)
        return
    embed = discord.Embed(title="選擇 checkpoint", color=EMBED_COLOR)
    await interaction.response.send_message(embed=embed, view=ChkpView(items, data.get("current")), ephemeral=True)


def _gacha_status_embed(n: int, done: int, errors: int, state: str) -> discord.Embed:
    """state: 'running'（還在跑）/ 'done'（正常跑完）/ 'cancelled'（使用者按了取消）。"""
    if state == "cancelled":
        title = f"🚫 已取消（{done}/{n} 張已完成）"
        color = ERROR_COLOR
    elif state == "done":
        title = f"✅ 完成 {done}/{n} 張"
        color = EMBED_COLOR
    else:
        title = f"🎴 生成中…（{done}/{n} 完成）"
        color = EMBED_COLOR
    embed = discord.Embed(title=title, color=color)
    if errors:
        embed.description = f"{errors} 張失敗"
    return embed


class GachaCancelView(discord.ui.View):
    """掛在進度訊息上的「取消」按鈕。按下只設一個旗標，實際呼叫暗房
    /api/gen-cancel 跟停止輪詢是 _run_gacha 的迴圈自己看旗標決定——按鈕
    callback 不直接碰 pending 清單（那份清單活在迴圈的區域變數裡）。"""

    def __init__(self, cancel_event: asyncio.Event) -> None:
        super().__init__(timeout=None)   # 訊息生命週期由 _run_gacha 自己收尾，不靠 view 逾時
        self.cancel_event = cancel_event

    @discord.ui.button(label="❌ 取消剩餘", style=discord.ButtonStyle.danger)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        self.cancel_event.set()
        button.disabled = True
        button.label = "取消中…"
        await interaction.response.edit_message(view=self)


async def _run_gacha(interaction: discord.Interaction, n: int) -> None:
    assert http_session is not None
    output_channel_id = CONFIG.get("gacha_output_channel_id")
    if not output_channel_id:
        await interaction.response.send_message(
            embed=_error_embed("還沒設定 gacha_output_channel_id，請先在 config.json 填好圖片要送去哪個頻道"),
            ephemeral=True,
        )
        return
    output_channel = bot.get_channel(int(output_channel_id))
    if output_channel is None:
        await interaction.response.send_message(
            embed=_error_embed(f"機器人拿不到頻道 id {output_channel_id}（不在同一個伺服器，或機器人沒被邀進去）"),
            ephemeral=True,
        )
        return

    selected = CONFIG.get("selected_lora")
    if selected is None:
        loras_payload = None    # 還沒選過，套暗房伺服器端自己的預設 LoRA
        trigger_payload = None
    elif isinstance(selected, list):
        loras_payload = []      # 明確選了「不套用 LoRA」
        trigger_payload = ""
    else:
        loras_payload = [{"folder": selected["folder"], "file": selected["file"],
                           "strength": selected.get("strength", LORA_STRENGTH)}]
        trigger_payload = selected.get("trigger") or ""

    # 只是個 3 秒內一定要有的輕量 ack，真正看得到進度/取消按鈕的是下面另外
    # send 出去的那則訊息——這樣後續無論跑多久都不受 interaction followup
    # 15 分鐘過期的限制（進度訊息用一般頻道訊息 .edit()，不是 interaction API）。
    await interaction.response.send_message(f"🎴 已排入 {n} 張，開始生成…", ephemeral=True)
    reply_channel = interaction.channel

    try:
        draw = await dc.agent_draw(http_session, BASE_URL, n, loras=loras_payload, trigger=trigger_payload)
    except dc.DarkroomError as e:
        await reply_channel.send(embed=_error_embed(str(e)))
        return

    items = draw["items"]
    applied_loras = draw.get("loras") or []
    lora_desc = "、".join(f"{name}@{strength}" for name, strength in applied_loras) or "無"

    pending = {it["id"]: it for it in items}
    done_ids: set[str] = set()
    error_ids: set[str] = set()
    cancel_event = asyncio.Event()
    cancel_view = GachaCancelView(cancel_event)
    progress_msg = await reply_channel.send(embed=_gacha_status_embed(n, 0, 0, "running"), view=cancel_view)

    cancelled = False
    while pending:
        if cancel_event.is_set():
            cancelled = True
            try:
                await dc.gen_cancel(http_session, BASE_URL, list(pending))
            except dc.DarkroomError:
                pass   # 取消本身失敗也不影響「不再繼續輪詢」這個結果
            break
        try:
            statuses = await dc.gen_status(http_session, BASE_URL, list(pending))
        except dc.DarkroomError as e:
            await reply_channel.send(embed=_error_embed(str(e)))
            break
        progressed = False
        for gid, st in statuses.items():
            status = st.get("status")
            if status == "done" and gid not in done_ids:
                done_ids.add(gid)
                progressed = True
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
                progressed = True
                pending.pop(gid, None)
        if progressed:
            await progress_msg.edit(embed=_gacha_status_embed(n, len(done_ids), len(error_ids), "running"),
                                     view=cancel_view)
        if pending and not cancel_event.is_set():
            await asyncio.sleep(POLL_INTERVAL_S)

    final_state = "cancelled" if cancelled else "done"
    await progress_msg.edit(embed=_gacha_status_embed(n, len(done_ids), len(error_ids), final_state), view=None)


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
