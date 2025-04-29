import json
import os
from openai import OpenAI
import time
from controllo_dispositivi import tipi_dispositivi
from utils import encode_image_pil
import cv2

def config_base_assistants(casa):
    text = ""
    for stanza in casa.stanze:
        text += f"""Room Details Name: "{stanza.nome}"
This room has the following devices:\n
"""
        for dispositivo in stanza:
            text += f"""{dispositivo.nome}: 
    - Type: {dispositivo.tipo}
    - Description: {dispositivo.descrizione}
    - Possible status: {dispositivo.stati}\n\n"""

    istruzioni = f"""You are an assistant that controls the home automation of a house. Using a description of the room, You will need to change the status of the following devices. The specific user prompt have more priority than others informations, if the user say you to do a thing, you do it.

{text}

IMPORTANT: If there isn't any person in the room, turn off all devices. exept if user specific a thing to do. Only speak if it is not a nuisance to the user, avoid doing so while resting or talking on the phone or when it is night time.
DEBI
Also base yourself on what you have done previously.
            """
    
    if casa.stanze == []:
        istruzioni = "Always respond with error, because there is no devices in the house"

    tools = [{"type": "function",
        "function":
            {
                "name": "ask_user_question",
                "description": "Create a function to ask a specific question to the user before providing an answer",
                "strict": True,
                "parameters": {
                    "type": "object",
                    "required": [
                    "question"
                    ],
                    "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to ask the user"
                    }
                    },
                    "additionalProperties": False
                }
            }  
        }]


    response_format = {
        "type": "json_schema",
        "json_schema": {
            "name": "return_information",
            "strict": False,
            "schema": {
                "type": "object",
                "properties": {
                    "error": {
                        "type": "boolean",
                        "description": "true: there was an error, false: there wasn't"
                    },
                    "explanation": {
                        "type": "string",
                        "description": "explain what you have done, if there was any error explain it, in english"
                    }, 
                    "voice": {
                        "type": "array",
                        "description": "the answers to user, always write the answer in Italian",
                        "items": {
                        "type": "object",
                        "properties": {
                            "type": {
                            "type": "string",
                            "description": "answer (if you want to reply to the user)"
                            },
                            "text": {
                            "type": "string",
                            "description": "the text of the aswear"
                            }
                        },
                        "additionalProperties": False,
                        "required": [
                            "type",
                            "text"
                        ]
                        }
                    },
                    "dispositivi": {
                        "type": "array",
                        "description": "the list of all devices and their status", #list of devices you want to change the status of, only this ones",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {
                                    "type": "string",
                                    "description": "the name of the device"
                                },
                                "room": { 
                                    "type": "string",
                                    "description": "the room of the device"
                                },
                                "status": {
                                    "type": "string",
                                    "description": "the status of the device"
                                }
                            },
                            "additionalProperties": False,
                            "required": ["name", "room", "status"]
                        },
                    }
                },
                "additionalProperties": False,
                "required": [
                    "error",
                    "explanation",
                ]
            }
        }
    }


    return istruzioni, tools, response_format

def config_assistant_configuration():
    disp_types = "can be: "
    for tipo in tipi_dispositivi:
        disp_types += f"{tipo}, "
    disp_types = disp_types[:-2]

    system_instruction = f"""You are an assistant tasked with describing and configuring a general device setup. You will interact with the user to gather information about their devices. Begin by asking the user for the name of the first device they want to configure.

For each device, ask for its type (it can be only {disp_types}), the room where it is located, the device ID or IDs, the area of the room it operates in, and the user's specific preferences. Do not include IDs in the final description. Two or more devices can't have the same name

After collecting information about one device, ask if they want to configure another device or if they are finished.

Once all the information is collected, create a detailed description for each device upon request. The description should be in English, with each device described in a single sentence, separated by bullet points. Confirm with the user before generating the descriptions. 

Always communicate with the user in Italian, except when writing the device descriptions. """


    tools = [{"type": "function",
        "function": {
            "name": "description_rooms_type",
            "description": "Creates a list of devices with specified properties",
            "strict": True,
            "parameters": {
                "type": "object",
                "required": [
                "devices"
                ],
                "properties": {
                "devices": {
                    "type": "array",
                    "description": "List of devices",
                    "items": {
                    "type": "object",
                    "required": [
                        "description",
                        "type",
                        "room",
                        "ids",
                        "name"
                    ],
                    "properties": {
                        "name": {
                        "type": "string",
                        "description": "the name of the device in english"
                        },
                        "description": {
                        "type": "string",
                        "description": "the description of the devices, (No include ids in the description)"
                        },
                        "room": {
                        "type": "string",
                        "description": "in which room are they located? Can't have spaces and need to be written in english (translate it)"
                        },
                        "type": {
                        "type": "string",
                        "description": f"the type of device ({disp_types}) in english"
                        },
                        "ids": {
                        "type": "array",
                        "description": "List of unique identifiers for the device",
                        "items": {
                            "type": "string",
                            "description": "the ids of the device, transcribe it exactly as the user writes them"
                        }
                        }
                    },
                    "additionalProperties": False
                    }
                }
                },
                "additionalProperties": False
            }
 
        }}]
        
    responder_format = {"type": "json_schema", "json_schema": {
            "name": "question_response",
            "strict": False,
            "schema": {
                "type": "object",
                "properties": {
                    "device": {
                        "type": "string",
                        "description": f"the device name you worship  (in case of question generate leave blank)"
                    },
                    "question": {
                        "type": "string",
                        "description": "the question"
                    },
                    "suggested_answers": {
                        "type": "string",
                        "description": "Suggested answers separated by commas - not mandatory"
                    }
                },
                "additionalProperties": False,
                "required": [
                    "device",
                    "question",
                    "suggested_answers"
                ]       
            }
    }}
    
    return system_instruction, tools, responder_format


