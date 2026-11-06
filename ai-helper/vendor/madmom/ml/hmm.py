# encoding: utf-8
# cython: embedsignature=True
"""
This module contains Hidden Markov Model (HMM) functionality.

Pure-Python/NumPy port of madmom 0.16.1's Cython hmm.pyx for Music Theorizer,
so the helper installs without a C compiler. Same results; Viterbi is vectorised per frame.

Notes
-----
If you want to change this module and use it interactively, use pyximport.

>>> import pyximport
>>> pyximport.install(reload_support=True,
...                   setup_args={'include_dirs': np.get_include()})
... # doctest: +ELLIPSIS
(None, <pyximport.pyximport.PyxImporter object at 0x...>)
"""

from __future__ import absolute_import, division, print_function

import warnings
import numpy as np






class TransitionModel(object):
    """
    Transition model class for a HMM.

    The transition model is defined similar to a scipy compressed sparse row
    matrix and holds all transition probabilities from one state to an other.
    This allows an efficient Viterbi decoding of the HMM.

    Parameters
    ----------
    states : numpy array
        All states transitioning to state s are stored in:
        states[pointers[s]:pointers[s+1]]
    pointers : numpy array
        Pointers for the `states` array for state s.
    probabilities : numpy array
        The corresponding transition are stored in:
        probabilities[pointers[s]:pointers[s+1]].

    Notes
    -----
    This class should be either used for loading saved transition models or
    being sub-classed to define a specific transition model.

    See Also
    --------
    scipy.sparse.csr_matrix

    Examples
    --------
    Create a simple transition model with two states using a list of
    transitions and their probabilities

    >>> tm = TransitionModel.from_dense([0, 1, 0, 1], [0, 0, 1, 1],
    ...                                 [0.8, 0.2, 0.3, 0.7])
    >>> tm  # doctest: +ELLIPSIS
    <madmom.ml.hmm.TransitionModel object at 0x...>

    TransitionModel.from_dense will check if the supplied probabilties for
    each state sum to 1 (and thus represent a correct probability distribution)

    >>> tm = TransitionModel.from_dense([0, 1], [1, 0], [0.5, 1.0])
    ... # doctest: +IGNORE_EXCEPTION_DETAIL
    Traceback (most recent call last):
    ...
    ValueError: Not a probability distribution.

    """

    def __init__(self, states, pointers, probabilities):
        # save the parameters
        self.states = states
        self.pointers = pointers
        self.probabilities = probabilities

    @property
    def num_states(self):
        """Number of states."""
        return len(self.pointers) - 1

    @property
    def num_transitions(self):
        """Number of transitions."""
        return len(self.probabilities)

    @property
    def log_probabilities(self):
        """Transition log probabilities."""
        return np.log(self.probabilities)

    @staticmethod
    def make_dense(states, pointers, probabilities):
        """
        Return a dense representation of sparse transitions.

        Parameters
        ----------
        states : numpy array
            All states transitioning to state s are returned in:
            states[pointers[s]:pointers[s+1]]
        pointers : numpy array
            Pointers for the `states` array for state s.
        probabilities : numpy array
            The corresponding transition are returned in:
            probabilities[pointers[s]:pointers[s+1]].

        Returns
        -------
        states : numpy array, shape (num_transitions,)
            Array with states (i.e. destination states).
        prev_states : numpy array, shape (num_transitions,)
            Array with previous states (i.e. origination states).
        probabilities : numpy array, shape (num_transitions,)
            Transition probabilities.

        See Also
        --------
        :class:`TransitionModel`

        Notes
        -----
        Three 1D numpy arrays of same length must be given. The indices
        correspond to each other, i.e. the first entry of all three arrays
        define the transition from the state defined prev_states[0] to that
        defined in states[0] with the probability defined in probabilities[0].

        """
        from scipy.sparse import csr_matrix
        # convert everything into a sparse CSR matrix
        transitions = csr_matrix((np.array(probabilities),
                                  np.array(states), np.array(pointers)))
        # convert to correct types
        states, prev_states = transitions.nonzero()
        # return them
        return states, prev_states, probabilities

    @staticmethod
    def make_sparse(states, prev_states, probabilities):
        """
        Return a sparse representation of dense transitions.

        This method removes all duplicate states and thus allows an efficient
        Viterbi decoding of the HMM.

        Parameters
        ----------
        states : numpy array, shape (num_transitions,)
            Array with states (i.e. destination states).
        prev_states : numpy array, shape (num_transitions,)
            Array with previous states (i.e. origination states).
        probabilities : numpy array, shape (num_transitions,)
            Transition probabilities.

        Returns
        -------
        states : numpy array
            All states transitioning to state s are returned in:
            states[pointers[s]:pointers[s+1]]
        pointers : numpy array
            Pointers for the `states` array for state s.
        probabilities : numpy array
            The corresponding transition are returned in:
            probabilities[pointers[s]:pointers[s+1]].

        See Also
        --------
        :class:`TransitionModel`

        Notes
        -----
        Three 1D numpy arrays of same length must be given. The indices
        correspond to each other, i.e. the first entry of all three arrays
        define the transition from the state defined prev_states[0] to that
        defined in states[0] with the probability defined in probabilities[0].

        """
        from scipy.sparse import csr_matrix
        # check for a proper probability distribution, i.e. the emission
        # probabilities of each prev_state must sum to 1
        states = np.asarray(states)
        prev_states = np.asarray(prev_states, dtype=np.int64)
        probabilities = np.asarray(probabilities)
        if not np.allclose(np.bincount(prev_states, weights=probabilities), 1):
            raise ValueError('Not a probability distribution.')
        # convert everything into a sparse CSR matrix, make sure it is square.
        # looking through prev_states is enough, because there *must* be a
        # transition *from* every state
        num_states = max(prev_states) + 1
        transitions = csr_matrix((probabilities, (states, prev_states)),
                                 shape=(num_states, num_states))
        # convert to correct types
        states = transitions.indices.astype(np.uint32)
        pointers = transitions.indptr.astype(np.uint32)
        probabilities = transitions.data.astype(dtype=np.float64)
        # return them
        return states, pointers, probabilities

    @classmethod
    def from_dense(cls, states, prev_states, probabilities):
        """
        Instantiate a TransitionModel from dense transitions.

        Parameters
        ----------
        states : numpy array, shape (num_transitions,)
            Array with states (i.e. destination states).
        prev_states : numpy array, shape (num_transitions,)
            Array with previous states (i.e. origination states).
        probabilities : numpy array, shape (num_transitions,)
            Transition probabilities.

        Returns
        -------
        :class:`TransitionModel` instance
            TransitionModel instance.

        """
        # get a sparse representation of the transitions
        transitions = cls.make_sparse(states, prev_states, probabilities)
        # instantiate a new TransitionModel and return it
        return cls(*transitions)


