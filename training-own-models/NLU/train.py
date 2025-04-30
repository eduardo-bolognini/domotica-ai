import json
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from torch.nn.utils.rnn import pack_padded_sequence, pad_sequence
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR
from tqdm import tqdm

device = torch.device('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')

with open('dataset.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

records = []
inputs = set()
for rec in data:
    init = rec['input']
    if init in inputs:
        continue
    inputs.add(init)
    prev = '<NONE>'
    for act in rec['actions']:
        name = act['action_name']
        param = act['params'][0] if act['params'] and act['params'][0] is not None else '<NONE>'
        records.append((init, prev, name, param))
        prev = name
    records.append((init, prev, 'stop', '<NONE>'))

df = pd.DataFrame(records, columns=['init', 'prev', 'action', 'param'])

actions = sorted(df['action'].unique())
params = sorted(df['param'].unique())
a2i = {a: i for i, a in enumerate(actions)}
p2i = {p: i for i, p in enumerate(params)}

vocab = {'<PAD>': 0, '<UNK>': 1}
for text in pd.concat([df['init'], df['prev']]).unique():
    for tok in text.split():
        if tok not in vocab:
            vocab[tok] = len(vocab)

# Dataset e dataloader
class ChainDataset(Dataset):
    def __init__(self, df, vocab, a2i, p2i):
        self.rows = df.to_numpy()
        self.vocab = vocab
        self.a2i = a2i
        self.p2i = p2i

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        init, prev, act, param = self.rows[idx]
        seq = [self.vocab.get(t, self.vocab['<UNK>']) for t in (init + ' <SEP> ' + prev).split()]
        return torch.tensor(seq, dtype=torch.long), self.a2i[act], self.p2i[param]

def collate_batch(batch):
    seqs, acts, pars = zip(*batch)
    lengths = torch.tensor([len(s) for s in seqs], device=device)
    padded = pad_sequence(seqs, batch_first=True, padding_value=vocab['<PAD>']).to(device)
    return padded, lengths, torch.tensor(acts, device=device), torch.tensor(pars, device=device)

dataset = ChainDataset(df, vocab, a2i, p2i)
loader = DataLoader(dataset, batch_size=64, shuffle=True, collate_fn=collate_batch)

class IntentModel(nn.Module):
    def __init__(self, vocab_size, emb_dim, hid_dim, n_act, n_par, pad_idx):
        super().__init__()
        self.emb = nn.Embedding(vocab_size, emb_dim, padding_idx=pad_idx)
        self.ln_emb = nn.LayerNorm(emb_dim)
        self.lstm = nn.LSTM(emb_dim, hid_dim, num_layers=2, bidirectional=True, batch_first=True, dropout=0.3)
        self.drop = nn.Dropout(0.3)
        self.fc_act = nn.Linear(hid_dim * 2, n_act)
        self.fc_par = nn.Linear(hid_dim * 2, n_par)

    def forward(self, x, lengths):
        e = self.emb(x)
        e = self.ln_emb(e)
        packed = pack_padded_sequence(e, lengths.cpu(), batch_first=True, enforce_sorted=False)
        _, (h, _) = self.lstm(packed)
        h_fwd, h_bwd = h[-2], h[-1]
        h_cat = torch.cat((h_fwd, h_bwd), dim=1)
        h_drop = self.drop(h_cat)
        return self.fc_act(h_drop), self.fc_par(h_drop)

model = IntentModel(
    vocab_size=len(vocab),
    emb_dim=64,
    hid_dim=128,
    n_act=len(a2i),
    n_par=len(p2i),
    pad_idx=vocab['<PAD>']
).to(device)

opt = AdamW(model.parameters(), lr=1e-3, weight_decay=1e-5)
sched = CosineAnnealingLR(opt, T_max=100, eta_min=1e-5)
crit = nn.CrossEntropyLoss()
scaler = torch.cuda.amp.GradScaler(enabled=(device.type == 'cuda'))

with open("last.json", "w") as f:
    json.dump({
        "vocab": vocab,
        "a2i": a2i,
        "p2i": p2i,
        "actions": actions,
        "params": params
    }, f)

epochs = 0 # THE N OF EPOCHS THAT YOU WANT
best_loss = float('inf')
for ep in range(1, epochs + 1):
    model.train()
    total = 0
    for x, lengths, ya, yp in tqdm(loader, desc=f"Epoca {ep}"):
        opt.zero_grad()
        with torch.cuda.amp.autocast(enabled=(device.type == 'cuda')):
            oa, op = model(x, lengths)
            loss = crit(oa, ya) + crit(op, yp)
        scaler.scale(loss).backward()
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        scaler.step(opt)
        scaler.update()
        total += loss.item()
    avg = total / len(loader)
    sched.step()
    if avg < best_loss:
        best_loss = avg
        torch.save(model.state_dict(), 'last.pt')
    print(f"Epoca {ep}: loss={avg:.4f} lr={opt.param_groups[0]['lr']:.5f}")
