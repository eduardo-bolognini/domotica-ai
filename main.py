import json
import os
import threading
import requests
import base64
import numpy as np
import pandas as pd
from collections import deque
from utils import contolla_casa, get_local_ip
from controllo_dispositivi import Casa, tipi_dispositivi, Stanza, Dispositivo
from openaiapi import OPENAI, config_base_assistants
from datetime import datetime
import platform
from PIL import Image
from transformers import BlipProcessor, BlipForConditionalGeneration
from torch.quantization import quantize_dynamic
import torch
import io
import time
from ultralytics import YOLO as YOLO_ultralytics


from flask import Flask, request, jsonify, Response

from flask_jwt_extended import (
    JWTManager, create_access_token,
    jwt_required, get_jwt_identity, get_jwt, exceptions as decode_token, verify_jwt_in_request, 
)

from werkzeug.security import generate_password_hash, check_password_hash
from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO, emit, join_room
from sqlalchemy import event
from flask_cors import CORS

from model import load_model, predict as model_predict


#LOGGING DA AGGIUNGERE
"""logging.basicConfig(level=logging.DEBUG)
logging.basicConfig(filename="logs.log", level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
"""

def config_openai(casa, API_KEY):
    system_istruction, tools, response_format = config_base_assistants(casa)
    openai = OPENAI(API_KEY, system_instructions=system_istruction, tools=tools, response_format=response_format)
    return openai


with open("config files/config.json", "r") as config_file:
    config_dict = json.load(config_file)

def _override_config(path, env_name, cast=None):
    value = os.getenv(env_name)
    if value is None or value == "":
        return
    target = config_dict
    for key in path[:-1]:
        target = target.setdefault(key, {})
        if not isinstance(target, dict):
            return
    try:
        target[path[-1]] = cast(value) if cast else value
    except (ValueError, TypeError):
        print(f"Valore non valido per {env_name}: {value}")

_override_config(("SERVER_PHOTO", "url"), "SERVER_PHOTO_URL")
_override_config(("SERVER_PHOTO", "port"), "SERVER_PHOTO_PORT", int)
_override_config(("models apy key / ids", "openai"), "OPENAI_API_KEY")
_override_config(("models apy key / ids", "assistant_id"), "ASSISTANT_ID")
_override_config(("models apy key / ids", "repo_id_dayvision"), "MODEL_REPO_DAY")
_override_config(("models apy key / ids", "repo_id_nightvision"), "MODEL_REPO_NIGHT")
_override_config(("models apy key / ids", "yolo_version"), "YOLO_VERSION_FILE")
_override_config(("models apy key / ids", "K_vision"), "K_VISION", float)
_override_config(("models apy key / ids", "model_bundle_path"), "MODEL_BUNDLE_PATH")

SERVER_PHOTO = config_dict["SERVER_PHOTO"]["url"] # url for online cameras
PORT_PHOTO = int(config_dict["SERVER_PHOTO"]["port"]) # port for online cameras

CSV_PATH = config_dict["MAIN save data paths"]["csv"] # path where save validation metadata
VAL_PHOTO_SAVE_PATH = config_dict["MAIN save data paths"]["save_path"] # path where save validation photos
CSV_STRUCTURE = ["indirizzi delle foto", "risposta grezza", "json", "data e ora", "conversation", "validazione", "commenti"] # const

CASA_CONFIG_PATH = config_dict["MAIN save data paths"]["casa"] # path where home configuration is saved

models_cfg = config_dict.get("models apy key / ids", {})

API_KEY_OPENAI = os.getenv("OPENAI_API_KEY") or models_cfg.get("openai", "")

REPO_ID_DAY = models_cfg.get("repo_id_dayvision")
REPO_ID_NIGHT = models_cfg.get("repo_id_nightvision")
K_vision = float(models_cfg.get("K_vision", 0.3))
YOLO_VERSION = models_cfg.get("yolo_version")

if not REPO_ID_DAY or not REPO_ID_NIGHT:
    raise ValueError("Repository dei modelli BLIP non configurati")

if not YOLO_VERSION:
    raise ValueError("Versione del modello YOLO non configurata")

