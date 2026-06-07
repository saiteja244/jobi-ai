import os
import time
import sys

# Add backend directory to sys.path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from services.stt_service import speech_to_text
from services.gpt_service import iter_voice_reply
from services.tts_service import text_to_speech_base64

audio_file = "uploads/voice_chat_0299c995b0e94b71bee36b6632c4f45e.webm"
if not os.path.exists(audio_file):
    # Try another one if it doesn't exist
    for f in os.listdir("uploads"):
        if f.endswith(".webm"):
            audio_file = os.path.join("uploads", f)
            break

print(f"Testing with audio file: {audio_file}")

# 1. Measure STT Latency
start_time = time.time()
stt_text = speech_to_text(audio_file)
stt_duration = time.time() - start_time
print(f"STT Output: '{stt_text}'")
print(f"STT Duration: {stt_duration:.2f} seconds")

# 2. Measure LLM Stream start and duration
start_time = time.time()
first_token_time = None
tokens = []
try:
    generator = iter_voice_reply(stt_text, [])
    for token in generator:
        if first_token_time is None:
            first_token_time = time.time() - start_time
        tokens.append(token)
except Exception as e:
    print(f"LLM Error: {e}")
llm_duration = time.time() - start_time
full_response = "".join(tokens)
print(f"LLM Full Response: '{full_response}'")
if first_token_time is not None:
    print(f"LLM First Token Latency: {first_token_time:.2f} seconds")
print(f"LLM Total Duration: {llm_duration:.2f} seconds")

# 3. Measure TTS Latency
start_time = time.time()
tts_audio = text_to_speech_base64(full_response)
tts_duration = time.time() - start_time
print(f"TTS Duration (Full Response): {tts_duration:.2f} seconds")

# 4. Measure Sentence-by-Sentence TTS Latency
print("\nSimulating Sentence-by-Sentence TTS:")
text_buffer = ""
start_time = time.time()
is_first = True
for token in tokens:
    text_buffer += token
    # Simulate first chunk (4 words)
    words = text_buffer.split()
    if is_first and len(words) >= 4:
        chunk = " ".join(words[:4])
        text_buffer = " ".join(words[4:])
        is_first = False
        tts_start = time.time()
        audio = text_to_speech_base64(chunk)
        tts_chunk_duration = time.time() - tts_start
        print(f"  First Chunk (4 words) Synthesized in {tts_chunk_duration:.2f}s (Total time from start: {time.time() - start_time:.2f}s)")
