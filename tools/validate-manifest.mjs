#!/usr/bin/env node
/**
 * Validates module.json against the Foundry v13+ package manifest rules that
 * matter for installation, and checks that every referenced file exists.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID_RE = /^[a-z0-9-]+$/;
const URL_RE = /^https:\/\/[^\s]+$/;

export function validateManifest(m, baseDir, { requireUrls = false } = {}) {
  const p = [];
  if (m.id !== "token-scribble") p.push(`id must be "token-scribble" (got ${JSON.stringify(m.id)})`);
  if (!ID_RE.test(m.id ?? "")) p.push("id may only contain lowercase letters, digits and dashes");
  if (typeof m.title !== "string" || !m.title.trim()) p.push("title is required");
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(m.version ?? "")) p.push(`version must be semver (got ${m.version})`);
  if ("name" in m) p.push('"name" is the pre-v10 field; use "id"');
  if ("minimumCoreVersion" in m || "compatibleCoreVersion" in m) p.push("legacy *CoreVersion fields must not be used");
  const c = m.compatibility;
  if (!c || typeof c.minimum !== "string") p.push("compatibility.minimum is required");
  else if (Number.parseInt(c.minimum, 10) < 13) p.push("compatibility.minimum must be at least 13");
  if (c?.verified !== undefined && typeof c.verified !== "string") p.push("compatibility.verified must be a string");
  if (!Array.isArray(m.authors) || m.authors.length === 0) p.push("authors must be a non-empty array");
  if (!Array.isArray(m.esmodules) || m.esmodules.length === 0) p.push("esmodules is required");
  if (m.socket !== true) p.push("socket must be true (presence channel)");
  const files = [...(m.esmodules ?? []), ...(m.styles ?? []), ...(m.languages ?? []).map((l) => l.path)];
  for (const f of files) if (!existsSync(join(baseDir, f))) p.push(`referenced file missing: ${f}`);
  for (const l of m.languages ?? []) {
    if (!l.lang || !l.name || !l.path) p.push(`language entry incomplete: ${JSON.stringify(l)}`);
    else {
      try {
        JSON.parse(readFileSync(join(baseDir, l.path), "utf8"));
      } catch (err) {
        p.push(`language file ${l.path} is not valid JSON: ${err.message}`);
      }
    }
  }
  for (const key of ["url", "manifest", "download"]) {
    if (m[key] !== undefined && !URL_RE.test(m[key])) p.push(`${key} must be an https URL`);
    if (requireUrls && m[key] === undefined) p.push(`${key} is required for a release`);
  }
  if (m.download && !m.download.endsWith("/module.zip")) p.push("download must point at module.zip");
  return p;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = process.argv[2] ? resolve(process.argv[2]) : join(root, "dist");
  const manifest = JSON.parse(readFileSync(join(dir, "module.json"), "utf8"));
  const problems = validateManifest(manifest, dir);
  if (problems.length) {
    console.error(`[manifest] ${problems.length} problem(s):\n - ${problems.join("\n - ")}`);
    process.exitCode = 1;
  } else {
    console.log(`[manifest] ${manifest.id}@${manifest.version} OK (${dir})`);
  }
}
