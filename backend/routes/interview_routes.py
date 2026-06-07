import base64
import os
import uuid

from flask import Blueprint, Response, jsonify, request, stream_with_context

import ast

from routes.resume_routes import stored_resume
from services.gpt_service import ask_gpt, ask_voice
from services.interview_state import interview_state
from services.stt_service import speech_to_text
from services.tts_service import text_to_speech
from services.voice_stream import stream_voice_chat, stream_voice_chat_text

UPLOAD_FOLDER = "uploads"
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

chat_history = []

interview_bp = Blueprint("interview_bp", __name__)


def _save_audio_file(audio_file, prefix="audio"):
    ext = os.path.splitext(audio_file.filename or "")[1] or ".webm"
    path = os.path.join(UPLOAD_FOLDER, f"{prefix}_{uuid.uuid4().hex}{ext}")
    audio_file.save(path)
    return path


def _encode_audio_file(audio_path):
    if not audio_path or not os.path.isfile(audio_path):
        return ""
    with open(audio_path, "rb") as f:
        return base64.b64encode(f.read()).decode()


@interview_bp.route("/compare-jd", methods=["POST"])
def compare_jd():
    data = request.json or {}
    jd = data.get("job_description", "").strip()

    if not jd:
        return jsonify({"error": "Job description is required"}), 400

    if not stored_resume:
        return jsonify({"error": "Upload a resume first"}), 400

    prompt = f"""
Resume:
{stored_resume}

Job Description:
{jd}

Brief JD match (bullets only):
- ATS score /100
- Top 3 matching skills, missing skills, keywords
- Top 2 resume fixes + 2 study priorities
- 3 short interview questions
"""
    result = ask_gpt(prompt, mode="jd")

    if result is None:
        return jsonify({"error": "AI service unavailable. Check GEMINI_API_KEY or quota."}), 500

    return jsonify({"comparison": result})


@interview_bp.route("/generate-questions", methods=["POST"])
def generate_questions():
    data = request.json or {}
    resume = data.get("resume", "").strip()
    jd = data.get("job_description", "").strip()

    if not resume or not jd:
        return jsonify({"error": "Resume and job description are required"}), 400

    prompt = f"""
Resume:
{resume}

Job Description:
{jd}

Generate exactly 5 short interview questions.
Return ONLY a Python list of 5 strings.
"""

    result = ask_gpt(prompt, mode="questions")

    if result is None:
        return jsonify({"error": "AI service unavailable. Check GEMINI_API_KEY or quota."}), 500

    try:
        questions = ast.literal_eval(result)
        if not isinstance(questions, list):
            raise ValueError("Not a list")
    except (ValueError, SyntaxError):
        questions = [q.strip() for q in result.split("\n") if q.strip()]

    interview_state["questions"] = questions
    interview_state["answers"] = []
    interview_state["current_question"] = 0

    return jsonify({"questions": questions})


@interview_bp.route("/start-interview", methods=["GET"])
def start_interview():
    if len(interview_state["questions"]) == 0:
        return jsonify({"error": "No questions generated. Upload a resume or generate questions first."}), 400

    interview_state["answers"] = []
    interview_state["current_question"] = 0

    first_question = interview_state["questions"][0]
    audio_file = text_to_speech(first_question, for_voice_reply=False)

    return jsonify({
        "question": first_question,
        "audio": _encode_audio_file(audio_file),
    })


@interview_bp.route("/chat", methods=["POST"])
def chat():
    audio = request.files.get("audio")
    if not audio:
        return jsonify({"error": "No audio file provided"}), 400

    path = _save_audio_file(audio, "chat")
    user_text = speech_to_text(path)

    if not user_text:
        return jsonify({"error": "Could not understand audio. Speak louder or longer."}), 400

    chat_history.append(f"User: {user_text}")

    try:
        ai_response = ask_voice(user_text, chat_history[:-1])
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503

    if not ai_response:
        return jsonify({"error": "AI service unavailable."}), 503

    chat_history.append(f"Assistant: {ai_response}")

    audio_file = text_to_speech(ai_response, for_voice_reply=True)

    return jsonify({
        "user_text": user_text,
        "ai_response": ai_response,
        "ai_text": ai_response,
        "audio": _encode_audio_file(audio_file),
    })


@interview_bp.route("/clear-chat", methods=["POST"])
def clear_chat():
    chat_history.clear()
    return jsonify({"message": "Chat cleared"})


@interview_bp.route("/submit-answer", methods=["POST"])
def submit_answer():
    data = request.json or {}
    answer = (data.get("answer") or "").strip()

    if not answer:
        return jsonify({"error": "Answer is required"}), 400

    if not interview_state["questions"]:
        return jsonify({"error": "No active interview"}), 400

    idx = interview_state["current_question"]

    if idx >= len(interview_state["questions"]):
        return jsonify({"error": "Interview already completed"}), 400

    interview_state["answers"].append({
        "question": interview_state["questions"][idx],
        "answer": answer,
    })

    interview_state["current_question"] += 1

    if interview_state["current_question"] >= len(interview_state["questions"]):
        return jsonify({"completed": True})

    return jsonify({
        "completed": False,
        "question": interview_state["questions"][interview_state["current_question"]],
    })


