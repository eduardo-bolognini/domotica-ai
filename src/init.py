# __init__.py
import multiprocessing
import subprocess

def start_process(script_name):
    subprocess.run(["python", script_name])

if __name__ == "__main__":
    # Avvia il processo per main.py
    process_main = multiprocessing.Process(target=start_process, args=("main.py",))
    process_main.start()
    
    # Avvia il processo per server_photo.py
    process_server_photo = multiprocessing.Process(target=start_process, args=("server_photo.py",))
    process_server_photo.start()
    
    # Aspetta che i processi finiscano
    process_main.join()
    process_server_photo.join()

