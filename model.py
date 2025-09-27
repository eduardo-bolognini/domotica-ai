from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np
import timm
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image
from torchvision import transforms as T
from ultralytics import YOLO


# ==========================================================
# CONFIGURATION
# ==========================================================

_ROOT = Path(__file__).resolve().parent
DEFAULT_BUNDLE_PATH = _ROOT / "model_definitive.pth"

_MODEL_CACHE = {
    "path": None,
    "device": None,
    "model": None,
}


def _select_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ==========================================================
# MODELS
# ==========================================================


class FocalLoss(nn.Module):
    def __init__(self, gamma: float = 2.0, alpha=None, reduction: str = "mean", ignore_index: int = -100):
        super().__init__()
        self.gamma = gamma
        self.reduction = reduction
        self.ignore_index = ignore_index
        self.alpha = torch.as_tensor(alpha, dtype=torch.float32) if alpha is not None else None

    def forward(self, logits: torch.Tensor, targets: torch.Tensor):
        ce = F.cross_entropy(
            logits,
            targets,
            reduction="none",
            ignore_index=self.ignore_index,
            weight=self.alpha.to(logits.device) if self.alpha is not None else None,
        )
        pt = torch.exp(-ce)
        loss = (1 - pt) ** self.gamma * ce

        if self.ignore_index >= 0:
            valid = targets != self.ignore_index
            loss = loss[valid]

        if self.reduction == "mean":
            return loss.mean()
        if self.reduction == "sum":
            return loss.sum()
        return loss


class ActivityClassifier(nn.Module):
    def __init__(self, num_classes: int, device: str = "cpu", gamma: float = 2.0, alpha=None):
        super().__init__()
        self.device = device
        self.num_classes = num_classes

        self.backbone = timm.create_model(
            "efficientnet_b0",
            pretrained=True,
            num_classes=0,
            global_pool="",
        ).to(self.device)
        self.backbone.eval()

        self.adaptive_pool = nn.AdaptiveAvgPool2d((1, 1))
        embed_dim = 1280
        self.classifier = nn.Linear(embed_dim, num_classes).to(self.device)

        self.preprocess = T.Compose(
            [
                T.ToTensor(),
                T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            ]
        )

        self.criterion = FocalLoss(gamma=gamma, alpha=alpha, reduction="mean")

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        with torch.no_grad():
            features = self.backbone(images)
            pooled = self.adaptive_pool(features)
            embeddings = pooled.flatten(1)
        return self.classifier(embeddings)

    def predict(self, image: Image.Image, return_prob: bool = False):
        self.eval()
        with torch.no_grad():
            img_tensor = self.preprocess(image).unsqueeze(0).to(self.device)
            logits = self.forward(img_tensor)
            if return_prob:
                probs = F.softmax(logits, dim=1)
                return probs.argmax(dim=1).item(), probs.squeeze()
            return logits.argmax(dim=1).item()


class YOLOPersonDetector:
    def __init__(self, weights_path: str, device: str = "cpu", person_class: int = 0, iou: float = 0.5):
        self.model = YOLO(weights_path)
        self.model.to(device)
        self.device = torch.device(device)
        self.person_class = person_class
        self.iou = iou
        self.num_classes = 1
        self._weights_path = weights_path

    @staticmethod
    def _to_numpy(image_tensor: torch.Tensor) -> np.ndarray:
        image_tensor = image_tensor.detach().cpu()
        arr = image_tensor
        if arr.dtype != torch.uint8:
            arr = arr.clamp(0, 255)
            if arr.max() <= 1.0:
                arr = arr * 255.0
            arr = arr.byte()
        return arr.permute(1, 2, 0).contiguous().numpy()

    def predict(self, image: torch.Tensor, score_threshold: float = 0.5):
        np_img = self._to_numpy(image)
        results = self.model.predict(
            source=np_img,
            conf=score_threshold,
            iou=self.iou,
            verbose=False,
            device=self.device,
        )
        res = results[0]
        if res.boxes is None or len(res.boxes) == 0:
            empty = torch.empty((0, 4), dtype=torch.float32)
            return {"boxes": empty, "scores": torch.empty((0,), dtype=torch.float32)}

        boxes_xyxy = res.boxes.xyxy
        confs = res.boxes.conf
        clss = res.boxes.cls

        keep = clss == self.person_class
        boxes_xyxy = boxes_xyxy[keep].detach().cpu()
        confs = confs[keep].detach().cpu()
        return {"boxes": boxes_xyxy, "scores": confs}


