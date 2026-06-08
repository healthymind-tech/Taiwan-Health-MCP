import pytest

from admin_sources import (
    catalog_entry,
    clear_drug_module,
    delete_uploaded_source,
    source_object_key,
    validate_source_filename,
)


def test_validate_source_filename_accepts_expected_extension():
    entry = catalog_entry("drug", "drug_index_csv")
    assert validate_source_filename("36_2.csv", entry) == "36_2.csv"


def test_validate_source_filename_rejects_wrong_extension():
    entry = catalog_entry("drug", "drug_index_csv")
    with pytest.raises(ValueError, match="File type not allowed"):
        validate_source_filename("36_2.txt", entry)


def test_source_object_key_normalizes_filename():
    key = source_object_key(
        "drug",
        "drug_index_csv",
        "deadbeef",
        "../36 2.csv",
    )
    assert key == "admin-sources/drug/drug_index_csv/deadbeef/36-2.csv"


class _FakeAcquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakePool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return _FakeAcquire(self.conn)


class _DrugDeleteConn:
    def __init__(self, fetchvals):
        self.fetchvals = list(fetchvals)
        self.executed = []

    async def fetchrow(self, query, *args):
        return {
            "uploaded_file_id": str(args[0]),
            "module_key": "drug",
            "source_role": "drug_index_csv",
            "original_filename": "36_2.csv",
            "object_key": "admin-sources/drug/drug_index_csv/hash/36_2.csv",
        }

    async def fetchval(self, query, *args):
        return self.fetchvals.pop(0)

    def transaction(self):
        return _FakeTransaction()

    async def execute(self, query, *args):
        self.executed.append((query, args))
        return "OK"


class _FakeMinio:
    def __init__(self):
        self.removed = []

    async def remove_object(self, object_key):
        self.removed.append(object_key)


@pytest.mark.asyncio
async def test_delete_drug_upload_refuses_queued_or_importing_file():
    conn = _DrugDeleteConn(fetchvals=[1])

    with pytest.raises(ValueError, match="queued or importing"):
        await delete_uploaded_source(
            _FakePool(conn),
            uploaded_file_id="00000000-0000-0000-0000-000000000001",
            deleted_by="admin",
        )

    assert conn.executed == []


@pytest.mark.asyncio
async def test_delete_drug_upload_refuses_imported_file():
    conn = _DrugDeleteConn(fetchvals=[None, 1])

    with pytest.raises(ValueError, match="already been imported into the drug index"):
        await delete_uploaded_source(
            _FakePool(conn),
            uploaded_file_id="00000000-0000-0000-0000-000000000001",
            deleted_by="admin",
        )

    assert conn.executed == []


@pytest.mark.asyncio
async def test_delete_drug_upload_allows_pending_or_failed_file():
    conn = _DrugDeleteConn(fetchvals=[None, None])
    minio = _FakeMinio()

    result = await delete_uploaded_source(
        _FakePool(conn),
        uploaded_file_id="00000000-0000-0000-0000-000000000001",
        deleted_by="admin",
        minio_service=minio,
    )

    assert result == {
        "uploaded_file_id": "00000000-0000-0000-0000-000000000001",
        "module_key": "drug",
    }
    assert any("DELETE FROM admin.uploaded_files" in query for query, _ in conn.executed)
    assert minio.removed == ["admin-sources/drug/drug_index_csv/hash/36_2.csv"]


class _DrugClearConn:
    def __init__(self, active_job=None):
        self.active_job = active_job
        self.executed = []

    async def fetchrow(self, query, *args):
        return self.active_job

    async def fetch(self, query, *args):
        if "FROM admin.uploaded_files" in query:
            return [
                {
                    "uploaded_file_id": "upload-1",
                    "object_key": "admin-sources/drug/drug_index_csv/hash/36_2.csv",
                    "original_filename": "36_2.csv",
                    "source_role": "drug_index_csv",
                }
            ]
        if "FROM drug.assets" in query:
            return [
                {
                    "asset_id": "asset-1",
                    "object_key": "drug/assets/a.pdf",
                    "source_filename": "a.pdf",
                    "asset_group": "insert",
                },
                {
                    "asset_id": "asset-2",
                    "object_key": "drug/assets/a.pdf",
                    "source_filename": "a.pdf",
                    "asset_group": "analysis",
                },
            ]
        return []

    async def fetchval(self, query, *args):
        return 1

    def transaction(self):
        return _FakeTransaction()

    async def execute(self, query, *args):
        self.executed.append((query, args))
        return "OK"


@pytest.mark.asyncio
async def test_clear_drug_module_refuses_active_drug_job():
    conn = _DrugClearConn(
        active_job={
            "job_id": "job-1",
            "job_type": "drug_enrichment",
            "status": "running",
        }
    )

    with pytest.raises(ValueError, match="drug_enrichment is running"):
        await clear_drug_module(
            _FakePool(conn),
            cleared_by="admin",
        )

    assert conn.executed == []


@pytest.mark.asyncio
async def test_clear_drug_module_truncates_data_and_removes_objects():
    conn = _DrugClearConn(active_job=None)
    minio = _FakeMinio()

    result = await clear_drug_module(
        _FakePool(conn),
        cleared_by="admin",
        minio_service=minio,
    )

    assert result["module_key"] == "drug"
    assert result["licenses_truncated"] == 1
    assert result["files_deleted"] == 1
    assert result["asset_objects_deleted"] == 1
    assert any("TRUNCATE" in query and "drug.licenses" in query for query, _ in conn.executed)
    assert any("DELETE FROM admin.uploaded_files" in query for query, _ in conn.executed)
    assert minio.removed == [
        "admin-sources/drug/drug_index_csv/hash/36_2.csv",
        "drug/assets/a.pdf",
    ]
