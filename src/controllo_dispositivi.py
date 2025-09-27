import requests
import json
import os
from utils import contolla_casa
import json

with open("config files/config.json", "r") as config_file:
    config_dict = json.load(config_file)
    api_url = config_dict["homeassistant"]["api_url"]
    token = config_dict["homeassistant"]["token"]

def show_microfoni():
    for i, mic_name in enumerate(sr.Microphone.list_microphone_names()):
        print(f"Microfono {i}: {mic_name}")

def get_microfono_index(name):
    for i, mic_name in enumerate(sr.Microphone.list_microphone_names()):
        if mic_name == name:
            return i


def send_request(url, method, entity_id):
    headers = {
        "Authorization": f"Bearer {token}",
        "content-type": "application/json",
    }

    data = {"entity_id": entity_id}
    response = requests.request(method, url, headers=headers, json=data)
    if response.status_code != 200:
        raise Exception(f"Error with the request: {response.text}")
    return response


class Light:
    def __init__(self, ids, *args, **kwargs):
        self.tipo = "light"
        self.id = ids
        self.entity_id = "light."+ids
        self.stati = "0 turned off, 1 turned on"
    def turn_on(self):
        url = f"{api_url}/services/light/turn_on"
        request = send_request(url, "POST", self.entity_id)
        if request.status_code == 200:
            return True
        print(request.text)
        raise Exception("Error with the request")
    def turn_off(self):

        url = f"{api_url}/services/light/turn_off"
        request = send_request(url, "POST", self.entity_id)
        if request.status_code == 200:
            return True
        print(request.text)
        raise Exception("Error with the request")
    def stato(self, stato, *args, **kwargs):
        stato = int(stato)
        if stato == 1:
            self.turn_on()
        else:
            self.turn_off()
    def ottieni_stato(self):
        url = f"{api_url}/states/{self.entity_id}"
        request = send_request(url, "GET", self.entity_id)
        if request.status_code == 200:
            return 1 if request.json()["state"] == "on" else 0
        
        print(request.text)
        raise Exception("Error with the request")


class Faretti:
    def __init__(self, ids: list, *args, **kwargs):
        self.tipo = "spotlights"
        self.id = [name for name in ids]
        self.lights = [Light(name) for name in ids]

    def ottieni_stato(self):
        return  round(sum([light.ottieni_stato() for light in self.lights]) / len(self.lights))

    def __getattribute__(self, name, *args, **kwargs):
        try:
            return super().__getattribute__(name)
        except AttributeError:
            if hasattr(self.lights[0], name):
                if not callable(getattr(self.lights[0], name)):
                    return getattr(self.lights[0], name)
                    
                def wrapper(*args, **kwargs):
                    for light in self.lights:
                        getattr(light, name)(*args, **kwargs)
                return wrapper
            raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'")
        

class SmartPlug:
    def __init__(self, ids, *args, **kwargs):
        self.tipo = "smartplug"
        self.id = ids
        self.entity_id = "switch."+ids
        self.stati = "0 turned off, 1 turned on"
    
    def turn_on(self):  
        self.stato(1)
    def turn_off(self):
        self.stato(0)
    def stato(self, stato, *args, **kwargs):
        stato = int(stato)
        url = f"{api_url}/services/switch/{'turn_on' if stato == 1 else 'turn_off'}"

        request = send_request(url, "POST", self.entity_id)
        if request.status_code == 200:
            return True
        print(request.text)
        raise Exception("Error with the request")
    def ottieni_stato(self):
        url = f"{api_url}/states/{self.entity_id}"
        request = send_request(url, "GET", self.entity_id)
        if request.status_code == 200:
            return 1 if request.json()["state"] == "on" else 0
        
        print(request.text)

class Musica:
    def __init__(self, *args, **kwargs):
        self.tipo = "music"
        self.stati = "0 not playing, 1 playing"

        self.stato_autonomo = 0

    def stato(self, stato, *args, **kwargs):
        stato = int(stato)

        if stato == 1:
            os.system("""osascript -e 'tell application "Music" to play playlist "LA STORIA"'""")
        elif stato == 0 and self.stato_autonomo == 1:
            os.system("""osascript -e 'tell application "Music" to pause'""")
        
        self.stato_autonomo = stato
    
    def ottieni_stato(self):
        return self.stato_autonomo
        


class Sensore:
    def __init__(self, ids, *args, **kwargs):
        self.tipo = "sensor"
        self.entity_id = f"sensor.{ids}"
    
    def ottieni_stato(self):
        url = f"{api_url}/states/{self.entity_id}"
        request = send_request(url, "GET", self.entity_id)
        if request.status_code == 200:
            return request.json()["state"]
        
        print(request.text)
        raise Exception("Error with the request")


tipi_dispositivi = {"light": Light, "spotlights": Faretti, "music": Musica, "smartplug": SmartPlug, "sensor": Sensore}



