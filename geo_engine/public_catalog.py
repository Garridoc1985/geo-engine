"""Proyección pública local para consumidores de datos y futuros agentes IA."""
import re
import psycopg


def read_public_catalog(database_url: str, company_id: str | None = None) -> dict:
    if company_id is not None and (not isinstance(company_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", company_id)):
        raise ValueError("Identificador de empresa inválido")
    with psycopg.connect(database_url, connect_timeout=5) as db:
        rows = db.execute("""
            SELECT c.id, d.id, d.title, c.content, s.id, s.reference
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            JOIN sources s ON s.id = d.source_id
            WHERE d.visibility = 'public' AND c.visibility = 'public'
              AND cardinality(d.allowed_principals)=0 AND cardinality(c.allowed_principals)=0
              AND NOT EXISTS (
                  SELECT 1 FROM company_documents cd WHERE cd.document_id=d.id AND NOT cd.active
              )
              AND (%s::text IS NULL OR EXISTS (
                  SELECT 1 FROM company_documents scoped
                  WHERE scoped.document_id=d.id AND scoped.company_id=%s AND scoped.active
              ))
            ORDER BY d.id, c.id
        """, (company_id, company_id)).fetchall()
    return {
        "schema_version": "1",
        "items": [
            {"chunk_id": c, "document_id": d, "title": title, "content": content,
             "source": {"id": source_id, "reference": reference}}
            for c, d, title, content, source_id, reference in rows
        ],
    }
