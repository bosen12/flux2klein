# 本地 Qwen3-TTS（克隆音色）—— 不走阿里雲 DashScope，全部在本機跑。
#
# 與 LiveTalking 內建的 --tts qwentts 的差別：qwentts 打 DashScope 雲端 API、要阿里
# key；這支用 faster-qwen3-tts 在本機跑 Qwen3-TTS-Base，音色來自 REF_AUDIO 指的參考
# 音訊（x-vector 聲紋克隆，不需逐字稿）。
#
# 幾個實作要點：
#  - BaseTTS.sample_rate 是 16000、chunk 是 20ms（320 樣本）；Qwen3-TTS 原生 24000，
#    所以每塊都要重取樣到 16000 再切幀。
#  - 用 streaming 版而非一次合成：LiveTalking 是即時對嘴，越早給出第一幀越好。
#  - 'end' 事件要落在「最後一幀」，但串流時拿到當下並不知道是不是最後一塊，所以用
#    「延遲一幀」送出：手上永遠留著一幀，收到下一幀才把前一幀送出，生成結束時
#    留在手上的那幀就是最後一幀，標 end。
#  - 模型物件內部有 _voice_prompt_cache，同一個 ref_audio 重複合成會走快取，
#    不必自己管聲紋抽取。
import os
import sys
import threading
import time

import numpy as np
import resampy

from utils.logger import logger
from .base_tts import BaseTTS, State
from registry import register

