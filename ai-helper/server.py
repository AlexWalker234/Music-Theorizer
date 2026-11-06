"""Music Theorizer AI helper: a small local web server the app calls for song analysis.

  python server.py [--port 8765] [--host 127.0.0.1] [--cpu]

GET  /health                 -> {"ok": true, "version", "device", "demucs", "recognition", "audiosep": bool, "busy": bool}
POST /analyze?sr=22050[&separate=1]
     body: the song as raw little-endian float32 mono samples
     -> the analysis JSON from analyzer.py
POST /separate?sr=44100&ch=2[&auto=0]
     auto (default on): name the instruments in the song and split each one out (needs the optional models)
     body: the song as little-endian int16 samples, one channel after the other
     -> binary: 4-byte little-endian header length, the header JSON (stems, sampleRate, gains), then
        each present stem as int16 mono samples in header order. GET /health shows the progress.

Only listens on this computer (127.0.0.1) unless --host says otherwise.
"""
import argparse
import importlib.util
import json
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np

import instruments

VERSION = '1.2'
MAX_BYTES = 12 * 60 * 48000 * 4 + 1024
MAX_SEP_BYTES = 12 * 60 * 48000 * 2 * 2 + 1024

analyzer = None
lock = threading.Lock()
ready = threading.Event()
load_error = None
job = {}            # the running job's kind, progress (0-1) and stage, shown by /health


def load(device):
    global analyzer, load_error
    try:
        from analyzer import Analyzer
        analyzer = Analyzer(device)
        print('Models loaded in %.1f s on %s. Ready.' % (analyzer.load_seconds, analyzer.device), flush=True)
    except Exception as e:
        load_error = '%s: %s' % (type(e).__name__, e)
        traceback.print_exc()
    ready.set()


class Handler(BaseHTTPRequestHandler):
    server_version = 'MusicTheorizerAI/1.0'

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path.rstrip('/') in ('', '/health'):
            self._send(200, {'ok': analyzer is not None, 'loading': not ready.is_set(), 'error': load_error, 'version': VERSION,
                             'device': str(analyzer.device) if analyzer else None, 'demucs': importlib.util.find_spec('demucs') is not None,
                             'recognition': instruments.recognition_available(), 'audiosep': instruments.audiosep_available(),
                             'busy': lock.locked(), 'job': dict(job) if job else None})
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path.rstrip('/') == '/separate':
            return self._separate(parse_qs(u.query))
        if u.path.rstrip('/') != '/analyze':
            return self._send(404, {'error': 'not found'})
        q = parse_qs(u.query)
        try:
            sr = int(q.get('sr', ['22050'])[0])
            n = int(self.headers.get('Content-Length', 0))
        except ValueError:
            return self._send(400, {'error': 'bad sr or Content-Length'})
        if n <= 0 or n > MAX_BYTES or n % 4 or not 8000 <= sr <= 192000:
            return self._send(400, {'error': 'send 4 s to 12 min of float32 mono audio at 8–192 kHz'})
        data = self.rfile.read(n)
        if not ready.wait(600) or analyzer is None:
            return self._send(503, {'error': 'models failed to load: %s' % load_error})
        samples = np.frombuffer(data, dtype='<f4')
        if len(samples) < 4 * sr:
            return self._send(400, {'error': 'clip shorter than 4 seconds'})
        separate = q.get('separate', ['0'])[0] in ('1', 'true')
        t0 = time.time()
        with lock:
            job.update(kind='analyze', progress=None, stage='Analysing')
            try:
                res = analyzer.analyze(samples, sr, separate=separate)
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {'error': '%s: %s' % (type(e).__name__, e)})
            finally:
                job.clear()
        res['seconds'] = round(time.time() - t0, 2)
        print('Analysed %.0f s of audio in %.1f s (%s): key %s, %d chords, %s BPM' % (
            len(samples) / sr, res['seconds'], res['engine'], res['key'], len(res['chords']), res['tempo']['bpm']), flush=True)
        self._send(200, res)

    def _separate(self, q):
        try:
            sr = int(q.get('sr', ['44100'])[0])
            ch = int(q.get('ch', ['1'])[0])
            auto = q.get('auto', ['1'])[0] not in ('0', 'false')
            n = int(self.headers.get('Content-Length', 0))
        except ValueError:
            return self._send(400, {'error': 'bad sr, ch or Content-Length'})
        if ch not in (1, 2) or n <= 0 or n > MAX_SEP_BYTES or n % (2 * ch) or not 8000 <= sr <= 192000:
            return self._send(400, {'error': 'send 4 s to 12 min of int16 audio (1 or 2 channels) at 8–192 kHz'})
        data = self.rfile.read(n)
        if not ready.wait(600) or analyzer is None:
            return self._send(503, {'error': 'models failed to load: %s' % load_error})
        if importlib.util.find_spec('demucs') is None:
            return self._send(501, {'error': 'Demucs is not installed. Run the setup again and answer y to the Demucs question.', 'code': 'no_demucs'})
        x = np.frombuffer(data, dtype='<i2').astype(np.float32).reshape(ch, -1) / 32768.0
        if x.shape[1] < 4 * sr:
            return self._send(400, {'error': 'clip shorter than 4 seconds'})
        t0 = time.time()
        with lock:
            job.update(kind='separate', progress=0.0, stage='Starting')

            def progress(p, stage):
                job.update(progress=round(p, 3), stage=stage)
            try:
                info, stems = analyzer.separate(x, sr, progress=progress, auto=auto)
            except Exception as e:
                traceback.print_exc()
                msg = '%s: %s' % (type(e).__name__, e)
                if 'HTTP' in msg or 'URL' in msg or 'connect' in msg.lower() or 'resolve' in msg.lower():
                    msg = 'Could not download the separation model (it needs internet the first time). ' + msg
                return self._send(500, {'error': msg})
            finally:
                job.clear()
        info['seconds'] = round(time.time() - t0, 2)
        head = json.dumps(info).encode()
        body = b''.join(s.tobytes() for s in stems)
        print('Separated %.0f s of audio in %.1f s on %s: %s' % (x.shape[1] / sr, info['seconds'], info['device'],
              ', '.join(s['id'] for s in info['stems'] if s['present'])), flush=True)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(4 + len(head) + len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(len(head).to_bytes(4, 'little') + head)
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description='Music Theorizer AI helper')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--cpu', action='store_true', help='do not use the GPU')
    a = ap.parse_args()
    threading.Thread(target=load, args=('cpu' if a.cpu else None,), daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print('Music Theorizer AI helper on http://%s:%d (loading models...)' % (a.host, a.port), flush=True)
    print('Leave this window open while you use the app. Press Ctrl+C to stop.', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('Stopped.')
        sys.exit(0)


if __name__ == '__main__':
    main()