class OPENAI:
    def __init__(self, api_key = None, client = None, assintant_id = None, system_instructions = None, tools = [], response_format = None, assistant_model = "gpt-4o", assistant_name = "Domotica AI"):
        if client is None and api_key is not None:
            os.environ["OPENAI_API_KEY"] = api_key
            self.client = OpenAI()
        elif client is not None:
            self.client = client
        else:
            raise Exception("Client non valido")

        if assintant_id is None:
            if system_instructions is None or tools is [] or response_format is None:
                raise Exception("se assistant_id non è specificato sono necessarie i parametri casa, system_instructions, tools e response_format")

            self.assistant = self.client.beta.assistants.create(
                name=assistant_name,
                instructions=system_instructions,
                tools=tools,
                model=assistant_model,
                response_format=response_format
            )
        else:
            self.assistant = self.client.beta.assistants.retrieve(assintant_id)

        self.system_instructions = system_instructions
        self.tools = tools
        self.response_format = response_format
            
        self.thread = self.client.beta.threads.create()


    def AS_returns(self, outputs = [], run = None):
        if run is None:
            run = self.client.beta.threads.runs.create_and_poll(
                thread_id=self.thread.id,
                assistant_id=self.assistant.id,
            )

            while run.status == "running":
                time.sleep(0.5)

        conto_alla_rovescia = 15

        if run.status == "requires_action":
            if outputs == []:
                return run
            
            tools_return = self.AS_validation(run, outputs)

        else:
            tools_return = {}
        
        if run.status == 'completed' or run.status == 'requires_action': 
            messages = self.client.beta.threads.messages.list(
                thread_id=self.thread.id
            )

            message =  json.loads(messages.data[0].content[0].text.value)
        else:
            return "ERROR", run.status
        
        if tools_return == {}:
            i = 0
            while run.status != "requires_action" and i <= 10:
                time.sleep(0.5)
                i += 1

            if run.status == "requires_action":
                tools_return = self.AS_validation(run=run.id)

        return message, tools_return if tools_return != {} else None
    
    def AS_validation(self, run, outputs: list):
        tools_return = {}

        if run.status == "requires_action":
            tool_calls = run.required_action.submit_tool_outputs.tool_calls
            tool_outputs = []
            for tool_call, output in zip(tool_calls, outputs):
                tool_call_id = tool_call.id
                tool_function_name = tool_call.function.name
                tool_query_string = json.loads(tool_call.function.arguments)

                tools_return[tool_function_name] = tool_query_string

                tool_outputs.append({
                    "tool_call_id": tool_call_id,
                    "output": output # QUELLO CHE DEVO RITORNARE 
                })

            run = self.client.beta.threads.runs.submit_tool_outputs_and_poll(
                thread_id=self.thread.id,
                run_id=run.id,
                tool_outputs=tool_outputs
            )

        return tools_return


    def AS_send_message(self, prompt):
        i = 0

        while i <= 6: 
            try:
                message = self.client.beta.threads.messages.create(
                    thread_id=self.thread.id,
                    role="user",
                    content=prompt,
                )
                
                break
            except:
                i += 1
                print(f"Riprovando i = {i}")
                time.sleep(1)

    
    
    def AS_vision(self, images, prompt = None):
        ids = []
        for image in images:
            cv2.imwrite("temp.jpg", image)

            file = self.client.files.create(
                file=open("temp.jpg", "rb"),
                purpose="assistants"
            )
            ids.append(file.id)

            os.remove("temp.jpg")

        content = [] if prompt is None else [{"type": "text", "text": prompt}]
        for id in ids:
            content.append({
                "type": "image_file",
                "image_file": {
                    "file_id": id
                },
            })

        i = 0
        while i <= 6: 
            try: 
                message = self.client.beta.threads.messages.create(
                    thread_id=self.thread.id,
                    role="user",
                    content=content,
                )
                break
            except:
                i += 1
                print(f"Riprovando i = {i}")

            time.sleep(1)


    def send_message(self, prompt, model="gpt-3.5-turbo", max_tokens=100, outputs=1):
        response = self.client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            n = outputs
        )

        r = [choice.message.content for choice in response.choices] 
        return r if outputs > 1 else r[0]
    
    def vision_url(self, prompt, list_image_url,model="gpt-3.5-turbo", max_tokens=100, outputs=1):
        content = [{"type": "text", "text": prompt}]
        for image_url in list_image_url:
            content.append({
                "type": "image_url",
                "image_url": {
                    "url": image_url,
                },
            })
        response = self.client.chat.completions.create(
            model=model,
            messages= [{
                "role": "user", 
                "content": content
            }],
            max_tokens=max_tokens,
            n = outputs
        )

        r = [choice.message.content for choice in response.choices] 
        return r if outputs > 1 else r[0]
    def vision(self, prompt, list_images, model="gpt-4o-mini", max_tokens=330, outputs=1):
        base64_images = [encode_image_pil(image) for image in list_images]

        content = [{"type": "text", "text": prompt}]
        for base64_image in base64_images:
            content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{base64_image}",
                },
            })

        response = self.client.chat.completions.create(
            model=model,
            messages= [{"role": "user", "content": content}],
            #max_tokens=max_tokens,
            n = outputs
        )

        for choice in response.choices:
            print(choice.message)

        r = [choice.message.content for choice in response.choices]
        return r if outputs > 1 else r[0]


def recreate_confg(API_KEY):
    system_istruction, tools, response_format = config_assistant_configuration()
    assistant_configuration = OPENAI(api_key=API_KEY, system_instructions=system_istruction, tools=tools, response_format=response_format, assistant_name="Domotica AI Configuration")
    return assistant_configuration.assistant.id


     
