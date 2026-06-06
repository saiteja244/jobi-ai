import json
import os
import re

from services.gpt_service import iter_voice_reply, truncate_words
from services.stt_service import speech_to_text
from services.tts_service import text_to_speech_base64

FIRST_TTS_MIN_WORDS = int(os.getenv("FIRST_TTS_MIN_WORDS", "3"))
FIRST_TTS_MAX_WORDS = int(os.getenv("FIRST_TTS_MAX_WORDS", "8"))


def _line(payload):
    return json.dumps(payload, ensure_ascii=False) + "\n"


def _extract_first_segment(text):
    text = (text or "").strip()
    if not text:
        return None

    words = text.split()
    if len(words) < FIRST_TTS_MIN_WORDS:
        return None

    match = re.search(r"[.!?]", text)
    if match:
        end = match.end()
        segment = text[:end].strip()
        if len(segment.split()) >= FIRST_TTS_MIN_WORDS:
            return segment

    if len(words) >= FIRST_TTS_MAX_WORDS:
        return " ".join(words[:FIRST_TTS_MAX_WORDS])

    return None


def _extract_remainder(full_text, spoken_segment):
    if not spoken_segment:
        return full_text.strip()
    idx = full_text.find(spoken_segment)
    if idx == -1:
        return ""
    return full_text[idx + len(spoken_segment):].strip()


def stream_voice_chat(audio_path, chat_history):
    try:
        user_text = speech_to_text(audio_path)
        if not user_text:
            yield _line({
                "event": "error",
                "error": "Could not understand audio. Speak clearly for 2+ seconds.",
            })
            return

        yield _line({"event": "transcript", "user_text": user_text})

        chat_history.append(f"User: {user_text}")

        full_text = ""
        first_segment = None
        first_audio_sent = False

        try:
            for delta in iter_voice_reply(user_text, chat_history[:-1]):
                full_text += delta
                yield _line({"event": "delta", "delta": delta})

                if not first_audio_sent:
                    segment = _extract_first_segment(full_text)
                    if segment:
                        audio = text_to_speech_base64(
                            segment, max_words=FIRST_TTS_MAX_WORDS
                        )
                        if audio:
                            first_segment = segment
                            first_audio_sent = True
                            yield _line({
                                "event": "audio",
                                "audio": audio,
                                "segment": "first",
                            })

        except RuntimeError as e:
            chat_history.pop()
            yield _line({"event": "error", "error": str(e)})
            return

        full_text = truncate_words(full_text)

        if not full_text.strip():
            chat_history.pop()
            yield _line({"event": "error", "error": "AI returned an empty reply."})
            return

        if not first_audio_sent and full_text.strip():
            audio = text_to_speech_base64(full_text)
            if audio:
                first_segment = full_text
                first_audio_sent = True
                yield _line({"event": "audio", "audio": audio, "segment": "first"})
        else:
            remainder = _extract_remainder(full_text, first_segment or "")
            if remainder and len(remainder.split()) >= 4:
                audio = text_to_speech_base64(remainder)
                if audio:
                    yield _line({
                        "event": "audio",
                        "audio": audio,
                        "segment": "rest",
                    })

        chat_history.append(f"Assistant: {full_text}")

        yield _line({
            "event": "done",
            "ai_text": full_text,
            "ai_response": full_text,
        })

    except Exception as e:
        print("voice_stream error:", e)
        yield _line({"event": "error", "error": f"Voice processing failed: {e}"})
