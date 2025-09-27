# Domotica AI

**I modelli necessari per l'automazione devono essere allenati seguendo la sezione [Model Training](#model-training).** Senza quei modelli il progetto non può funzionare correttamente.

## Panoramica
Domotica AI è una piattaforma sperimentale per il controllo autonomo di una casa smart. Il sistema combina:
- Elaborazione di flussi video provenienti da una o più camere IP.
- Riconoscimento delle attività tramite un modello multimodale personalizzato (`model.py`).
- Integrazione con Home Assistant per l'accensione/spegnimento di luci e prese.
- Interfaccia HTTP + Socket.IO in Flask per il controllo manuale e la supervisione.
- Automatismi passivi che reagiscono al contesto visivo e allo storico delle azioni.

Il repository non include i pesi dei modelli; è necessario addestrarli e confezionarli come descritto più avanti.

## Struttura del progetto
```
.
├── controllo_dispositivi.py   # Wrapper per i dispositivi Home Assistant
├── main.py                    # Entry point Flask + automazione passiva
├── model.py                   # Definizione del modello multimodale
├── openaiapi.py               # Integrazione con OpenAI Assistants
├── requirements.txt           # Dipendenze Python
├── utils.py                   # Utility varie (encoding immagini, networking)
└── README.md
```

## Prerequisiti
- Python 3.10 (consigliato) con `pip` e `venv`.
- Home Assistant configurato con token Long-Lived.
- Server HTTP che fornisce immagini (`/get-photo`) secondo quanto atteso in `take_photo()`.
- Librerie di sistema per audio/video (es. `portaudio`, `ffmpeg`, librerie X/GL) se si esegue su Linux.

## Installazione rapida
1. Clona il repository e spostati nella cartella `src`.
2. (Opzionale ma consigliato) crea un ambiente virtuale:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Installa le dipendenze:
   ```bash
   pip install -r requirements.txt
   ```
4. Crea la cartella `config files/` (attenzione allo spazio nel nome) e popola i file di configurazione richiesti (vedi sotto).
5. Posiziona nella stessa cartella `config files/` i pesi dei modelli (YOLO, bundle personalizzato, eventuali pesi BLIP se non scaricati da internet).

## Configurazione
### `config files/config.json`
Il progetto si aspetta un file JSON con questa struttura minima:
```json
{
  "SERVER_PHOTO": {
    "url": "192.168.x.x",
    "port": 8000
  },
  "MAIN save data paths": {
    "csv": "dati.csv",
    "save_path": "foto",
    "casa": "config files/casa.json"
  },
  "models apy key / ids": {
    "openai": "sk-...",
    "assistant_id": "asst_...",
    "repo_id_dayvision": "utente/modello-day",
    "repo_id_nightvision": "utente/modello-night",
    "use_quantization_day": false,
    "K_vision": 0.3,
    "model_bundle_path": "config files/model_definitive.pth",
    "yolo_version": "yolov8l.pt"
  },
  "microfono": "Nome microfono",
  "homeassistant": {
    "api_url": "http://homeassistant.local:8123/api",
    "token": "<LONG_LIVED_TOKEN>"
  }
}
```
- `SERVER_PHOTO`: endpoint dal quale `main.py` recupera i frame.
- `MAIN save data paths`: percorso del CSV di log, directory di salvataggio degli scatti e file `casa.json` con la descrizione della casa.
- `models apy key / ids`: credenziali OpenAI e riferimenti ai modelli. `model_bundle_path` deve puntare al bundle creato nello step di training.
- `homeassistant`: endpoint e token per le API REST.

> Il file viene automaticamente sovrascritto da variabili d'ambiente, se impostate. Le chiavi supportate includono `SERVER_PHOTO_URL`, `SERVER_PHOTO_PORT`, `OPENAI_API_KEY`, `ASSISTANT_ID`, `MODEL_REPO_DAY`, `MODEL_REPO_NIGHT`, `YOLO_VERSION_FILE`, `K_VISION`, `MODEL_BUNDLE_PATH`.

### `config files/casa.json`
Definisce le stanze e i dispositivi disponibili. Esempio sintetico:
```json
{
  "camera": [
    {
      "nome": "scrivania",
      "descrizione": "Spotlight sopra la scrivania principale.",
      "tipo": "light",
      "entity_id": "light.scrivania"
    },
    {
      "nome": "monitor",
      "descrizione": "Smart plug che alimenta monitor e LED.",
      "tipo": "smartplug",
      "entity_id": "switch.monitor"
    }
  ]
}
```
Il file viene caricato da `Casa(load_path=...)` ed è necessario per popolare l'assistente OpenAI con le informazioni sui dispositivi.

### Altri asset
- `config files/yolov8l.pt`: pesi YOLO (o altro modello) utilizzati da `ultralytics` per la fase di crop.
- `config files/model_definitive.pth`: bundle generato dopo l'addestramento del modello personalizzato (vedi [Model Training](#model-training)).
- Directory `foto/`: viene popolata a runtime con gli scatti su cui opera l'automazione.

## Esecuzione
```bash
python main.py
```
Il server avvia:
- Flask + Socket.IO sulla porta `8880` (host `0.0.0.0`).
- Un thread di automazione passiva (`passive_automation`) che ogni 5 minuti acquisisce un frame, aggiorna la finestra temporale di immagini e invoca `model_predict` per scegliere l'azione.
- Un thread di refresh periodico dell'istanza OpenAI.

Assicurati che il servizio camera risponda a `GET http://<SERVER_PHOTO_URL>:<PORT>/get-photo` restituendo JSON con chiavi `id` e `image` (base64).

## Automazione passiva
- Mantiene in memoria gli ultimi `N` scatti (`N = num_input_images` del modello) e le ultime azioni emesse.
- Salva gli scatti in `foto/passive_automation/` per auditing.
- Confronta lo stato luci prima/dopo l'azione e spegne eventuali dispositivi non modificati esplicitamente.
- Richiede che `passive_automation_actions` contenga gli handler per le azioni restituite dal modello.

## Model Training
I pesi non sono inclusi: è necessario produrli prima di avviare il sistema.

1. **Raccolta dati**
   - Genera sequenze temporali di immagini (`num_input_images` per predizione) accompagnate da vettori sensoriali e storico azioni.
   - Annota, per ogni sequenza, l'azione target e i parametri (es. stanza, dispositivo). Le label devono essere coerenti con i vocaboli che verranno salvati nel bundle.

2. **Segui le istruzioni inserite nel readme della cartella "model training" di questo repo**
## Suggerimenti per lo sviluppo
- Per un controllo rapido della sintassi esegui `python -m py_compile main.py`.
- Se modifichi il modello, amplia le variabili d'ambiente oppure rigenera il bundle.
- Monitora `foto/passive_automation/` per valutare i frame che innescano azioni inattese.

## Troubleshooting
- **`Impossibile caricare il modello per l'automazione passiva`**: verifica percorso `MODEL_BUNDLE_PATH` e la presenza delle chiavi nel bundle.
- **Azioni non eseguite**: controlla che `casa.json` contenga nome stanza/dispositivo coerente con quanto atteso dai parametri del modello.

---
Per domande o contributi apri una issue o contattami (eduardo.bolognini@robocommunity.it)
