"""The migrations create what db/tables.py describes."""

from __future__ import annotations

import pytest
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import create_async_engine

from tutor_api.db.tables import metadata


@pytest.mark.filterwarnings("ignore:Did not recognize type .vector.")
async def test_migrated_schema_matches_the_tables(database_url):
    engine = create_async_engine(database_url)

    def columns(sync_conn):
        insp = inspect(sync_conn)
        return {t: {c["name"]: c["nullable"] for c in insp.get_columns(t)} for t in insp.get_table_names()
                if t != "alembic_version"}

    async with engine.connect() as conn:
        db = await conn.run_sync(columns)
    await engine.dispose()
    ours = {t.name: {c.name: c.nullable for c in t.columns} for t in metadata.sorted_tables}
    assert db == ours