# 都可用環境變數覆蓋，bat 裡設定就好，不用改程式
MODEL_NAME = os.getenv("QWEN3_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
REF_AUDIO = os.getenv("QWEN3_TTS_REF_AUDIO", r"C:\projects\flux2klein\voices\my_voice_10s.wav")
# x-vector 只取聲紋、不需逐字稿。若要連語調風格一起學（ICL），把這個設 0 並提供
# QWEN3_TTS_REF_TEXT（必須與參考音訊逐字一致，填錯音色會走樣）。
XVEC_ONLY = os.getenv("QWEN3_TTS_XVEC_ONLY", "1") not in ("0", "false", "False")
REF_TEXT = os.getenv("QWEN3_TTS_REF_TEXT", "")

# faster_qwen3_tts 吃的是模型 config 裡 codec_language_id 的 key（"chinese"、"english"…）
# 或 "auto"，**不吃 "zh" 這種 ISO 代碼**——傳 zh 會 NotImplementedError: Language zh
# not implemented。這張表與 speech_to_speech 的 QWEN3_LANGUAGE_ALIASES 一致。
_LANG_ALIASES = {
    "zh": "chinese", "zh-cn": "chinese", "zh-tw": "chinese",
    "zh-hans": "chinese", "zh-hant": "chinese", "cmn": "chinese",
    "en": "english", "en-us": "english", "en-gb": "english",
    "ja": "japanese", "jp": "japanese", "ko": "korean", "kr": "korean",
    "de": "german", "fr": "french", "ru": "russian",
    "pt": "portuguese", "pt-br": "portuguese", "pt-pt": "portuguese",
    "es": "spanish", "it": "italian",
}


def _normalize_language(lang):
    s = (lang or "auto").strip().replace("_", "-").lower()
    return _LANG_ALIASES.get(s, s) if s else "auto"


LANGUAGE = _normalize_language(os.getenv("QWEN3_TTS_LANGUAGE", "zh"))
DEVICE = os.getenv("QWEN3_TTS_DEVICE", "cuda")
# 每塊的 codec 步數，12 約等於 1 秒。調小 = 第一幀更快、但呼叫更頻繁。
CHUNK_SIZE = int(os.getenv("QWEN3_TTS_CHUNK_SIZE", "8"))


# 模型跨 session 共用。LiveTalking 的 build_avatar_session() 是「每個 WebRTC
# session 呼叫一次」，若在 __init__ 各自 from_pretrained，每開一個 session 就多一份
# ~3.5GB 的模型在顯存裡（max_session 預設 5，直接爆），重連也要再等十幾秒載入。
# 模型本身是唯讀推論、可安全共用，所以放模組層級只載一次。
_MODEL = None
_MODEL_LOCK = threading.Lock()


def _get_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:      # 等鎖期間別人已經載好了
            return _MODEL
        from faster_qwen3_tts import FasterQwen3TTS

        t = time.time()
        logger.info(f"loading local Qwen3-TTS {MODEL_NAME} on {DEVICE} ...")
        model = FasterQwen3TTS.from_pretrained(MODEL_NAME, device=DEVICE, backend="torch")
        logger.info(f"local Qwen3-TTS loaded in {time.time()-t:.1f}s "
                    f"(ref={os.path.basename(REF_AUDIO)}, xvec_only={XVEC_ONLY}, lang={LANGUAGE})")

        # 預熱：第一次合成要捕獲 CUDA graph 並抽取聲紋，實測 ~6.6 秒（即時率 3.8x）；
        # 之後每次只要 ~0.35x（比即時快約 3 倍）。不預熱那 6 秒會落在使用者的第一句
        # 話上。順帶把 ref_audio 的聲紋存進模型內部的 _voice_prompt_cache。
        t = time.time()
        logger.info("warming up local Qwen3-TTS (first synthesis captures CUDA graphs) ...")
        try:
            for _ in model.generate_voice_clone_streaming(
                text="嗨", language=LANGUAGE, ref_audio=REF_AUDIO, ref_text=REF_TEXT,
                xvec_only=XVEC_ONLY, chunk_size=CHUNK_SIZE,
            ):
                pass
            logger.info(f"local Qwen3-TTS warmed up in {time.time()-t:.1f}s")
        except Exception as e:
            # 預熱失敗不該讓服務起不來（第一次真正合成時還會再試一次）
            logger.warning(f"local Qwen3-TTS warmup failed ({type(e).__name__}: {e}); "
                           f"first reply will be slower")
        _MODEL = model
        return _MODEL


@register("tts", "qwen3local")
class Qwen3LocalTTS(BaseTTS):
    def __init__(self, opt, parent):
        super().__init__(opt, parent)

        if not os.path.isfile(REF_AUDIO):
            raise FileNotFoundError(
                f"找不到參考音訊 {REF_AUDIO}。用 QWEN3_TTS_REF_AUDIO 指到你的 wav "
                f"（24kHz 單聲道、5~10 秒純淨人聲）。"
            )
        if not XVEC_ONLY and not REF_TEXT:
            raise ValueError("ICL 模式（QWEN3_TTS_XVEC_ONLY=0）必須提供 QWEN3_TTS_REF_TEXT，"
                             "內容要與參考音訊逐字一致。")

        self.model = _get_model()

    def txt_to_audio(self, msg: tuple[str, dict]):
        text, textevent = msg
        t = time.time()
        try:
            stream = self.model.generate_voice_clone_streaming(
                text=text,
                language=LANGUAGE,
                ref_audio=REF_AUDIO,
                ref_text=REF_TEXT,
                xvec_only=XVEC_ONLY,
                chunk_size=CHUNK_SIZE,
            )
        except Exception as e:
            # 除了 logger（可能被導到別的 handler）也印到 stderr：這類設定錯誤
            # （例如 language 代碼不對）不講清楚會很難查
            logger.exception("qwen3local tts")
            print(f"[qwen3local] 合成失敗: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            return

        buf = np.zeros(0, dtype=np.float32)
        held = None          # 延遲一幀：手上留著的那幀，收到下一幀才送出
        first = True
        nframes = 0
        try:
            for item in stream:
                if self.state != State.RUNNING:      # 被打斷（flush_talk）就別再送
                    break
                audio, sr = item[0], item[1]
                a = np.asarray(audio, dtype=np.float32).reshape(-1)
                if a.size == 0:
                    continue
                if sr != self.sample_rate:
                    a = resampy.resample(x=a, sr_orig=sr, sr_new=self.sample_rate)
                buf = np.concatenate((buf, a)) if buf.size else a

                while buf.size >= self.chunk and self.state == State.RUNNING:
                    frame, buf = buf[:self.chunk], buf[self.chunk:]
                    if held is not None:
                        self._emit(held, text, textevent, first, False)
                        first = False
                        nframes += 1
                    held = frame
        except Exception as e:
            logger.exception("qwen3local tts stream")
            print(f"[qwen3local] 串流中斷: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

        if self.state != State.RUNNING:
            return
        # 收尾：把剩下不足一幀的補零併進來，最後一幀標 end
        if buf.size > 0:
            if held is not None:
                self._emit(held, text, textevent, first, False)
                first = False
                nframes += 1
            held = np.pad(buf, (0, self.chunk - buf.size))
        if held is not None:
            self._emit(held, text, textevent, first, True)
            nframes += 1
        logger.info(f"-------local qwen3 tts time:{time.time()-t:.4f}s frames:{nframes} text:{text[:20]}")

    def _emit(self, frame, text, textevent, is_first, is_last):
        eventpoint = {}
        if is_first:
            eventpoint = {'status': 'start', 'text': text}
        elif is_last:
            eventpoint = {'status': 'end', 'text': text}
        eventpoint.update(**textevent)
        self.parent.put_audio_frame(frame, eventpoint)
