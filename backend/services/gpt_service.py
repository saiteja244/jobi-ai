import os
import re
import time

import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv(override=True)

VOICE_MAX_WORDS = int(os.getenv("VOICE_MAX_WORDS", "75"))

DEFAULT_MODEL = "gemini-flash-lite-latest"


def _configured_model():
    return os.getenv("GEMINI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL


def _fallback_models():
    seen = set()
    models = []
    for name in [
        _configured_model(),
        DEFAULT_MODEL,
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash-lite",
        "gemini-2.0-flash",
    ]:
        if name and name not in seen:
            seen.add(name)
            models.append(name)
    return models

CONCISE_SYSTEM = """You are a career interview coach.
Be short and useful: bullets over paragraphs, no filler, only key points."""

VOICE_SYSTEM = """You are a voice career coach.
Answer ONLY the user's specific question — not a full lesson on the topic.
Use chat history only for pronouns (it/that). Max ~75 words (~30 sec spoken). No markdown."""

MAX_TOKENS = {
    "voice": 512,
    "chat": 512,
    "resume": 512,
    "jd": 768,
    "report": 768,
    "questions": 384,
    "default": 512,
}

def _api_key():
    return os.getenv("GEMINI_API_KEY")


if _api_key():
    genai.configure(api_key=_api_key())

_model_cache = {}
_active_model = DEFAULT_MODEL


def get_active_model():
    return _active_model


def _is_retryable_error(err):
    msg = str(err).lower()
    return (
        "quota" in msg
        or "429" in msg
        or "resource_exhausted" in msg
        or "limit: 0" in msg
        or "404" in msg
        or "not found" in msg
        or "not supported" in msg
    )


def _get_model(model_name, system_instruction):
    key = (model_name, system_instruction)
    if key not in _model_cache:
        _model_cache[key] = genai.GenerativeModel(
            model_name,
            system_instruction=system_instruction,
        )
    return _model_cache[key]


def truncate_words(text, max_words=None):
    if not text:
        return ""
    limit = max_words if max_words is not None else VOICE_MAX_WORDS
    words = text.split()
    if len(words) <= limit:
        return text.strip()
    trimmed = " ".join(words[:limit]).rstrip(".,;:-")
    return trimmed + "…"


def _extract_text(response):
    if not response or not getattr(response, "candidates", None):
        return ""

    candidate = response.candidates[0]
    finish = getattr(candidate, "finish_reason", None)

    if finish and str(finish) not in ("STOP", "1", "FinishReason.STOP"):
        print(f"Gemini finish_reason: {finish}")

    if not candidate.content or not candidate.content.parts:
        return ""

    return "".join(
        part.text for part in candidate.content.parts if hasattr(part, "text") and part.text
    ).strip()


def _generate_once(model, prompt, max_tokens):
    response = model.generate_content(
        prompt,
        generation_config=genai.types.GenerationConfig(
            max_output_tokens=max_tokens,
            temperature=0.35,
        ),
    )
    return _extract_text(response)


def _generate_stream_once(model, prompt, max_tokens):
    """Generate content with streaming for real-time responses."""
    response = model.generate_content(
        prompt,
        generation_config=genai.types.GenerationConfig(
            max_output_tokens=max_tokens,
            temperature=0.35,
        ),
        stream=True,
    )
    return response


def _generate_with_fallback(system_instruction, prompt, max_tokens):
    global _active_model

    if not _api_key():
        raise RuntimeError(
            "GEMINI_API_KEY is missing. Add it to backend/.env "
            "(get a free key at https://aistudio.google.com/apikey)."
        )

    last_error = "No response from AI"
    preferred = _configured_model()

    for model_name in _fallback_models():
        try:
            model = _get_model(model_name, system_instruction)
            text = _generate_once(model, prompt, max_tokens)

            if text:
                _active_model = model_name
                if model_name != preferred:
                    print(f"Using fallback Gemini model: {model_name}")
                return text

            last_error = f"{model_name} returned empty text"
        except Exception as e:
            last_error = str(e)
            print(f"Gemini {model_name} failed:", e)
            if _is_retryable_error(e):
                continue
            break

        time.sleep(0.5)

    raise RuntimeError(
        "All Gemini models failed (quota exhausted or API error). "
        "Set GEMINI_MODEL=gemini-flash-lite-latest in backend/.env, "
        "wait a few minutes, or create a new API key at "
        "https://aistudio.google.com/apikey"
    )


def _generate_stream_with_fallback(system_instruction, prompt, max_tokens):
    """Generate content with streaming and fallback support."""
    global _active_model

    if not _api_key():
        raise RuntimeError(
            "GEMINI_API_KEY is missing. Add it to backend/.env "
            "(get a free key at https://aistudio.google.com/apikey)."
        )

    last_error = "No response from AI"
    preferred = _configured_model()

    for model_name in _fallback_models():
        try:
            model = _get_model(model_name, system_instruction)
            stream = _generate_stream_once(model, prompt, max_tokens)

            if stream:
                _active_model = model_name
                if model_name != preferred:
                    print(f"Using fallback Gemini model: {model_name}")
                return stream

            last_error = f"{model_name} returned empty stream"
        except Exception as e:
            last_error = str(e)
            print(f"Gemini {model_name} streaming failed:", e)
            if _is_retryable_error(e):
                continue
            break

        time.sleep(0.5)

    raise RuntimeError(
        "All Gemini models failed (quota exhausted or API error). "
        "Set GEMINI_MODEL=gemini-flash-lite-latest in backend/.env, "
        "wait a few minutes, or create a new API key at "
        "https://aistudio.google.com/apikey"
    )


def iter_voice_reply(user_message, conversation_history=None):
    """Stream Gemini tokens for voice replies (word-by-word)."""
    user_message = (user_message or "").strip()
    if not user_message:
        return

    history_block = ""
    if conversation_history:
        history_block = (
            "Recent conversation (context only):\n"
            + "\n".join(conversation_history[-8:])
            + "\n\n"
        )

    prompt = f"""{history_block}User message:
\"\"\"{user_message}\"\"\"

Reply only to that message. Under {VOICE_MAX_WORDS} words. Start with the direct answer immediately."""

    stream = _generate_stream_with_fallback(
        VOICE_SYSTEM,
        prompt,
        MAX_TOKENS["voice"],
    )

    for chunk in stream:
        try:
            text = chunk.text
        except (AttributeError, ValueError):
            text = ""
        if text:
            yield text


def ask_voice(user_message, conversation_history=None):
    user_message = (user_message or "").strip()
    if not user_message:
        return None

    history_block = ""
    if conversation_history:
        history_block = (
            "Recent conversation (context only):\n"
            + "\n".join(conversation_history[-8:])
            + "\n\n"
        )

    prompt = f"""{history_block}User message:
\"\"\"{user_message}\"\"\"

Reply only to that message. Under {VOICE_MAX_WORDS} words."""

    return ask_gpt(prompt, mode="voice")


def ask_voice_stream(user_message, conversation_history=None):
    """Stream voice responses for real-time conversation."""
    user_message = (user_message or "").strip()
    if not user_message:
        return None

    history_block = ""
    if conversation_history:
        history_block = (
            "Recent conversation (context only):\n"
            + "\n".join(conversation_history[-8:])
            + "\n\n"
        )

    prompt = f"""{history_block}User message:
\"\"\"{user_message}\"\"\"

Reply only to that message. Under {VOICE_MAX_WORDS} words."""

    max_tokens = MAX_TOKENS.get("voice", MAX_TOKENS["default"])
    system = VOICE_SYSTEM

    stream = _generate_stream_with_fallback(system, prompt, max_tokens)
    return stream


def ask_gpt(prompt, mode="default"):
    max_tokens = MAX_TOKENS.get(mode, MAX_TOKENS["default"])
    system = VOICE_SYSTEM if mode == "voice" else CONCISE_SYSTEM

    if mode == "questions":
        user_prompt = prompt
    elif mode == "voice":
        user_prompt = prompt
    else:
        user_prompt = f"{prompt.strip()}\n\nKeep the answer brief."

    text = _generate_with_fallback(system, user_prompt, max_tokens)

    if mode == "voice":
        return truncate_words(text, VOICE_MAX_WORDS)
    if mode in ("resume", "jd", "report", "chat"):
        return truncate_words(text, 120)
    return text


def check_gemini_health():
    """Quick connectivity check for /health."""
    if not _api_key():
        return {"ok": False, "error": "GEMINI_API_KEY not set"}

    try:
        text = _generate_with_fallback(
            CONCISE_SYSTEM,
            "Reply with exactly: OK",
            16,
        )
        return {"ok": bool(text), "model": get_active_model(), "sample": text[:20]}
    except Exception as e:
        return {"ok": False, "error": str(e), "model": _configured_model()}


def parse_questions_json(raw_text):
    if not raw_text:
        return None

    cleaned = raw_text.replace("```json", "").replace("```", "").strip()

    import json

    try:
        data = json.loads(cleaned)
        if isinstance(data, list):
            return [str(q).strip() for q in data if str(q).strip()]
        if isinstance(data, dict) and isinstance(data.get("questions"), list):
            return [str(q).strip() for q in data["questions"] if str(q).strip()]
    except json.JSONDecodeError:
        pass

    match = re.search(r"\[(?:\s*\"[^\"]+\"\s*,?)+\s*\]", cleaned, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(0))
            if isinstance(data, list):
                return [str(q).strip() for q in data if str(q).strip()]
        except json.JSONDecodeError:
            pass

    lines = [
        re.sub(r"^[\d\.\-\*\)]+\s*", "", line).strip()
        for line in cleaned.split("\n")
        if line.strip() and "?" in line
    ]
    return lines[:5] if lines else None