global df
if not os.path.exists(CSV_PATH):
    df = pd.DataFrame(columns=CSV_STRUCTURE)
else:
    df = pd.read_csv(CSV_PATH, index_col=0)

if not os.path.exists(VAL_PHOTO_SAVE_PATH):
    os.makedirs(VAL_PHOTO_SAVE_PATH)  

PASSIVE_MODEL_BUNDLE_PATH = os.getenv("MODEL_BUNDLE_PATH") or models_cfg.get("model_bundle_path")
PASSIVE_AUTOMATION_DIR = os.path.join(VAL_PHOTO_SAVE_PATH, "passive_automation")

PASSIVE_MODEL = None
PASSIVE_MODEL_NUM_IMAGES = 0
PASSIVE_MODEL_NUM_PREV = 0

try:
    PASSIVE_MODEL = load_model(bundle_path=PASSIVE_MODEL_BUNDLE_PATH)
    PASSIVE_MODEL_NUM_IMAGES = getattr(PASSIVE_MODEL, "num_input_images", 0)
    PASSIVE_MODEL_NUM_PREV = getattr(PASSIVE_MODEL, "num_prev_actions", 0)
except Exception as exc:
    print(f"Impossibile caricare il modello per l'automazione passiva: {exc}")

os.makedirs(PASSIVE_AUTOMATION_DIR, exist_ok=True)

PASSIVE_AUTOMATION_IMAGE_HISTORY = deque(maxlen=PASSIVE_MODEL_NUM_IMAGES or 3)
PASSIVE_AUTOMATION_PREV_ACTIONS = deque(maxlen=PASSIVE_MODEL_NUM_PREV or 8)

global casa

# element CASA to control devices
if os.path.exists(CASA_CONFIG_PATH):  
    casa = Casa(load_path=CASA_CONFIG_PATH)
else:
    casa = Casa(stanze=[])




global openai

openai = config_openai(casa, API_KEY_OPENAI)


assistant_id = config_dict["models apy key / ids"]["assistant_id"]
assistant_configuration = OPENAI(client=openai.client, assintant_id=assistant_id)

model_day_ = BlipForConditionalGeneration.from_pretrained(REPO_ID_DAY).to("cpu")
PROCESSOR_DAY = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")

if config_dict["models apy key / ids"]["use_quantization_day"]:
    # torch.backends.quantized.engine = "fbgemm" if "fbgemm" in torch.backends.quantized.engine else "qnnpack"
    MODEL_DAY = quantize_dynamic(model_day_, {torch.nn.Linear}, dtype=torch.qint8)
else:
    MODEL_DAY = model_day_
    
MODEL_NIGHT = BlipForConditionalGeneration.from_pretrained(REPO_ID_NIGHT).to("cpu")
PROCESSOR_NIGHT = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-large")

YOLO = YOLO_ultralytics(f"config files/{YOLO_VERSION}")


APP = Flask(__name__)
CORS(APP, resources={r"/api/*": {"origins": "*"}})


APP.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///data.db'

APP.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(APP)

class UserData(db.Model):
    tablename = 'user_data'
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password = db.Column(db.String(200), nullable=False)

class Chats(db.Model):
    tablename = 'chats'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user_data.id'), nullable=False)
    token = db.Column(db.String(255), unique=True, nullable=False)
    user = db.relationship('UserData', backref=db.backref('chats', lazy=True))

