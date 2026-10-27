import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicFiles = ["index.html", "knowledge.json", "manifest.json", "sitemap.xml"];
const hashedFiles = ["index.html", "knowledge.json", "sitemap.xml"];

function readRegular(directory, name) {
  const filename = path.join(directory, name);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.size > 5_000_000) throw new Error(`Archivo inválido: ${name}`);
  return readFileSync(filename);
}

export function validateRelease(directory, siteUrl) {
  const site = new URL(siteUrl);
  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.port ||
    site.pathname !== "/" ||
    site.search ||
    site.hash
  ) {
    throw new Error("Indica la URL HTTPS raíz del sitio, sin credenciales ni parámetros.");
  }
  const files = Object.fromEntries(publicFiles.map((name) => [name, readRegular(directory, name)]));
  const manifest = JSON.parse(files["manifest.json"].toString("utf8"));
  if (
    manifest.schema_version !== "1" ||
    manifest.format !== "site-integration" ||
    manifest.status !== "prepared" ||
    manifest.company_id !== "vectorbikes" ||
    manifest.canonical_url !== new URL("geo/", site).href
  ) {
    throw new Error("El paquete no corresponde a Vector Bikes o al destino /geo/ indicado.");
  }
  for (const name of hashedFiles) {
    const hash = createHash("sha256").update(files[name]).digest("hex");
    if (manifest.files?.[name] !== hash) throw new Error(`Integridad inválida: ${name}`);
  }
  const knowledge = JSON.parse(files["knowledge.json"].toString("utf8"));
  const version = createHash("sha256").update(files["knowledge.json"]).digest("hex");
  if (
    version !== manifest.content_version ||
    knowledge.schema_version !== "1" ||
    knowledge.company_id !== manifest.company_id ||
    knowledge.canonical_url !== manifest.canonical_url ||
    knowledge.name !== "Vector Bikes" ||
    !Array.isArray(knowledge.items) ||
    knowledge.items.length < 1 ||
    knowledge.items.length > 30 ||
    knowledge.items.length !== manifest.item_count
  ) {
    throw new Error("El conocimiento no coincide con la empresa, versión o cantidad declarada.");
  }
  return files;
}

export function installRelease(directory, siteUrl, root) {
  // Validar todo antes de cambiar la publicación existente. Los hashes no sustituyen revisión editorial.
  const files = validateRelease(directory, siteUrl);
  const publicDir = path.join(root, "public");
  mkdirSync(publicDir, { recursive: true });
  const target = path.join(publicDir, "geo");
  const backup = path.join(root, ".geo-backup");
  if (existsSync(backup))
    throw new Error("Conserva o retira .geo-backup antes de otra instalación.");
  if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error("Destino inválido.");
  const stage = mkdtempSync(path.join(publicDir, ".geo-stage-"));
  try {
    for (const name of publicFiles) writeFileSync(path.join(stage, name), files[name]);
    if (existsSync(target)) renameSync(target, backup);
    try {
      renameSync(stage, target);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, target);
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, siteUrl, approval, ...extra] = process.argv.slice(2);
  if (!directory || !siteUrl || approval !== "--reviewed" || extra.length) {
    console.error("Uso: node scripts/geo-install.mjs RELEASE HTTPS_SITE_URL --reviewed");
    process.exitCode = 1;
  } else {
    try {
      installRelease(directory, siteUrl, fileURLToPath(new URL("../", import.meta.url)));
      console.log("Paquete GEO instalado localmente. Falta construir, verificar y desplegar.");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
