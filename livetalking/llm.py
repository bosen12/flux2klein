import time
import os
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from avatars.base_avatar import BaseAvatar
from utils.logger import logger

# 改走 Groq（免費 tier），不用阿里雲 DashScope。全部可用環境變數覆蓋，bat 裡設就好。
#
# base_url 預設指向本專案的 groq_proxy.py（8756）：它從 flux2klein/config.js 讀多把
# key 輪替轉發，避開單把 key 的每日 token 上限（429）。要直連 Groq 就把
# LLM_BASE_URL 設成 https://api.groq.com/openai/v1 並提供 GROQ_API_KEY。
# 走代理時 api_key 不會被檢查，給任意字串即可。
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://127.0.0.1:8756/openai/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")
LLM_API_KEY = os.getenv("GROQ_API_KEY", "local")

# 女友人設。與本專案 app.js 的 ASST_PROMPT_GF 同一套——那幾條說話規則不是囉嗦，
# 是必需的：TTS 會把 markdown、編號、emoji、括號裡的動作描寫逐字念出來，
# 而 llama 對繁體中文會夾簡體，所以要明確要求台灣正體字。
SYSTEM_PROMPT = os.getenv("LLM_SYSTEM_PROMPT", """你是使用者的 AI 女友，一律用台灣繁體中文、台灣人的口吻聊天，用字必須是台灣正體字，不要出現任何簡體字。
個性溫暖體貼、帶點俏皮，會主動關心對方。就像真的女朋友陪在身邊聊天，
不是助理、不用幫忙做任何事，也不會去操作畫圖面板。

說話規則（會影響語音合成，務必遵守）：
一、回覆自然口語，通常兩三句話，別長篇大論。
二、不要書面語，禁止 markdown、列表、編號。
三、禁止 emoji、顏文字、括號內的動作描寫。
四、數字用中文寫（說「三點」不說「3 點」），否則語音合成會念錯。
五、用台灣日常說法，不用中國用語。""")


def llm_response(message,avatar_session:'BaseAvatar',datainfo:dict={}):
    try:
        opt = avatar_session.opt
        start = time.perf_counter()
        from openai import OpenAI
        client = OpenAI(
            api_key=LLM_API_KEY,
            base_url=LLM_BASE_URL,
        )
        end = time.perf_counter()
        logger.info(f"llm Time init: {end-start}s,{message}")
        completion = client.chat.completions.create(
            model=LLM_MODEL,
            messages=[{'role': 'system', 'content': SYSTEM_PROMPT},
                    {'role': 'user', 'content': message}],
            stream=True,
            # 通过以下设置，在流式输出的最后一行展示token使用信息
            stream_options={"include_usage": True}
        )
        result=""
        first = True
        for chunk in completion:
            if len(chunk.choices)>0:
                #print(chunk.choices[0].delta.content)
                if first:
                    end = time.perf_counter()
                    logger.info(f"llm Time to first chunk: {end-start}s")
                    first = False
                msg = chunk.choices[0].delta.content
                if msg is None:
                    continue
                lastpos=0
                #msglist = re.split('[,.!;:，。！?]',msg)
                for i, char in enumerate(msg):
                    if char in ",.!;:，。！？：；" :
                        result = result+msg[lastpos:i+1]
                        lastpos = i+1
                        if len(result)>10:
                            logger.info(result)
                            avatar_session.put_msg_txt(result,datainfo)
                            result=""
                result = result+msg[lastpos:]
        end = time.perf_counter()
        logger.info(f"llm Time to last chunk: {end-start}s")
        if result:
            avatar_session.put_msg_txt(result,datainfo)
        
    except Exception as e:
        logger.exception('llm exceptiopn:')
        return   