class Messages(db.Model):
    tablename = 'messages'
    id = db.Column(db.Integer, primary_key=True)
    chat_id = db.Column(db.Integer, db.ForeignKey('chats.id'), nullable=False)
    photo_id = db.Column(db.String(20))
    sender = db.Column(db.String(20), nullable=False)  # 'user' o 'bot'
    content = db.Column(db.JSON)
    loading = db.Column(db.Boolean, default=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    reply_to_id = db.Column(db.Integer, db.ForeignKey('messages.id'), nullable=True)
    reply_to = db.relationship('Messages', remote_side=[id], backref='replies')

    chat = db.relationship('Chats', backref=db.backref('messages', lazy=True))

    def to_dict(self):
        return {
            "id": self.id,
            "chat_id": self.chat_id,
            "photo_id": self.photo_id,
            "sender": self.sender,
            "content": self.content,
            "loading": self.loading,
            "timestamp": self.timestamp.isoformat(),
            "reply_to_id": self.reply_to_id,
        }


with APP.app_context():
    db.create_all()

# defining global variabiles
global main_completed, validation_data, completed, photos_cache, peoples_cache, ora_ultima_attivazione

main_completed = False
completed = False
validation_data = {}
photos_cache = [np.zeros((512, 512, 3), dtype=np.uint8)]
peoples_cache = True
ora_ultima_attivazione = datetime.now()


EVENTO = threading.Event() # to connect the main threading to the activation threading

def take_photo(): # function to get last taked image with server photo
    response = requests.get(f"http://{SERVER_PHOTO}:{PORT_PHOTO}/get-photo")

    if response.status_code == 200:
        data = response.json()
        image_id = data["id"]
        image_base64 = data["image"]

        try:
            image_bytes = base64.b64decode(image_base64)
        except:
            image_bytes = image_base64.encode("latin1")

        # PER USARE CV2: 
        # image_array = np.frombuffer(image_bytes, np.uint8)
        # img = cv2.imdecode(image_array, cv2.IMREAD_COLOR)

        # PER USARE PILLOW
        image_stream = io.BytesIO(image_bytes)
        img = Image.open(image_stream)

        if img is None:
            raise ValueError(f"Impossibile decodificare l'immagine dalla camera online")


        return {"id": image_id, "image": img}
    else:
        raise ValueError(f"Errore con la camera online: {response.status_code} - {response.text}")

def is_gray_scale(image: Image) -> bool:
    img = image.convert('RGB')
    img_array = np.array(img)
    r, g, b = img_array[:,:,0], img_array[:,:,1], img_array[:,:,2]
    return np.all(r == g) and np.all(g == b)
    


def return_cropped(image, threshold=0.5):
    results = YOLO(image)

    crops = []
    w, h = image.size

    for det in results:
        for box in det.boxes:
            if int(box.cls) == 0 and box.conf[0] >= threshold:
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())

                x1 = max(0, int(x1 - x1 * K_vision))
                y1 = max(0, int(y1 - y1 * K_vision))
                x2 = min(w, int(x2 + x2 * K_vision))
                y2 = min(h, int(y2 + y2 * K_vision))

                if (x2 - x1) > 0 and (y2 - y1) > 0:
                    cropped = image.crop((x1, y1, x2, y2))
                    crops.append(cropped)

    return crops if crops else [None, image]

def generate(image: Image, salta=False):
    if 'model' in locals() | globals():
        del model

    if is_gray_scale(image):
        model = MODEL_DAY
        processor = PROCESSOR_DAY
    else:
        model = MODEL_DAY
        processor = PROCESSOR_DAY

    crops = return_cropped(image)
    if salta and crops[0] is None:
        return None

    if crops[0] is None: crops = [image]

    captions = []
    for crop in crops:
        crop = crop.convert("RGB")
        inputs = processor(images=crop, return_tensors="pt")
        pixel_values = inputs.pixel_values

        generated_ids = model.generate(pixel_values=pixel_values, max_length=50)
        caption = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        captions.append(caption)

    return captions

    
def say(text):
    system = platform.system()

    print("SYSTEM: system")

    if system == "Darwin":
        os.system(f"say '{text}'")
    elif system == "Linux":
        os.system(f"espeak '{text}'")
    else:
        print(f"Say non supportato nel tuo sistema operativo ({system})")




def activation(specific_prompt, photo = None, chat_id = None):
    pass

passive_automation_actions = {
    "turn_on": lambda x: casa[x[0]][x[1]].turn_on(),
    "turn_off": lambda x: casa[x[0]][x[1]].turn_off(),
    "turn_off_all": lambda x: casa[x[0]].turn_off_all(),
}


