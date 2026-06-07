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


def stream_voice_chat_text(user_text, chat_history):
    """Fast path: text in → streamed Gemini out. No STT/TTS (client handles voice)."""
    try:
        user_text = (user_text or "").strip()
        if not user_text:
            yield _line({"event": "error", "error": "Empty message."})
            return

        yield _line({"event": "transcript", "user_text": user_text})
        chat_history.append(f"User: {user_text}")

        full_text = ""

        try:
            for delta in iter_voice_reply(user_text, chat_history[:-1]):
                full_text += delta
                yield _line({"event": "delta", "delta": delta})
        except RuntimeError as e:
            chat_history.pop()
            yield _line({"event": "error", "error": str(e)})
            return

        full_text = truncate_words(full_text)

        if not full_text.strip():
            chat_history.pop()
            yield _line({"event": "error", "error": "AI returned an empty reply."})
            return

        chat_history.append(f"Assistant: {full_text}")

        yield _line({
            "event": "done",
            "ai_text": full_text,
            "ai_response": full_text,
        })

    except Exception as e:
        print("voice_stream text error:", e)
        yield _line({"event": "error", "error": f"Voice processing failed: {e}"})


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
        text_buffer = ""
        is_first_segment = True

        sentence_end_pattern = re.compile(r'([.!?])(\s+|$)', re.UNICODE)

        try:
            for delta in iter_voice_reply(user_text, chat_history[:-1]):
                full_text += delta
                text_buffer += delta

                yield _line({"event": "delta", "delta": delta})

                chunk = None
                if is_first_segment:
                    words = text_buffer.split()
                    match = sentence_end_pattern.search(text_buffer)
                    if match:
                        split_idx = match.end()
                        chunk = text_buffer[:split_idx].strip()
                        text_buffer = text_buffer[split_idx:]
                        is_first_segment = False
                    elif len(words) >= 4:
                        chunk = " ".join(words[:4])
                        text_buffer = " ".join(words[4:])
                        is_first_segment = False
                else:
                    match = sentence_end_pattern.search(text_buffer)
                    if match:
                        split_idx = match.end()
                        chunk = text_buffer[:split_idx].strip()
                        text_buffer = text_buffer[split_idx:]
                    else:
                        words = text_buffer.split()
                        if len(words) >= 10:
                            comma_match = re.search(r'([,;:\n])(\s+)', text_buffer)
                            if comma_match:
                                split_idx = comma_match.end()
                                chunk = text_buffer[:split_idx].strip()
                                text_buffer = text_buffer[split_idx:]
                            else:
                                chunk = " ".join(words[:8])
                                text_buffer = " ".join(words[8:])

                if chunk:
                    audio = text_to_speech_base64(chunk)
                    if audio:
                        yield _line({
                            "event": "audio",
                            "audio": audio,
                            "segment": chunk,
                        })

        except RuntimeError as e:
            chat_history.pop()
            yield _line({"event": "error", "error": str(e)})
            return

        if text_buffer.strip():
            audio = text_to_speech_base64(text_buffer.strip())
            if audio:
                yield _line({
                    "event": "audio",
                    "audio": audio,
                    "segment": text_buffer.strip(),
                })

        full_text = truncate_words(full_text)

        if not full_text.strip():
            chat_history.pop()
            yield _line({"event": "error", "error": "AI returned an empty reply."})
            return

        chat_history.append(f"Assistant: {full_text}")

        yield _line({
            "event": "done",
            "ai_text": full_text,
            "ai_response": full_text,
        })

    except Exception as e:
        print("voice_stream error:", e)
        yield _line({"event": "error", "error": f"Voice processing failed: {e}"})
