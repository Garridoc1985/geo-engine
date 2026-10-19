"""Puerto de recuperación: aplicar permisos de documento Y fragmento."""
from typing import Protocol
from .contracts import Evidence, Query
from .contracts import Source
import psycopg
import re


class Retrieval(Protocol):
    def search(self, query: Query) -> tuple[Evidence, ...]: ...


def search_public(database_url: str, text: str, limit: int = 5, company_id: str | None = None) -> tuple[Evidence, ...]:
    """Recuperación textual española; autorizar ambas capas antes de devolver datos."""
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("Consulta vacía o demasiado extensa")
    if not 1 <= limit <= 20:
        raise ValueError("Límite de resultados fuera de rango")
    if company_id is not None and (not isinstance(company_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", company_id)):
        raise ValueError("Identificador de empresa inválido")
    with psycopg.connect(database_url, connect_timeout=5) as db:
        rows = db.execute("""
            SELECT c.id, d.id, s.id, s.reference, s.title, c.content
            FROM chunks c JOIN documents d ON d.id=c.document_id
            JOIN sources s ON s.id=d.source_id
            LEFT JOIN company_documents cd ON cd.document_id=d.id,
                 websearch_to_tsquery('spanish', %s) AS query
            WHERE d.visibility='public' AND c.visibility='public'
              AND (cd.document_id IS NULL OR cd.active)
              AND (%s::text IS NULL OR cd.company_id=%s)
              AND to_tsvector('spanish', c.content) @@ query
            ORDER BY ts_rank(to_tsvector('spanish', c.content), query) DESC, c.id
            LIMIT %s
        """, (text, company_id, company_id, limit)).fetchall()
    return tuple(Evidence(c, d, Source(s, ref, title), content) for c, d, s, ref, title, content in rows)


def task_context(database_url: str, company_id: str, task: str, limit: int = 5) -> tuple[Evidence, ...]:
    """Contexto público de dominios SCW para tareas generales de una empresa."""
    domains = {
        "company_profile": ("company_profile", "business_model", "products_services", "organization"),
        "catalog": ("products_services",),
        "faq": ("products_services", "company_profile"),
        "geo_content": ("company_profile", "products_services", "commercial_context"),
    }
    if not isinstance(company_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", company_id):
        raise ValueError("Identificador de empresa inválido")
    if task not in domains or not 1 <= limit <= 20:
        raise ValueError("Tarea o límite de contexto inválido")
    document_ids = [f"scw:{company_id}:domain:{domain}:document" for domain in domains[task]]
    prefix = f"scw:{company_id}:evidence:"
    with psycopg.connect(database_url, connect_timeout=5) as db:
        rows = db.execute("""
            SELECT c.id,d.id,s.id,s.reference,s.title,c.content
            FROM chunks c JOIN documents d ON d.id=c.document_id
            JOIN sources s ON s.id=d.source_id
            JOIN company_documents cd ON cd.document_id=d.id
            WHERE cd.company_id=%s AND cd.active
              AND d.visibility='public' AND c.visibility='public'
              AND (d.id=ANY(%s::text[]) OR left(d.id,length(%s))=%s)
            ORDER BY array_position(%s::text[],d.id) NULLS LAST, d.id, c.id
            LIMIT %s
        """, (company_id, document_ids, prefix, prefix, document_ids, limit)).fetchall()
    return tuple(Evidence(c, d, Source(s, ref, title), content) for c, d, s, ref, title, content in rows)
