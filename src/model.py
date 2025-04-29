import json
import torch
import torch.nn as nn
from torch.nn.utils.rnn import pack_padded_sequence


device = torch.device('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')

with open("config.json") as f:
    config_dict = json.load(f)

    JSON_FILE = config_dict['models apy key / ids']['ownmodel'][".json"]
    PT_FILE = config_dict['models apy key / ids']['ownmodel'][".pt"]

with open(JSON_FILE) as f:
    dati = json.load(f)

    vocab = dati["vocab"]
    a2i = dati["a2i"]
    p2i = dati["p2i"]
    actions = dati["actions"]
    params = dati["params"]


class IntentModel(nn.Module):
    def __init__(self, vocab_size, emb_dim, hid_dim, n_act, n_par):
        super().__init__()
        self.emb = nn.Embedding(vocab_size, emb_dim, padding_idx=vocab['<PAD>'])
        self.ln_emb = nn.LayerNorm(emb_dim)
        self.lstm = nn.LSTM(emb_dim, hid_dim, num_layers=2, bidirectional=True, batch_first=True, dropout=0.3)
        self.drop = nn.Dropout(0.3)
        self.fc_act = nn.Linear(hid_dim*2, n_act)
        self.fc_par = nn.Linear(hid_dim*2, n_par)

    def forward(self, x, lengths):
        e = self.emb(x)
        e = self.ln_emb(e)
        packed = pack_padded_sequence(e, lengths.cpu(), batch_first=True, enforce_sorted=False)
        _, (h, _) = self.lstm(packed)
        # h shape: (layers*2, batch, hid_dim) -> prendere ultimo layer bidirezionale
        h_fwd, h_bwd = h[-2], h[-1]
        h_cat = torch.cat((h_fwd, h_bwd), dim=1)
        h_drop = self.drop(h_cat)
        return self.fc_act(h_drop), self.fc_par(h_drop)

model = IntentModel(len(vocab), emb_dim=64, hid_dim=128, n_act=len(a2i), n_par=len(p2i)).to(device)


model.load_state_dict(torch.load(PT_FILE, map_location=device))

def pred(text, max_steps=5):
    prev = '<NONE>'
    return_actions = []
    for _ in range(max_steps):
        seq = [vocab.get(t, vocab['<UNK>']) for t in (text+' <SEP> '+prev).split()]
        x = torch.tensor([seq], device=device)
        lengths = torch.tensor([len(seq)], device=device)
        with torch.no_grad():
            oa, op = model(x, lengths)
        ia, ip = oa.argmax(1).item(), op.argmax(1).item()
        a, p = actions[ia], params[ip]
        
        
        
        if a == 'stop': break

        return_actions.append({
            "action": a,
            "params": p if p != "<NONE>" else None
        })
        
        prev = a
    
    return return_actions

if __name__ == "__main__":
    print(pred("user sitting on bed awake"))
