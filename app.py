# Import Library 

import os
import io
import time
from base64 import b64decode
import requests
import json
from google.cloud import speech
from google import genai
from google.genai import types
import base64
import re
import logging
from logging.handlers import RotatingFileHandler
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv

load_dotenv()

# --- Configuration ---
PROJECT_ID = os.getenv('PROJECT_ID')
LOCATION = "us-central1"
GEMINI_MODEL_NAME  = "gemini-2.0-flash-001"
DATASTORE_ID = os.getenv('DATASTORE_ID')
DATASTORE_PATH = f"projects/{PROJECT_ID}/locations/global/collections/default_collection/dataStores/{DATASTORE_ID}"

D_ID_API_KEY = os.getenv('D_ID_API_KEY') # Replace with your D-ID API Key
D_ID_BASE_URL = "https://api.d-id.com"
AVATAR_IMAGE_URL = "https://d-id-public-bucket.s3.us-west-2.amazonaws.com/alice.jpg" # Replace with your desired avatar image URL

# --- Logging Setup ---
# Create a logs directory if it doesn't exist
log_dir = 'app_logs'
if not os.path.exists(log_dir):
    os.makedirs(log_dir)

log_file_path = os.path.join(log_dir, 'application.log')

# Configure basicConfig to set the root logger's level and console output
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(levelname)s %(name)s %(threadName)s : %(message)s',
                    handlers=[logging.StreamHandler()])

# Get the root logger or a specific logger
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Create a file handler for writing to a log file
file_handler = RotatingFileHandler(
    log_file_path,
    maxBytes=10*1024*1024,  # 10 MB
    backupCount=5
)
file_handler.setLevel(logging.INFO) # Set the level for this handler
file_formatter = logging.Formatter('%(asctime)s %(levelname)s %(name)s : %(message)s [in %(pathname)s:%(lineno)d]')
file_handler.setFormatter(file_formatter)

# Add the file handler to the logger
logger.addHandler(file_handler)

logger.info("Logging configured to save to file and console.")

# --- Initialize Flask App ---
app = Flask(__name__)

# --- Google Cloud Clients ---
speech_client = None
try:
    speech_client = speech.SpeechClient()
    genai_client = genai.Client(
        vertexai=True,
        project=PROJECT_ID,
        location=LOCATION,
    )
    logger.info("Google Cloud clients initialized successfully.")
except Exception as e:
    logger.error(f"Error initializing Google Cloud clients: {e}")
    speech_client = None
    genai_client = None

# --- D-ID Configuration ---
D_ID_HEADERS = {
    "Authorization": f"Basic {D_ID_API_KEY}",
    "Content-Type": "application/json"
}

# --- System Instruction for Gemini ---
SYSTEM_INSTRUCTION_TEXT = (
    """Anda adalah AI asisten yang bertugas menjawab pertanyaan hanya berdasarkan konten dari dokumen yang diunggah (jika ada).
    Gunakan hanya informasi yang terdapat di dalam dokumen ini jika sumbernya adalah dokumen.
    Jika pertanyaan bersifat umum dan tidak merujuk ke dokumen, Anda boleh menggunakan pengetahuan umum Anda.
    Jangan menambahkan informasi dari luar yang tidak relevan, atau asumsi pribadi yang tidak didukung.
    Berikan jawaban yang akurat dan sedetail mungkin.
    Selalu berikan respons dalam Bahasa Indonesia yang baik, jelas, dan mudah dipahami."""
)

# --- Helper Functions (Adapted from your script) ---
def transcribe_google_stt(speech_file_path):
    if not speech_client:
        logger.error("Speech client not initialized.")
        return None
    try:
        with io.open(speech_file_path, "rb") as audio_file:
            content = audio_file.read()
    except FileNotFoundError:
        logger.error(f"Error: Audio file not found at {speech_file_path}")
        return None
    except Exception as e:
        logger.error(f"Error loading audio file: {e}")
        return None

    audio = speech.RecognitionAudio(content=content)
    config = speech.RecognitionConfig(
        language_code="id-ID",
        enable_automatic_punctuation=True,
    )

    logger.info("Sending audio to Google Cloud Speech-to-Text...")
    try:
        response = speech_client.recognize(config=config, audio=audio)
    except Exception as e:
        logger.error(f"Error calling Speech-to-Text API: {e}")
        return None

    if not response.results:
        logger.warning("No transcription results found from Google STT.")
        return None

    transcription = "".join(result.alternatives[0].transcript + " " for result in response.results)
    logger.info(f"Transcription finished: {transcription.strip()}")
    return transcription.strip()

