import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateRelease } from "./geo-install.mjs";

const origin = "https://vectorbikestest.cl";

test("el release aprobado conserva empresa, archivos y versión coherentes", () => {
  assert.ok(validateRelease("public/geo", origin)["knowledge.json"]);
});

test("un archivo alterado bloquea la compilación", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "vector-geo-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync("public/geo", directory, { recursive: true });
  writeFileSync(path.join(directory, "knowledge.json"), "{}");
  assert.throws(() => validateRelease(directory, origin), /Integridad inválida/);
});

test("rechaza datos de otra empresa incluso con hashes recalculados", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "vector-geo-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync("public/geo", directory, { recursive: true });
  const knowledge = JSON.parse(readFileSync(path.join(directory, "knowledge.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  knowledge.company_id = "otra_empresa";
  const bytes = JSON.stringify(knowledge);
  const hash = createHash("sha256").update(bytes).digest("hex");
  manifest.files["knowledge.json"] = hash;
  manifest.content_version = hash;
  writeFileSync(path.join(directory, "knowledge.json"), bytes);
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => validateRelease(directory, origin), /no coincide/);
});
