import discord, json, asyncio

token = json.load(open('preview_config.json'))['discord_bot_token']
FORUM = 1537116847068160140

posts = [
    {
        "name": "🗞️ 每日科技新聞速報",
        "body": """# 每日科技新聞速報

- ⏰ 排程：每天 12:00
- 📡 投遞頻道：#科技
- 🔧 類型：cron 自動任務（job `650d831f8ba6`）

## 在幹嘛
全程僅使用 web_search，搜尋並整理當日數則科技新聞，每則附來源與 2~3 句摘要，最後以繁體中文輸出一份科技新聞速報，發送到 #科技 頻道。"""
    },
    {
        "name": "📈 每日午間股市速報（台股＋美股）",
        "body": """# 每日午間股市速報（台股＋美股）

- ⏰ 排程：每天 12:00
- 📡 投遞頻道：#股票
- 🔧 類型：cron 自動任務（job `0059a4a1dd78`）

## 在幹嘛
全程僅使用 web_search，整理當日台股與美股重點標的：
- 台股：加權指數、台積電(2330)、聯發科(2454)、0050、群創(3481) 等權值股
- 美股：輝達(NVDA)、Apple(AAPL)、Google(GOOGL)、SpaceX（註明私有公司）等科技股

每檔附最新價格、漲跌%、一句動態摘要，以繁體中文輸出，發送到 #股票 頻道。"""
    },
    {
        "name": "📰 每晚台灣新聞速報",
        "body": """# 每晚台灣新聞速報

- ⏰ 排程：每天 22:00
- 📡 投遞頻道：#台灣新聞
- 🔧 類型：cron 自動任務（job `4ce72c58fa26`）

## 在幹嘛
全程僅使用 web_search，整理過去 24 小時內 5 則代表性台灣新聞，每則附來源、時間、2~3 句摘要與重要性說明，以繁體中文輸出，發送到 #台灣新聞 頻道。"""
    },
]

async def main():
    client = discord.Client(intents=discord.Intents.default())
    async with client:
        await client.login(token)
        forum = await client.fetch_channel(FORUM)
        for p in posts:
            thread = await forum.create_thread(name=p["name"], content=p["body"])
            tid = thread.thread.id if hasattr(thread, 'thread') else thread.id
            print("created:", p["name"], "->", tid)

asyncio.run(main())
