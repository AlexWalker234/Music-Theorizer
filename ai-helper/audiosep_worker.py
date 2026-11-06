"""AudioSep worker: separates whatever instrument you name ("violin", "synthesizer", "trumpet") from audio.

AudioSep (Liu et al. 2023, "Separate Anything You Describe", MIT licence) lives in its own folder
(ai-helper/audiosep, downloaded by install_audiosep.py) and uses module names ("models", "utils") that
clash with the chord model's, so it runs in this separate process. analyzer.py starts it and talks to it
with one JSON line per request on stdin/stdout:

  -> {"in": "mix.npy", "queries": ["violin", "trumpet"], "out": "dir"}    (mono float32 at 32 kHz)
  <- {"progress": 0.4, "stage": "..."}                                     (any number of these)
  <- {"ok": true, "files": ["dir/0.npy", "dir/1.npy"]}  or  {"ok": false, "error": "..."}

Usage: python audiosep_worker.py <audiosep folder> [--cpu]
"""
import json
import os
import sys
import traceback

import numpy as np

SR = 32000
CKPT = 'checkpoint/audiosep_base_4M_steps.ckpt'
CLAP_CKPT = 'checkpoint/music_speech_audioset_epoch_15_esc_89.98.pt'


def say(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


class numpy_safe_load:
    """PyTorch 2.6+ only unpickles plain tensors by default, and AudioSep's CLAP checkpoint also holds a few
    numpy numbers (its training stats), which AudioSep's own code (written for older PyTorch) loads with
    torch.load's old default. This keeps the safe loader and allows just numpy's scalar and dtype types."""

    def __enter__(self):
        import torch
        np_core = getattr(np, '_core', None) or np.core
        allowed = [(np_core.multiarray.scalar, 'numpy.core.multiarray.scalar'), np_core.multiarray.scalar, np.dtype]
        allowed += [t for t in vars(getattr(np, 'dtypes', object)).values() if isinstance(t, type)]
        allowed = [a for a in allowed if a is not None]
        try:
            self.ctx = torch.serialization.safe_globals(allowed)
        except Exception:
            self.ctx = torch.serialization.safe_globals([a for a in allowed if not isinstance(a, tuple)])
        self.ctx.__enter__()
        return self

    def __exit__(self, *exc):
        return self.ctx.__exit__(*exc)


def drop_position_ids():
    """The CLAP checkpoint was saved with an older transformers, whose RoBERTa kept
    'embeddings.position_ids' in its weights; newer versions rebuild it and reject the stored copy."""
    from models.CLAP.open_clip import factory
    if getattr(factory.load_state_dict, 'mt_patched', False):
        return
    orig = factory.load_state_dict

    def load_state_dict(*a, **k):
        sd = orig(*a, **k)
        return {key: v for key, v in sd.items() if not key.endswith('embeddings.position_ids')}
    load_state_dict.mt_patched = True
    factory.load_state_dict = load_state_dict


def load(folder, device):
    """The separation network (ResUNet30) and its text encoder (CLAP), without PyTorch Lightning:
    the checkpoint's 'ss_model.' weights go straight into the network."""
    import torch
    os.chdir(folder)
    sys.path.insert(0, folder)
    import yaml
    from models.resunet import ResUNet30
    from models.clap_encoder import CLAP_Encoder
    with open('config/audiosep_base.yaml') as f:
        cfg = yaml.safe_load(f)['model']
    net = ResUNet30(input_channels=cfg['input_channels'], output_channels=cfg['output_channels'], condition_size=cfg['condition_size'])
    sd = torch.load(CKPT, map_location='cpu', weights_only=False)
    sd = sd.get('state_dict', sd)
    missing, _ = net.load_state_dict({k[len('ss_model.'):]: v for k, v in sd.items() if k.startswith('ss_model.')}, strict=False)
    if missing:
        raise RuntimeError('the AudioSep checkpoint is missing %d weights (for example %s)' % (len(missing), missing[0]))
    drop_position_ids()
    with numpy_safe_load():
        clap = CLAP_Encoder(pretrained_path=CLAP_CKPT).eval()
    return net.eval().to(device), clap.to(device)


def separate(net, clap, mix, queries, device, report):
    """mix: mono float32 at 32 kHz. Returns one array per query. Runs in 5 s windows that overlap by 1 s
    on each side (as AudioSep's own chunk_inference does), keeping each window's middle 3 s."""
    import torch
    NL, NC, NR = SR, 3 * SR, SR
    win = NL + NC + NR
    L = len(mix)
    starts = list(range(0, max(1, L - NL - NR), NC))
    outs = []
    x = torch.as_tensor(mix, dtype=torch.float32, device=device)
    for qi, q in enumerate(queries):
        with torch.no_grad():
            cond = clap.get_query_embed(modality='text', text=[q], device=device)
            film = net.film(conditions=cond)
            out = np.zeros(L, dtype=np.float32)
            for k, s in enumerate(starts):
                seg = x[s:s + win]
                if len(seg) < win:
                    seg = torch.nn.functional.pad(seg, (0, win - len(seg)))
                y = net.base(mixtures=seg[None, None, :], film_dict=film)['waveform'][0, 0].float().cpu().numpy()
                a = 0 if s == 0 else NL                 # keep the middle of each window
                b = min(win, L - s) if s + win >= L else NL + NC
                out[s + a:s + b] = y[a:b]
                report((qi + (k + 1) / len(starts)) / len(queries), 'Separating the %s (%d of %d)' % (q, qi + 1, len(queries)))
        outs.append(out)
    return outs


def main():
    folder = os.path.abspath(sys.argv[1])
    import torch
    device = torch.device('cpu' if '--cpu' in sys.argv or not torch.cuda.is_available() else 'cuda')
    try:
        net, clap = load(folder, device)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        say({'ready': False, 'error': '%s: %s' % (type(e).__name__, e)})
        return
    say({'ready': True, 'device': str(device)})
    for line in sys.stdin:
        try:
            req = json.loads(line)
            mix = np.load(req['in']).astype(np.float32)
            outs = separate(net, clap, mix, req['queries'], device, lambda p, st: say({'progress': round(p, 3), 'stage': st}))
            files = []
            for i, y in enumerate(outs):
                path = os.path.join(req['out'], '%d.npy' % i)
                np.save(path, y)
                files.append(path)
            say({'ok': True, 'files': files})
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            say({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})


if __name__ == '__main__':
    main()
