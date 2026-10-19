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


def main() -> int:
    parser = argparse.ArgumentParser(description="GEO Engine: ingesta local de catálogo")
    commands = parser.add_subparsers(dest="command", required=True)
    ingest = commands.add_parser("ingest", help="Importar catálogo JSON o CSV")
    ingest.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        items = load_catalog(args.path)
        config = Config.from_env()
        initialize(config.database_url)
        print(json.dumps(save_catalog(config.database_url, items)))
        return 0
    except (ValueError, OSError, csv.Error) as error:
        print(f"Ingesta rechazada: {error}", file=sys.stderr)
        return 1
    except psycopg.Error:
        print("No se pudo completar la transacción PostgreSQL. Revise conexión y esquema.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
