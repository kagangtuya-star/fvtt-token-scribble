#!/usr/bin/env node
/**
 * Zero-dependency build: strips TypeScript types with Node's built-in
 * `module.stripTypeScriptTypes` (Node ≥ 22.13), rewrites import specifiers and
 * assembles an installable module folder in `dist/`.
 *
 * Foundry loads native ES modules, so no bundler is needed: each source file
 * maps 1:1 to an output file (readable stack traces, no source maps required).
 *
 *   node tools/build.mjs            production build into dist/
 *   node tools/build.mjs --dev      same, keeps dev harness files
 *   node tools/build.mjs --watch    rebuild on change
 *   node tools/build.mjs --harness  also build dev/ harness into dist-dev/
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");
const OUT_SCRIPTS = join(DIST, "scripts");
const VENDOR_DIR = join(OUT_SCRIPTS, "vendor", "perfect-freehand");
const args = new Set(process.argv.slice(2));

/** Static files copied into the package root. */
const STATIC = ["lang", "styles", "assets", "LICENSE", "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"];

const log = (...m) => console.log("[build]", ...m);

function walk(dir, filter) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

/** Locate perfect-freehand's ESM entry through Node resolution (honours package "exports"). */
function resolvePerfectFreehand() {
  // Search the node_modules lookup paths directly: the package's "exports" map
  // does not expose ./package.json, so require.resolve() cannot be used for it.
  const req = createRequire(join(ROOT, "package.json"));
  const pkgJsonPath = (req.resolve.paths("perfect-freehand") ?? [])
    .map((dir) => join(dir, "perfect-freehand", "package.json"))
    .find((p) => existsSync(p));
  if (!pkgJsonPath) throw new Error("perfect-freehand is not installed. Run `npm install` (see README → Development).");
  const pkgDir = dirname(pkgJsonPath);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const exp = pkg.exports?.["."] ?? pkg.exports;
  const candidates = [
    typeof exp === "string" ? exp : null,
    exp?.import?.default ?? exp?.import,
    exp?.module,
    exp?.default,
    pkg.module,
  ].filter((c) => typeof c === "string");
  for (const c of candidates) {
    const file = join(pkgDir, c);
    if (existsSync(file)) return { pkgDir, entry: file, version: pkg.version };
  }
  throw new Error(`Could not find an ES module entry in perfect-freehand@${pkg.version}`);
}

function vendorPerfectFreehand(vendorDir = VENDOR_DIR) {
  const { pkgDir, entry, version } = resolvePerfectFreehand();
  const entryDir = dirname(entry);
  mkdirSync(vendorDir, { recursive: true });
  // Copy the whole directory of the entry so internal relative imports keep working.
  for (const file of walk(entryDir, (p) => /\.(m?js)$/.test(p) && !/\.map$/.test(p))) {
    const target = join(vendorDir, relative(entryDir, file));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
  }
  for (const lic of ["LICENSE", "LICENSE.md", "license"]) {
    if (existsSync(join(pkgDir, lic))) cpSync(join(pkgDir, lic), join(vendorDir, "LICENSE"));
  }
  if (!existsSync(join(vendorDir, "LICENSE"))) {
    throw new Error("perfect-freehand LICENSE not found; refusing to ship it without its license text.");
  }
  log(`vendored perfect-freehand@${version}`);
  return join(vendorDir, relative(entryDir, entry));
}

const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*)(["'])([^"'\n]+)\2/g;

function rewriteSpecifiers(code, outFile, vendorEntry) {
  return code.replace(SPECIFIER_RE, (all, lead, q, spec) => {
    if (spec === "perfect-freehand") {
      let rel = relative(dirname(outFile), vendorEntry).split(sep).join("/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${lead}${q}${rel}${q}`;
    }
    if (spec.startsWith(".") && spec.endsWith(".ts")) return `${lead}${q}${spec.slice(0, -3)}.js${q}`;
    if (!spec.startsWith(".")) throw new Error(`Unexpected bare import "${spec}" in ${outFile}`);
    return all;
  });
}

function compileTree(srcDir, outDir, vendorEntry) {
  const files = walk(srcDir, (p) => p.endsWith(".ts") && !p.endsWith(".d.ts"));
  for (const file of files) {
    const rel = relative(srcDir, file);
    const outFile = join(outDir, rel.replace(/\.ts$/, ".js"));
    const source = readFileSync(file, "utf8");
    let js;
    try {
      js = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: rel });
    } catch (err) {
      throw new Error(`Type stripping failed for ${rel}: ${err.message}`);
    }
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, rewriteSpecifiers(js, outFile, vendorEntry));
  }
  return files.length;
}

function checkVersions() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));
  if (pkg.version !== manifest.version) {
    throw new Error(`Version mismatch: package.json ${pkg.version} vs module.json ${manifest.version}`);
  }
  return manifest;
}

function build() {
  const started = Date.now();
  const manifest = checkVersions();
  resolvePerfectFreehand(); // fail before touching dist/
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(OUT_SCRIPTS, { recursive: true });
  const vendorEntry = vendorPerfectFreehand();
  const count = compileTree(SRC, OUT_SCRIPTS, vendorEntry);
  for (const item of STATIC) {
    const from = join(ROOT, item);
    if (!existsSync(from)) throw new Error(`Missing static file: ${item}`);
    cpSync(from, join(DIST, item), { recursive: true });
  }
  writeFileSync(join(DIST, "module.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const entry of manifest.esmodules ?? []) {
    if (!existsSync(join(DIST, entry))) throw new Error(`module.json esmodule ${entry} was not produced`);
  }
  if (args.has("--harness")) {
    // The harness mirrors the source layout (dev/ imports ../src/...).
    const outDev = join(ROOT, "dist-dev");
    rmSync(outDev, { recursive: true, force: true });
    mkdirSync(outDev, { recursive: true });
    const devVendor = vendorPerfectFreehand(join(outDev, "vendor", "perfect-freehand"));
    compileTree(SRC, join(outDev, "src"), devVendor);
    compileTree(join(ROOT, "dev"), join(outDev, "dev"), devVendor);
    cpSync(join(ROOT, "dev", "harness.html"), join(outDev, "index.html"));
    cpSync(join(ROOT, "dev", "replace-harness.html"), join(outDev, "replace.html"));
    cpSync(join(ROOT, "styles"), join(outDev, "styles"), { recursive: true });
    cpSync(join(ROOT, "lang"), join(outDev, "lang"), { recursive: true });
    log("harness → dist-dev/index.html, dist-dev/replace.html");
  }
  log(`${count} modules compiled in ${Date.now() - started} ms → ${relative(ROOT, DIST)}/`);
}

try {
  build();
} catch (err) {
  console.error("[build] failed:", err.message);
  process.exitCode = 1;
}

if (args.has("--watch")) {
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        build();
      } catch (err) {
        console.error("[build] failed:", err.message);
      }
    }, 120);
  };
  for (const dir of ["src", "styles", "lang", "dev"]) watch(join(ROOT, dir), { recursive: true }, rebuild);
  watch(join(ROOT, "module.json"), rebuild);
  log("watching for changes…");
}
