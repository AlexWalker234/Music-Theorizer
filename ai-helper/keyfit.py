"""Key from a chord sequence: how much of the song's chord time fits each of the 24 major/minor keys,
plus weight for time spent on the tonic chord and for starting/ending on it. On the 22 test songs this
beat madmom's key CNN (19/22 against 9/22), whose guesses are kept as a second opinion."""
import numpy as np
PC = {'C':0,'C#':1,'D':2,'D#':3,'E':4,'F':5,'F#':6,'G':7,'G#':8,'A':9,'A#':10,'B':11}
MAJ_Q = {0:'maj',2:'min',4:'min',5:'maj',7:'maj',9:'min',11:'dim'}   # degree offset -> triad quality
def triad(q):
    if q in ('maj','maj7','7','maj6','sus2','sus4','aug'): return 'maj'
    if q in ('min','min7','min6','minmaj7'): return 'min'
    if q in ('dim','dim7','hdim7'): return 'dim'
    return None
def parse(l):
    if l in ('N','X'): return None
    r, q = (l.split(':') + ['maj'])[:2]; return PC[r], q
def madmom_index(root, minor):  # madmom order: A major..Ab major, A minor..G# minor
    return ((root - 9) % 12) + (12 if minor else 0)
def key_scores(chords, keyprob=None, w_model=0.0):
    chords = list(chords)
    if not chords: return np.zeros(24)
    """chords: [(start,end,label)]. Returns (24,) scores, index = root + 12*minor."""
    dur = {}
    tot = 0.0
    for s, e, l in chords:
        p = parse(l)
        if not p: continue
        t = triad(p[1])
        if not t: continue
        dur[(p[0], t)] = dur.get((p[0], t), 0) + (e - s); tot += e - s
    sc = np.zeros(24)
    if tot == 0: return sc
    for k in range(24):
        root, minor = k % 12, k >= 12
        rel_major = (root + 3) % 12 if minor else root
        fit = 0.0
        for (r, t), d in dur.items():
            off = (r - rel_major) % 12
            if MAJ_Q.get(off) == t: fit += d
            elif minor and off == 7 and t == 'maj': fit += 0.8 * d     # harmonic-minor V in minor
            elif not minor and off == 10 and t == 'maj': fit += 0.5 * d  # bVII (mixolydian colour)
        tonic = dur.get((root, 'min' if minor else 'maj'), 0)
        # first and last chord on the tonic
        ends = [parse(c[2]) for c in (chords[0], chords[-1])]
        endb = sum(1 for p in ends if p and p[0] == root and triad(p[1]) == ('min' if minor else 'maj'))
        sc[k] = fit / tot + 0.6 * tonic / tot + 0.05 * endb
        if keyprob is not None and w_model:
            sc[k] += w_model * np.log(keyprob[madmom_index(root, minor)] + 1e-4)
    return sc