def passive_automation():
    required_images = PASSIVE_AUTOMATION_IMAGE_HISTORY.maxlen or PASSIVE_MODEL_NUM_IMAGES or 3

    while True:
        if PASSIVE_MODEL is None:
            print("Automazione passiva: modello non disponibile, riprovo tra poco")
            time.sleep(60 * 5)
            continue

        try:
            photo_data = take_photo()
            raw_image = photo_data["image"]
        except Exception as exc:
            print(f"Automazione passiva: errore durante l'acquisizione della foto: {exc}")
            time.sleep(60 * 5)
            continue

        try:
            image_rgb = raw_image.convert("RGB")
        except Exception:
            image_rgb = raw_image

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        photo_id = photo_data.get("id")
        filename_parts = ["passive", timestamp]
        if photo_id:
            filename_parts.append(str(photo_id))
        photo_filename = "_".join(filename_parts) + ".jpg"
        photo_path = os.path.join(PASSIVE_AUTOMATION_DIR, photo_filename)

        try:
            image_rgb.save(photo_path)
        except Exception as exc:
            print(f"Automazione passiva: impossibile salvare l'immagine {photo_filename}: {exc}")
            time.sleep(60 * 5)
            continue

        removed_path = None
        if (
            PASSIVE_AUTOMATION_IMAGE_HISTORY.maxlen
            and len(PASSIVE_AUTOMATION_IMAGE_HISTORY) == PASSIVE_AUTOMATION_IMAGE_HISTORY.maxlen
        ):
            removed_path = PASSIVE_AUTOMATION_IMAGE_HISTORY[0]

        PASSIVE_AUTOMATION_IMAGE_HISTORY.append(photo_path)

        if removed_path and removed_path != photo_path:
            try:
                if os.path.exists(removed_path):
                    os.remove(removed_path)
            except OSError as exc:
                print(f"Automazione passiva: non riesco a rimuovere {removed_path}: {exc}")

        if len(PASSIVE_AUTOMATION_IMAGE_HISTORY) < required_images:
            print("Automazione passiva: accumulo immagini di contesto prima di fare previsioni")
            time.sleep(60 * 5)
            continue

        try:
            initial_state = casa.ottieni_stati_filtro(tipi=["light"])
        except Exception as exc:
            print(f"Automazione passiva: errore nel recupero dello stato iniziale: {exc}")
            initial_state = None

        actions_executed = []

        try:
            prediction = model_predict(
                image_paths=list(PASSIVE_AUTOMATION_IMAGE_HISTORY),
                prev_action_names=list(PASSIVE_AUTOMATION_PREV_ACTIONS)
                if PASSIVE_AUTOMATION_PREV_ACTIONS
                else None,
                bundle_path=PASSIVE_MODEL_BUNDLE_PATH,
            )
        except Exception as exc:
            print(f"Automazione passiva: errore durante la predizione del modello: {exc}")
            time.sleep(60 * 5)
            continue

        if prediction:
            action_name, *params = prediction
            print(f"Automazione passiva - previsione: {action_name}, params: {params}")
            action_fn = passive_automation_actions.get(action_name)
            if action_fn:
                try:
                    action_fn(params)
                    stanza = params[0] if len(params) > 0 else None
                    dispositivo = params[1] if len(params) > 1 else None
                    actions_executed.append([stanza, dispositivo])
                    PASSIVE_AUTOMATION_PREV_ACTIONS.append(action_name)
                except Exception as exc:
                    print(f"Errore nell'esecuzione dell'azione {action_name}: {exc}")
            else:
                print(f"Automazione passiva: azione '{action_name}' non supportata")
        else:
            print("Automazione passiva: nessuna azione suggerita dal modello")

        try:
            final_state = (
                casa.ottieni_stati_filtro(tipi=["light"])
                if initial_state is not None
                else None
            )
        except Exception as exc:
            print(f"Automazione passiva: errore nel recupero dello stato finale: {exc}")
            final_state = None

        if initial_state is not None and final_state is not None:
            print("initial state: ", initial_state)
            print("final state: ", final_state)

            for stanza in casa.stanze:
                for dispositivo in stanza.dispositivi:
                    stanza_state = final_state.get(stanza.nome, {})
                    iniziale_stanza = initial_state.get(stanza.nome, {})
                    if dispositivo.nome not in stanza_state:
                        continue
                    if (
                        stanza_state.get(dispositivo.nome)
                        == iniziale_stanza.get(dispositivo.nome)
                        and getattr(dispositivo, 'turn_off', None) is not None
                        and [stanza.nome, dispositivo.nome] not in actions_executed
                    ):
                        dispositivo.turn_off()

        time.sleep(60 * 5)  # Aspetta 5 minuti prima di prendere un'altra foto


