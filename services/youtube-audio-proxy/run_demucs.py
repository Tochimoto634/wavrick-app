#!/usr/bin/env python3
"""demucs CLI（pad1d パッチ適用済みプロセス内で実行）"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import _patch_demucs_pad1d

_patch_demucs_pad1d()

from demucs.separate import main

if __name__ == "__main__":
    main()
