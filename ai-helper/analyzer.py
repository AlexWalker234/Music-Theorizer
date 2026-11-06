"""Music Theorizer's AI song analysis: chords (BTC), beats/downbeats (madmom), key (from the chords,
with madmom's key CNN as a second opinion), and optional source separation first (Demucs).

analyze(samples, sr, separate=False) -> dict, the JSON the app's Jam Mode merges into its own analysis.
Notes, the riff and tuning still come from the app's built-in Basic Pitch engine.

separate(channels, sr) -> (info, stems): Jam Mode's Instruments mixer. Demucs htdemucs_6s splits drums, bass,
vocals, guitar, piano and other; then (optional) AST names the instruments in the song and AudioSep pulls
each one out of its stem (instruments.py, audiosep_worker.py).
"""
import os
import sys
import time
import warnings

import numpy as np
from scipy.signal import resample_poly

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))     # madmom 0.16.1, patched to run without a C compiler
warnings.filterwarnings('ignore')

import torch  # noqa: E402
from madmom.audio.signal import Signal  # noqa: E402
from madmom.features.downbeats import RNNDownBeatProcessor, DBNDownBeatTrackingProcessor  # noqa: E402
from madmom.features.key import CNNKeyRecognitionProcessor  # noqa: E402

from btc_chords import BTC  # noqa: E402
from keyfit import key_scores, madmom_index  # noqa: E402

VERSION = '1.2'
MAX_SECONDS = 12 * 60
NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']


