// Uso: node scripts/check-public-site.mjs https://vectorbikestest.cl
// Sin cookies ni credenciales: detecta bloqueos que una sesión del dueño oculta.
const origin = new URL(process.argv[2] || "https://vectorbikestest.cl").origin;
let failed = false;
for (const path of ["/", "/servicios/", "/robots.txt", "/sitemap-index.xml"]) {
  try {
    const response = await fetch(origin + path, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    const problems = [];
    if (response.status !== 200) problems.push(`HTTP ${response.status}`);
    if (new URL(response.url).origin !== origin) problems.push("Redirección fuera del sitio");
    if (/noindex/i.test(response.headers.get("x-robots-tag") || "")) problems.push("Cabecera noindex");
    if (path.endsWith("/") && !text.includes(`<link rel="canonical" href="${origin}${path === "/" ? "/" : "/servicios"}`)) problems.push("Canonical ausente o distinto");
    if (path.endsWith("/") && /<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(text)) problems.push("Meta noindex");
    if (path === "/robots.txt" && (!text.includes(`Sitemap: ${origin}/sitemap-index.xml`) || /^Disallow:\s*\/\s*$/im.test(text))) problems.push("Robots bloqueado o sitemap ausente");
    if (path === "/sitemap-index.xml" && !text.includes("<sitemapindex")) problems.push("Sitemap inválido");
    failed ||= problems.length > 0;
    console.log(JSON.stringify({ path, ok: problems.length === 0, problems }));
  } catch {
    failed = true;
    console.log(JSON.stringify({ path, ok: false, problems: ["Error de conexión o tiempo agotado"] }));
  }
}
process.exitCode = failed ? 1 : 0;
