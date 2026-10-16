"""Trava de execução: só uma coleta por vez.

Evita duas coletas gravando ao mesmo tempo nos mesmos arquivos (ex.: a rotina das 00:00
ainda rodando quando a das 10:00 começa). O bloqueio é do sistema operacional: se o
processo cair, a trava é liberada sozinha.
"""

from __future__ import annotations

import msvcrt
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .config import DATA_DIR

LOCK_FILE = DATA_DIR / "coleta.lock"


class CollectionLockedError(RuntimeError):
    """Outra coleta já está em execução."""


@contextmanager
def collection_lock(path: Path = LOCK_FILE) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    try:
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise CollectionLockedError("Outra coleta do WeDrop já está em execução.") from exc
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    finally:
        handle.close()
