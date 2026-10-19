"""Puerto de recuperación: aplicar permisos de documento Y fragmento."""
from typing import Protocol
from .contracts import Evidence, Query
from .contracts import Source
import psycopg


class Retrieval(Protocol):
    def search(self, query: Query) -> tuple[Evidence, ...]: ...


def search_public(database_url: str, text: str, limit: int = 5) -> tuple[Evidence, ...]:
    """Recuperación textual española; autorizar ambas capas antes de devolver datos."""
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("Consulta vacía o demasiado extensa")
    if not 1 <= limit <= 20:
        raise ValueError("Límite de resultados fuera de rango")
    with psycopg.connect(database_url, connect_timeout=5) as db:
        rows = db.execute("""
            SELECT c.id, d.id, s.id, s.reference, s.title, c.content
            FROM chunks c JOIN documents d ON d.id=c.document_id
            JOIN sources s ON s.id=d.source_id,
                 websearch_to_tsquery('spanish', %s) AS query
            WHERE d.visibility='public' AND c.visibility='public'
              AND to_tsvector('spanish', c.content) @@ query
            ORDER BY ts_rank(to_tsvector('spanish', c.content), query) DESC, c.id
            LIMIT %s
        """, (text, limit)).fetchall()
    return tuple(Evidence(c, d, Source(s, ref, title), content) for c, d, s, ref, title, content in rows)
