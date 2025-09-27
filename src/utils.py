import cv2
from io import BytesIO
import base64
import numpy as np
import socket

def encode_image_pil(image_pil):
    with BytesIO() as img_byte_arr:
        image_pil.save(img_byte_arr, format='JPEG')
        img_byte_arr.seek(0)  
        return base64.b64encode(img_byte_arr.read()).decode("utf-8")
    
def contolla_casa(j, CASA):
    for dispostivo in j:
        stanza = dispostivo["room"]
        nome = dispostivo["name"]
        stato = dispostivo["status"]

        CASA[stanza][nome].stato(stato, CASA=CASA)

    return j

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip
