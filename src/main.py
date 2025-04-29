import json
import os
import threading
import requests
import cv2
import base64
import numpy as np
import logging
import pandas as pd
from utils import blur_detected_poses, contolla_casa, get_local_ip
from controllo_dispositivi import Casa, SpeakerVoce, tipi_dispositivi, Stanza, Dispositivo
from openaiapi import OPENAI, config_base_assistants
from datetime import datetime
import platform
from PIL import Image
from transformers import BlipProcessor, BlipForConditionalGeneration
import torch
import io
import time

from flask import Flask, request, redirect, url_for, jsonify, session, Response, make_response

from flask_jwt_extended import (
    JWTManager, create_access_token,
    jwt_required, get_jwt_identity, get_jwt, exceptions as jwt_exceptions, decode_token, verify_jwt_in_request, 
)

from werkzeug.security import generate_password_hash, check_password_hash
from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO, emit, disconnect, send, join_room
from sqlalchemy import event
from sqlalchemy.orm.attributes import get_history
from flask_cors import CORS

from model import pred


#LOGGING DA AGGIUNGERE
"""logging.basicConfig(level=logging.DEBUG)
logging.basicConfig(filename="logs.log", level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
"""

def config_openai(casa, API_KEY):
    system_istruction, tools, response_format = config_base_assistants(casa)
    openai = OPENAI(API_KEY, system_instructions=system_istruction, tools=tools, response_format=response_format)
    return openai


with open("config.json", "r") as config_file:
    config_dict = json.load(config_file)
    
SERVER_PHOTO = config_dict["SERVER_PHOTO"]["url"] # url for online cameras
PORT_PHOTO = config_dict["SERVER_PHOTO"]["port"] #Â port for online cameras

CSV_PATH = config_dict["MAIN save data paths"]["csv"] # path where save validation metadata
VAL_PHOTO_SAVE_PATH = config_dict["MAIN save data paths"]["save_path"] # path where save validation photos
CSV_STRUCTURE = ["indirizzi delle foto", "risposta grezza", "json", "data e ora", "conversation", "validazione", "commenti"] # const

CASA_CONFIG_PATH = config_dict["MAIN save data paths"]["casa"] # path where home configuration is saved

API_KEY_OPENAI = config_dict["models apy key / ids"]["openai"]

REPO_ID_DAY = config_dict["models apy key / ids"]["repo_id_dayvision"]
REPO_ID_NIGHT = config_dict["models apy key / ids"]["repo_id_nightvision"]

global df
if not os.path.exists(CSV_PATH):
    df = pd.DataFrame(columns=CSV_STRUCTURE)
else:
    df = pd.read_csv(CSV_PATH, index_col=0)

if not os.path.exists(VAL_PHOTO_SAVE_PATH):
    os.makedirs(VAL_PHOTO_SAVE_PATH)  

global casa

# element CASA to control devices
if os.path.exists(CASA_CONFIG_PATH):  
    casa = Casa(load_path=CASA_CONFIG_PATH)
else:
    casa = Casa(stanze=[])

speaker_voce = SpeakerVoce(mic=config_dict["microfono"])



global openai

openai = config_openai(casa, API_KEY_OPENAI)


assistant_id = config_dict["models apy key / ids"]["assistant_id"]
assistant_configuration = OPENAI(client=openai.client, assintant_id=assistant_id)

model = BlipForConditionalGeneration.from_pretrained(REPO_ID_DAY).to("mps" if torch.mps.is_available() else "cpu")
processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-large")
model = BlipForConditionalGeneration.from_pretrained(REPO_ID_NIGHT).to("mps" if torch.mps.is_available() else "cpu")
processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-large")




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
    
def generate(image: Image):
    repo = REPO_ID_NIGHT if is_gray_scale(image) else REPO_ID_DAY
    
    print("ho usato il repo: ", repo)
    
    model = BlipForConditionalGeneration.from_pretrained(repo).to("mps" if torch.mps.is_available() else "cpu")
    processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-large")


    image = image.convert("RGB")
    inputs = processor(images=image, return_tensors="pt").to("mps" if torch.mps.is_available() else "cpu")
    pixel_values = inputs.pixel_values

    generated_ids = model.generate(pixel_values=pixel_values, max_length=50)
    generated_caption = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]

    return generated_caption

    
def say(text):
    system = platform.system()

    print("SYSTEM: system")

    if system == "Darwin":
        os.system(f"say '{text}'")
    elif system == "Linux":
        os.system(f"espeak '{text}'")
    else:
        print(f"Say non supportato nel tuo sistema operativo ({system})")

    
