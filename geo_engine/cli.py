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


def main() -> int:
    parser = argparse.ArgumentParser(description="GEO Engine: ingesta y router de IA")
    commands = parser.add_subparsers(dest="command", required=True)
    ingest = commands.add_parser("ingest", help="Importar catálogo JSON o CSV")
    ingest.add_argument("path", type=Path)
    route = commands.add_parser("route", help="Planificar una consulta; --execute habilita consumo de API")
    route.add_argument("query")
    route.add_argument("--origin", default="generic", help="Etiqueta de IA de origen, sin privilegios de acceso")
    route.add_argument("--execute", action="store_true", help="Enviar consulta y evidencia pública al proveedor (puede generar cargos)")
    route.add_argument("--allow-fallback", action="store_true", help="Tras fallo temporal, permitir siguiente proveedor configurado")
    args = parser.parse_args()
    try:
        config = Config.from_env()
        if args.command == "ingest":
            items = load_catalog(args.path)
            initialize(config.database_url)
            result = save_catalog(config.database_url, items)
        else:
            router = Router(build_providers_from_env(), lambda text: search_public(config.database_url, text))
            result = router.route(RouterQuery(args.query, args.origin), execute=args.execute, allow_fallback=args.allow_fallback)
        print(json.dumps(result, ensure_ascii=False))
        if args.command == "route" and args.execute and result["status"] in {"provider_error", "no_provider", "insufficient_evidence"}:
            return 2
        return 0
    except (ValueError, OSError, csv.Error) as error:
        print(f"Ingesta rechazada: {error}", file=sys.stderr)
        return 1
    except psycopg.Error:
        print("No se pudo completar la transacción PostgreSQL. Revise conexión y esquema.", file=sys.stderr)
        return 1
    except ProviderError as error:
        print(f"Configuración de proveedor rechazada: {error.code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
