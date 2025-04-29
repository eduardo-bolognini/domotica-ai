import os
import uuid
import json
import time
import threading
from datetime import datetime

import cv2
import requests
import numpy as np
from ultralytics import YOLO
from flask import Flask, send_file, Response, jsonify, request


import aiohttp
from imouapi.api import ImouAPIClient 
import asyncio
from functools import cmp_to_key

from onvif import ONVIFCamera
from urllib.parse import urlparse


import logging
logging.getLogger('ultralytics').setLevel(logging.ERROR)

SAVE_PATH = "files"
os.makedirs(SAVE_PATH, exist_ok=True)

class ERRORECAMERA(Exception):
    pass

def check_cameras(max_index=10):
    cams = []
    for i in range(max_index):
        cap = cv2.VideoCapture(i)
        if cap.isOpened():
            cams.append(i)
            cap.release()
    return cams


class HybridTracker:
    def __init__(self, yolo_model_path_powerful="yolov8l.pt", yolo_model_path_weak="yolov8n.pt", powerful_interval=100, crop_margin=0.6):
        self.yolo_powerful = YOLO(yolo_model_path_powerful)
        self.yolo_weak = YOLO(yolo_model_path_weak)
        self.powerful_interval = powerful_interval
        self.frame_count = 0
        self.last_bbox = None
        self.crop_margin = crop_margin

    def _run_yolo(self, frame, yolo=None):
        if not yolo: yolo = self.yolo_powerful
        results = yolo(frame)
        
        best = None; best_area = 0
        for det in results:
            for box in det.boxes:
                if int(box.cls) == 0:
                    x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                    area = (x2-x1)*(y2-y1)
                    if area > best_area:
                        best_area = area
                        best = (x1, y1, x2-x1, y2-y1)
        return best

    def _crop_roi(self, frame, bbox):
        x, y, w, h = bbox
        dx = int(w * self.crop_margin)
        dy = int(h * self.crop_margin)
        x0 = max(0, x - dx)
        y0 = max(0, y - dy)
        x1 = min(frame.shape[1], x + w + dx)
        y1 = min(frame.shape[0], y + h + dy)
        
        x0 = 0 if x0 < 0 else (frame.shape[1] if x0 > frame.shape[1] else x0)
        x1 = 0 if x1 < 0 else (frame.shape[1] if x1 > frame.shape[1] else x1)
        y0 = 0 if y0 < 0 else (frame.shape[0] if y0 > frame.shape[0] else y0)
        y1 = 0 if y1 < 0 else (frame.shape[0] if y1 > frame.shape[0] else y1)

        return frame[int(y0):int(y1), int(x0):int(x1)], (int(x0), int(y0))

    def process(self, frame, use_large = False):
        self.frame_count += 1
        if self.frame_count % self.powerful_interval == 0 or self.last_bbox is None or self.frame_count == 1 or not use_large:
            bbox = self._run_yolo(frame)
            if bbox:
                self.last_bbox = bbox
                return bbox, frame
                
        elif self.last_bbox:
            roi, offset = self._crop_roi(frame, self.last_bbox)

            new_bbox = self._run_yolo(roi, self.yolo_weak)
            if new_bbox:
                x_off, y_off = offset
                x, y, w, h = new_bbox
                bbox = (int(x + x_off), int(y + y_off), int(w), int(h))
                self.last_bbox = bbox
                return bbox, frame
        
        self.last_bbox = None
        self.frame_count = 0
        return False, frame.copy()
    
class FrameReader:
    def __init__(self, cap):
        self.cap = cap
        self.frame = None
        self.running = False
        self.lock = threading.Lock()
        self.thread = None
        
    def start(self):
        if self.running:
            return
            
        self.running = True
        self.thread = threading.Thread(target=self._update_frame, daemon=True)
        self.thread.start()
        
    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=1.0)
            self.thread = None
        
    def _update_frame(self):
        while self.running:
            ret, frame = self.cap.read()
            if ret:
                with self.lock:
                    self.frame = frame.copy()
            time.sleep(0.01)  # ~30 fps
    
    def read(self):
        with self.lock:
            if self.frame is None:
                raise ERRORECAMERA("No frame available")
            return self.frame.copy()
        

