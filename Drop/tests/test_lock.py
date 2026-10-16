"""Trava de execução: uma coleta por vez."""

import tempfile
import unittest
from pathlib import Path

from wedrop.lock import CollectionLockedError, collection_lock


class CollectionLockTest(unittest.TestCase):
    def test_second_collection_is_blocked_while_first_runs(self):
        with tempfile.TemporaryDirectory() as folder:
            lock_path = Path(folder) / "coleta.lock"
            with collection_lock(lock_path):
                with self.assertRaises(CollectionLockedError):
                    with collection_lock(lock_path):
                        pass

    def test_lock_is_released_after_the_first_collection_ends(self):
        with tempfile.TemporaryDirectory() as folder:
            lock_path = Path(folder) / "coleta.lock"
            with collection_lock(lock_path):
                pass
            with collection_lock(lock_path):
                pass


if __name__ == "__main__":
    unittest.main()