class ObservationModel(object):
    """
    Observation model class for a HMM.

    The observation model is defined as a plain 1D numpy arrays `pointers` and
    the methods `log_densities()` and `densities()` which return 2D numpy
    arrays with the (log) densities of the observations.

    Parameters
    ----------
    pointers : numpy array (num_states,)
        Pointers from HMM states to the correct densities. The length of the
        array must be equal to the number of states of the HMM and pointing
        from each state to the corresponding column of the array returned
        by one of the `log_densities()` or `densities()` methods. The
        `pointers` type must be np.uint32.

    See Also
    --------
    ObservationModel.log_densities
    ObservationModel.densities

    """

    def __init__(self, pointers):
        # save parameters
        self.pointers = pointers

    def log_densities(self, observations):
        """
        Log densities (or probabilities) of the observations for each state.

        Parameters
        ----------
        observations : numpy array
            Observations.

        Returns
        -------
        numpy array
            Log densities as a 2D numpy array with the number of rows being
            equal to the number of observations and the columns representing
            the different observation log probability densities. The type must
            be np.float64.

        """
        raise NotImplementedError('must be implemented by subclass')

    def densities(self, observations):
        """
        Densities (or probabilities) of the observations for each state.

        This defaults to computing the exp of the `log_densities`.
        You can provide a special implementation to speed-up everything.

        Parameters
        ----------
        observations : numpy array
            Observations.

        Returns
        -------
        numpy array
            Densities as a 2D numpy array with the number of rows being equal
            to the number of observations and the columns representing the
            different observation log probability densities. The type must be
            np.float64.

        """
        return np.exp(self.log_densities(observations))


class DiscreteObservationModel(ObservationModel):
    """
    Simple discrete observation model that takes an observation matrix of the
    form (num_states x num_observations) containing P(observation | state).

    Parameters
    ----------
    observation_probabilities : numpy array
        Observation probabilities as a 2D array of shape (num_observations,
        num_states). Has to sum to 1 over the second axis, since it
        represents P(observation | state).

    Examples
    --------
    Assuming two states and three observation types, instantiate a discrete
    observation model:

    >>> om = DiscreteObservationModel(np.array([[0.1, 0.5, 0.4],
    ...                                         [0.7, 0.2, 0.1]]))
    >>> om  # doctest: +ELLIPSIS
    <madmom.ml.hmm.DiscreteObservationModel object at 0x...>

    If the probabilities do not sum to 1, it throws a ValueError:

    >>> om = DiscreteObservationModel(np.array([[0.5, 0.5, 0.5],
    ...                                         [0.5, 0.5, 0.5]]))
    ... # doctest: +IGNORE_EXCEPTION_DETAIL
    Traceback (most recent call last):
    ...
    ValueError: Not a probability distribution.

    """

    def __init__(self, observation_probabilities):
        # check that it is a probability distribution
        if not np.allclose(observation_probabilities.sum(axis=1), 1):
            raise ValueError('Not a probability distribution.')
        # instantiate an ObservationModel
        super(DiscreteObservationModel, self).__init__(
            np.arange(observation_probabilities.shape[0], dtype=np.uint32))
        # save the observation probabilities
        self.observation_probabilities = observation_probabilities

    def densities(self, observations):
        """
        Densities of the observations.

        Parameters
        ----------
        observations : numpy array
            Observations.

        Returns
        -------
        numpy array
            Densities of the observations.

        """
        return self.observation_probabilities[:, observations].T

    def log_densities(self, observations):
        """
        Log densities of the observations.

        Parameters
        ----------
        observations : numpy array
            Observations.

        Returns
        -------
        numpy array
            Log densities of the observations.

        """
        return np.log(self.densities(observations))


