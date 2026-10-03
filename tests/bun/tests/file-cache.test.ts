import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { FileCache } from "../../../packages/core/src/bun/utils.ts";

const CACHE_ROOT = "./data/file-cache-unit";

beforeAll(() => {
  fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
});

function pngBytes(): Buffer {
  // Minimal valid-enough PNG signature + IHDR-ish payload for magic detection
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ]);
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function webpBytes(): Buffer {
  const buf = Buffer.alloc(16, 0);
  buf.write("RIFF", 0);
  buf.write("WEBP", 8);
  return buf;
}

function avifBytes(): Buffer {
  const buf = Buffer.alloc(16, 0);
  buf.write("ftyp", 4);
  buf.write("avif", 8);
  return buf;
}

test("bun FileCache: get returns null for missing file", async () => {
  const cache = new FileCache(CACHE_ROOT, { touchIntervalMs: null });
  const res = await cache.get(path.join(CACHE_ROOT, "missing.webp"), new Headers());
  expect(res).toBeNull();
});

test("bun FileCache: write uses temp+rename and get detects content types", async () => {
  const cache = new FileCache(CACHE_ROOT, { touchIntervalMs: null });
  const cases: Array<{ name: string; bytes: Buffer; type: string }> = [
    { name: "a.webp", bytes: webpBytes(), type: "image/webp" },
    { name: "a.avif", bytes: avifBytes(), type: "image/avif" },
    { name: "a.png", bytes: pngBytes(), type: "image/png" },
    { name: "a.jpg", bytes: jpegBytes(), type: "image/jpeg" },
    { name: "extensionless", bytes: pngBytes(), type: "image/png" },
  ];

  for (const c of cases) {
    const cachePath = path.join(CACHE_ROOT, c.name);
    await cache.write(cachePath, Readable.from(c.bytes));
    expect(fs.existsSync(cachePath)).toBe(true);
    const tmpLeft = fs
      .readdirSync(CACHE_ROOT)
      .filter((f) => f.startsWith(c.name) && f.endsWith(".tmp"));
    expect(tmpLeft).toEqual([]);

    const res = await cache.get(cachePath, new Headers());
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toBe(c.type);
  }
});

test("bun FileCache: write failure leaves no final file and cleans tmp", async () => {
  const cache = new FileCache(CACHE_ROOT, { touchIntervalMs: null });
  const cachePath = path.join(CACHE_ROOT, "fail-write.bin");
  const bad = new Readable({
    read() {
      this.push(Buffer.from("partial"));
      this.emit("error", new Error("boom"));
    },
  });
  // Prevent unhandled 'error' if the promise rejects first
  bad.on("error", () => {});
  await expect(cache.write(cachePath, bad)).rejects.toThrow("boom");
  expect(fs.existsSync(cachePath)).toBe(false);
  const tmps = fs.readdirSync(CACHE_ROOT).filter((f) => f.endsWith(".tmp"));
  expect(tmps).toEqual([]);
});

test("bun FileCache: empty or unreadable file is a miss (null), not a throw", async () => {
  const cache = new FileCache(CACHE_ROOT, { touchIntervalMs: null });
  const emptyPath = path.join(CACHE_ROOT, "empty.webp");
  fs.writeFileSync(emptyPath, "");
  expect(await cache.get(emptyPath, new Headers())).toBeNull();
});

test("bun FileCache: touchCacheOnHit updates mtime only outside interval", async () => {
  const cachePath = path.join(CACHE_ROOT, "touch.webp");
  const intervalMs = 60_000;
  const cache = new FileCache(CACHE_ROOT, { touchIntervalMs: intervalMs });
  await cache.write(cachePath, Readable.from(webpBytes()));

  const old = new Date(Date.now() - 2 * intervalMs);
  await fs.promises.utimes(cachePath, old, old);
  const before = (await fs.promises.stat(cachePath)).mtimeMs;

  await cache.get(cachePath, new Headers());
  // utimes is fire-and-forget; give it a tick
  await Bun.sleep(50);
  const afterFirst = (await fs.promises.stat(cachePath)).mtimeMs;
  expect(afterFirst).toBeGreaterThan(before);

  await cache.get(cachePath, new Headers());
  await Bun.sleep(50);
  const afterSecond = (await fs.promises.stat(cachePath)).mtimeMs;
  expect(Math.abs(afterSecond - afterFirst)).toBeLessThan(2000);
});

test("bun FileCache: touch disabled never updates mtime", async () => {
  const cachePath = path.join(CACHE_ROOT, "no-touch.webp");
  const cache = new FileCache(CACHE_ROOT, { touchIntervalMs: null });
  await cache.write(cachePath, Readable.from(webpBytes()));
  const old = new Date("2020-01-01T00:00:00Z");
  await fs.promises.utimes(cachePath, old, old);
  const before = (await fs.promises.stat(cachePath)).mtimeMs;
  await cache.get(cachePath, new Headers());
  await Bun.sleep(50);
  const after = (await fs.promises.stat(cachePath)).mtimeMs;
  expect(after).toBe(before);
});
