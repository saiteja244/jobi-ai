import base64
import os
import re

from dotenv import load_dotenv
from sarvamai import SarvamAI

from services.gpt_service import VOICE_MAX_WORDS, truncate_words

load_dotenv(override=True)

client = SarvamAI(
    api_subscription_key=os.getenv("SARVAM_API_KEY")
)

TTS_VOICE_REPLY_WORDS = int(os.getenv("TTS_MAX_WORDS", str(VOICE_MAX_WORDS)))
TTS_QUESTION_WORDS = int(os.getenv("TTS_QUESTION_MAX_WORDS", "120"))


def _strip_markdown(text):
    text = re.sub(r"[*_#`]", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return text.strip()


def _synthesize(clean_text):
    response = client.text_to_speech.convert(
        text=clean_text,
        target_language_code="en-IN",
        speaker="shubh",
        model="bulbul:v3",
    )
    return "".join(response.audios)


def text_to_speech_base64(text, for_voice_reply=True, max_words=None):
    """Return base64 WAV audio without writing to disk (faster for streaming)."""
    try:
        clean = _strip_markdown(text or "")
        if not clean:
            return ""

        if max_words is not None:
            clean = truncate_words(clean, max_words)
        else:
            limit = TTS_VOICE_REPLY_WORDS if for_voice_reply else TTS_QUESTION_WORDS
            clean = truncate_words(clean, limit)

        if not clean:
            return ""

        return _synthesize(clean)

    except Exception as e:
        print("TTS ERROR:", e)
        return ""


def text_to_speech(text, for_voice_reply=True):
    try:
        audio_base64 = text_to_speech_base64(text, for_voice_reply=for_voice_reply)
        if not audio_base64:
            return None

        audio_bytes = base64.b64decode(audio_base64)
        output_file = "uploads/ai_response.wav"
        os.makedirs(os.path.dirname(output_file), exist_ok=True)

        with open(output_file, "wb") as f:
            f.write(audio_bytes)

        return output_file

    except Exception as e:
        print("TTS ERROR:", e)
        return None