class DomoticaAI(nn.Module):
    def __init__(
        self,
        person_detector,
        activity_classifier,
        num_sensor: int,
        num_prev_actions: int,
        num_output_actions: int,
        num_output_params: int,
        num_input_images: int = 3,
        embedding_dim: int = 128,
        prev_action_emb_dim: int = 64,
        action_emb_dim: int = 64,
        max_persons: int = 10,
        device: str = "cpu",
        action_vocab: Optional[Dict[str, int]] = None,
        param_vocab: Optional[Dict[str, int]] = None,
        prev_vocab: Optional[Dict[str, int]] = None,
    ):
        super().__init__()
        self.device = torch.device(device)

        self.num_sensor = num_sensor
        self.num_prev_actions = num_prev_actions
        self.num_output_actions = num_output_actions
        self.num_output_params = num_output_params
        self.num_input_images = num_input_images
        self.embedding_dim = embedding_dim
        self.prev_action_emb_dim = prev_action_emb_dim
        self.action_emb_dim = action_emb_dim
        self.max_persons = max_persons

        self.person_detector = person_detector
        self.activity_classifier = activity_classifier.to(self.device).eval()

        self.activity_embeddings = nn.ModuleList(
            [nn.Embedding(self.activity_classifier.num_classes, embedding_dim) for _ in range(num_input_images)]
        )
        self.no_person_embeddings = nn.ParameterList(
            [nn.Parameter(torch.zeros(embedding_dim), requires_grad=True) for _ in range(num_input_images)]
        )
        self.sensor_embeddings = nn.ModuleList([
            nn.Linear(num_sensor, embedding_dim) for _ in range(num_input_images)
        ])

        self.temporal_weights = nn.Parameter(torch.ones(num_input_images))
        self.image_lstm = nn.LSTM(embedding_dim, embedding_dim, batch_first=True)
        self.temporal_lstm = nn.LSTM(embedding_dim, embedding_dim, batch_first=True)

        self.prev_action_embedding = nn.Embedding(num_prev_actions, prev_action_emb_dim)
        self.prev_action_lstm = nn.LSTM(prev_action_emb_dim, 128, batch_first=True)

        combined_dim = embedding_dim + 128
        self.ln = nn.LayerNorm(combined_dim)
        self.drop = nn.Dropout(0.3)
        self.fc_act = nn.Linear(combined_dim, num_output_actions)
        self.act_emb = nn.Embedding(num_output_actions, action_emb_dim)
        self.fc_par = nn.Linear(combined_dim + action_emb_dim, num_output_params)

        self.to(self.device)

        if action_vocab is None:
            action_vocab = {str(i): i for i in range(num_output_actions)}
        if param_vocab is None:
            param_vocab = {str(i): i for i in range(num_output_params)}
        if prev_vocab is None:
            prev_vocab = {str(i): i for i in range(num_prev_actions)}
        self._attach_vocabs(action_vocab, param_vocab, prev_vocab)

    def _attach_vocabs(
        self,
        action_vocab: Dict[str, int],
        param_vocab: Dict[str, int],
        prev_vocab: Dict[str, int],
    ):
        self.action_vocab = dict(action_vocab)
        self.param_vocab = dict(param_vocab)
        self.prev_vocab = dict(prev_vocab)

        self.i2a = {idx: name for name, idx in self.action_vocab.items()}
        self.i2p = {idx: name for name, idx in self.param_vocab.items()}
        self.i2prev = {idx: name for name, idx in self.prev_vocab.items()}

        if len(self.action_vocab) != self.num_output_actions:
            print(
                f"[WARN] action_vocab size ({len(self.action_vocab)}) != num_output_actions ({self.num_output_actions})"
            )
        if len(self.param_vocab) != self.num_output_params:
            print(
                f"[WARN] param_vocab size ({len(self.param_vocab)}) != num_output_params ({self.num_output_params})"
            )
        if len(self.prev_vocab) != self.num_prev_actions:
            print(
                f"[WARN] prev_vocab size ({len(self.prev_vocab)}) != num_prev_actions ({self.num_prev_actions})"
            )

    def crop(self, image: torch.Tensor, bbox: torch.Tensor):
        to_pil = T.ToPILImage()
        pil = to_pil(image)
        x1, y1, x2, y2 = bbox.cpu().numpy().astype(int)
        w, h = x2 - x1, y2 - y1
        pad_x, pad_y = int(w * 0.3), int(h * 0.3)
        x1f, y1f = max(0, x1 - pad_x), max(0, y1 - pad_y)
        x2f = min(pil.width, x2 + pad_x)
        y2f = min(pil.height, y2 + pad_y)
        return pil.crop((x1f, y1f, x2f, y2f))

    def process_single_image(self, image: torch.Tensor, sensor_vec: torch.Tensor, timestep: int):
        det = self.person_detector.predict(image, score_threshold=0.5)
        boxes, scores = det["boxes"], det["scores"]
        if len(boxes) > self.max_persons:
            idx = torch.topk(scores, self.max_persons).indices
            boxes = boxes[idx]

        acts = []
        for box in boxes:
            sub = self.crop(image, box)
            acts.append(self.activity_classifier.predict(sub))

        if acts:
            cls_t = torch.tensor(acts, device=self.device)
            emb = self.activity_embeddings[timestep](cls_t)
            if emb.dim() == 1:
                emb = emb.unsqueeze(0)
            emb_input = emb.unsqueeze(0)
            _, (h_img, _) = self.image_lstm(emb_input)
            img_repr = h_img[-1, 0, :]
        else:
            no_person_emb = self.no_person_embeddings[timestep]
            no_person_input = no_person_emb.unsqueeze(0).unsqueeze(0)
            _, (h_img, _) = self.image_lstm(no_person_input)
            img_repr = h_img[-1, 0, :]

        sensor_emb = self.sensor_embeddings[timestep](sensor_vec.to(self.device))
        return img_repr + sensor_emb

    def forward(
        self,
        images: List[List[torch.Tensor]],
        sensor_data: List[List[torch.Tensor]],
        prev_action_seq: torch.Tensor,
    ):
        batch_size = len(images)
        t_steps = self.num_input_images
        reps = []

        for i in range(batch_size):
            step_reprs = []
            for t in range(t_steps):
                img = images[i][t].to(self.device)
                sensor_vec = sensor_data[i][t].to(self.device)
                step_repr = self.process_single_image(img, sensor_vec, t)
                step_reprs.append(step_repr)
            seq = torch.stack(step_reprs, dim=0)
            weights = torch.softmax(self.temporal_weights, dim=0).view(-1, 1)
            seq_w = (seq * weights).unsqueeze(0)
            _, (h_t, _) = self.temporal_lstm(seq_w)
            reps.append(h_t.squeeze(0).squeeze(0))

        img_r = torch.stack(reps, dim=0)

        prev_emb = self.prev_action_embedding(prev_action_seq.to(self.device))
        _, (h_p, _) = self.prev_action_lstm(prev_emb)
        prev_r = h_p[-1]

        combined = torch.cat([img_r, prev_r], dim=-1)
        combined = self.ln(combined)
        combined = self.drop(combined)

        logits = self.fc_act(combined)
        act_emb = torch.matmul(torch.softmax(logits, dim=-1), self.act_emb.weight)
        params = self.fc_par(torch.cat([combined, act_emb], dim=-1))
        return logits, params

    def predict(self, images, sensor_data, prev_action_seq, threshold: float = 0.5):
        self.eval()
        with torch.no_grad():
            logits, params = self.forward(images, sensor_data, prev_action_seq)
            action_id = logits.argmax(dim=-1).item()
            action_name = self.i2a.get(action_id, str(action_id))
            param_vec = params.squeeze(0)
            filtered = {
                self.i2p[i]: v.item()
                for i, v in enumerate(param_vec)
                if v.item() > threshold
            }
            return action_id, action_name, filtered

    def idx_to_action(self, idx: int) -> str:
        return self.i2a.get(idx, str(idx))

    def vec_to_params(self, param_scores: torch.Tensor, threshold: float = 0.5) -> List[str]:
        param_scores = param_scores.detach().cpu().flatten()
        return [self.i2p[i] for i, v in enumerate(param_scores) if float(v) > threshold]

    @classmethod
    def load_singlefile(cls, bundle_path: str):
        package = torch.load(bundle_path, map_location="cpu")
        cfg = package["cfg"]
        device = cfg.get("device", "cpu")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".pt") as tmp:
            tmp.write(package["yolo_bytes"])
            tmp_path = tmp.name

        try:
            person_detector = YOLOPersonDetector(weights_path=tmp_path, device=device)
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

        num_cls = cfg.get("activity_num_classes", 500)
        activity_classifier = ActivityClassifier(num_classes=num_cls, device=device)
        activity_classifier.classifier.load_state_dict(package["activity_state"])
        activity_classifier.to(device)

        vocabs = package.get("vocab", {})
        action_vocab = vocabs.get("action_vocab")
        param_vocab = vocabs.get("param_vocab")
        prev_vocab = vocabs.get("prev_vocab")

        model = cls(
            person_detector=person_detector,
            activity_classifier=activity_classifier,
            num_sensor=cfg["num_sensor"],
            num_prev_actions=cfg["num_prev_actions"],
            num_output_actions=cfg["num_output_actions"],
            num_output_params=cfg["num_output_params"],
            num_input_images=cfg["num_input_images"],
            embedding_dim=cfg["embedding_dim"],
            prev_action_emb_dim=cfg["prev_action_emb_dim"],
            action_emb_dim=cfg["action_emb_dim"],
            max_persons=cfg["max_persons"],
            device=device,
            action_vocab=action_vocab,
            param_vocab=param_vocab,
            prev_vocab=prev_vocab,
        )

        model.load_state_dict(package["core_state"], strict=True)
        model.to(device)
        model.eval()
        print(f"[OK] Bundle caricato da: {bundle_path} su device {device}")
        return model


