"""Paquete instalable GEO: destino público, contenido visible y procedencia."""
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from geo_engine.company_knowledge import KnowledgeRecord
from geo_engine.company_store import import_company
from geo_engine.integration import build_integration_bundle, export_integration
from geo_engine.storage import initialize


FILES = {
    "index.html", "body-fragment.html", "head-fragment.html", "home-link.html",
    "knowledge.json", "manifest.json", "sitemap.xml", "robots-merge.txt", "INSTALL.md",
}
BASE_URL = "https://alpha.example.com/geo/"


def record(identifier, content, reference="https://example.test/about", *, visibility="public"):
    return KnowledgeRecord(identifier, "Ficha empresarial", content, reference, visibility, ())


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere GEO_TEST_DATABASE_URL")
class IntegrationPostgreSQLTests(unittest.TestCase):
    def setUp(self):
        self.base = os.environ["GEO_TEST_DATABASE_URL"]
        self.schema = "geo_integration_test_" + uuid4().hex
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        self.url = make_conninfo(self.base, options=f"-c search_path={self.schema}")
        initialize(self.url)
        self.records = (
            record("domain:company_profile", "Empresa sintética Alpha."),
            record("domain:products_services", "Alpha ofrece reparación documentada.", "https://example.test/services"),
            record("domain:commercial_context", "NO_PUBLICAR_INTERNO_ALPHA", visibility="internal"),
        )
        import_company(self.url, "alpha", self.records)
        import_company(self.url, "beta", (
            record("domain:company_profile", "NO_PUBLICAR_OTRA_EMPRESA", "https://beta.example.test/about"),
        ))

    def drop_schema(self):
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def build(self, *, name="Alpha", base_url=BASE_URL, company="alpha"):
        return build_integration_bundle(self.url, company, name, base_url)

    def test_bundle_contains_visible_installable_content_and_public_sources(self):
        bundle = self.build()
        self.assertEqual(set(bundle), FILES)
        self.assertTrue(all(isinstance(value, str) for value in bundle.values()))
        body = bundle["body-fragment.html"]
        self.assertIn("geo-engine", body)
        self.assertRegex(body, r"<h2\b")
        self.assertRegex(body, r"<h3\b")
        self.assertIn("Empresa sintética Alpha.", body)
        self.assertIn("Alpha ofrece reparación documentada.", body)
        self.assertIn("https://example.test/about", body)
        self.assertIn("https://example.test/services", body)
        self.assertRegex(body, r"<p\b[^>]*>[^<]*Fuente:")
        for tag in ("html", "head", "h1", "script"):
            with self.subTest(tag=tag):
                self.assertNotRegex(body, rf"(?i)<{tag}(?:\s|>)")
        for selector in (r"(?:^|[}])\s*body\s*[{]", r"(?:^|[}])\s*main\s*[{]"):
            self.assertNotRegex(body, selector)
        serialized = "\n".join(bundle.values())
        self.assertNotIn("NO_PUBLICAR_INTERNO_ALPHA", serialized)
        self.assertNotIn("NO_PUBLICAR_OTRA_EMPRESA", serialized)
        knowledge = json.loads(bundle["knowledge.json"])
        self.assertEqual(knowledge["company_id"], "alpha")
        self.assertEqual(knowledge["canonical_url"], BASE_URL)
        self.assertEqual(len(knowledge["items"]), 2)
        self.assertEqual({item["source"]["reference"] for item in knowledge["items"]},
                         {"https://example.test/about", "https://example.test/services"})
        self.assertTrue(all(item["chunk_id"].startswith("scw:alpha:") for item in knowledge["items"]))

    def test_head_fragment_has_dataset_and_alternate_without_duplicate_page_metadata(self):
        bundle = self.build()
        head = bundle["head-fragment.html"]
        self.assertIn("application/ld+json", head)
        match = re.search(r'<script\b[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', head, re.S)
        self.assertIsNotNone(match)
        structured = json.loads(match.group(1))
        self.assertEqual(structured["@type"], "Dataset")
        self.assertEqual(structured["url"], BASE_URL)
        self.assertEqual(structured["distribution"]["contentUrl"], BASE_URL + "knowledge.json")
        self.assertEqual(set(structured["citation"]),
                         {"https://example.test/about", "https://example.test/services"})
        self.assertIn('rel="alternate"', head)
        self.assertIn(BASE_URL + "knowledge.json", head)
        self.assertNotRegex(head, r'(?i)rel\s*=\s*["\x27]canonical')
        self.assertNotRegex(head, r'"@type"\s*:\s*"LocalBusiness"')
        self.assertNotRegex(head, r"(?i)<(?:html|head|body|title)(?:\s|>)")
        self.assertIn(BASE_URL, bundle["home-link.html"])
        self.assertNotIn("localhost", "\n".join(bundle[filename] for filename in FILES - {"INSTALL.md"}))
        self.assertNotIn("127.0.0.1", "\n".join(bundle[filename] for filename in FILES - {"INSTALL.md"}))

    def test_robot_rules_are_a_merge_fragment_and_preserve_other_agent_policies(self):
        bundle = self.build()
        self.assertNotIn("robots.txt", bundle)
        rules = bundle["robots-merge.txt"]
        self.assertIn("User-agent: OAI-SearchBot", rules)
        self.assertIn("Sitemap: " + BASE_URL + "sitemap.xml", rules)
        directives = [line.strip() for line in rules.splitlines() if line.strip() and not line.lstrip().startswith("#")]
        agents = [line.partition(":")[2].strip() for line in directives if line.lower().startswith("user-agent:")]
        self.assertEqual(agents, ["OAI-SearchBot"])
        self.assertNotIn("User-agent: *", rules)
        self.assertNotIn("User-agent: GPTBot", rules)
        self.assertNotIn("Disallow: /", rules)
        self.assertIn(BASE_URL, bundle["sitemap.xml"])
        self.assertIn("robots", bundle["INSTALL.md"].lower())

    def test_manifest_hashes_cover_every_file_except_itself_and_are_deterministic(self):
        bundle = self.build()
        self.assertEqual(bundle, self.build())
        manifest = json.loads(bundle["manifest.json"])
        self.assertEqual(manifest["content_version"], sha256(bundle["knowledge.json"].encode("utf-8")).hexdigest())
        self.assertEqual(set(manifest["files"]), FILES - {"manifest.json"})
        for filename, digest in manifest["files"].items():
            with self.subTest(filename=filename):
                self.assertEqual(digest, sha256(bundle[filename].encode("utf-8")).hexdigest())

    def test_untrusted_text_is_escaped_and_json_ld_cannot_terminate_script(self):
        injection = '</script><script>alert("xss")</script><img src=x onerror=alert(1)>'
        import_company(self.url, "unsafe", (
            record("domain:company_profile", injection),
        ))
        bundle = self.build(company="unsafe", name='Nombre </script><img src=x onerror=alert(2)>')
        for filename in ("index.html", "body-fragment.html", "head-fragment.html", "home-link.html"):
            with self.subTest(filename=filename):
                self.assertNotIn('<script>alert("xss")</script>', bundle[filename])
                self.assertNotIn("<img src=x", bundle[filename])
        self.assertIn("&lt;", bundle["body-fragment.html"])
        self.assertNotIn("Nombre </script>", bundle["head-fragment.html"])
        knowledge = json.loads(bundle["knowledge.json"])
        self.assertEqual(knowledge["items"][0]["content"], injection)

    def test_empty_or_unknown_company_has_no_installable_bundle(self):
        with self.assertRaises(ValueError):
            self.build(company="missing")
        import_company(self.url, "alpha", ())
        with self.assertRaises(ValueError):
            self.build()

    def test_public_document_and_chunk_acl_are_both_enforced(self):
        with psycopg.connect(self.url) as db:
            db.execute("UPDATE documents SET allowed_principals=ARRAY['restricted'] WHERE id='scw:alpha:domain:company_profile:document'")
            db.execute("UPDATE chunks SET allowed_principals=ARRAY['restricted'] WHERE id='scw:alpha:domain:products_services:chunk:1'")
        with self.assertRaises(ValueError):
            self.build()

    def test_destination_must_be_explicit_public_https_without_ambiguous_paths(self):
        invalid = (
            "http://alpha.example.com/geo/", "https://localhost/geo/", "https://localhost./geo/",
            "https://alpha.local/geo/", "https://alpha.internal/geo/", "https://alpha.test/geo/",
            "https://127.0.0.1/geo/", "https://10.1.2.3/geo/", "https://192.168.1.1/geo/",
            "https://169.254.1.1/geo/", "https://[::1]/geo/", "https://[fc00::1]/geo/",
            "https://user:password@alpha.example.com/geo/", "https://alpha.example.com/geo/?key=value",
            "https://alpha.example.com/geo/#part", "https://alpha.example.com/a/../geo/",
            "https://alpha.example.com/geo//nested/", "https://alpha.example.com/%2e%2e/geo/",
            "https://alpha.example.com/geo\\nested/", "https://alpha.example.com/has space/",
            "https://alpha.example.com:invalid/geo/", "https:///geo/", "", None,
        )
        for base_url in invalid:
            with self.subTest(base_url=base_url), self.assertRaises(ValueError):
                self.build(base_url=base_url)

    def test_withdrawn_public_content_disappears_from_installation_release(self):
        before = self.build()
        import_company(self.url, "alpha", (self.records[0],))
        after = self.build()
        self.assertNotEqual(before["manifest.json"], after["manifest.json"])
        self.assertNotIn("Alpha ofrece reparación documentada.", "\n".join(after.values()))
        self.assertNotIn("https://example.test/services", "\n".join(after.values()))

    def test_export_writes_a_new_release_and_never_overwrites_existing_files(self):
        bundle = self.build()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "installation"
            export_integration(bundle, output)
            self.assertEqual({path.name for path in output.iterdir()}, FILES)
            for filename, expected in bundle.items():
                self.assertEqual((output / filename).read_text(encoding="utf-8"), expected)
            with self.assertRaises((ValueError, FileExistsError)):
                export_integration(bundle, output)
            self.assertEqual((output / "body-fragment.html").read_text(encoding="utf-8"), bundle["body-fragment.html"])


if __name__ == "__main__":
    unittest.main()