class CameraImou:
    def __init__(self):
        pass
    async def init(self, 
                   SERIAL_IMOU: str, APP_ID_IMOU: str, APP_SECRET_IMOU: str, 
                   CAMERA_IP: str,  CAMERA_PASSWORD: str,
                    server_url, attivazione_auto=False,
                        movimento_ms=100, soglia=4.5, camera_quality = "HD", 
                        base_ptz_positions = {'v': 0.1933333277702332, 'h': -0.2561111152172089, 'z': 0.0}, 
                        refind_ptz_positions = [
                            {'v': 0.05999999865889549, 'h': -0.4266666769981384, 'z': 0.0},
                            {'v': 0.119999997317791, 'h': -0.3866666555404663, 'z': 0.0},
                             {'v': 0.239999994635582, 'h': -0.04611111059784889, 'z': 0.0},
                             {'v': 0.2911111116409302, 'h': -0.1372222155332565, 'z': 0.0}
                        ]):
        

        self.session = aiohttp.ClientSession()      
        self.api_imou = ImouAPIClient(APP_ID_IMOU, APP_SECRET_IMOU, self.session)
        connesso = await self.api_imou.async_connect()
        if not connesso:
            raise RuntimeError("Impossibile connettersi al server IMOU")
        
        devices = await self.api_imou.async_api_deviceBaseList()
        self.device_id = [device['deviceId'] for device in devices['deviceList'] if device['deviceId'] == SERIAL_IMOU][0]

        await self.api_imou.async_api_controlLocationPTZ(
            self.device_id, 
            h=base_ptz_positions['h'], 
            v=base_ptz_positions['v'], 
            z=base_ptz_positions['z']
        )

        # CODE FOR USING IMOU API FOR STRAM

        """

        lives = await self.api_imou.async_api_liveList()

         for live in lives["lives"]:
            if live["deviceId"] == self.device_id:
                token = live["liveToken"]
                await self.api_imou.async_api_unbindLive(token)

        await self.api_imou.async_api_bindDeviceLive(self.device_id, camera_quality)
        info = await self.api_imou.async_api_getLiveStreamInfo(self.device_id)      


        urls = {}
        for s in info["streams"]:
            if s["status"] != "1":
                continue
            url_hls = s["hls"]
            if "proto=https" not in url_hls:
                continue
            key = "HD" if s["streamId"] == 0 else "SD"
            urls[key] = url_hls

        self.cap = cv2.VideoCapture(urls[camera_quality])
        if not self.cap.isOpened():
            raise RuntimeError(f"Impossibile aprire il flusso RTSP: {urls['SD']}")
            
        
        """

        ###
        


        camera = ONVIFCamera(CAMERA_IP, 80, "admin", CAMERA_PASSWORD)
        media = camera.create_media_service()

        profiles = media.GetProfiles()
        token = profiles[0].token

        stream_setup = {
            'StreamSetup': {
                'Stream': 'RTP-Unicast',
                'Transport': {'Protocol': 'RTSP'}
            },
            'ProfileToken': token
        }

        uri_response = media.GetStreamUri(stream_setup)
        raw_url = uri_response.Uri

        parsed = urlparse(raw_url)
        auth_url = (
            f"rtsp://admin:{CAMERA_PASSWORD}@"
            f"{parsed.hostname}:{parsed.port}"
            f"{parsed.path}?{parsed.query}"
        )

        self.cap = cv2.VideoCapture(auth_url, cv2.CAP_FFMPEG)
        if not self.cap.isOpened():
            raise RuntimeError(f"Impossibile aprire il flusso RTSP: {auth_url}")
        
        self.frame_reader = FrameReader(self.cap)
        self.frame_reader.start()

        self.server_url = server_url
        self.mov_s = movimento_ms
        self.soglia = soglia
        self.att_auto = attivazione_auto
        self.last_move = self.move_right
        self.tracker = HybridTracker()
        self.processing_lock = asyncio.Lock()  
        self.base_ptz_positions = base_ptz_positions
        self.refind_ptz_positions = refind_ptz_positions

        return self

    async def move_left(self, mv=0):
        if mv == 0: mv = self.mov_s
        await self.api_imou.async_api_controlMovePTZ(self.device_id, "left", mv)
        await asyncio.sleep(mv / 1000 + 0.2)

    async def move_right(self, mv=0):
        if mv == 0: mv = self.mov_s
        await self.api_imou.async_api_controlMovePTZ(self.device_id, "right", mv)
        await asyncio.sleep(mv / 1000 + 0.2)
    
    async def move_up(self, mv=0):
        if mv == 0: mv = self.mov_s
        await self.api_imou.async_api_controlMovePTZ(self.device_id, "up", mv)
        await asyncio.sleep(mv / 1000 + 0.2)
    
    async def move_down(self, mv=0):
        if mv == 0: mv = self.mov_s
        await self.api_imou.async_api_controlMovePTZ(self.device_id, "down", mv)
        await asyncio.sleep(mv / 1000 + 0.2)

    
    async def read(self):
        def _read():
            try:
                return self.frame_reader.read()
            except Exception as e:
                raise ERRORECAMERA(f"Errore nella lettura del frame: {str(e)}")
        
        return await asyncio.to_thread(_read)


    def attivazione(self):
        """
        if self.att_auto:
            try: requests.get(f"{self.server_url}/start")
            except requests.exceptions.ConnectionError: pass
        """
        pass

    async def segui_persona(self):
        async with self.processing_lock:
            frame = await self.read()
            

            def run_tracker(use_large = False):
                return self.tracker.process(frame, use_large)
            
            frame = await self.read()
            bbox, vis = await asyncio.to_thread(run_tracker)

            if not bbox:
                bbox, vis = await asyncio.to_thread(run_tracker)

            if bbox:
                x, y, w, h = bbox
                larg = frame.shape[1]
                centro_x = larg // 2
                alt = frame.shape[0]
                centro_y = alt // 2

                pers_x = (x + x + w) // 2
                pers_y = (y + y + h) // 2

                soglia_dinamica = 50 + (self.soglia * (larg / w))

                if pers_x < centro_x - soglia_dinamica:
                    await self.move_left()
                elif pers_x > centro_x + soglia_dinamica:
                    await self.move_right()

                if pers_y < centro_y - soglia_dinamica:
                    await self.move_up()
                elif pers_y > centro_y + soglia_dinamica:
                    await self.move_down()

            else:
                i = 0
                starting_position = await self.api_imou.async_api_devicePTZInfo(self.device_id)

                def compare(a, b):
                    dv_a = abs(a['v'] - starting_position['v'])
                    dv_b = abs(b['v'] - starting_position['v'])
                    if abs(dv_a - dv_b) <= 0.03:
                        dh_a = abs(a['h'] - starting_position['h'])
                        dh_b = abs(b['h'] - starting_position['h'])
                        return -1 if dh_a < dh_b else (1 if dh_a > dh_b else 0)
                    return -1 if dv_a < dv_b else 1

                self.refind_ptz_positions = sorted(
                    self.refind_ptz_positions,
                    key=cmp_to_key(compare)
                )


                await self.api_imou.async_api_controlLocationPTZ(
                            self.device_id, 
                            h=starting_position['h'], 
                            v=self.base_ptz_positions['v'], 
                            z=starting_position['z']
                        )
                
                
                while True:
                    for m in self.refind_ptz_positions:
                        if i < 5:
                            await self.api_imou.async_api_controlLocationPTZ(self.device_id, v=m['v'], h=m['h'], z=m['z'])
                            
                        elif i == 5:
                            await self.api_imou.async_api_controlLocationPTZ(
                                self.device_id, 
                                h=starting_position['h'], 
                                v=starting_position['v'], 
                                z=starting_position['z']
                            )
                            

                        frame = await self.read()
                        bbox, vis = await asyncio.to_thread(run_tracker, use_large = True) 

                        if bbox:
                            i = -1
                            break

                        await asyncio.sleep(1.3)

                    if i == -1:
                        break

                    i += 1

            await asyncio.sleep(0.3)
                    
            self.attivazione()
            return frame
    
    async def close(self):
        self.cap.release()
        await self.session.close()