@interview_bp.route("/voice-interview", methods=["POST"])
def voice_interview():
    audio = request.files.get("audio")
    if not audio:
        return jsonify({"error": "No audio file provided"}), 400

    if not interview_state["questions"]:
        return jsonify({"error": "No interview questions available"}), 400

    path = _save_audio_file(audio, "interview")
    transcript = speech_to_text(path)

    if not transcript:
        return jsonify({"error": "Could not understand audio. Speak louder or longer."}), 400

    idx = interview_state["current_question"]

    if idx >= len(interview_state["questions"]):
        return jsonify({"error": "Interview already completed"}), 400

    interview_state["answers"].append({
        "question": interview_state["questions"][idx],
        "answer": transcript,
    })

    interview_state["current_question"] += 1

    if interview_state["current_question"] >= len(interview_state["questions"]):
        return jsonify({
            "completed": True,
            "transcript": transcript,
        })

    next_question = interview_state["questions"][interview_state["current_question"]]
    audio_file = text_to_speech(next_question, for_voice_reply=False)

    return jsonify({
        "completed": False,
        "transcript": transcript,
        "question": next_question,
        "audio": _encode_audio_file(audio_file),
    })


@interview_bp.route("/final-feedback", methods=["GET", "POST"])
def final_feedback():
    qa_items = []

    if request.method == "POST":
        data = request.json or {}
        questions = data.get("questions") or []
        answers = data.get("answers") or []

        if len(questions) != len(answers):
            return jsonify({"error": "Questions and answers count must match"}), 400

        qa_items = [
            {"question": q, "answer": a}
            for q, a in zip(questions, answers)
        ]
    else:
        qa_items = interview_state["answers"]

    if not qa_items:
        return jsonify({"error": "No interview answers to evaluate"}), 400

    qa_text = ""
    for item in qa_items:
        qa_text += f"Q: {item['question']}\nA: {item['answer']}\n\n"

    prompt = f"""
Interview:
{qa_text}

Short scorecard: overall /100, technical /10, communication /10,
2 strengths, 2 weaknesses, hire verdict (Yes/Maybe/No).
"""

    report = ask_gpt(prompt, mode="report")

    if report is None:
        return jsonify({"error": "AI service unavailable. Check GEMINI_API_KEY or quota."}), 500

    return jsonify({"report": report})


@interview_bp.route("/voice-text-stream", methods=["POST"])
def voice_text_stream():
    """Fast path: client STT + client TTS; stream Gemini text only."""
    data = request.get_json(silent=True) or {}
    user_text = (data.get("text") or "").strip()
    if not user_text:
        return jsonify({"error": "No text provided"}), 400

    return Response(
        stream_with_context(stream_voice_chat_text(user_text, chat_history)),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@interview_bp.route("/voice-chat-stream", methods=["POST"])
def voice_chat_stream():
    """Stream AI text + early TTS audio for low-latency voice replies."""
    audio = request.files.get("audio")
    if not audio or not audio.filename:
        return jsonify({"error": "No audio file provided"}), 400

    path = _save_audio_file(audio, "voice_chat")
    file_size = os.path.getsize(path) if os.path.isfile(path) else 0

    if file_size < 800:
        return jsonify({"error": "Recording too short. Please speak a bit longer."}), 400

    return Response(
        stream_with_context(stream_voice_chat(path, chat_history)),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@interview_bp.route("/voice-chat", methods=["POST"])
def voice_chat():
    try:
        audio = request.files.get("audio")
        if not audio or not audio.filename:
            return jsonify({"error": "No audio file provided"}), 400

        path = _save_audio_file(audio, "voice_chat")
        file_size = os.path.getsize(path) if os.path.isfile(path) else 0

        if file_size < 800:
            return jsonify({"error": "Recording too short. Please speak a bit longer."}), 400

        user_text = speech_to_text(path)

        if not user_text:
            return jsonify({
                "error": "Could not understand audio. Speak clearly for 2+ seconds."
            }), 400

        chat_history.append(f"User: {user_text}")

        try:
            ai_text = ask_voice(user_text, chat_history[:-1])
        except RuntimeError as e:
            chat_history.pop()
            return jsonify({"error": str(e)}), 503

        if not ai_text:
            chat_history.pop()
            return jsonify({
                "error": "AI could not generate a reply. Set GEMINI_MODEL=gemini-flash-lite-latest in .env"
            }), 503

        chat_history.append(f"Assistant: {ai_text}")

        audio_file = text_to_speech(ai_text, for_voice_reply=True)

        return jsonify({
            "user_text": user_text,
            "ai_text": ai_text,
            "ai_response": ai_text,
            "audio": _encode_audio_file(audio_file),
        })

    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        print("voice_chat error:", e)
        return jsonify({"error": f"Voice processing failed: {e}"}), 500
