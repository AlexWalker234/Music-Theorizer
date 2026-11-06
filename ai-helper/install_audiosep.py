"""Downloads AudioSep (Liu et al. 2023, "Separate Anything You Describe", MIT licence) into ./audiosep:
its code from GitHub and its two checkpoints (about 3.5 GB together) from its Hugging Face space.
The setup scripts run this when you answer y to the AudioSep question; run it again to resume or repair.
Its text encoder also downloads roberta-base (about 500 MB) from Hugging Face the first time it loads."""
import io
import os
import shutil
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, 'audiosep')
CODE = 'https://github.com/Audio-AGI/AudioSep/archive/refs/heads/main.zip'
SPACE = 'https://huggingface.co/spaces/Audio-AGI/AudioSep/resolve/main/checkpoint/'
CKPTS = ['audiosep_base_4M_steps.ckpt', 'music_speech_audioset_epoch_15_esc_89.98.pt']


def fetch(url, path=None):
    with urllib.request.urlopen(url, timeout=60) as r:
        total = int(r.headers.get('Content-Length') or 0)
        out = open(path + '.part', 'wb') if path else io.BytesIO()
        got = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            got += len(chunk)
            if total:
                sys.stdout.write('\r  %s: %d of %d MB' % (url.rsplit('/', 1)[-1], got >> 20, total >> 20))
                sys.stdout.flush()
        print()
        if not path:
            return out.getvalue()
        out.close()
        if total and got != total:
            raise IOError('the download stopped early; run this again')
        os.replace(path + '.part', path)


def main():
    if not os.path.exists(os.path.join(DEST, 'models', 'resunet.py')):
        print('Downloading the AudioSep code from GitHub ...')
        z = zipfile.ZipFile(io.BytesIO(fetch(CODE)))
        tmp = DEST + '.tmp'
        shutil.rmtree(tmp, ignore_errors=True)
        z.extractall(tmp)
        top = os.path.join(tmp, os.listdir(tmp)[0])
        os.makedirs(DEST, exist_ok=True)
        for name in os.listdir(top):
            if name != 'checkpoint':
                shutil.move(os.path.join(top, name), os.path.join(DEST, name))
        shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(DEST, 'checkpoint'), exist_ok=True)
    for name in CKPTS:
        path = os.path.join(DEST, 'checkpoint', name)
        if os.path.exists(path):
            print('  %s is already here' % name)
            continue
        print('Downloading %s ...' % name)
        fetch(SPACE + name, path)
    print('AudioSep is installed in %s' % DEST)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('AudioSep did not install (%s: %s). Everything else still works; run this again to retry.' % (type(e).__name__, e))
        sys.exit(1)
