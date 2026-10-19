"""Persistencia operativa del conocimiento empresarial adaptado de SCW."""
import re
import psycopg
from .company_knowledge import KnowledgeRecord


def import_company(database_url: str, company_id: str, records: tuple[KnowledgeRecord, ...]) -> dict:
    if not isinstance(company_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", company_id):
        raise ValueError("Identificador de empresa inválido")
    if len({r.id for r in records}) != len(records):
        raise ValueError("El conocimiento debe contener registros únicos")
    imported = 0
    with psycopg.connect(database_url, connect_timeout=5) as db:
        db.execute("SELECT pg_advisory_xact_lock(739421002)")
        db.execute("INSERT INTO companies(id,name) VALUES (%s,%s) ON CONFLICT DO NOTHING", (company_id, company_id))
        previous = {row[0] for row in db.execute("SELECT document_id FROM company_documents WHERE company_id=%s AND active FOR UPDATE", (company_id,))}
        db.execute("UPDATE company_documents SET active=false WHERE company_id=%s", (company_id,))
        current = set()
        for item in records:
            source_id = f"scw:{company_id}:{item.id}:source"
            document_id = f"scw:{company_id}:{item.id}:document"
            chunk_id = f"scw:{company_id}:{item.id}:chunk:1"
            source = (source_id, item.reference, item.title)
            document = (document_id, source_id, item.title, item.visibility, list(item.allowed_principals))
            chunk = (chunk_id, document_id, item.content, item.visibility, list(item.allowed_principals))
            existing = db.execute("SELECT id FROM documents WHERE id=%s", (document_id,)).fetchone()
            db.execute("INSERT INTO sources(id,reference,title) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING", source)
            db.execute("INSERT INTO documents(id,source_id,title,visibility,allowed_principals) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", document)
            db.execute("INSERT INTO chunks(id,document_id,content,visibility,allowed_principals) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", chunk)
            actual = (
                db.execute("SELECT id,reference,title FROM sources WHERE id=%s", (source_id,)).fetchone(),
                db.execute("SELECT id,source_id,title,visibility,allowed_principals FROM documents WHERE id=%s", (document_id,)).fetchone(),
                db.execute("SELECT id,document_id,content,visibility,allowed_principals FROM chunks WHERE id=%s", (chunk_id,)).fetchone(),
            )
            if (actual[0], actual[1][:3], actual[2][:3]) != (source, document[:3], chunk[:3]):
                raise ValueError(f"Conflicto al importar conocimiento de {company_id}; no se sobrescribe")
            db.execute("UPDATE documents SET visibility=%s,allowed_principals=%s WHERE id=%s", (item.visibility, list(item.allowed_principals), document_id))
            db.execute("UPDATE chunks SET visibility=%s,allowed_principals=%s WHERE id=%s", (item.visibility, list(item.allowed_principals), chunk_id))
            db.execute("INSERT INTO company_documents(company_id,document_id,active) VALUES (%s,%s,true) ON CONFLICT(document_id) DO UPDATE SET active=true WHERE company_documents.company_id=EXCLUDED.company_id", (company_id, document_id))
            owner = db.execute("SELECT company_id FROM company_documents WHERE document_id=%s", (document_id,)).fetchone()
            if owner != (company_id,):
                raise ValueError("El documento pertenece a otra empresa")
            current.add(document_id)
            imported += existing is None
    return {"company_id": company_id, "processed": len(records), "imported": imported, "existing": len(records) - imported, "deactivated": len(previous - current)}
