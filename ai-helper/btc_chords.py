"""BTC (Bi-directional Transformer for Chord recognition, Park et al., ISMIR 2019, MIT licence),
large-vocabulary model: 12 roots x 14 qualities (triads, 6ths, 7ths, sus) plus N (no chord)."""
import os, sys
import numpy as np
import torch
import librosa

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'btc')
sys.path.insert(0, HERE)
from btc_model import BTC_model  # noqa: E402
from utils.hparams import HParams  # noqa: E402

ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
QUALS = ['min', 'maj', 'dim', 'aug', 'min6', 'maj6', 'min7', 'minmaj7', 'maj7', '7', 'dim7', 'hdim7', 'sus2', 'sus4']


def label(i):
    if i >= 168:
        return 'N'
    return ROOTS[i // 14] + ('' if i % 14 == 1 else ':' + QUALS[i % 14])


class BTC:
    SR = 22050

    def __init__(self, device):
        self.cfg = HParams.load(os.path.join(HERE, 'run_config.yaml'))
        self.cfg.feature['large_voca'] = True
        self.cfg.model['num_chords'] = 170
        self.dev = device
        ck = torch.load(os.path.join(HERE, 'models', 'btc_model_large_voca.pt'), map_location=device, weights_only=False)
        self.mean, self.std = ck['mean'], ck['std']
        self.model = BTC_model(config=self.cfg.model).to(device)
        self.model.load_state_dict(ck['model'])
        self.model.eval()

    def __call__(self, y):
        """y: mono float32 at 22050 Hz. Returns [{start, end, root, quality}] (root None for no chord)."""
        c = self.cfg
        seg = int(self.SR * c.mp3['inst_len'])
        parts = []
        for s in range(0, len(y), seg):    # the model was trained on CQTs computed in 10 s pieces
            part = y[s:s + seg]
            if len(part) < 2048:
                break
            parts.append(librosa.cqt(part, sr=self.SR, n_bins=c.feature['n_bins'], bins_per_octave=c.feature['bins_per_octave'],
                                     hop_length=c.feature['hop_length']))
        feat = np.log(np.abs(np.concatenate(parts, axis=1)) + 1e-6).T
        feat = (feat - self.mean) / self.std
        unit = c.mp3['inst_len'] / c.model['timestep']
        T = c.model['timestep']
        n = feat.shape[0]
        feat = np.pad(feat, ((0, (-n) % T), (0, 0)))
        x = torch.tensor(feat, dtype=torch.float32, device=self.dev).unsqueeze(0)
        preds = []
        with torch.no_grad():
            for t in range(feat.shape[0] // T):
                o, _ = self.model.self_attn_layers(x[:, T * t:T * (t + 1), :])
                p, _ = self.model.output_layer(o)
                preds.extend(p.squeeze(0).reshape(-1).tolist())
        preds = preds[:n]
        out, st = [], 0
        for i in range(1, n + 1):
            if i == n or preds[i] != preds[st]:
                k = int(preds[st])
                out.append({'start': round(st * unit, 3), 'end': round(i * unit, 3),
                            'root': None if k >= 168 else k // 14, 'quality': None if k >= 168 else QUALS[k % 14], 'label': label(k)})
                st = i
        return out
