from PIL import Image
import os
import torch
from transformers import BlipProcessor, BlipForConditionalGeneration
import pandas as pd
from torch.utils.data import Dataset, DataLoader
import json
from datasets import load_dataset

def generate(repo_id, image: Image):
    model = BlipForConditionalGeneration.from_pretrained(repo_id).to("mps" if torch.mps.is_available() else "cpu")
    processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-large")

    image = image.convert("RGB")
    inputs = processor(images=image, return_tensors="pt").to("mps" if torch.mps.is_available() else "cpu")
    pixel_values = inputs.pixel_values

    generated_ids = model.generate(pixel_values=pixel_values, max_length=50)
    generated_caption = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]

    return generated_caption

class ImageCaptioningDataset(Dataset):
    def __init__(self, dataset, processor):
        self.dataset = dataset
        self.processor = processor

    def __len__(self):
        return len(self.dataset)

    def __getitem__(self, idx):
        item = self.dataset[idx]
        encoding = self.processor(images=item["image"], text=item["text"], padding="max_length", return_tensors="pt")
        encoding = {k:v.squeeze() for k,v in encoding.items()}
        return encoding

def train(dataset: pd.DataFrame, dataset_path: str, n_epochs: int, repo_id: str, private: bool):
    processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-large")
    model = BlipForConditionalGeneration.from_pretrained("Salesforce/blip-image-captioning-large").to("mps" if torch.mps.is_available() else "cpu")

    dataset_train = dataset
    
    if len(dataset_train) % 2 != 0:
        raise Exception("numero di dati dispari")

    if not os.path.exists(dataset_path):
        os.makedirs(dataset_path)

    jsonl = []

    for i, row in dataset_train.iterrows():
        image = Image.open(row["image_path"]).convert("RGB")
        image.save(f"{dataset_path}/{i}.jpg")
        jsonl.append({
            "file_name": f"{i}.jpg",
            "text": row["caption_openai"].lower()
        })

    with open(f"{dataset_path}/metadata.jsonl", "w") as f:
        for item in jsonl:
            f.write(json.dumps(item) + "\n")

    dataset = load_dataset('imagefolder', data_dir='images', split='train')
    train_dataset = ImageCaptioningDataset(dataset, processor)
    train_dataloader = DataLoader(train_dataset, shuffle=True, batch_size=2)

    optimizer = torch.optim.AdamW(model.parameters(), lr=5e-5)
    device = "mps" if torch.mps.is_available() else "cpu"
    model.to(device)
    model.train()

    losses = []

    for epoch in range(n_epochs):
        print("Epoch:", epoch)
        for idx, batch in enumerate(train_dataloader):
            try:
                input_ids = batch.pop("input_ids").to(device)
                pixel_values = batch.pop("pixel_values").to(device)

                outputs = model(input_ids=input_ids, pixel_values=pixel_values, labels=input_ids)
                loss = outputs.loss
                print("Loss:", loss.item())

                if loss.item() < 0.5 and epoch >= 1:
                    model.push_to_hub(repo_id, private=private)
                    print("loss buona")
                    raise KeyboardInterrupt("loss buona")

                losses.append(loss.item())
                loss.backward()
                optimizer.step()
                optimizer.zero_grad()
                model.save_pretrained("model")

            except KeyboardInterrupt as e:
                print(e)
                model.save_pretrained("model")
                model.push_to_hub(repo_id, private=private)
                return 

    model.push_to_hub(repo_id, private=private)

dataset = pd.read_csv("YOUR CSV TRAINING", comment="#")
train(dataset, "images/train", 4 , "YOUR MODEL REPOSITORY ON HUGGING FACE", True)
