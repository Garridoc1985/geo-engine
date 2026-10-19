"""Entrada de ingesta local: python -m geo_engine.cli ingest archivo.json."""
import argparse
import csv
import json
import sys
from pathlib import Path

import psycopg
from .catalog import load_catalog, save_catalog
from .config import Config
from .storage import initialize
from .router import Router, RouterQuery
from .providers import ProviderError, build_providers_from_env
from .retrieval import search_public
from .runs import PostgresRunStore
from .company_knowledge import CompanyKnowledge
from .company_store import import_company


def main() -> int:
    parser = argparse.ArgumentParser(description="GEO Engine: ingesta y router de IA")
    commands = parser.add_subparsers(dest="command", required=True)
    ingest = commands.add_parser("ingest", help="Importar catálogo JSON o CSV")
    ingest.add_argument("path", type=Path)
    company = commands.add_parser("ingest-company", help="Importar conocimiento empresarial con estructura SCW")
    company.add_argument("company_id")
    company.add_argument("--workspace", type=Path, required=True, help="Raíz que contiene clients/<company_id>")
    route = commands.add_parser("route", help="Planificar una consulta; --execute habilita consumo de API")
    route.add_argument("query")
    route.add_argument("--origin", default="generic", help="Etiqueta de IA de origen, sin privilegios de acceso")
    route.add_argument("--company", dest="company_id", help="Recuperar conocimiento sólo de esta empresa")
    route.add_argument("--execute", action="store_true", help="Enviar consulta y evidencia pública al proveedor (puede generar cargos)")
    route.add_argument("--allow-fallback", action="store_true", help="Tras fallo temporal, permitir siguiente proveedor configurado")
    route.add_argument("--request-id", help="UUID estable para impedir repetir una ejecución ya reservada")
    show_run = commands.add_parser("show-run", help="Revisar una ejecución guardada en la base local")
    show_run.add_argument("request_id")
    args = parser.parse_args()
    try:
        config = Config.from_env()
        if args.command == "ingest":
            items = load_catalog(args.path)
            initialize(config.database_url)
            result = save_catalog(config.database_url, items)
        elif args.command == "ingest-company":
            records = CompanyKnowledge(args.workspace, args.company_id).load()
            initialize(config.database_url)
            result = import_company(config.database_url, args.company_id, records)
        elif args.command == "show-run":
            from uuid import UUID
            run_id = str(UUID(args.request_id))
            initialize(config.database_url)
            result = PostgresRunStore(config.database_url).get(run_id)
            if result is None:
                print("Ejecución no encontrada", file=sys.stderr)
                return 2
        else:
            initialize(config.database_url)
            router = Router(build_providers_from_env(), lambda text, company_id=None: search_public(config.database_url, text, company_id=company_id), PostgresRunStore(config.database_url))
            request = RouterQuery(args.query, args.origin, company_id=args.company_id, **({"request_id": args.request_id} if args.request_id is not None else {}))
            print(f"request_id={request.request_id}", file=sys.stderr)
            result = router.route(request, execute=args.execute, allow_fallback=args.allow_fallback)
        print(json.dumps(result, ensure_ascii=False))
        if args.command == "route" and args.execute and result["status"] in {"provider_error", "no_provider", "insufficient_evidence"}:
            return 2
        return 0
    except (ValueError, OSError, csv.Error) as error:
        print(f"Operación rechazada: {error}", file=sys.stderr)
        return 1
    except psycopg.Error:
        print("No se pudo completar la transacción PostgreSQL. Revise conexión y esquema.", file=sys.stderr)
        return 1
    except ProviderError as error:
        print(f"Configuración de proveedor rechazada: {error.code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