def get_gemini_response(text_input: str) -> str:
    if not genai_client:
        logger.error("Gemini client not initialized.")
        return "Error: Gemini client not initialized."

    try:
        logger.info(f"Sending to Gemini: '{text_input}'")
        response = genai_client.models.generate_content(
        model=GEMINI_MODEL_NAME,
        contents=text_input,
        config=types.GenerateContentConfig(
            tools=[
                # Use Vertex AI Search Tool
                types.Tool(
                    retrieval=types.Retrieval(
                        vertex_ai_search=types.VertexAISearch(
                            datastore="projects/eikon-dev-ai-team/locations/global/collections/default_collection/dataStores/test-datastore_1744718302529",
                        )
                    )
                )
            ],
            system_instruction=[types.Part.from_text(text=SYSTEM_INSTRUCTION_TEXT)]),

    )
        # logger.info(f"Gemini Raw Response: {response}")
        if response.candidates and response.candidates[0].content and response.candidates[0].content.parts:
            # Handle potential grounding metadata if using Vertex AI Search
            full_text = ""
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'text'):
                    full_text += part.text
                elif hasattr(part, 'retrieval'): # Or check specific grounding part type
                    logger.info(f"Grounding metadata found: {part}") # Log or process grounding
            logger.info(f"Gemini response: {full_text}")
            return full_text
        else:
            logger.error(f"Gemini response structure unexpected or empty: {response}")
            return "Maaf, saya tidak dapat menghasilkan respons saat ini."


    except Exception as e:
        logger.error(f"Error getting response from Gemini: {e}")
        return f"Maaf, terjadi kesalahan saat memproses permintaan Anda ke Gemini: {e}"


# --- Flask Routes ---
# @app.route('/')
# def index():
#     return render_template('index.html', avatar_url=AVATAR_IMAGE_URL)

@app.route('/')
def index():
    return render_template('index.html')

# THIS ROUTE IS NOW ONLY FOR INITIAL CONNECTION AND STREAM SETUP
@app.route('/initiate_did_stream', methods=['POST'])
def initiate_did_stream_route():
    if not D_ID_API_KEY or "your-did-api-key" in D_ID_API_KEY :
        logger.error("D-ID API Key not configured.")
        return jsonify({"error": "D-ID API Key not configured."}), 500

    user_text = "" # For initial greeting, or a system marker
    if 'text_input' in request.form: # Client sends a marker like "SYSTEM_CONNECT_REQUEST"
        user_text = request.form['text_input']
    
    if not user_text: # Fallback if no text_input from client for some reason
        user_text = "SYSTEM_CONNECT_REQUEST"


    # Get an initial greeting from Gemini
    if user_text == "SYSTEM_CONNECT_REQUEST":
        # You can have a predefined greeting or still ask Gemini
        agent_greeting_text = get_gemini_response("Berikan sapaan singkat untuk memulai percakapan.")
        if "Error:" in agent_greeting_text or "Maaf," in agent_greeting_text:
            agent_greeting_text = "Halo! Koneksi sedang disiapkan. Ada yang bisa saya bantu?"
    else: # Should not happen if client sends specific marker
        agent_greeting_text = "Selamat datang!"


    stream_payload = {"source_url": AVATAR_IMAGE_URL}
    try:
        logger.info("Attempting to create D-ID stream session for initial connection...")
        create_stream_response = requests.post(
            f"{D_ID_BASE_URL}/talks/streams",
            headers=D_ID_HEADERS,
            json=stream_payload
        )
        create_stream_response.raise_for_status()
        stream_data = create_stream_response.json()

        stream_id_for_path = stream_data.get("id")
        session_id_for_body = stream_data.get("session_id") # This is the D-ID session_id (cookie like)

        logger.info(f"D-ID stream created: stream_id_for_path='{stream_id_for_path}', session_id_for_body='{session_id_for_body}'")

        if not stream_id_for_path or not session_id_for_body:
            logger.error(f"D-ID stream creation response missing 'id' and/or 'session_id' fields. Response: {stream_data}")
            return jsonify({"error": "D-ID stream creation response incomplete."}), 500

        return jsonify({
            "stream_id_for_path": stream_id_for_path,
            "session_id_for_body": session_id_for_body,
            "offer_sdp": stream_data.get("offer"),
            "ice_servers": stream_data.get("ice_servers"),
            "agent_initial_greeting": agent_greeting_text, # Send greeting back
        })
    except requests.exceptions.RequestException as e:
        logger.error(f"Error creating D-ID stream: {e}")
        if e.response is not None:
            logger.error(f"D-ID Response Status: {e.response.status_code}, Body: {e.response.text}")
        return jsonify({"error": f"Failed to create D-ID stream: {str(e)}"}), 500

