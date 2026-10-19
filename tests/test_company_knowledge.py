import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from geo_engine.company_knowledge import CompanyKnowledge, DOMINIOS, KnowledgeRecord


HEADER = (
    "| Evidence ID | Client | Engagement | Workflow | Source Type | Source | "
    "Capture Date | Author | Confidence | ODT Domain | Summary | Related Evidence | Status |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
)


class CompanyKnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.company = self.workspace / "clients" / "demo"
        (self.company / "evidence").mkdir(parents=True)
        self.loader = CompanyKnowledge(self.workspace, "demo")

    def write(self, relative, content):
        path = self.company / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def row(self, evidence_id="EV-000001", relative="evidence/one.md", status="Validated"):
        values = [f"[{evidence_id}]({relative})", "demo", "", "", "", "fixture://one",
                  "", "", "high", "products_services", "Synthetic record", "", status]
        return "| " + " | ".join(values) + " |\n"

    def manifest(self, entries):
        self.write("access.json", json.dumps(entries))

    def test_original_scw_domains_and_registry_are_loaded_together(self):
        self.write("company_profile.md", "# Empresa ficticia\nPerfil empresarial sintético.")
        self.write("products_services.md", "# Servicios\nAnalítica comercial ficticia.")
        self.write("evidence/one.md", "# Oferta\nServicio sintético.")
        self.write("evidence_registry.md", "# Evidence Registry\n\n" + HEADER + self.row())
        records = self.loader.load()
        self.assertEqual([record.id for record in records], [
            "domain:company_profile", "domain:products_services", "evidence:EV-000001"
        ])
        self.assertEqual(records[2].title, "EV-000001")
        self.assertEqual(records[2].content, "# Oferta\nServicio sintético.")
        self.assertEqual(records[2].reference, "scw://demo/evidence/one.md")
        self.assertTrue(all(record.visibility == "internal" for record in records))
        self.assertTrue(all(record.allowed_principals == () for record in records))

    def test_only_known_domains_and_linked_evidence_are_loaded(self):
        for domain in DOMINIOS:
            self.write(f"{domain}.md", f"# {domain}\nSynthetic")
        self.write("secret_notes.md", "Should not be automatically imported")
        self.write("evidence/unlinked.md", "Should not be automatically imported")
        self.assertEqual(len(self.loader.load()), len(DOMINIOS))

    def test_empty_domains_and_original_placeholder_are_compatible(self):
        self.write("company_profile.md", " \n")
        self.write("evidence_registry.md", HEADER + "| EV-000001 | | | | | | | | | | | | New |\n")
        self.assertEqual(self.loader.load(), ())

    def test_manifest_is_explicit_and_does_not_make_other_records_public(self):
        self.write("company_profile.md", "Synthetic public profile")
        self.write("financial_context.md", "Synthetic confidential financials")
        self.write("evidence/one.md", "Synthetic restricted evidence")
        self.write("evidence_registry.md", HEADER + self.row())
        self.manifest({
            "company_profile.md": {"visibility": "public", "allowed_principals": [],
                                   "source_reference": "https://example.invalid/company"},
            "evidence/one.md": {"visibility": "internal", "allowed_principals": ["bob", "alice"]},
        })
        records = {record.id: record for record in self.loader.load()}
        profile = records["domain:company_profile"]
        self.assertEqual((profile.visibility, profile.reference),
                         ("public", "https://example.invalid/company"))
        self.assertEqual(records["domain:financial_context"].visibility, "internal")
        self.assertEqual(records["domain:financial_context"].allowed_principals, ())
        self.assertEqual(records["evidence:EV-000001"].allowed_principals, ("alice", "bob"))

    def test_all_retired_statuses_skip_missing_evidence(self):
        retired = ("Superseded by EV-000009", "**Archived**", "Rejected", "Invalid", "Deprecated")
        self.write("evidence_registry.md", HEADER + "".join(
            self.row(f"EV-{index:06d}", f"evidence/missing-{index}.md", status)
            for index, status in enumerate(retired, 1)
        ))
        self.assertEqual(self.loader.load(), ())

    def test_rejects_invalid_company_ids_and_missing_company(self):
        for company_id in ("", "../demo", "Other", "a" * 65, "a/b", "a\\b", None):
            with self.subTest(company_id=company_id), self.assertRaises(ValueError):
                CompanyKnowledge(self.workspace, company_id)
        with self.assertRaises(ValueError):
            CompanyKnowledge(self.workspace, "missing").load()

    def test_rejects_missing_evidence_and_duplicate_ids_atomically(self):
        self.write("company_profile.md", "Synthetic profile")
        self.write("evidence_registry.md", HEADER + self.row())
        with self.assertRaises(ValueError):
            self.loader.load()
        self.write("evidence/one.md", "Synthetic evidence")
        self.write("evidence_registry.md", HEADER + self.row() + self.row())
        with self.assertRaises(ValueError):
            self.loader.load()

    def test_rejects_malformed_registry_without_disclosing_content(self):
        for text in (
            "Not a registry: synthetic-sensitive-marker",
            HEADER + "| synthetic-sensitive-marker | Invalid row |\n",
            HEADER + self.row().replace("[EV-000001](evidence/one.md)", "synthetic-sensitive-marker"),
            HEADER.replace("Status", "Summary") + self.row(),
            HEADER + self.row(status=""),
        ):
            self.write("evidence_registry.md", text)
            with self.subTest(text=text), self.assertRaises(ValueError) as caught:
                self.loader.load()
            self.assertNotIn("synthetic-sensitive-marker", str(caught.exception))

    def test_rejects_escape_links_and_absolute_paths(self):
        for relative in (
            "evidence/../../other/private.md", "evidence/../company_profile.md",
            "/tmp/private.md", "evidence/..\\..\\other.md", "evidence/C:/private.md",
            "evidence//one.md",
        ):
            self.write("evidence_registry.md", HEADER + self.row(relative=relative))
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                self.loader.load()

    def test_manifest_rejects_invalid_acl_visibility_and_schema(self):
        entries = [
            [], {"company_profile.md": {"visibility": "public"}},
            {"company_profile.md": {"visibility": "unknown", "allowed_principals": []}},
            {"company_profile.md": {"visibility": [], "allowed_principals": []}},
            {"company_profile.md": {"visibility": "public", "allowed_principals": ["alice"]}},
            {"company_profile.md": {"visibility": "internal", "allowed_principals": ["alice", "alice"]}},
            {"company_profile.md": {"visibility": "internal", "allowed_principals": [" alice"]}},
            {"company_profile.md": {"visibility": "internal", "allowed_principals": [None]}},
            {"company_profile.md": {"visibility": "internal", "allowed_principals": [{}]}},
            {"company_profile.md": {"visibility": "internal", "allowed_principals": [], "extra": True}},
            {"company_profile.md": {"visibility": "public", "allowed_principals": [], "source_reference": ""}},
            {"../outside.md": {"visibility": "public", "allowed_principals": []}},
        ]
        for entry in entries:
            self.manifest(entry)
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                self.loader.load()
        self.write("access.json", '{"company_profile.md": {}, "company_profile.md": {}}')
        with self.assertRaises(ValueError):
            self.loader.load()

    def test_symlink_cannot_read_another_company(self):
        other = self.workspace / "clients" / "other"
        other.mkdir()
        (other / "private.md").write_text("synthetic-sensitive-marker", encoding="utf-8")
        link = self.company / "company_profile.md"
        try:
            link.symlink_to(other / "private.md")
        except (OSError, NotImplementedError):
            self.skipTest("La creación de symlinks requiere permisos en este sistema")
        with self.assertRaises(ValueError) as caught:
            self.loader.load()
        self.assertNotIn("synthetic-sensitive-marker", str(caught.exception))

    def test_evidence_and_manifest_symlinks_cannot_escape_company(self):
        outside = self.workspace / "outside.md"
        outside.write_text("synthetic-sensitive-marker", encoding="utf-8")
        link = self.company / "evidence" / "one.md"
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("La creación de symlinks requiere permisos en este sistema")
        self.write("evidence_registry.md", HEADER + self.row())
        with self.assertRaises(ValueError):
            self.loader.load()
        link.unlink()
        self.write("evidence/one.md", "Synthetic evidence")
        (self.company / "access.json").symlink_to(outside)
        with self.assertRaises(ValueError):
            self.loader.load()

    def test_company_symlink_cannot_alias_another_company(self):
        alias = self.workspace / "clients" / "alias"
        try:
            alias.symlink_to(self.company, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("La creación de symlinks requiere permisos en este sistema")
        with self.assertRaises(ValueError):
            CompanyKnowledge(self.workspace, "alias").load()

    def test_records_cannot_bypass_validation_when_constructed_directly(self):
        values = dict(id="domain:company_profile", title="Synthetic profile", content="Synthetic",
                      reference="fixture://profile", visibility="internal", allowed_principals=())
        self.assertEqual(KnowledgeRecord(**values).visibility, "internal")
        invalid = (
            {"id": "../../other"}, {"id": "evidence:EV-000001\n"},
            {"title": ""}, {"content": ""}, {"content": "Synthetic\x00"}, {"content": "x" * 20001},
            {"reference": None}, {"visibility": "unknown"},
            {"allowed_principals": []}, {"allowed_principals": ("alice", "alice")},
            {"allowed_principals": ([],)},
            {"visibility": "public", "allowed_principals": ("alice",)},
        )
        for change in invalid:
            with self.subTest(change=change), self.assertRaises(ValueError):
                KnowledgeRecord(**{**values, **change})

    def test_registry_cannot_cross_to_a_second_table(self):
        self.write("evidence/one.md", "Synthetic evidence")
        self.write("evidence_registry.md", HEADER + self.row() + "\n## Other table\n\n| key | value |\n|---|---|\n| one | two |\n")
        self.assertEqual(len(self.loader.load()), 1)

    def test_large_file_is_rejected_before_import(self):
        self.write("company_profile.md", "x" * 200001)
        with self.assertRaises(ValueError):
            self.loader.load()


if __name__ == "__main__":
    unittest.main()