# ==========================================================
# UTILITIES
# ==========================================================


_to_tensor = T.ToTensor()


def _load_one_image(path: str) -> torch.Tensor:
    if not os.path.exists(path):
        raise FileNotFoundError(f"Immagine non trovata: {path}")
    img = Image.open(path).convert("RGB")
    return _to_tensor(img)


def _prev_names_to_ids(prev_action_names: Optional[Sequence[str]], model: DomoticaAI, device: torch.device, seq_len: int):
    tok2id = getattr(model, "prev_vocab", {}) or {}
    none_id = tok2id.get("<NONE>", 0)
    names = list(prev_action_names or [])[-seq_len:]
    if len(names) < seq_len:
        names = ["<NONE>"] * (seq_len - len(names)) + names
    ids = [tok2id.get(name, none_id) for name in names]
    return torch.tensor([ids], dtype=torch.long, device=device)


def _make_inputs(
    image_paths: Sequence[str],
    model: DomoticaAI,
    device: torch.device,
    prev_action_names: Optional[Sequence[str]] = None,
    prev_seq_len: int = 8,
    sensor_fill: float = 0.0,
):
    num_steps = model.num_input_images
    if len(image_paths) != num_steps:
        raise ValueError(f"Servono esattamente {num_steps} immagini, ricevute {len(image_paths)}")

    imgs_per_t = [_load_one_image(p).to(device) for p in image_paths]
    images = [imgs_per_t]

    sensors_per_t = [
        torch.full((model.num_sensor,), float(sensor_fill), device=device)
        for _ in range(num_steps)
    ]
    sensor_data = [sensors_per_t]

    prev_action_seq = _prev_names_to_ids(prev_action_names, model, device, prev_seq_len)
    return images, sensor_data, prev_action_seq