# API

APP.config['JWT_SECRET_KEY'] = "Wf6Nfe&!oENV9DY8u$g!SSHqV"
APP.config['JWT_TOKEN_LOCATION']    = ['headers', 'query_string']
APP.config['JWT_QUERY_STRING_NAME'] = 'token'
jwt = JWTManager(APP)
BLOCKLIST = set()

socketio = SocketIO(APP, cors_allowed_origins="*", async_mode="threading", path='/socket.io')

@jwt.token_in_blocklist_loader
def is_token_revoked(jwt_header, jwt_payload):
    jti = jwt_payload["jti"]
    return jti in BLOCKLIST

@jwt.revoked_token_loader
def revoked_token_callback(jwt_header, jwt_payload):
    return jsonify({
        "description": "Il token Ã¨ stato revocato.",
        "error": "token_revocato"
    }), 401

def validate_jwt(token):
    try:
        decoded = decode_token(token)
        # Puoi aggiungere ulteriori controlli, ad esempio se l'utente esiste nel DB
        return decoded
    except:
        return None

@APP.route('/api/register', methods=['POST'])
def register():
    if request.remote_addr != '127.0.0.1':
        return jsonify({'error': 'Accesso negato. Registrazione consentita solo da locale.'}), 403
    
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'Username e password sono obbligatori'}), 400

    if UserData.query.filter_by(username=username).first():
        return jsonify({'error': 'L\'utente esiste giÃ '}), 409

    hashed_password = generate_password_hash(password)
    
    new_user = UserData(username=username, password=hashed_password)
    db.session.add(new_user)
    db.session.commit()
    
    return jsonify({'msg': 'Utente creato con successo'}), 201
    


@APP.route('/api/ x-form', methods=['GET'])
def show_register_form():
    if request.remote_addr != '127.0.0.1':
        return "Accesso negato. Pagina disponibile solo in locale.", 403

    html_content = """
    <!DOCTYPE html>
    <html lang="it">
    <head>
        <meta charset="UTF-8">
        <title>Registrazione</title>
    </head>
    <body>
        <h2>Registrazione Utente</h2>
        <form id="registerForm">
            <label for="username">Username:</label>
            <input type="text" id="username" name="username" required><br><br>

            <label for="password">Password:</label>
            <input type="password" id="password" name="password" required><br><br>

            <button type="submit">Registrati</button>
        </form>

        <p id="responseMessage"></p>

        <script>
            document.getElementById('registerForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                const username = document.getElementById('username').value;
                const password = document.getElementById('password').value;

                const response = await fetch('/api/register', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ username, password })
                });

                const result = await response.json();
                document.getElementById('responseMessage').textContent = result.message || result.error;
            });
        </script>
    </body>
    </html>
    """
    return Response(html_content, mimetype='text/html')


    




@APP.route('/api/login', methods=['POST'])
def generate_token():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'Username e password sono obbligatori'}), 400

    user = UserData.query.filter_by(username=username).first()
    

    if not user or not check_password_hash(user.password, password):
        return jsonify({"error": "creenziali non valide"}), 401
    
    access_token = create_access_token(identity=username)

    

    return jsonify({"msg": "Login effettuato con successo", "token": access_token}), 200 # DA TOGLIERE



@APP.route('/api/logout', methods=['POST'])
@jwt_required()
def logout():
    jti = get_jwt()["jti"]
    BLOCKLIST.add(jti)
    return jsonify({"msg": "Logout effettuato con successo."}), 200

