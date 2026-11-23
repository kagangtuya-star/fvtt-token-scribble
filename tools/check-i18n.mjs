#!/usr/bin/env node
/**
 * i18n consistency check:
 *  - every language file has exactly the same key set as en.json,
 *  - no value is empty and `{placeholders}` match between languages,
 *  - every key referenced from src/ exists (static keys, plus the dynamic
 *    families built from template literals such as `Tool.${tool}`),
 *  - no key in en.json is unused.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "TOKEN_SCRIBBLE";

/** Dynamic key families: template prefix → the values the code can produce. */
const DYNAMIC = {
  "Tool.": ["pen", "marker", "brush", "fill", "eraser"],
  "ToolHint.": ["pen", "marker", "brush", "fill", "eraser"],
  "Status.": ["saved", "dirty", "saving", "error", "offline"],
  "Replace.Refused.": ["permission", "files", "video"],
};

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

const problems = [];
const langDir = join(ROOT, "lang");
const en = flatten(JSON.parse(readFileSync(join(langDir, "en.json"), "utf8")));

for (const file of readdirSync(langDir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const other = flatten(JSON.parse(readFileSync(join(langDir, file), "utf8")));
  for (const k of en.keys()) if (!other.has(k)) problems.push(`${file}: missing ${k}`);
  for (const [k, v] of other) {
    if (!en.has(k)) problems.push(`${file}: extra key ${k}`);
    else if (placeholders(v) !== placeholders(en.get(k))) problems.push(`${file}: placeholders differ for ${k}`);
  }
}
for (const [k, v] of en) if (typeof v !== "string" || !v.trim()) problems.push(`en.json: empty value ${k}`);

const used = new Set();
const KEY_RE = /["'`]((?:TOKEN_SCRIBBLE\.)?(?:[A-Z][A-Za-z]*\.)+[A-Za-z]+)["'`]/g;
const SETTINGS_RE = /\bL\(\s*["']([\w.]+)["']\s*\)/g;
for (const file of walk(join(ROOT, "src"))) {
  const code = readFileSync(file, "utf8");
  for (const m of code.matchAll(KEY_RE)) {
    const key = m[1].startsWith(`${PREFIX}.`) ? m[1] : `${PREFIX}.${m[1]}`;
    if (en.has(key)) used.add(key);
    else if (/^(Tool|ToolHint|Toolbar|Status|Menu|Help|Hud|Controls|Placement|Keys|Draft|Corrupt|Revert|Prototype|Notify|Settings|Token)\./.test(m[1].replace(`${PREFIX}.`, ""))) {
      problems.push(`${file.slice(ROOT.length + 1)}: unknown key ${m[1]}`);
    }
  }
  if (file.endsWith("settings.ts")) {
    for (const m of code.matchAll(SETTINGS_RE)) {
      const key = `${PREFIX}.Settings.${m[1]}`;
      if (en.has(key)) used.add(key);
      else problems.push(`settings.ts: unknown key ${key}`);
    }
  }
}
for (const [family, values] of Object.entries(DYNAMIC)) {
  for (const v of values) {
    const key = `${PREFIX}.${family}${v}`;
    if (en.has(key)) used.add(key);
    else problems.push(`dynamic key missing: ${key}`);
  }
}
for (const k of en.keys()) if (!used.has(k)) problems.push(`unused key ${k}`);

if (problems.length) {
  console.error(`[i18n] ${problems.length} problem(s):\n - ${problems.join("\n - ")}`);
  process.exitCode = 1;
} else {
  console.log(`[i18n] ${en.size} keys, all languages consistent and all keys used.`);
}
