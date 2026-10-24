import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const replit = readFileSync(".replit", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};

/** Contenido de una tabla TOML (`[nombre]` o `[[nombre]]`) hasta la siguiente. */
function section(name: string): string {
  const lines = replit.split("\n");
  const start = lines.findIndex((line) => line.trim() === name);
  if (start === -1) {
    return "";
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("["));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function line(block: string, key: string): string {
  return block.split("\n").find((entry) => entry.trim().startsWith(`${key} =`)) ?? "";
}

describe(".replit", () => {
  // El `run` de nivel superior es el del workspace; publicar usa el de [deployment].
  const deployment = section("[deployment]");

  it("publica en Autoscale construyendo con el lockfile", () => {
    expect(replit).toContain("[deployment]");
    expect(line(deployment, "deploymentTarget")).toContain('"cloudrun"');
    const build = line(deployment, "build");
    expect(build).toContain("pnpm@12.4.2 install --frozen-lockfile");
    expect(build).toContain("pnpm@12.4.2 build");
  });

  it("fija pnpm 12.4.2 en el build, porque Replit reescribe package.json al publicar", () => {
    const build = line(deployment, "build");
    expect(build).toContain("pnpm@12.4.2");
    expect(build).toContain("--frozen-lockfile");
  });

  it("relaja minimumReleaseAge solo en el install del build de [deployment]", () => {
    const build = line(deployment, "build");
    expect(build).toContain("install --frozen-lockfile --config.minimumReleaseAge=0");
    expect(replit.match(/minimumReleaseAge/g)).toHaveLength(1);
  });

  it("arranca el servidor standalone en 0.0.0.0:4321", () => {
    const run = line(deployment, "run");
    expect(run).toContain("HOST=0.0.0.0");
    expect(run).toContain("node dist/server/entry.mjs");
    expect(section("[[ports]]")).toMatch(/^\s*localPort = 4321\s*$/m);
  });
});

describe("package.json", () => {
  it("define los scripts que usan Replit y la tarea programada", () => {
    expect(pkg.scripts?.start).toContain("node dist/server/entry.mjs");
    expect(pkg.scripts?.["reminders:send"]).toBe(
      "node --env-file-if-exists=.env scripts/reminders-send.ts",
    );
  });
});