def _resample(y, sr, target):
    if sr == target:
        return y.astype(np.float32)
    g = np.gcd(int(sr), int(target))
    return resample_poly(y, target // g, int(sr) // g).astype(np.float32)


class Analyzer:
    def __init__(self, device=None):
        self.device = torch.device(device or ('cuda' if torch.cuda.is_available() else 'cpu'))
        t0 = time.time()
        self.btc = BTC(self.device)
        self.key_cnn = CNNKeyRecognitionProcessor()
        self.downbeat_rnn = RNNDownBeatProcessor()
        self.downbeat_dbn = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], fps=100)
        self.demucs = None
        self.recognizer = None
        self.audiosep = None
        self.load_seconds = round(time.time() - t0, 1)

    @staticmethod
    def demucs_available():
        try:
            import demucs  # noqa: F401
            return True
        except ImportError:
            return False

    # Demucs htdemucs_6s: six instruments. Synths, lead lines and strings have no stem of their own
    # in any openly available model, so they come out together in "other".
    STEMS = [('drums', 'Drums & percussion'), ('bass', 'Bass'), ('vocals', 'Vocals'), ('guitar', 'Guitar'),
             ('piano', 'Piano & keys'), ('other', 'Other: synths, leads, strings')]
    DEMUCS_MODEL = 'htdemucs_6s'

    def _load_demucs(self):
        """The model (about 55 MB) downloads on first use and is cached by PyTorch / Hugging Face."""
        from demucs.pretrained import get_model
        return get_model(self.DEMUCS_MODEL)

    def _run_demucs(self, wav, progress=None):
        """wav: (channels, samples) float32 at the model's rate. Returns {source: (channels, samples)}."""
        from demucs.apply import apply_model
        if self.demucs is None:
            if progress:
                progress(0.0, 'Loading the separation model (the first time it downloads about 55 MB)')
            self.demucs = self._load_demucs().to(self.device).eval()
        m = self.demucs
        x = torch.as_tensor(wav, dtype=torch.float32)
        if x.shape[0] == 1:
            x = x.repeat(2, 1)
        ref = x.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        x = (x - mean) / std
        # Progress: one "end" callback per 7.8 s segment and model in the bag.
        seg = float(getattr(m, 'segment', None) or getattr(m.models[0], 'segment', 7.8))
        n_models = len(getattr(m, 'models', [m]))
        n_seg = max(1, int(np.ceil(x.shape[-1] / int(0.75 * seg * m.samplerate))))
        done = [0]

        def cb(d):
            if d.get('state') == 'end' and progress:
                done[0] += 1
                progress(min(0.99, done[0] / (n_seg * n_models)), 'Separating the instruments')
        if progress:
            progress(0.0, 'Separating the instruments')
        with torch.no_grad():
            out = apply_model(m, x[None].to(self.device), device=self.device, split=True, overlap=0.25, progress=False, callback=cb)[0]
        out = (out * std + mean).cpu().numpy()
        return dict(zip(m.sources, out)), int(m.samplerate)

    def _separate(self, y44):
        """For analysis: the mix without drums and with most vocals removed, so the chord model hears the harmony."""
        src, rate = self._run_demucs(np.stack([y44, y44]))      # Demucs models all run at 44.1 kHz
        mono = {k: v.mean(axis=0) for k, v in src.items()}
        harmonic = sum(mono.get(k, 0) for k in ('bass', 'other', 'guitar', 'piano')) + 0.3 * mono.get('vocals', 0)
        return _resample(np.asarray(harmonic, dtype=np.float32), rate, 44100)

    FAMILY = {'drums': 'drums', 'bass': 'bass', 'vocals': 'vocals', 'guitar': 'pitched', 'piano': 'pitched', 'other': 'pitched'}
    REST = {'drums': 'Drum kit', 'guitar': 'Guitar: the rest', 'piano': 'Keys: the rest', 'other': 'Everything else'}

    def _recognize(self, mix, mono, rate, progress):
        """The instruments AST hears in the mix and in the guitar, piano and other stems (see instruments.py)."""
        import instruments
        if self.recognizer is None:
            progress(0.0, 'Loading the instrument recogniser (the first time it downloads about 350 MB)')
            self.recognizer = instruments.Recognizer(self.device)
        progress(0.0, 'Listening for which instruments play')
        sources = {'mix': _resample(mix, rate, 16000)}
        for k in ('guitar', 'piano', 'other'):
            if k in mono:
                sources[k] = _resample(mono[k], rate, 16000)
        return instruments.detect(self.recognizer, sources)

    def separate(self, channels, sr, out_sr=32000, progress=None, auto=True):
        """channels: (1 or 2, samples) float32 at sr. Returns (info, [int16 mono arrays]).

        Demucs splits the song into six stems. With auto (and the optional models installed), the
        instrument recogniser then names what plays, each stem is labelled by what is in it, and AudioSep
        pulls every recognised instrument out of the stem it landed in (strings, brass and synth out of
        "other"; acoustic from electric guitar; organ from piano...), leaving the rest. info['stems'] lists
        each with 'present' (it plays a real part), 'family', its level, and 'samples' when its audio is sent;
        info['instruments'] lists what was recognised."""
        import instruments
        progress = progress or (lambda p, st: None)
        t0 = time.time()
        notes = []
        x = np.asarray(channels, dtype=np.float32)
        if x.shape[1] > MAX_SECONDS * sr:
            x = x[:, :int(MAX_SECONDS * sr)]
        rate = 44100
        x = np.stack([_resample(c, sr, rate) for c in x])

        def stage(lo, hi):
            return lambda p, st: progress(lo + (hi - lo) * p, st)
        use_rec = auto and instruments.recognition_available()
        use_sep = use_rec and instruments.audiosep_available()
        src, rate = self._run_demucs(x, stage(0, 0.5 if use_rec else 0.99))
        mix_mono = x.mean(axis=0)
        mono = {k: v.mean(axis=0) for k, v in src.items()}

        found = []
        if use_rec:
            try:
                found = self._recognize(mix_mono, mono, rate, stage(0.5, 0.6))
            except Exception as e:
                use_sep = False
                notes.append('Could not recognise the instruments (%s: %s).' % (type(e).__name__, e))
        elif auto:
            notes.append('Instrument recognition is not installed: run the setup again and answer y to the Demucs question.')

        # One list of (id, label, family, audio at out_sr, instruments in it) per stem, splitting buckets with AudioSep.
        parts = []
        mono_out = {k: _resample(v, rate, out_sr) for k, v in mono.items()}
        jobs = []
        for sid, label in self.STEMS:
            if sid not in mono_out:
                continue
            here = [f for f in found if f['bucket'] == sid]
            split = [f for f in here if f['query']]
            # Split a stem when it holds more than one recognised instrument, or anything at all for "other".
            if use_sep and split and (len(here) > 1 or sid == 'other'):
                jobs.append((sid, label, here, split))
            else:
                if here:
                    names = [f['name'] for f in here]
                    label = names[0] if len(here) == 1 else ' & '.join(names[:2]) if sid in ('drums', 'bass', 'vocals') \
                        else '%s: %s' % (label.split(':')[0], ', '.join(names))
                parts.append((sid, label, self.FAMILY[sid], mono_out[sid], [f['id'] for f in here]))
                for f in here:
                    f['stem'] = sid
        if jobs and out_sr != 32000:
            raise ValueError('AudioSep runs at 32 kHz')
        n_q = sum(len(j[3]) for j in jobs)
        done = 0
        for sid, label, here, split in jobs:
            base = mono_out[sid]
            try:
                if self.audiosep is None:
                    self.audiosep = instruments.AudioSep(cpu=self.device.type == 'cpu')
                lo = 0.6 + 0.39 * done / n_q
                outs = self.audiosep.separate(base, [f['query'] for f in split],
                                              stage(lo, lo + 0.39 * len(split) / n_q))
            except Exception as e:
                notes.append('Could not split the %s stem (%s).' % (sid, e))
                parts.append((sid, '%s: %s' % (label.split(':')[0], ', '.join(f['name'] for f in here)), self.FAMILY[sid], base, [f['id'] for f in here]))
                continue
            finally:
                done += len(split)
            rest = base.copy()
            for f, y in zip(split, outs):
                y = np.asarray(y, dtype=np.float32)[:len(base)]
                y = np.pad(y, (0, len(base) - len(y)))
                rest -= y
                f['stem'] = f['id']
                f['separated'] = True
                parts.append((f['id'], f['name'], 'drums' if f['family'] == 'drums' else 'pitched', y, [f['id']]))
            left = [f for f in here if not f['query']]
            for f in left:
                f['stem'] = sid
            rest_id = sid + '-rest' if any(f['id'] == sid for f in split) else sid     # e.g. "piano" split out of the piano stem
            parts.append((rest_id, left[0]['name'] if left else self.REST[sid], self.FAMILY[sid], rest, [f['id'] for f in left]))
        order = [sid for sid, _ in self.STEMS]
        bucket = {f['id']: f['bucket'] for f in found}
        bucket.update({sid + '-rest': sid for sid in order})

        def place(q):           # each split instrument next to what is left of its stem
            if q[0].endswith('-rest'):
                return order.index(bucket[q[0]]) + 0.5
            return order.index(bucket[q[0]]) if q[0] in bucket and any(f['id'] == q[0] and f.get('separated') for f in found) \
                else order.index(q[0]) + 0.5
        parts.sort(key=place)
        progress(0.99, 'Sending the instruments')

        mix_out = _resample(mix_mono, rate, out_sr)
        mix_rms = float(np.sqrt(np.mean(mix_out ** 2)) + 1e-9)
        # Loudness in 1 s windows, to tell a real part from the faint bleed every stem has.
        win = out_sr
        nwin = max(1, len(mix_out) // win)
        mix_win = np.sqrt(np.mean(mix_out[:nwin * win].reshape(nwin, win) ** 2, axis=1) + 1e-12) if len(mix_out) >= win else np.array([mix_rms])
        stems, data = [], []
        for sid, label, family, out, ids in parts:
            rms = float(np.sqrt(np.mean(out ** 2)))
            if len(out) >= win:
                w = np.sqrt(np.mean(out[:nwin * win].reshape(nwin, win) ** 2, axis=1) + 1e-12)
                active = float(np.mean(w > 0.12 * mix_win))
            else:
                active = 1.0 if rms > 0.12 * mix_rms else 0.0
            level_db = round(20 * np.log10(rms / mix_rms + 1e-9), 1)
            present = bool(active >= 0.08 and level_db > -30) or bool(ids and level_db > -36)
            entry = {'id': sid, 'label': label, 'family': family, 'instruments': ids, 'present': present,
                     'levelDb': level_db, 'active': round(active, 2)}
            # Faint stems are still sent (the app tucks them away) in case the guess is wrong; near-silent ones aren't.
            if present or level_db > -40:
                peak = max(1.0, float(np.max(np.abs(out))) if len(out) else 1.0)
                entry['gain'] = round(peak, 4)       # int16 holds out / peak; the app multiplies back
                entry['samples'] = int(len(out))
                data.append(np.clip(np.round(out / peak * 32767), -32768, 32767).astype('<i2'))
            stems.append(entry)
        if not use_sep and auto and use_rec:
            notes.append('AudioSep is not installed, so instruments that share a stem stay together.')
        info = {'version': VERSION, 'model': self.DEMUCS_MODEL + (' + AudioSep' if use_sep else ''), 'sampleRate': out_sr,
                'stems': stems, 'device': str(self.device), 'seconds': round(time.time() - t0, 2),
                'recognition': bool(use_rec), 'audiosep': bool(use_sep),
                'instruments': [{k: f.get(k) for k in ('id', 'name', 'family', 'confidence', 'share', 'stem', 'separated')} for f in found],
                'notes': notes}
        return info, data

    def analyze(self, samples, sr, separate=False):
        timings = {}
        warn = []
        y = np.asarray(samples, dtype=np.float32)
        if len(y) > MAX_SECONDS * sr:
            y = y[:int(MAX_SECONDS * sr)]
            warn.append('Only the first 12 minutes were analysed.')
        duration = len(y) / sr
        y44 = _resample(y, sr, 44100)

        harmonic44 = None
        if separate:
            t0 = time.time()
            try:
                harmonic44 = self._separate(y44)
            except Exception as e:     # missing package, no internet for the first download, out of memory...
                warn.append('Instrument separation was skipped: %s' % e)
            timings['separate'] = time.time() - t0

        t0 = time.time()
        chord_src = harmonic44 if harmonic44 is not None else y44
        raw = self.btc(_resample(chord_src, 44100, BTC.SR))
        chords = _smooth(raw, min_len=0.3)
        timings['chords'] = time.time() - t0

        t0 = time.time()
        sig = Signal(y44, sample_rate=44100, num_channels=1)
        bt = self.downbeat_dbn(self.downbeat_rnn(sig))
        beats = bt[:, 0] if len(bt) else np.zeros(0)
        pos = bt[:, 1].astype(int) if len(bt) else np.zeros(0, int)
        downbeats = beats[pos == 1]
        bpb = int(pos.max()) if len(pos) else 4
        ibi = np.diff(beats)
        bpm = float(60 / np.median(ibi)) if len(ibi) > 2 else None
        tempo_conf = float(max(0.0, 1 - np.std(ibi) / np.mean(ibi) * 4)) if len(ibi) > 2 else 0.0
        timings['beats'] = time.time() - t0

        t0 = time.time()
        keyprob = self.key_cnn(sig)[0]
        timings['key'] = time.time() - t0
        sc = key_scores([(c['start'], c['end'], c['label']) for c in chords])
        order = np.argsort(-sc)
        cands = [{'rootPc': int(k % 12), 'scaleId': 'minor' if k >= 12 else 'major', 'score': round(float(sc[k]), 3)} for k in order[:3]]
        mk = int(np.argmax(keyprob))
        mm = {'rootPc': int((mk % 12 + 9) % 12), 'scaleId': 'minor' if mk >= 12 else 'major', 'probability': round(float(keyprob[mk]), 3)}
        best, second = cands[0], cands[1]
        gap = best['score'] - second['score']
        relative = second['scaleId'] != best['scaleId'] and (
            (best['scaleId'] == 'major' and second['rootPc'] == (best['rootPc'] + 9) % 12) or
            (best['scaleId'] == 'minor' and second['rootPc'] == (best['rootPc'] + 3) % 12))
        agrees = (mm['rootPc'], mm['scaleId']) == (best['rootPc'], best['scaleId'])
        # Calibrated on the 22 test songs: a clear winner, or a near-tie that madmom's key CNN settles.
        level = 'high' if best['score'] >= 1.1 and (gap >= 0.1 or relative or agrees) else 'medium' if best['score'] >= 0.9 else 'low'

        return {
            'version': VERSION,
            'duration': round(duration, 3),
            'key': {'rootPc': best['rootPc'], 'scaleId': best['scaleId']},
            'keyCandidates': cands,
            'keyConfidence': {'level': level, 'best': best['score'], 'gap': round(gap, 3), 'relativeTie': bool(relative and gap < 0.1), 'modelAgrees': agrees},
            'madmomKey': mm,
            'tempo': {'bpm': round(bpm, 1) if bpm else None, 'confidence': round(tempo_conf, 2)},
            'beats': [round(float(b), 3) for b in beats],
            'downbeats': [round(float(b), 3) for b in downbeats],
            'beatsPerBar': bpb,
            'chords': chords,
            'separated': harmonic44 is not None,
            'warnings': warn,
            'device': str(self.device),
            'timingsMs': {k: int(v * 1000) for k, v in timings.items()},
            'engine': 'BTC + madmom' + (' + Demucs' if harmonic44 is not None else ''),
        }


def _smooth(segs, min_len):
    """Merge chord segments shorter than min_len seconds into the previous one (single-frame flickers)."""
    out = []
    for s in segs:
        if out and (s['end'] - s['start'] < min_len or (s['root'], s['quality']) == (out[-1]['root'], out[-1]['quality'])):
            out[-1]['end'] = s['end']
            continue
        out.append(dict(s))
    if len(out) > 1 and out[0]['end'] - out[0]['start'] < min_len:
        out[1]['start'] = out[0]['start']
        out.pop(0)
    return [s for s in out if s['root'] is not None]
