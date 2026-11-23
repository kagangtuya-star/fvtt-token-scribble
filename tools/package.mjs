#!/usr/bin/env node
/**
 * Package dist/ into module.zip (+ a copy of module.json) under release/.
 *
 * Release URLs are injected only when the repository is known, either from
 * the environment (`MODULE_REPO=owner/name`, set by the GitHub workflow from
 * `github.repository`) or `--repo owner/name`. Nothing is invented otherwise.
 *
 * The zip writer is self-contained (Node zlib + CRC32) so packaging works the
 * same on Linux, macOS and Windows without a system `zip`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { validateManifest } from "./validate-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, "release");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Minimal ZIP (deflate) writer. `entries` = [{ name, data: Buffer }] */
export function createZip(entries, mtime = new Date()) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, day } = dosTime(mtime);
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function main() {
  if (!existsSync(join(DIST, "module.json"))) throw new Error("dist/ is missing; run `npm run build` first.");
  const manifest = JSON.parse(readFileSync(join(DIST, "module.json"), "utf8"));
  const repo = arg("--repo") ?? process.env.MODULE_REPO;
  const tag = arg("--tag") ?? process.env.RELEASE_TAG ?? `v${manifest.version}`;
  if (repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid repository "${repo}" (expected owner/name)`);
    if (tag.replace(/^v/, "") !== manifest.version) {
      throw new Error(`Tag ${tag} does not match module version ${manifest.version}`);
    }
    manifest.url = `https://github.com/${repo}`;
    manifest.manifest = `https://github.com/${repo}/releases/latest/download/module.json`;
    manifest.download = `https://github.com/${repo}/releases/download/${tag}/module.zip`;
    manifest.bugs = `https://github.com/${repo}/issues`;
    writeFileSync(join(DIST, "module.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  const problems = validateManifest(manifest, DIST, { requireUrls: !!repo });
  if (problems.length) throw new Error(`module.json is invalid:\n - ${problems.join("\n - ")}`);
  const files = walk(DIST);
  const entries = files.map((f) => ({ name: relative(DIST, f).split(sep).join("/"), data: readFileSync(f) }));
  mkdirSync(OUT, { recursive: true });
  const zip = createZip(entries);
  writeFileSync(join(OUT, "module.zip"), zip);
  writeFileSync(join(OUT, "module.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[package] ${entries.length} files → release/module.zip (${(zip.length / 1024).toFixed(1)} KiB)`);
  if (!repo) console.log("[package] no repository configured: manifest/download URLs left unset (see README → Releasing).");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error("[package] failed:", err.message);
    process.exitCode = 1;
  }
}
