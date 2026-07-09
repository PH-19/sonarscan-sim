"""Compatibility entry point for the current proposed scanning method.

The frozen previous version lives in ``strategies.proposed_v2``. New
experiments and paper-facing defaults should use ``BELIEF_PSO_V3`` from
``strategies.proposed_v3``.
"""

from . import proposed_v3 as _current
from .proposed_v3 import *  # noqa: F401,F403


def __getattr__(name: str):
    return getattr(_current, name)


def __dir__():
    return sorted(set(globals()) | set(dir(_current)))