def load_model(bundle_path: Optional[str] = None, device: Optional[str] = None) -> DomoticaAI:
    bundle = Path(bundle_path) if bundle_path else DEFAULT_BUNDLE_PATH
    if not bundle.exists():
        raise FileNotFoundError(f"Bundle non trovato: {bundle}")

    target_device = torch.device(device or _select_device())

    if (
        _MODEL_CACHE["model"] is not None
        and _MODEL_CACHE["path"] == bundle
        and _MODEL_CACHE["device"] == target_device.type
    ):
        return _MODEL_CACHE["model"]

    model = DomoticaAI.load_singlefile(str(bundle))

    if model.device.type != target_device.type:
        model.to(target_device)
        model.device = target_device
        model.activity_classifier.to(target_device)
        model.person_detector.model.to(target_device)
        model.person_detector.device = target_device

    _MODEL_CACHE.update({"path": bundle, "device": target_device.type, "model": model})
    return model


# ==========================================================
# PREDICTION INTERFACE
# ==========================================================

def predict(
    image_paths: Sequence[str],
    prev_action_names: Optional[Sequence[str]] = None,
    threshold: float = 0.5,
    bundle_path: Optional[str] = None,
    device: Optional[str] = None,
) -> List[str]:
    """Esegue una singola predizione e restituisce [azione, parametri...]."""

    model = load_model(bundle_path=bundle_path, device=device)
    device_obj = model.device

    images, sensor_data, prev_action_seq = _make_inputs(
        image_paths=image_paths,
        model=model,
        device=device_obj,
        prev_action_names=prev_action_names,
    )

    _, action_name, params_dict = model.predict(images, sensor_data, prev_action_seq, threshold=threshold)

    if isinstance(params_dict, dict):
        sorted_params = [k for k, v in sorted(params_dict.items(), key=lambda kv: kv[1], reverse=True)]
    else:
        sorted_params = list(params_dict or [])

    return [action_name] + sorted_params


__all__ = ["predict", "load_model", "DEFAULT_BUNDLE_PATH"]
