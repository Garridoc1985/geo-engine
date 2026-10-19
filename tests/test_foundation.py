import json
import os
import threading
import unittest
from uuid import uuid4
from unittest.mock import patch
from urllib.request import urlopen
from urllib.error import HTTPError

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from geo_engine.api import create_server
from geo_engine.config import Config
from geo_engine.contracts import Permissions
from geo_engine.storage import initialize, ready


class FoundationTests(unittest.TestCase):
    def test_permissions(self):
        restricted = Permissions("internal", ("authorized",))
        self.assertFalse(restricted.allows(None))
        self.assertFalse(restricted.allows("other"))
        self.assertTrue(restricted.allows("authorized"))
        self.assertTrue(Permissions("public").allows(None))

    def test_remote_bind_rejected(self):
        with patch.dict(os.environ, {"GEO_HOST": "0.0.0.0"}):
            with self.assertRaises(ValueError):
                Config.from_env()

    def test_requires_postgresql(self):
        with patch.dict(os.environ, {"DATABASE_URL": "file:///invalid"}):
            with self.assertRaises(ValueError):
                Config.from_env()

    def test_ipv6_not_supported_by_local_server(self):
        with patch.dict(os.environ, {"GEO_HOST": "::1"}):
            with self.assertRaises(ValueError):
                Config.from_env()

    def test_credentials_not_in_repr(self):
        self.assertNotIn("secret", repr(Config("127.0.0.1", 8000, "postgresql://user:secret@localhost/db")))


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere GEO_TEST_DATABASE_URL")
class PostgreSQLTests(unittest.TestCase):
    def setUp(self):
        self.base_url = os.environ["GEO_TEST_DATABASE_URL"]
        self.schema = "geo_test_" + uuid4().hex
        with psycopg.connect(self.base_url) as connection:
            connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        self.database_url = make_conninfo(self.base_url, options=f"-c search_path={self.schema}")

    def drop_schema(self):
        with psycopg.connect(self.base_url) as connection:
            connection.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def test_schema_and_provenance(self):
        initialize(self.database_url)
        initialize(self.database_url)
        with psycopg.connect(self.database_url) as db:
            with self.assertRaises(psycopg.errors.ForeignKeyViolation):
                with db.transaction():
                    db.execute("INSERT INTO documents VALUES ('d', 'missing', 'title', 'public', '{}')")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sources").fetchone()[0], 0)
            db.execute("INSERT INTO sources VALUES ('s', 'fixture://source', 'Synthetic')")
            db.execute("INSERT INTO documents VALUES ('d', 's', 'Test', 'internal', %s)", (["authorized"],))
            self.assertEqual(db.execute("SELECT allowed_principals FROM documents").fetchone()[0], ["authorized"])

    def test_readiness_without_schema(self):
        self.assertFalse(ready(self.database_url))

    def test_api_integration(self):
        server = create_server(Config("127.0.0.1", 0, self.database_url))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            for endpoint, expected in [("/health", {"status": "ok", "service": "geo-engine"}), ("/ready", {"database": "ready"})]:
                with urlopen(base + endpoint, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.load(response), expected)
            with self.assertRaises(HTTPError) as error:
                urlopen(base + "/documents", timeout=5)
            self.assertEqual(error.exception.code, 404)
            with psycopg.connect(self.database_url) as db:
                db.execute("DROP TABLE schema_version")
            with self.assertRaises(HTTPError) as error:
                urlopen(base + "/ready", timeout=5)
            self.assertEqual(error.exception.code, 503)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