# NEW ROUTE: Get agent response without D-ID interaction
@app.route('/get_agent_response', methods=['POST'])
def get_agent_response_route():
    user_text = ""
    processed_user_text_for_chat = ""

    if 'audio_data' in request.files:
        audio_file = request.files['audio_data']
        uploads_dir = "uploads"
        if not os.path.exists(uploads_dir):
            os.makedirs(uploads_dir)
        temp_audio_path = os.path.join(uploads_dir, f"recorded_audio_{time.time()}.wav")
        audio_file.save(temp_audio_path)
        user_text = transcribe_google_stt(temp_audio_path)
        processed_user_text_for_chat = user_text # Store transcription for chat
        if os.path.exists(temp_audio_path): os.remove(temp_audio_path)
        if not user_text: return jsonify({"error": "Could not transcribe audio."}), 400
    elif 'text_input' in request.form:
        user_text = request.form['text_input']
        processed_user_text_for_chat = user_text # Store text input for chat
    else:
        return jsonify({"error": "No input provided"}), 400

    if not user_text: return jsonify({"error":"Input text is empty"}),400

    agent_response_text = get_gemini_response(user_text)
    if "Error:" in agent_response_text or "Maaf," in agent_response_text :
         return jsonify({"error": agent_response_text, "user_text_processed": processed_user_text_for_chat}), 500

    return jsonify({
        "agent_response_text": agent_response_text,
        "user_text_processed": processed_user_text_for_chat # Send back the processed user text
    })


@app.route('/submit_sdp_answer', methods=['POST'])
def submit_sdp_answer_route():
    data = request.json
    stream_id_for_path_from_client = data.get('stream_id_for_path')
    session_id_for_body_from_client = data.get('session_id_for_body')
    sdp_answer_obj = data.get('sdp_answer')

    if not stream_id_for_path_from_client:
        return jsonify({"error": "Client did not send stream_id_for_path"}), 400
    if not session_id_for_body_from_client: # This is the D-ID session ID from stream creation
        return jsonify({"error": "Client did not send session_id_for_body"}), 400

    stream_id_for_path = stream_id_for_path_from_client.strip()

    if not stream_id_for_path or not sdp_answer_obj:
        return jsonify({"error": "Missing stream_id or sdp_answer after processing"}), 400

    sdp_payload_to_did = {
        "session_id": session_id_for_body_from_client, # D-ID specific session_id
        "answer": sdp_answer_obj
    }
    target_url = f"{D_ID_BASE_URL}/talks/streams/{stream_id_for_path}/sdp"
    logger.info(f"SDP Submission: POST to D-ID URL: {target_url} with payload: {json.dumps(sdp_payload_to_did)}")

    try:
        response = requests.post(target_url, headers=D_ID_HEADERS, json=sdp_payload_to_did)
        response.raise_for_status()
        logger.info(f"SDP answer submitted successfully to D-ID. Response: {response.json()}")
        return jsonify({"status": "sdp_answer_submitted", "d_id_response": response.json()})
    except requests.exceptions.RequestException as e:
        logger.error(f"Error submitting SDP answer to D-ID URL '{target_url}': {e}")
        if e.response is not None:
            logger.error(f"D-ID Response (SDP Answer) Status: {e.response.status_code}, Body: {e.response.text}")
        return jsonify({"error": f"Failed to submit SDP answer to D-ID: {str(e)}"}), 500

