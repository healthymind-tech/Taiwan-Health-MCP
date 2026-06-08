"""Tests for the incremental embedding helper (loader/loaders/embedding_loader.py).

The value of this feature is: only NEW or CONTENT-CHANGED rows are sent to the
model, orphaned embeddings are pruned, and every run stamps a per-module marker.
These tests exercise that selection logic with a fake pool (no DB, no Ollama):
``_embed_batch`` is monkeypatched, and a recording fake connection captures the
upsert rows, the orphan-prune keys, and the run-log write.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "loader"))

from loaders import embedding_loader as el  # noqa: E402


class _FakeTxn:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class FakeConn:
    def __init__(self, existing: dict, count_value: int = 0, delete_n: int = 0):
        self.existing = existing            # key -> stored source_hash
        self.count_value = count_value
        self.delete_n = delete_n
        self.execute_calls = []
        self.executemany_calls = []
        self.copy_calls = []
        self.fetch_called = False

    async def execute(self, sql, *args):
        self.execute_calls.append((sql, args))
        if sql.strip().upper().startswith("DELETE"):
            return f"DELETE {self.delete_n}"
        return "OK"

    async def executemany(self, sql, rows):
        self.executemany_calls.append((sql, list(rows)))

    async def fetch(self, sql, *args):
        self.fetch_called = True
        return [(k, h) for k, h in self.existing.items()]

    async def fetchval(self, sql, *args):
        return self.count_value

    async def copy_records_to_table(self, table, *, records, columns):
        self.copy_calls.append(list(records))

    def transaction(self):
        return _FakeTxn()


class FakePool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        return _FakeAcquire(self._conn)


@pytest.fixture
def captured_embed(monkeypatch):
    """Record the text batches sent to the model; return 2-d fake vectors."""
    calls = []

    async def _fake_embed_batch(client, texts):
        calls.append(list(texts))
        return [[1.0, 2.0] for _ in texts]

    monkeypatch.setattr(el, "_embed_batch", _fake_embed_batch)
    return calls


def _rows(*pairs):
    return [{"k": k, "t": t} for k, t in pairs]


def _common_kwargs(rows):
    return dict(
        table="x.embeddings",
        key_col="k",
        key_sql_type="TEXT",
        rows=rows,
        key_of=lambda r: r["k"],
        text_of=lambda r: r["t"],
        desc="X",
    )


def test_text_hash_is_stable_and_content_sensitive():
    assert el._text_hash("hello") == el._text_hash("hello")
    assert el._text_hash("hello") != el._text_hash("hello!")


async def test_only_new_and_changed_rows_are_embedded(captured_embed):
    # A unchanged, B changed (stored hash differs), C brand new.
    existing = {"A": el._text_hash("a"), "B": el._text_hash("b-old")}
    conn = FakeConn(existing, count_value=3)
    rows = _rows(("A", "a"), ("B", "b-new"), ("C", "c"))

    stats = await el._embed_table(FakePool(conn), **_common_kwargs(rows))

    # Only B and C were sent to the model (A skipped).
    assert captured_embed == [["b-new", "c"]]
    # Upsert carried exactly B and C, with their fresh hashes.
    upserted = conn.executemany_calls[-1][1]
    assert [r[0] for r in upserted] == ["B", "C"]
    assert upserted[0][2] == el._text_hash("b-new")
    assert stats["changed"] == 2
    assert stats["source_total"] == 3


async def test_unchanged_module_embeds_nothing(captured_embed):
    existing = {"A": el._text_hash("a"), "B": el._text_hash("b")}
    conn = FakeConn(existing, count_value=2)
    rows = _rows(("A", "a"), ("B", "b"))

    stats = await el._embed_table(FakePool(conn), **_common_kwargs(rows))

    assert captured_embed == []               # model never called
    assert conn.executemany_calls == []        # nothing upserted
    assert stats["changed"] == 0


async def test_orphans_are_pruned(captured_embed):
    # Source has A, B; embeddings table also has stale key Z.
    existing = {"A": el._text_hash("a"), "B": el._text_hash("b"), "Z": el._text_hash("z")}
    conn = FakeConn(existing, count_value=2, delete_n=1)
    rows = _rows(("A", "a"), ("B", "b"))

    stats = await el._embed_table(FakePool(conn), **_common_kwargs(rows))

    # The keep-set copied for the anti-join is exactly the current source keys.
    assert conn.copy_calls == [[("A",), ("B",)]]
    assert any(c[0].strip().upper().startswith("DELETE") for c in conn.execute_calls)
    assert stats["deleted"] == 1


async def test_empty_source_never_wipes(captured_embed):
    conn = FakeConn({"A": "h"}, count_value=1)
    stats = await el._embed_table(FakePool(conn), **_common_kwargs([]))

    assert captured_embed == []
    assert conn.copy_calls == []          # no orphan delete on empty source
    assert conn.fetch_called is False     # didn't even diff
    assert stats == {"source_total": 0, "changed": 0, "embedded_total": 1, "deleted": 0}


async def test_write_embed_log_upserts_run_marker():
    conn = FakeConn({}, count_value=0)
    await el._write_embed_log(
        FakePool(conn), "icd", source_total=10, embedded=10, changed=3
    )
    sql, args = conn.execute_calls[-1]
    assert "admin.module_embed_log" in sql
    assert args == ("icd", 10, 10, 3)
