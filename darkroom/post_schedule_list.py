import discord, json, asyncio

token = json.load(open('preview_config.json'))['discord_bot_token']
FORUM = 1537116847068160140

content = """# 📋 我的排程清單

以下為目前啟用的定時任務（皆以繁體中文輸出，全程僅使用 web_search）：

## 1. 每日科技新聞速報
- ⏰ 時間：每天 12:00
- 📡 投遞：#科技
- 📝 內容：搜尋並整理數則當日科技新聞，附來源與摘要。

## 2. 每日午間股市速報（台股＋美股）
- ⏰ 時間：每天 12:00
- 📡 投遞：#股票
- 📝 內容：台股（加權指數、台積電、聯發科、0050、群創等權值股）＋ 美股（輝達、Apple、Google、SpaceX 等科技股）最新股價與動態。

## 3. 每晚台灣新聞速報
- ⏰ 時間：每天 22:00
- 📡 投遞：#台灣新聞
- 📝 內容：整理過去 24 小時內 5 則代表性台灣新聞，含來源、時間與摘要。

---
_最後更新：2026-08-12_"""

async def main():
    client = discord.Client(intents=discord.Intents.default())
    async with client:
        await client.login(token)
        forum = client.get_channel(FORUM)
        if forum is None:
            forum = await client.fetch_channel(FORUM)
        thread = await forum.create_thread(name="📋 我的排程清單", content=content)
        print("created thread:", thread.thread.id if hasattr(thread, 'thread') else thread.id)

asyncio.run(main())
