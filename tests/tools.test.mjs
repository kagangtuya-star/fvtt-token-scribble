import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inflateRawSync } from "node:zlib";
import { createZip } from "../tools/package.mjs";
import { validateManifest } from "../tools/validate-manifest.mjs";

/** Minimal ZIP reader: walks the central directory and inflates each entry. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(offset), 0x04034b50);
    const localName = buf.readUInt16LE(offset + 26);
    const start = offset + 30 + localName + buf.readUInt16LE(offset + 28);
    const body = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    p += 46 + nameLen;
  }
  return out;
}

describe("zip writer", () => {
  it("round-trips stored and deflated entries with UTF-8 names", () => {
    const entries = [
      { name: "module.json", data: Buffer.from(JSON.stringify({ id: "token-scribble" }).repeat(50)) },
      { name: "assets/blank.png", data: readFileSync(new URL("../assets/blank.png", import.meta.url)) },
      { name: "lang/zh-CN.json", data: Buffer.from('{"名":"随绘棋子"}') },
      { name: "empty.txt", data: Buffer.alloc(0) },
      { name: "random.bin", data: Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 251)) },
    ];
    const zip = createZip(entries, new Date(2026, 0, 2, 3, 4, 6));
    const back = readZip(zip);
    assert.equal(back.size, entries.length);
    for (const e of entries) assert.deepEqual(back.get(e.name), e.data, e.name);
  });
});

describe("manifest validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-manifest-"));
  const manifest = JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8"));
  for (const f of [...manifest.esmodules, ...manifest.styles]) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  mkdirSync(join(dir, "lang"), { recursive: true });
  for (const l of manifest.languages)
    writeFileSync(join(dir, l.path), readFileSync(new URL(`../${l.path}`, import.meta.url)));

  it("accepts the repository manifest", () => {
    assert.deepEqual(validateManifest(manifest, dir), []);
  });

  it("requires URLs for releases and checks their shape", () => {
    const missingUrls = { ...manifest };
    for (const key of ["url", "manifest", "download"]) delete missingUrls[key];
    assert.equal(validateManifest(missingUrls, dir, { requireUrls: true }).length, 3);
    const release = {
      ...manifest,
      url: "https://github.com/o/r",
      manifest: "https://github.com/o/r/releases/latest/download/module.json",
      download: "https://github.com/o/r/releases/download/v1.0.0/module.zip",
    };
    assert.deepEqual(validateManifest(release, dir, { requireUrls: true }), []);
    assert.ok(validateManifest({ ...release, download: "http://x/module.zip" }, dir).length > 0);
  });

  it("rejects legacy and broken manifests", () => {
    assert.ok(validateManifest({ ...manifest, name: "token-scribble" }, dir).some((p) => p.includes("pre-v10")));
    assert.ok(validateManifest({ ...manifest, compatibility: { minimum: "12" } }, dir).length > 0);
    assert.ok(
      validateManifest({ ...manifest, esmodules: ["scripts/missing.js"] }, dir).some((p) => p.includes("missing")),
    );
    assert.ok(validateManifest({ ...manifest, socket: false }, dir).length > 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("package.json and module.json versions agree", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.version, manifest.version);
  });
});
