"""Proyección pública local para consumidores de datos y futuros agentes IA."""
import psycopg


def read_public_catalog(database_url: str) -> dict:
    with psycopg.connect(database_url, connect_timeout=5) as db:
        rows = db.execute("""
            SELECT c.id, d.id, d.title, c.content, s.id, s.reference
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            JOIN sources s ON s.id = d.source_id
            WHERE d.visibility = 'public' AND c.visibility = 'public'
            ORDER BY d.id, c.id
        """).fetchall()
    return {
        "schema_version": "1",
        "items": [
            {"chunk_id": c, "document_id": d, "title": title, "content": content,
             "source": {"id": source_id, "reference": reference}}
            for c, d, title, content, source_id, reference in rows
        ],
    }