def val(photos, rText, j, t, conversation, validazione = "", commenti = ""):
    global df, completed

    photos_path = []
    photos_path_str = ""
    
    existing_photos = [f for f in os.listdir(VAL_PHOTO_SAVE_PATH) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.tiff', '.bmp', '.gif'))]
    if not existing_photos:
        next_index = 0
    else:
        latest_photo = max(existing_photos, key=lambda x: int(x.split('-')[0]))
        next_index = int(latest_photo.split('-')[0]) + 1

    for i, photo in enumerate(photos):
        photo_path = f"{VAL_PHOTO_SAVE_PATH}/{next_index}-{i}.jpg"
        photos_path.append(photo_path)
        photos_path_str += photo_path+"\n"
        cv2.imwrite(photo_path, photo)

    commenti = ""
    if validazione == "":
        while True:
            try:
                validazione = input("validazione: ").replace(" ", "")
                if validazione == "":
                    break
                else:
                    validazione = float(str(validazione))

                if validazione >= 0 and validazione <= 1:
                    if commenti == "":
                        commenti = input("commenti: ")                

                    break
                else:
                    raise ValueError
            except:
                print("valore non valido, scegliere tra 1 e 0")


    newRow = pd.DataFrame({"indirizzi delle foto": [photos_path_str], "risposta grezza": [rText.replace("\n", " ")], "json": [json.dumps(j)], "data e ora": [t], "conversation": [conversation],"validazione": [validazione], "commenti": [commenti]})
 
    df = pd.concat([df, newRow])
    df.to_csv(CSV_PATH, index=True)

    completed = False


def activation(specific_prompt, photo = None, chat_id = None):
    global main_completed, completed

    main_completed = True

    try:

        with APP.app_context():
            if photo == None:
                shot = take_photo()

                id = shot["id"]
                photo = shot["image"]

            
            stati = casa.ottieni_stati() 


            if chat_id != None:
                chat = Chats.query.filter_by(id = chat_id).first()

                if not chat:
                    raise Exception("Non esiste chat corrispondente all'id")

                chat_user = Messages(chat = chat, photo_id = id, sender = "user", content = {"tipo": "attivazione", "message": specific_prompt, "stati": stati})
                db.session.add(chat_user)
                db.session.commit()

                chat_assistant = Messages(chat = chat, sender = "assistant", content = {"tipo": "loading"}, loading=True, reply_to = chat_user)
                db.session.add(chat_assistant)
                db.session.commit()

            caption = generate(photo)
            print("generated caption: ", caption)

            if specific_prompt != "":
                specific_prompt = f'User specific prompt: "{specific_prompt}" \n'

            stato_dispositivi = f'{specific_prompt} this is currently the state of the devices: {stati}'
            
            openai.AS_send_message(f"""image description: "{caption}"
            current state of the devices: "{stato_dispositivi}"
            {specific_prompt}""")

            return_info = openai.AS_returns()

            try:
                question = json.loads(return_info.required_action.submit_tool_outputs.tool_calls[0].function.arguments)["question"]
            except:
                question = None

            outputs = []
        
            while question is not None:
                chat_assistant.content = {
                    "tipo": "question",
                    "question": question,
                    "reply_to": chat_assistant.id
                }

                chat_assistant.loading = False
                db.session.commit()

                conto_alla_rovescia = 30

                while question is not None and conto_alla_rovescia >= 0:
                    risposta = Messages.query.filter_by(chat_id = chat_id, reply_to_id = chat_assistant.id).first()

                    if risposta:
                        if risposta.content["tipo"] == "answer":
                            question = None
                            outputs.append(risposta.content["message"])
                            continue

                    time.sleep(1)
                    conto_alla_rovescia -= 1

                if len(outputs) == 0:
                    outputs = ["non Ã¨ stata data nessuna risposta"]

                print(outputs)

                return_info  = openai.AS_returns(outputs, return_info)

                try:
                    question = json.loads(return_info.required_action.submit_tool_outputs.tool_calls[0].function.arguments)["question"]

                    print("altra domanda")
                except:
                    question = None

            returned = return_info[0]

            if returned["error"] == True:
                raise ValueError(f"Error ({returned['error']}) with Assistants: {returned['explanation']}")
            
            if chat_id != None:
                changes = []
                for disp in returned.get("dispositivi", []):
                    if disp["status"] != str(stati[disp["room"]][disp["name"]]):
                        changes.append(disp)
                

                chat_assistant.content = {
                    "tipo": "execution",
                    "messages": returned.get("voice", None),
                    "explanation": returned.get("explanation", None),
                    "changes": changes
                }

                chat_assistant.loading = False

                db.session.commit()
            

            j = contolla_casa(returned["dispositivi"], casa) # CHAT  
            
            log_file = 'logs.csv'
            cols = ['photo_id', 'specific_prompt', 'caption', 'returned', 'stati']
            if os.path.exists(log_file):
                df = pd.read_csv(log_file, dtype=str)
            else:
                df = pd.DataFrame(columns=cols)

            new_row = {
                'photo_id': id,
                'specific_prompt': specific_prompt.strip(),
                'caption': caption,
                'returned': json.dumps(returned, ensure_ascii=False),
                'stati': json.dumps(stati, ensure_ascii=False)
            }
            df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
            df.to_csv(log_file, index=False)

            main_completed = False
            return returned

    except Exception as e:
        main_completed = False
        raise e



       

def main(specific_prompt = "", ev = False, photos = []): 
    global main_completed, validation_data, completed, photos_cache, peoples_cache, ora_ultima_attivazione
    
    try:
        returned = activation(specific_prompt=specific_prompt, photos=photos)

        conversation = []     

        for item in returned["voice"]:
            type = item["type"]
            text = item["text"]
            if type == "question":
                thread = threading.Thread(target=speaker_voce.domanda, args = [text, openai, casa])
                thread.start()
            elif type == "answer":
                # continuare
                pass
        
        os.system("pkill Preview")

        print("Finito con successo")

    
        photos_cache = photos
        peoples_cache = True 

        ora_ultima_attivazione = datetime.now()
        if ev:
            EVENTO.set()

        validation_data = {
            "rText": str(returned),
            "json": returned,
            "t": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "conversation": conversation
        }

        
        main_completed = False
        completed = True

    except Exception as e:
        main_completed = False
        validation_data = None
        completed = False
    
        print(e)
        # raise e


def passive_automation():
    while True:
        photo = take_photo()["image"]

        caption = generate(photo)
        
        print("generated caption: ", caption)
        
        list_actions = pred(caption)
        print("list of actions: ", list_actions)


        for la in list_actions:
            action = la["action"]
            if action == "turn_on_light" or action == "turn_on_smart_plug":
                for stanza in casa.stanze:
                    for dispositivo in stanza:
                        if dispositivo.nome == la["params"]:
                            dispositivo.turn_on()

            elif action == "turn_off_light" or action == "turn_off_smart_plug":
                for stanza in casa.stanze:
                    for dispositivo in stanza:
                        if dispositivo.nome == la["params"]:
                            dispositivo.turn_off()

            else: 
                print("Uknown action: " + action)

        time.sleep(5)

        






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
    


@APP.route('/api/register-form', methods=['GET'])
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

@APP.route('/')
def index():
    html = '''
<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <title>Chat API Client</title>
    <style>
        body { font-family: sans-serif; background: #f5f5f5; padding: 20px; }
        .hidden { display: none; }
        input, textarea, button { display: block; width: 100%%; margin: 10px 0; padding: 10px; }
        button { background: #4CAF50; color: white; border: none; cursor: pointer; }
        #chat-box { background: white; padding: 10px; border: 1px solid #ccc; height: 300px; overflow-y: scroll; }
    </style>
    <!-- Socket.IO client -->
    <script src="https://cdn.socket.io/4.6.1/socket.io.min.js"></script>
</head>
<body>
    <div id="login-form">
        <h2>Login</h2>
        <input id="username" placeholder="Username">
        <input id="password" type="password" placeholder="Password">
        <button onclick="login()">Login</button>
    </div>

    <div id="chat-ui" class="hidden">
        <h2>Chat</h2>
        <textarea id="message" placeholder="Scrivi messaggio"></textarea>
        <button onclick="sendMessage()">Invia Messaggio</button>

        <h2>Messaggi</h2>
        <div id="chat-box"></div>
    </div>

    <script>
        let token = null;
        let socket = null;

        async function login() {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: document.getElementById('username').value,
                    password: document.getElementById('password').value
                })
            });
            const data = await res.json();
            if (res.ok) {
                token = data.token;
                document.getElementById('login-form').classList.add('hidden');
                document.getElementById('chat-ui').classList.remove('hidden');
                await createChat();
                connectSocket();
            } else {
                alert(data.error || "Errore durante il login");
            }
        }

        async function createChat() {
            const res = await fetch('/api/create_chat', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const data = await res.json();
            // ignoro il caso "esiste già"
            if (res.ok && data.msg && !data.msg.includes("esiste già")) {
                alert(data.msg);
            }
        }

        function connectSocket() {
            socket = io({
                auth: { token: token }
            });

            socket.on('connect', () => {
                console.log('Socket connesso, entra nella stanza...');
                socket.emit('join_chat');
            });

            socket.on('joined_room', ({ room }) => {
                console.log('Entrato in', room);
            });

            socket.on('new_message', (msg) => {
                appendMessage(msg);
            });

            socket.on('modified_message', (msg) => {
                // se vuoi gestire modifiche
                console.log('Messaggio modificato:', msg);
            });

            socket.on('connect_error', (err) => {
                console.error('Errore di connessione:', err.message);
            });
        }

        async function sendMessage() {
            const text = document.getElementById('message').value;
            if (!text) return alert("Scrivi prima un messaggio");
            const res = await fetch('/api/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ message: text })
            });
            const data = await res.json();
            if (data.error) alert(data.error);
            document.getElementById('message').value = '';
        }

        function appendMessage(msg) {
            const box = document.getElementById('chat-box');
            const div = document.createElement('div');
            div.textContent = '[' + msg.sender + '] ' + JSON.stringify(msg.content);
            box.appendChild(div);
            box.scrollTop = box.scrollHeight;
        }
    </script>
</body>
</html>
    '''
    return make_response(html)

@APP.route('/configuration-start', methods=['GET'])
def configuration_start():
    global assistant_configuration

    if validation_data != {}:
        val(validation_data["photos"], validation_data["rText"], validation_data["json"], validation_data["t"], validation_data["conversation"],validazione="", commenti="")

    assistant_configuration = OPENAI(client=openai.client, assintant_id=assistant_id)
    
    photos = [take_photo()["image"]]
    message = assistant_configuration.AS_vision(photos)[0]

    return redirect(url_for('configuration')+f"?device={message['device']}&question={message['question']}&suggested_answers={message['suggested_answers']}")

@APP.route('/configuration', methods=['GET'])
def configuration():
    global assistant_configuration
    if len(assistant_configuration.client.beta.threads.messages.list(thread_id=assistant_configuration.thread.id).data) == 0:
        return redirect(url_for('configuration_start'))
    
    device = request.args.get('device', '')
    question = request.args.get('question', '')
    suggested_answers = request.args.get('suggested_answers', '').split(",")

    print(device, question, suggested_answers)

    if not question:
        assistant_configuration = OPENAI(client=openai.client, assintant_id=assistant_id)
        return redirect(url_for('configuration'))
    
    suggestion = ""
    for answer in suggested_answers:
        suggestion += f"<a href='/configuration-backend?answer={answer}'>{answer}</a><br>"

    return f"""<h1> Configuration </h1>
<h3> device: {device} </h3>
<h4> question: {question} </h4>

{suggestion}
<br>
<form action="/configuration-backend" method="get">
    <textarea name="answer" type="text" id="answer" required></textarea>
    <button type="submit">Submit</button>
</form>
<a href="/configuration-start">Start Over</a>
    """

@APP.route("/configuration-backend/", methods=['GET'])
def configuration_backend():
    global assistant_configuration, casa, openai
    
    answear = request.args.get('answer', '')
    if not answear:
        return redirect(url_for('configuration'))
    
    message, returned = assistant_configuration.AS_send_message(answear)

    if returned != None:
        devices = returned["description_rooms_type"]
        rooms = {device["room"]: [] for device in devices['devices']}

        
        for device in devices['devices']:
            name = device["name"]
            tipo = tipi_dispositivi[device["type"].lower()]
            ids = device["ids"]
            description = device["description"]

            if len(ids) == 1:
                ids = ids[0]

            print(f"new device: {name}, {tipo}, {ids}, {description}")

            d = Dispositivo(name, tipo(ids), description)

            rooms[device["room"]].append(d)
                
        casa = Casa([])
        for room_name, dispositivi in rooms.items():
            casa.stanze.append(Stanza(room_name, dispositivi))

        casa.save(CASA_CONFIG_PATH)

        openai = config_openai(casa, API_KEY_OPENAI)

        return redirect(url_for('form')+f"?avviso=configurazione completata")
            
    return redirect(url_for('configuration')+f"?device={message['device']}&question={message['question']}&suggested_answers={message['suggested_answers']}")

def run_server(port):
    print("INIZIALIZZANDO SERVER")
    socketio.run(APP, debug=False, host='0.0.0.0', port=port,)

def RUN():
    port = 8880
    ip = get_local_ip()
    thread = threading.Thread(target=run_server, args=(port,))
    thread.start()

    # thread_aut = threading.Thread(target=passive_automation, args=())
    # thread_aut.start()
    
    global casa, openai
    
    while True:
        time.sleep(60 * 60)
        print("reload openai")
        openai = config_openai(casa, API_KEY_OPENAI)
    
    return f"http://{ip}:{port}"


if __name__ == "__main__":
    RUN()
