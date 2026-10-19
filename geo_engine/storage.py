"""Inicialización transaccional del esquema PostgreSQL, sin datos reales."""
import psycopg

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY CHECK(version = 1)
);
INSERT INTO schema_version VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, reference TEXT NOT NULL, title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    title TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('public', 'internal')),
    allowed_principals TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    content TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('public', 'internal')),
    allowed_principals TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY,
    branch TEXT NOT NULL CHECK(branch IN ('commercial', 'geo')),
    status TEXT NOT NULL CHECK(status IN ('draft', 'insufficient_evidence')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS result_evidence (
    result_id TEXT NOT NULL REFERENCES results(id),
    chunk_id TEXT NOT NULL REFERENCES chunks(id),
    PRIMARY KEY(result_id, chunk_id)
);
"""


def initialize(database_url: str) -> None:
    with psycopg.connect(database_url, connect_timeout=5) as connection:
        connection.execute(SCHEMA)


def ready(database_url: str) -> bool:
    try:
        with psycopg.connect(database_url, connect_timeout=5) as connection:
            return connection.execute("SELECT version FROM schema_version").fetchone() == (1,)
    except psycopg.Error:
        return False
