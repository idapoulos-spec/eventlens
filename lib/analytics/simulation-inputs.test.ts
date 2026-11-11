import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// On a branch, CI runs the slow simulations only when the branch changes a path listed in
// .github/simulation-inputs.txt (scripts/simulations-needed.sh). This follows the imports of every
// simulation file (*.sim.test.ts, vitest.shared.ts's SIMULATIONS) and of vitest.sim.config.mts, and
// fails if the list doesn't cover a file they reach, so the list can't quietly fall behind when the
// statistics start importing something new. Packages are covered by package.json and pnpm-lock.yaml.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LIST = ".github/simulation-inputs.txt";

// Static imports and re-exports, dynamic imports, and side-effect imports.
const IMPORT =
  /\b(?:import|export)\s[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".json", "/index.ts", "/index.tsx"];

/** Repo-relative path with forward slashes. */
function repoPath(absolute: string): string {
  return relative(ROOT, absolute).split(sep).join("/");
}

function listEntries(): string[] {
  return readFileSync(join(ROOT, LIST), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** An entry ending in "/" covers everything under that directory; any other entry, that one file. */
function covered(file: string, entries: string[]): boolean {
  return entries.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

/** Every *.sim.test.ts file, outside node_modules and dot-directories. */
function simulationFiles(dir = ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) found.push(...simulationFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".sim.test.ts")) {
      found.push(repoPath(join(dir, entry.name)));
    }
  }
  return found.sort();
}

/** The repo file an import resolves to; null for a package; undefined when a local import doesn't resolve. */
function resolveImport(from: string, specifier: string): string | null | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = join(ROOT, dirname(from), specifier);
  else return null;
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return repoPath(candidate);
  }
  return undefined;
}

/** Every repo file reachable by imports from the roots, and the local imports that didn't resolve. */
function reach(roots: string[]): { files: string[]; unresolved: string[] } {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const match of readFileSync(join(ROOT, file), "utf8").matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const target = resolveImport(file, specifier);
      if (target === undefined) unresolved.push(`${file}: ${specifier}`);
      else if (target !== null) queue.push(target);
    }
  }
  return { files: [...files].sort(), unresolved };
}

describe(`the simulations' inputs (${LIST})`, () => {
  const entries = listEntries();
  const simulations = simulationFiles();
  const { files, unresolved } = reach([...simulations, "vitest.sim.config.mts"]);

  it("finds the simulation files", () => {
    expect(simulations.length).toBeGreaterThan(0);
    expect(files).toEqual(expect.arrayContaining(simulations));
  });

  it("resolves every local import they make", () => {
    expect(unresolved).toEqual([]);
  });

  it("lists every file they import, and the Vitest config that runs them", () => {
    expect(files.filter((file) => !covered(file, entries))).toEqual([]);
  });

  it("lists the dependencies, the TypeScript config, the CI job, the decision, and itself", () => {
    expect(entries).toEqual(
      expect.arrayContaining([
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        ".github/workflows/ci.yml",
        LIST,
        "scripts/simulations-needed.sh",
      ]),
    );
  });

  it("lists only paths that exist", () => {
    expect(entries.filter((entry) => !existsSync(join(ROOT, entry)))).toEqual([]);
  });
});
