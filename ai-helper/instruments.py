"""Which instruments play in a song: the Audio Spectrogram Transformer fine-tuned on AudioSet
(MIT/ast-finetuned-audioset-10-10-0.4593, about 350 MB, downloads from Hugging Face on first use),
run over 10 s windows of the mix and of the separated stems.

CATALOG maps AudioSet's labels to the instruments the app shows. Each one says which Demucs stem it
usually ends up in (its "bucket") and, when it can be pulled out of that stem by AudioSep, the text
query to ask for. The thresholds are a first guess: tune them on real songs.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

AST_MODEL = 'MIT/ast-finetuned-audioset-10-10-0.4593'
AST_SR = 16000
WIN_S, HOP_S = 10.0, 5.0

# id, name, family (drums | bass | vocals | pitched), bucket (Demucs stem), AudioSet labels, AudioSep query or None
CATALOG = [
    ('drums', 'Drum kit', 'drums', 'drums', ['Drum kit', 'Drum', 'Snare drum', 'Bass drum', 'Cymbal', 'Hi-hat', 'Drum roll', 'Rimshot'], None),
    ('drum-machine', 'Drum machine', 'drums', 'drums', ['Drum machine'], None),
    ('percussion', 'Hand percussion', 'drums', 'drums', ['Tambourine', 'Maraca', 'Rattle (instrument)', 'Wood block', 'Tabla', 'Gong', 'Timpani'], 'percussion, tambourine and shaker'),
    ('bass', 'Bass guitar', 'bass', 'bass', ['Bass guitar'], None),
    ('double-bass', 'Double bass', 'bass', 'bass', ['Double bass'], None),
    ('vocals', 'Vocals', 'vocals', 'vocals', ['Singing', 'Male singing', 'Female singing', 'Child singing', 'Synthetic singing', 'Humming', 'Yodeling'], None),
    ('choir', 'Choir', 'vocals', 'vocals', ['Choir', 'Chant'], None),
    ('rap', 'Rap', 'vocals', 'vocals', ['Rapping', 'Beatboxing'], None),
    ('electric-guitar', 'Electric guitar', 'pitched', 'guitar', ['Electric guitar', 'Tapping (guitar technique)'], 'electric guitar'),
    ('acoustic-guitar', 'Acoustic guitar', 'pitched', 'guitar', ['Acoustic guitar', 'Strum'], 'acoustic guitar'),
    ('slide-guitar', 'Slide guitar', 'pitched', 'guitar', ['Steel guitar, slide guitar'], 'slide guitar'),
    ('banjo', 'Banjo', 'pitched', 'guitar', ['Banjo'], 'banjo'),
    ('mandolin', 'Mandolin', 'pitched', 'guitar', ['Mandolin'], 'mandolin'),
    ('ukulele', 'Ukulele', 'pitched', 'guitar', ['Ukulele'], 'ukulele'),
    ('sitar', 'Sitar', 'pitched', 'other', ['Sitar', 'Zither'], 'sitar'),
    ('piano', 'Piano', 'pitched', 'piano', ['Piano'], 'piano'),
    ('electric-piano', 'Electric piano', 'pitched', 'piano', ['Electric piano'], 'electric piano'),
    ('harpsichord', 'Harpsichord', 'pitched', 'piano', ['Harpsichord'], 'harpsichord'),
    ('organ', 'Organ', 'pitched', 'other', ['Organ', 'Electronic organ', 'Hammond organ'], 'organ'),
    ('synth', 'Synthesizer', 'pitched', 'other', ['Synthesizer', 'Sampler'], 'synthesizer'),
    ('strings', 'Strings', 'pitched', 'other', ['String section', 'Bowed string instrument', 'Violin, fiddle', 'Cello', 'Pizzicato', 'Orchestra'], 'string section, violin and cello'),
    ('brass', 'Brass', 'pitched', 'other', ['Brass instrument', 'Trumpet', 'Trombone', 'French horn'], 'brass section, trumpet and trombone'),
    ('saxophone', 'Saxophone', 'pitched', 'other', ['Saxophone'], 'saxophone'),
    ('flute', 'Flute', 'pitched', 'other', ['Flute'], 'flute'),
    ('clarinet', 'Clarinet', 'pitched', 'other', ['Clarinet'], 'clarinet'),
    ('woodwinds', 'Woodwinds', 'pitched', 'other', ['Wind instrument, woodwind instrument'], 'woodwind instruments'),
    ('harp', 'Harp', 'pitched', 'other', ['Harp'], 'harp'),
    ('mallets', 'Mallets', 'pitched', 'other', ['Mallet percussion', 'Marimba, xylophone', 'Glockenspiel', 'Vibraphone', 'Steelpan', 'Tubular bells'], 'marimba, xylophone and glockenspiel'),
    ('bells', 'Bells', 'pitched', 'other', ['Bell', 'Chime', 'Wind chime', 'Church bell', 'Jingle bell'], 'bells and chimes'),
    ('accordion', 'Accordion', 'pitched', 'other', ['Accordion'], 'accordion'),
    ('harmonica', 'Harmonica', 'pitched', 'other', ['Harmonica'], 'harmonica'),
    ('bagpipes', 'Bagpipes', 'pitched', 'other', ['Bagpipes'], 'bagpipes'),
    ('theremin', 'Theremin', 'pitched', 'other', ['Theremin'], 'theremin'),
    ('scratching', 'DJ scratching', 'drums', 'other', ['Scratching (performance technique)'], 'DJ turntable scratching'),
]
BY_ID = {c[0]: c for c in CATALOG}

PRESENT_MAX = 0.35    # a window this sure: it plays somewhere in the song
PRESENT_P80 = 0.15    # or this sure across a fifth of the song
ACTIVE = 0.10         # a window counts towards "how much of the song" above this


class Recognizer:
    def __init__(self, device):
        from transformers import ASTFeatureExtractor, ASTForAudioClassification
        self.device = device
        self.fe = ASTFeatureExtractor.from_pretrained(AST_MODEL)
        self.model = ASTForAudioClassification.from_pretrained(AST_MODEL).to(device).eval()
        names = {v.lower(): int(k) for k, v in self.model.config.id2label.items()}
        self.cols = [[names[lb.lower()] for lb in c[4] if lb.lower() in names] for c in CATALOG]
        self.music = names.get('music')

    def windows(self, y16, hop_s=HOP_S):
        """Per-window AudioSet probabilities (n_windows, 527) for mono audio at 16 kHz."""
        import torch
        w, h = int(WIN_S * AST_SR), int(hop_s * AST_SR)
        starts = list(range(0, max(1, len(y16) - w // 2), h)) or [0]
        probs = []
        for i in range(0, len(starts), 8):
            batch = [y16[s:s + w] for s in starts[i:i + 8]]
            batch = [b if len(b) >= AST_SR else np.pad(b, (0, AST_SR - len(b))) for b in batch]
            feats = self.fe(batch, sampling_rate=AST_SR, return_tensors='pt')
            with torch.no_grad():
                logits = self.model(**{k: v.to(self.device) for k, v in feats.items()}).logits
            probs.append(torch.sigmoid(logits).float().cpu().numpy())
        return np.concatenate(probs, 0)

    def scores(self, y16, hop_s=HOP_S):
        """For each CATALOG entry: (max, 80th percentile, share of windows active, best AudioSet label)."""
        P = self.windows(y16, hop_s)
        out = []
        for c, cols in zip(CATALOG, self.cols):
            if not cols:
                out.append((0.0, 0.0, 0.0, None))
                continue
            sub = P[:, cols]
            per_win = sub.max(axis=1)
            best = c[4][[lb.lower() for lb in c[4]].index(self.model.config.id2label[cols[int(np.argmax(sub.max(axis=0)))]].lower())]
            out.append((float(per_win.max()), float(np.percentile(per_win, 80)), float(np.mean(per_win > ACTIVE)), best))
        return out


def detect(rec, sources):
    """sources: {name: mono float32 at 16 kHz}, the mix plus any stems. An instrument is scored on the
    mix and on its own bucket's stem (where it isn't drowned out), keeping the higher score. Stems are
    heard in windows that don't overlap and skipped when nearly silent, to save time on a CPU.
    Returns a list of dicts, most confident first, for the instruments that play."""
    mix_rms = float(np.sqrt(np.mean(sources['mix'] ** 2)) + 1e-9)
    scored = {}
    for name, y in sources.items():
        if y is None or not len(y):
            continue
        if name != 'mix' and np.sqrt(np.mean(y ** 2)) < 0.03 * mix_rms:
            continue
        scored[name] = rec.scores(y, HOP_S if name == 'mix' else WIN_S)
    found = []
    for i, c in enumerate(CATALOG):
        cands = [scored[n][i] for n in ('mix', c[3]) if n in scored]
        if not cands:
            continue
        mx, p80, active, label = max(cands, key=lambda s: (s[0] + s[1]))
        if mx >= PRESENT_MAX or p80 >= PRESENT_P80:
            found.append({'id': c[0], 'name': c[1], 'family': c[2], 'bucket': c[3], 'query': c[5],
                          'confidence': round(max(mx, p80), 3), 'share': round(active, 2), 'tag': label})
    found.sort(key=lambda f: -f['confidence'])
    return found


AUDIOSEP_DIR = os.environ.get('MT_AUDIOSEP_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'audiosep')
AUDIOSEP_FILES = ['config/audiosep_base.yaml', 'checkpoint/audiosep_base_4M_steps.ckpt',
                  'checkpoint/music_speech_audioset_epoch_15_esc_89.98.pt']


def recognition_available():
    return importlib.util.find_spec('transformers') is not None


def audiosep_available():
    return all(os.path.exists(os.path.join(AUDIOSEP_DIR, f)) for f in AUDIOSEP_FILES[:2])


class AudioSep:
    """Talks to audiosep_worker.py, started once and kept running (loading takes a while)."""

    def __init__(self, cpu=False):
        self.cpu = cpu
        self.proc = None
        self.tmp = tempfile.mkdtemp(prefix='mt-audiosep-')

    def _start(self, progress):
        if self.proc and self.proc.poll() is None:
            return
        if progress:
            progress(0.0, 'Loading the instrument separator (AudioSep)')
        args = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'audiosep_worker.py'), AUDIOSEP_DIR]
        if self.cpu:
            args.append('--cpu')
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        first = json.loads(self.proc.stdout.readline() or '{"ready": false, "error": "the AudioSep worker quit while loading"}')
        if not first.get('ready'):
            self.proc = None
            raise RuntimeError('AudioSep could not load: %s' % first.get('error'))

    def separate(self, mono32k, queries, progress=None):
        """mono32k: float32 at 32 kHz. Returns one float32 array per query."""
        self._start(progress)
        src = os.path.join(self.tmp, 'in.npy')
        np.save(src, np.asarray(mono32k, dtype=np.float32))
        self.proc.stdin.write(json.dumps({'in': src, 'queries': list(queries), 'out': self.tmp}) + '\n')
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                self.proc = None
                raise RuntimeError('the AudioSep worker stopped (out of memory?)')
            msg = json.loads(line)
            if 'progress' in msg:
                if progress:
                    progress(msg['progress'], msg['stage'])
            elif msg.get('ok'):
                return [np.load(f) for f in msg['files']]
            else:
                raise RuntimeError('AudioSep: %s' % msg.get('error'))