# THIS ROUTE IS FOR MAKING AN *EXISTING* STREAM TALK
@app.route('/start_talk_stream', methods=['POST'])
def start_talk_stream_route():
    data = request.json
    stream_id_for_path_from_client = data.get('stream_id_for_path')
    session_id_for_body_from_client = data.get('session_id_for_body') # D-ID specific session_id
    text_to_speak = data.get('text_to_speak')

    if not stream_id_for_path_from_client:
        return jsonify({"error": "Client did not send stream_id_for_path"}), 400
    if not session_id_for_body_from_client:
        return jsonify({"error": "Client did not send session_id_for_body"}), 400

    stream_id_for_path = stream_id_for_path_from_client.strip()

    if not stream_id_for_path or not text_to_speak:
        return jsonify({"error": "Missing stream_id or text_to_speak after processing"}), 400

    script_details = {
        "type": "text", "input": text_to_speak,
        "provider": {"type": "microsoft", "voice_id": "id-ID-GadisNeural"}
    }
    talk_payload_to_did = {
        "session_id": session_id_for_body_from_client, # D-ID specific session_id
        "script": script_details,
        "config": {"stitch": True}
    }
    target_url = f"{D_ID_BASE_URL}/talks/streams/{stream_id_for_path}"
    logger.info(f"Start Talk: POST to D-ID URL: {target_url} with payload: {json.dumps(talk_payload_to_did)}")

    try:
        response = requests.post(target_url, headers=D_ID_HEADERS, json=talk_payload_to_did)
        response.raise_for_status()
        logger.info(f"Talk stream started successfully with D-ID. Response: {response.json()}")
        return jsonify({"status": "talk_stream_started", "d_id_response": response.json()})
    except requests.exceptions.RequestException as e:
        logger.error(f"Error starting D-ID talk stream to URL '{target_url}': {e}")
        if e.response is not None:
            logger.error(f"D-ID Response (Start Talk) Status: {e.response.status_code}, Body: {e.response.text}")
        return jsonify({"error": f"Failed to start D-ID talk stream: {str(e)}"}), 500

@app.route('/destroy_did_session', methods=['POST'])
def destroy_did_session_route():
    data = request.json
    stream_id_for_path = data.get('stream_id_for_path')
    session_id_for_body = data.get('session_id_for_body')

    if not stream_id_for_path:
        return jsonify({"error": "stream_id_for_path is required"}), 400
    if not session_id_for_body:
        return jsonify({"error": "session_id_for_body is required for DELETE operation"}), 400

    target_url = f"{D_ID_BASE_URL}/talks/streams/{stream_id_for_path.strip()}"
    delete_payload = {"session_id": session_id_for_body}

    logger.info(f"Attempting to destroy D-ID stream: DELETE to {target_url} with body {json.dumps(delete_payload)}")
    try:
        response = requests.delete(target_url, headers=D_ID_HEADERS, json=delete_payload)
        response.raise_for_status()
        logger.info(f"D-ID stream {stream_id_for_path} destroyed successfully. Status: {response.status_code}")
        return jsonify({"status": "session_destroyed", "d_id_response": response.text or "OK"}), 200
    except requests.exceptions.RequestException as e:
        logger.error(f"Error destroying D-ID stream {stream_id_for_path}: {e}")
        if e.response is not None:
            logger.error(f"D-ID Response (Destroy Stream) Status: {e.response.status_code}, Body: {e.response.text}")
        return jsonify({"error": f"Failed to destroy D-ID stream: {str(e)}"}), 500
    except Exception as e:
        logger.error(f"Unexpected error destroying D-ID stream {stream_id_for_path}: {e}")
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500

if __name__ == '__main__':
    if not all([PROJECT_ID, D_ID_API_KEY, LOCATION]):
        logger.warning("One or more critical environment variables (PROJECT_ID, D_ID_API_KEY, LOCATION) might be missing.")
    
    if DATASTORE_ID and DATASTORE_PATH:
        logger.info(f"DATASTORE_PATH is configured: {DATASTORE_PATH}")
    else:
        logger.info("DATASTORE_ID not provided or invalid. Vertex AI Search will not be used.")
        if not DATASTORE_ID : logger.info("Reason: DATASTORE_ID not in .env")
        elif not PROJECT_ID: logger.info("Reason: PROJECT_ID not in .env (needed for DATASTORE_PATH)")


    # Create 'uploads' directory if it doesn't exist
    if not os.path.exists("uploads"):
        os.makedirs("uploads")
        logger.info("Created 'uploads' directory.")

    app.run(debug=True, host='0.0.0.0', port=5001)