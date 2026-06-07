import json
import os
import re

from flask import Blueprint, jsonify, request
from werkzeug.utils import secure_filename

from services.gpt_service import ask_gpt, parse_questions_json
from services.interview_state import interview_state
from services.resume_parser import extract_resume_text

stored_resume = ""

resume_bp = Blueprint("resume_bp", __name__)

UPLOAD_FOLDER = "uploads"

if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)


@resume_bp.route("/upload-resume", methods=["POST"])
def upload_resume():
    global stored_resume

    if "resume" not in request.files:
        return jsonify({"error": "Resume missing"}), 400

    file = request.files["resume"]

    if file.filename == "":
        return jsonify({"error": "No selected file"}), 400

    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF resumes are supported"}), 400

    filename = secure_filename(file.filename)
    path = os.path.join(UPLOAD_FOLDER, filename)
    file.save(path)

    try:
        resume_text = extract_resume_text(path)
    except Exception as e:
        return jsonify({"error": f"Failed to parse resume file: {str(e)}"}), 500

    if not resume_text.strip():
        return jsonify({"error": "Could not extract text from resume. Use a text-based PDF."}), 400

    stored_resume = resume_text
    interview_state["resume_text"] = resume_text

    # Single Gemini call saves API quota vs two separate calls
    combined_prompt = f"""
Resume:
{resume_text}

Return ONLY valid JSON (no markdown):
{{
  "analysis": "4-5 short bullet points: profile, strengths, improvements, roles",
  "questions": ["q1", "q2", "q3", "q4", "q5"]
}}

Questions must be exactly 5 short interview questions.
"""

    try:
        raw = ask_gpt(combined_prompt, mode="resume")
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503

    if raw is None:
        return jsonify({
            "error": "AI service unavailable. Set GEMINI_MODEL=gemini-flash-lite-latest in .env"
        }), 500

    analysis = ""
    parsed_questions = None

    # Try extracting outer braces first (most robust against markdown/prefixes)
    try:
        start_idx = raw.find('{')
        end_idx = raw.rfind('}')
        if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
            json_str = raw[start_idx:end_idx+1]
            data = json.loads(json_str)
            if isinstance(data, dict):
                analysis = str(data.get("analysis", "")).strip()
                if isinstance(data.get("questions"), list):
                    parsed_questions = [
                        str(q).strip() for q in data["questions"] if str(q).strip()
                    ]
    except Exception as e:
        print("Failed parsing outer brace JSON:", e)

    # Fallback to general parsing
    if not parsed_questions:
        cleaned = raw.replace("```json", "").replace("```", "").strip()
        try:
            data = json.loads(cleaned)
            if isinstance(data, dict):
                analysis = str(data.get("analysis", "")).strip()
                if isinstance(data.get("questions"), list):
                    parsed_questions = [
                        str(q).strip() for q in data["questions"] if str(q).strip()
                    ]
        except json.JSONDecodeError:
            match = re.search(r"\{[\s\S]*\}", cleaned)
            if match:
                try:
                    data = json.loads(match.group(0))
                    analysis = str(data.get("analysis", "")).strip()
                    if isinstance(data.get("questions"), list):
                        parsed_questions = [
                            str(q).strip() for q in data["questions"] if str(q).strip()
                        ]
                except json.JSONDecodeError:
                    pass

    if not analysis:
        analysis = cleaned

    if not parsed_questions:
        parsed_questions = parse_questions_json(raw)

    if not parsed_questions:
        return jsonify({
            "error": "AI returned analysis but failed to parse questions. Try again.",
            "details": raw[:500],
        }), 500

    interview_state["questions"] = parsed_questions[:5]
    interview_state["answers"] = []
    interview_state["current_question"] = 0

    return jsonify({
        "analysis": analysis,
        "questions": interview_state["questions"],
    })
