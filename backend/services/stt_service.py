import os

from dotenv import load_dotenv
from sarvamai import SarvamAI

load_dotenv(override=True)

client = SarvamAI(api_subscription_key=os.getenv("SARVAM_API_KEY"))

MIN_AUDIO_BYTES = int(os.getenv("STT_MIN_AUDIO_BYTES", "800"))


def _detect_codec(path):
    ext = os.path.splitext(path)[1].lower()
    codec_map = {
        ".webm": "webm",
        ".wav": "wav",
        ".mp3": "mp3",
        ".ogg": "ogg",
        ".opus": "opus",
        ".m4a": "x-m4a",
        ".mp4": "mp4",
    }
    return codec_map.get(ext)


def _transcribe_once(audio_path, language_code, codec=None):
    with open(audio_path, "rb") as audio_file:
        kwargs = {
            "file": audio_file,
            "model": "saaras:v3",
            "mode": "transcribe",
            "language_code": language_code,
        }
        if codec:
            kwargs["input_audio_codec"] = codec

        response = client.speech_to_text.transcribe(**kwargs)

    transcript = getattr(response, "transcript", "") or ""
    return transcript.strip() if isinstance(transcript, str) else str(transcript).strip()


def speech_to_text(audio_path):
    try:
        if not os.path.isfile(audio_path):
            print("STT ERROR: file not found", audio_path)
            return ""

        size = os.path.getsize(audio_path)
        if size < MIN_AUDIO_BYTES:
            print(f"STT ERROR: audio too small ({size} bytes)")
            return ""

        codec = _detect_codec(audio_path)
        primary_lang = os.getenv("STT_LANGUAGE_CODE", "en-IN")

        attempts = [
            (primary_lang, codec),
            (primary_lang, None),
            ("en-IN", codec),
            ("en-IN", None),
        ]

        seen = set()
        for lang, attempt_codec in attempts:
            key = (lang, attempt_codec)
            if key in seen:
                continue
            seen.add(key)

            try:
                text = _transcribe_once(audio_path, lang, attempt_codec)
                if text:
                    return text
            except Exception as e:
                print(f"STT attempt failed ({lang}, {attempt_codec}):", e)

        return ""

    except Exception as e:
        print("STT ERROR:", e)
        return ""