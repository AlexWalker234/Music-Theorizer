# encoding: utf-8
"""Stub: madmom's Cython comb filters are not shipped with Music Theorizer's helper (not needed for
beats, downbeats or key). Importing works; using them raises."""


def _missing(*args, **kwargs):
    raise ImportError('comb filters are not included in this build of madmom')


feed_forward_comb_filter = feed_backward_comb_filter = _missing


class CombFilterbankProcessor(object):
    def __init__(self, *args, **kwargs):
        _missing()
