"""Alembic environment: runs the migrations on the async engine for `sqlalchemy.url`."""

import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from tutor_api.db.tables import metadata

target_metadata = metadata


def run(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def main() -> None:
    engine = create_async_engine(context.config.get_main_option("sqlalchemy.url"))
    async with engine.connect() as conn:
        await conn.run_sync(run)
        await conn.commit()
    await engine.dispose()


if context.is_offline_mode():
    raise SystemExit("offline migrations are not supported")
asyncio.run(main())