class HiddenMarkovModel(object):
    """Hidden Markov Model (NumPy port of madmom's Cython class)."""

    def __init__(self, transition_model, observation_model, initial_distribution=None):
        self.transition_model = transition_model
        self.observation_model = observation_model
        if initial_distribution is None:
            initial_distribution = np.ones(transition_model.num_states, dtype=np.float64) / transition_model.num_states
        if not np.allclose(initial_distribution.sum(), 1):
            raise ValueError('Initial distribution is not a probability distribution.')
        self.initial_distribution = initial_distribution
        self._prev = self.initial_distribution.copy()

    def __getstate__(self):
        state = self.__dict__.copy()
        state.pop('_prev', None)
        return state

    def __setstate__(self, state):
        self.__dict__.update(state)
        self._prev = self.initial_distribution.copy()

    def reset(self, initial_distribution=None):
        self._prev = initial_distribution or self.initial_distribution.copy()

    def _segments(self):
        tm = self.transition_model
        ptr = np.asarray(tm.pointers, dtype=np.int64)
        counts = np.diff(ptr)
        nonempty = counts > 0
        return ptr, counts, nonempty

    def viterbi(self, observations):
        tm = self.transition_model
        om = self.observation_model
        states = np.asarray(tm.states, dtype=np.int64)
        logp = np.asarray(tm.log_probabilities, dtype=np.float64)
        ptr, counts, nonempty = self._segments()
        starts = ptr[:-1][nonempty]
        num_states = tm.num_states
        dens = om.log_densities(observations)
        om_ptr = np.asarray(om.pointers, dtype=np.int64)
        num_obs = len(dens)
        prev = np.log(self.initial_distribution)
        bt_type = np.uint16 if num_states < 65536 else np.uint32
        bt = np.zeros((num_obs, num_states), dtype=bt_type)
        seg_of = np.repeat(np.arange(num_states), counts)
        cur = np.full(num_states, -np.inf)
        with np.errstate(invalid='ignore'):
            for frame in range(num_obs):
                cand = prev[states] + logp
                cur = np.full(num_states, -np.inf)
                if len(cand):
                    seg_max = np.maximum.reduceat(cand, starts)
                    cur[nonempty] = seg_max
                    # first transition reaching the segment maximum (as in the Cython loop's strict '>')
                    hit = np.flatnonzero(cand == cur[seg_of])
                    first = hit[np.searchsorted(hit, starts)]
                    bt[frame, nonempty] = states[first]
                cur = cur + dens[frame, om_ptr]
                prev = cur
        state = int(np.argmax(cur))
        log_probability = cur[state]
        if np.isinf(log_probability):
            warnings.warn('-inf log probability during Viterbi decoding cannot find a valid path', RuntimeWarning)
            return np.empty(0, dtype=np.uint32), log_probability
        path = np.empty(num_obs, dtype=np.uint32)
        for frame in range(num_obs - 1, -1, -1):
            path[frame] = state
            state = int(bt[frame, state])
        return path, log_probability

    def forward(self, observations, reset=True):
        tm = self.transition_model
        om = self.observation_model
        states = np.asarray(tm.states, dtype=np.int64)
        probs = np.asarray(tm.probabilities, dtype=np.float64)
        ptr, counts, nonempty = self._segments()
        starts = ptr[:-1][nonempty]
        dens = om.densities(observations)
        om_ptr = np.asarray(om.pointers, dtype=np.int64)
        if reset:
            self.reset()
        fwd_prev = np.asarray(self._prev, dtype=np.float64)
        out = np.zeros((len(dens), tm.num_states))
        for frame in range(len(dens)):
            cur = np.zeros(tm.num_states)
            if len(probs):
                cur[nonempty] = np.add.reduceat(fwd_prev[states] * probs, starts)
            cur *= dens[frame, om_ptr]
            norm = cur.sum()
            cur /= norm
            out[frame] = cur
            fwd_prev = cur
        self._prev = fwd_prev
        return out

    def forward_generator(self, observations, block_size=None):
        for frame_fwd in self.forward(observations, reset=False):
            yield frame_fwd


HMM = HiddenMarkovModel
