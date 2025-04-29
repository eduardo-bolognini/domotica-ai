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

from ultralytics import YOLO
import mediapipe as mp

YOLO_model = YOLO("yolov8n.pt")

mp_drawing = mp.solutions.drawing_utils
mp_pose = mp.solutions.pose

def pose_detection_and_blurring(cv2_image):    
    h, w = cv2_image.shape[:2]
    
    scale_factor = 2
    scaled_image = cv2.resize(cv2_image, (w * scale_factor, h * scale_factor))
    
    with mp_pose.Pose(
        static_image_mode=True,
        model_complexity=2,
        enable_segmentation=True,
        min_detection_confidence=0.3) as pose:
        
        results = pose.process(cv2.cvtColor(scaled_image, cv2.COLOR_BGR2RGB))
        
        if not results.pose_landmarks:
            return cv2_image, False

        mask = (results.segmentation_mask > 0.1).astype(np.uint8)
        blurred = cv2.GaussianBlur(scaled_image, (99, 99), 30)
        scaled_processed = np.where(mask[..., None], blurred, scaled_image)
        
        scaled_processed_rgb = cv2.cvtColor(scaled_processed, cv2.COLOR_BGR2RGB)
        mp_drawing.draw_landmarks(
            scaled_processed_rgb,
            results.pose_landmarks,
            mp_pose.POSE_CONNECTIONS,
            landmark_drawing_spec=mp_drawing.DrawingSpec(
                color=(0, 255, 0), thickness=3, circle_radius=3),            
            connection_drawing_spec=mp_drawing.DrawingSpec(
                color=(255, 0, 0), thickness=5))
        
        scaled_processed = cv2.cvtColor(scaled_processed_rgb, cv2.COLOR_RGB2BGR)
        resized_back = cv2.resize(scaled_processed, (w, h))
    
    return resized_back, True

def blur_detected_poses(cv2_image):
    results = YOLO_model(cv2_image)
    image = cv2_image.copy()
    people = False
    
    for result in results:
        boxes = result.boxes  
        for box in boxes:
            if box.cls == 0:
                xmin, ymin, xmax, ymax = map(int, box.xyxy[0].tolist())
                
                if xmax <= xmin or ymax <= ymin:
                    continue
                
                try:
                    cropped_region = image[ymin:ymax, xmin:xmax]
                    blurred_region, success = pose_detection_and_blurring(cropped_region)
                    
                    if success:
                        image[ymin:ymax, xmin:xmax] = blurred_region
                    else: 
                        blurred = cv2.GaussianBlur(cropped_region, (99, 99), 30)
                        h, w = blurred.shape[:2]
                        
                        center_x, center_y = w // 2, h // 2
                        head_radius = h // 10
                        body_length = h // 3
                        arm_length = w // 4
                        leg_length = h // 4

                        # Draw stick figure
                        cv2.line(blurred, (center_x, center_y - body_length//2), 
                                (center_x, center_y + body_length//2), (0, 0, 255), 5)
                        cv2.line(blurred, (center_x, center_y - body_length//2), 
                                (center_x - arm_length, center_y - body_length//2 - arm_length//5), 
                                (0, 0, 255), 10)
                        cv2.line(blurred, (center_x, center_y - body_length//2), 
                                (center_x + arm_length, center_y - body_length//2 - arm_length//5), 
                                (0, 0, 255), 10)
                        cv2.line(blurred, (center_x, center_y + body_length//2), 
                                (center_x - leg_length, center_y + body_length//2 + leg_length//2), 
                                (0, 0, 255), 10)
                        cv2.line(blurred, (center_x, center_y + body_length//2), 
                                (center_x + leg_length, center_y + body_length//2 + leg_length//2), 
                                (0, 0, 255), 10)
                        cv2.ellipse(blurred, 
                                   (center_x, center_y - body_length//2 - head_radius), 
                                   (head_radius, head_radius), 0, 0, 360, (0, 0, 255), 10)

                        image[ymin:ymax, xmin:xmax] = blurred

                    cv2.rectangle(image, (xmin, ymin), (xmax, ymax), (0, 0, 255), 3)
                    people = True 

                except Exception as e:
                    print(f"Errore nell'elaborazione della regione: {e}")

    return image, people