@APP.route("/api/create_chat", methods=["POST"])
@jwt_required()
def create_chat_api():
    username = get_jwt_identity()

    user = UserData.query.filter_by(username=username).first()

    jti = get_jwt()["jti"]

    if not user:
        return jsonify({"non esiste lo username, riprovare a fare la registrazione o il login"}), 400
    
    
    if Chats.query.filter_by(token = jti).first():
        return jsonify({"msg": "esiste giÃ  una chat per questo token"}), 200 
    

    new_chat = Chats(user = user, token = jti)
    db.session.add(new_chat)
    db.session.commit()

    return jsonify({"msg": "chat creata con successo"})




@APP.route("/api/start", methods=["POST"])
@jwt_required()
def api_start():
    global main_completed

    jti = get_jwt()["jti"]
   
    chat = Chats.query.filter_by(token = jti).first()

    if not chat:
        return jsonify({"error": "non esiste nessuna chat per questo token, crea la chat"}), 400
    

    message = request.get_json().get("message")

    if not os.path.exists(CASA_CONFIG_PATH):
        return jsonify({"msg": "Non esiste la configurazione per casa"}), 500
    
    if main_completed:
        return jsonify({"msg": "il processo Ã¨ giÃ  in esecuzione"}), 409

    thread = threading.Thread(target=activation, kwargs={"specific_prompt": message, "chat_id": chat.id})
    thread.start()

    return jsonify({"msg": "processo attivato"})


@APP.route("/api/answer", methods=["POST"])
@jwt_required()
def api_answer():
    jti = get_jwt()["jti"]

    answear = request.get_json().get("answer")
    id = request.get_json().get("id")

    chat = Chats.query.filter_by(token = jti).first()

    if not chat:
        return jsonify({"error": "non esiste nessuna chat per questo token, crea la chat"}), 400

    
    chat_user = Messages(
        chat = chat,
        sender = "user",
        content = {"tipo": "answer", "message": answear},
        reply_to = Messages.query.filter_by(id = id).first()
    )

    db.session.add(chat_user)
    db.session.commit()

    return jsonify({"msg": "risposta inviata con successo"}), 200


@APP.route("/api/read_chat", methods=["GET"])
@jwt_required()
def read_chat():
    token = get_jwt()["jti"]

    chat = Chats.query.filter_by(token = token).first()
    
    
    if not chat:
        return jsonify({"error": "non esiste nessuna chat per questo token, crea la chat"}), 400
    
    messaggi = []
    for msg in chat.messages:
        messaggi.append(msg.to_dict())
        

    return jsonify({"chat": messaggi}), 200


# TORNARE ALLO STATO PRECEDENTE AGGIUNGERE


@socketio.on('connect')
def handle_connect():
    try:
        verify_jwt_in_request()
    except Exception as e:
        emit({"error": str(e)})
        return False  # Chiude la connessione
    

@socketio.on('join_chat')
def on_join():
    verify_jwt_in_request()
    token = get_jwt()["jti"]

    chat = Chats.query.filter_by(token = token).first()

    if not chat:
        emit({"error": "non esiste nessuna chat per questo token, crea la chat"})
        return False

    room = f"chat_{chat.id}"
    join_room(room)

    emit('joined_room', {'room': room})


@event.listens_for(Messages, 'after_insert')
def after_insert(mapper, connection, target):
    messaggio_dict = target.to_dict()
    room = f"chat_{messaggio_dict['chat_id']}"
    socketio.emit('new_message', messaggio_dict, room=room)

@event.listens_for(Messages, 'after_update')
def after_update(mapper, connection, target):
    messaggio_dict = target.to_dict()
    room = f"chat_{messaggio_dict['chat_id']}"
    socketio.emit('modified_message', messaggio_dict, room=room)

##########################################

def run_server(port):
    print("INIZIALIZZANDO SERVER")
    socketio.run(APP, debug=False, host='0.0.0.0', port=port,)

def RUN():
    port = 8880
    ip = get_local_ip()
    thread = threading.Thread(target=run_server, args=(port,))
    thread.start()

    thread_aut = threading.Thread(target=passive_automation, args=())
    thread_aut.start()
    
    global casa, openai
    
    while True:
        time.sleep(60 * 5) # 60 * min 
        print("reload openai")
        openai = config_openai(casa, API_KEY_OPENAI)
    

if __name__ == "__main__":
    RUN()

 