class Dispositivo: 
    def __init__(self, nome, dispositivo, descrizione, **kwargs):
        if "." in nome:
            raise Exception("Il nome del dispositivo non puo contenere il carattere '.'")
        self.nome = nome
        if type(dispositivo) not in tipi_dispositivi.values():
            raise Exception("Dispositivo non valido")
        
        self.dispositivo = dispositivo
        self.descrizione = descrizione

        for key, value in kwargs.items():
            setattr(self, key, value)
    def __getattribute__(self, name, *args, **kwargs):
            try:
                return super().__getattribute__(name)
            except AttributeError:
                if hasattr(self.dispositivo, name):
                    attr = getattr(self.dispositivo, name)
                    if not callable(attr):
                        return attr

                    def wrapper(*args, **kwargs):
                        return attr(*args, **kwargs)
                    return wrapper
                raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'")


class Stanza:
    def __init__(self, nome, dispositivi: list):
        self.nome = nome
        self.dispositivi = dispositivi
        self.nomi_dispositivi = [dispositivo.nome for dispositivo in dispositivi]

    def turn_off_all(self):
        for dispositivo in self.dispositivi:
            if hasattr(dispositivo, "turn_off"): dispositivo.turn_off()

    def __getitem__(self, name):
        try:
            return self.dispositivi[self.nomi_dispositivi.index(name)]
        except ValueError: 
            raise Exception(f"Dispositivo {name} non trovato")
    
    def __iter__(self):
        return iter(self.dispositivi)

class Casa:
    def __init__(self, stanze= [], load_path=None):
        if load_path is None:
            self.stanze = stanze
            self.nomi_stanze = [stanza.nome for stanza in stanze]
            self.memoria = []
        elif load_path is not None:
            self.nomi_stanze = []
            self.stanze = []
            with open(load_path, "r") as f:
                stanze = json.load(f)
                for nome_stanza, dispositivi in stanze.items():
                    disp = []
                    for dispositivo in dispositivi:
                        disp.append(Dispositivo(dispositivo=tipi_dispositivi[dispositivo["tipo"]](dispositivo["entity_id"]), **{k: v for k, v in dispositivo.items()}))
                
                    self.stanze.append(Stanza(nome_stanza, disp))
                    self.nomi_stanze.append(nome_stanza)

        for nomi_stanze in self.nomi_stanze:
            if " " in nomi_stanze:
                raise Exception("Il nome della stanza non puo contenere il carattere ' '")
        
        nomi_dispositivi = []
        for stanze in self.stanze:
            for dispositivo in stanze:
                if dispositivo.nome in nomi_dispositivi:
                    raise Exception(f"Dispositivo {dispositivo.nome} non puo avere lo stesso nome di un altro dispositivo")
                nomi_dispositivi.append(dispositivo.nome) 
                

    def ottieni_stati (self):
        stati = {}
        for stanza in self.stanze:
            stati[stanza.nome] = {}
            for dispositivo in stanza:
                if getattr(dispositivo, "automated_mode", True) is False:
                    continue
                stati[stanza.nome][dispositivo.nome] = dispositivo.ottieni_stato()
        
        return stati
    
    def ottieni_stati_sensori(self):
        stati = {}
        for stanza in self.stanze:
            stati[stanza.nome] = {}
            for dispositivo in stanza:
                if getattr(dispositivo, "tipo", None) == "sensor" and getattr(dispositivo, "automated_mode", True):
                    stati[stanza.nome][dispositivo.nome] = dispositivo.ottieni_stato()
        
        return stati

    def ottieni_stati_filtro(self, tipi:list):
        stati = {}
        for stanza in self.stanze:
            stati[stanza.nome] = {}
            for dispositivo in stanza:
                if getattr(dispositivo, "tipo", None) not in tipi or getattr(dispositivo, "automated_mode", True) is False:
                    continue
                
                stati[stanza.nome][dispositivo.nome] = {
                    "tipo": dispositivo.tipo,
                    "stato": dispositivo.ottieni_stato(),
                    "descrizione": dispositivo.descrizione
                }
        
        return stati
    
    def save(self, path):
        j = {}
        for stanza in self.stanze:
            j[stanza.nome] = []
            for dispositivo in stanza:
                try:
                    id = dispositivo.id
                except:
                    id = ""

                j[stanza.nome].append({"nome": dispositivo.nome, "descrizione": dispositivo.descrizione, "tipo": dispositivo.tipo, "entity_id": id})

        with open(path, "w") as f:
            json.dump(j, f)
    

    def __getitem__(self, name):
        try:
            return self.stanze[self.nomi_stanze.index(name)]
        except ValueError: 
            raise Exception(f"Stanza {name} non trovata")


if __name__ == "__main__":
    casa = Casa(load_path="config files/casa.json")

    print(casa.ottieni_stati_sensori())