doc = Flask(__name__)

def id_generator():
    while True:
        uid = str(uuid.uuid4())
        exts = ['.jpg','.jpeg','.png','.bmp']
        paths = [os.path.join(SAVE_PATH, uid+e) for e in exts]
        if not any(os.path.exists(p) for p in paths): 
            return uid

async def segui():
    while True:
        err_persistente = 10
        try:
            frame = await camera_imou.segui_persona()
            
            data = datetime.now().strftime("%d-%m-%Y %H-%M")
            path_day = os.path.join(SAVE_PATH, data)
            os.makedirs(path_day, exist_ok=True)
            uid = id_generator()
            filename = os.path.join(path_day, f"{uid}.jpg")
            
            def save_image():
                return cv2.imwrite(filename, frame)
            
            await asyncio.to_thread(save_image)

            await asyncio.sleep(0.5)

            err_persistente = 10
        except Exception as e:
            err_persistente -= 1
            if err_persistente <= 0:
                raise e
            print(f"ERRORE nel seguire persona: {e}")
        



@doc.route('/get-photo')
def get_photo():
    data = datetime.now().strftime("%d-%m-%Y %H-%M")
    path_day = os.path.join(SAVE_PATH, data)
    manual = True
    if os.path.exists(path_day):
        jpgs = [f for f in os.listdir(path_day) if f.endswith('.jpg')]
        if jpgs:
            latest = max(jpgs, key=lambda f: os.path.getmtime(os.path.join(path_day,f)))
            uid = latest.split(".")[0]
            frame = cv2.imread(os.path.join(path_day,latest))
            manual = False
    if manual:
        try:
            frame = camera_imou.frame_reader.read()
            uid = id_generator()
            os.makedirs(path_day, exist_ok=True)
            cv2.imwrite(os.path.join(path_day, f"{uid}.jpg"), frame)
        except Exception as e:
            return jsonify({'err': f"{e}"}), 500
            
    ret, buf = cv2.imencode('.jpg', frame)
    if request.args.get('only_photo') is not None:
        return Response(buf.tobytes(), mimetype='image/jpeg')
    return jsonify({'id': uid, 'image': buf.tobytes().decode('latin1')})


@doc.route('/')
def index():
    return '''
    <a href="/recalibrate">Recalibrate</a> |
    <a href="/toggle-auto">Toggle Automazione</a>
    '''

def RUN(config_path='config.json', server='http://localhost'):
    
    global camera_imou

    camera_imou = CameraImou()

    with open(config_path, "r") as config_file:
        config_dict = json.load(config_file)['SERVER_PHOTO']

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    loop.run_until_complete(camera_imou.init(
        SERIAL_IMOU=config_dict["serial_imou"],
        APP_ID_IMOU=config_dict["app_id_imou"],
        APP_SECRET_IMOU=config_dict["app_secret_imou"],
        CAMERA_IP=config_dict["camera_ip"],
        CAMERA_PASSWORD=config_dict["camera_password"],
        server_url=server,
    ))
    
    asyncio_thread = threading.Thread(
        target=lambda: loop.run_until_complete(segui()),
        daemon=True
    )
    asyncio_thread.start()

    doc.run(host='0.0.0.0', port=config_dict["port"])
    
        




if __name__ == '__main__':
    RUN()
    






