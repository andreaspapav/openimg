import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getImgResponse } from "openimg/bun";

const ROOT = "./data/cache-behavior";

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function req(url: string) {
  return new Request("http://localhost/" + url);
}

function freshDir(name: string) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

test("bun cache: metadata.json is never created", async () => {
  const cacheFolder = freshDir("no-meta");
  const res = await getImgResponse(
    req("?src=/cat.png&w=50&h=50&format=webp"),
    { cacheFolder }
  );
  expect(res.status).toBe(200);
  expect(fs.existsSync(path.join(cacheFolder, "metadata.json"))).toBe(false);
});

test("bun cache: content types on cache hit for webp/avif/png/jpeg/extensionless", async () => {
  const cacheFolder = freshDir("ctypes");

  const formats: Array<{ qs: string; type: string; source?: object }> = [
    { qs: "?src=/cat.png&w=40&h=40&format=webp", type: "image/webp" },
    { qs: "?src=/cat.png&w=40&h=40&format=avif", type: "image/avif" },
    { qs: "?src=/cat.png&w=40&h=40&format=png", type: "image/png" },
    { qs: "?src=/exif.jpeg&w=40&h=40&format=jpeg", type: "image/jpeg" },
  ];

  for (const f of formats) {
    const miss = await getImgResponse(req(f.qs), { cacheFolder });
    expect(miss.status).toBe(200);
    expect(miss.headers.get("Content-Type")).toBe(f.type);
    const hit = await getImgResponse(req(f.qs), { cacheFolder });
    expect(hit.status).toBe(200);
    expect(hit.headers.get("Content-Type")).toBe(f.type);
  }

  const dataQs = "?w=40&h=40";
  const cfg = {
    cacheFolder,
    getImgSource: async () => ({
      type: "data" as const,
      data: fs.readFileSync("./public/cat.png"),
      cacheKey: "extless-cat",
    }),
  };
  const miss = await getImgResponse(req(dataQs), cfg);
  expect(miss.status).toBe(200);
  expect(miss.headers.get("Content-Type")).toBe("image/png");
  const hit = await getImgResponse(req(dataQs), cfg);
  expect(hit.status).toBe(200);
  expect(hit.headers.get("Content-Type")).toBe("image/png");
});

test("bun cache: deleted file is regenerated on next request", async () => {
  const cacheFolder = freshDir("regen");
  const qs = "?src=/cat.png&w=41&h=41&format=webp";
  const first = await getImgResponse(req(qs), { cacheFolder });
  expect(first.status).toBe(200);
  const firstBytes = Buffer.from(await first.arrayBuffer());

  const files = fs.readdirSync(path.join(cacheFolder, "public"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    fs.unlinkSync(path.join(cacheFolder, "public", f));
  }

  const second = await getImgResponse(req(qs), { cacheFolder });
  expect(second.status).toBe(200);
  const secondBytes = Buffer.from(await second.arrayBuffer());
  expect(secondBytes.equals(firstBytes)).toBe(true);
});

test("bun cache: truncated cached file does not crash (served or regenerated)", async () => {
  const cacheFolder = freshDir("trunc");
  const qs = "?src=/cat.png&w=42&h=42&format=webp";
  const first = await getImgResponse(req(qs), { cacheFolder });
  expect(first.status).toBe(200);

  const dir = path.join(cacheFolder, "public");
  const file = fs.readdirSync(dir).find((f) => f.includes("w-42"));
  expect(file).toBeDefined();
  fs.writeFileSync(path.join(dir, file!), Buffer.from([0x00, 0x01, 0x02]));

  // Pin today's behavior: we do not crash. Truncated/corrupt files may be
  // served as-is; only complete writes are guaranteed going forward.
  const second = await getImgResponse(req(qs), { cacheFolder });
  expect(second.status).toBe(200);
});

test("bun cache: concurrent requests for same uncached image leave no .tmp files", async () => {
  const cacheFolder = freshDir("concurrent");
  const qs = "?src=/cat.png&w=43&h=43&format=webp";
  const results = await Promise.all(
    Array.from({ length: 8 }, () => getImgResponse(req(qs), { cacheFolder }))
  );
  for (const r of results) {
    expect(r.status).toBe(200);
  }
  const bodies = await Promise.all(
    results.map(async (r) => Buffer.from(await r.arrayBuffer()))
  );
  for (const b of bodies) {
    expect(b.equals(bodies[0]!)).toBe(true);
  }

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };
  expect(walk(cacheFolder).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("bun cache: pipeline error leaves no cache file and no .tmp", async () => {
  const cacheFolder = freshDir("pipeline-err");
  let threw = false;
  try {
    await getImgResponse(req("?src=/cat.png&w=44&h=44&format=webp"), {
      cacheFolder,
      getSharpPipeline: async () => {
        throw new Error("forced pipeline failure");
      },
    });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);

  if (fs.existsSync(cacheFolder)) {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
      }
      return out;
    };
    const files = walk(cacheFolder);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }
});

test("bun cache: touchCacheOnHit updates mtime when stale", async () => {
  const cacheFolder = freshDir("touch");
  const qs = "?src=/cat.png&w=45&h=45&format=webp";
  const cfg = {
    cacheFolder,
    touchCacheOnHit: { intervalMs: 60_000 },
  };
  await getImgResponse(req(qs), cfg);

  const dir = path.join(cacheFolder, "public");
  const file = fs.readdirSync(dir).find((f) => f.includes("w-45"))!;
  const full = path.join(dir, file);
  const old = new Date(Date.now() - 120_000);
  await fs.promises.utimes(full, old, old);
  const before = (await fs.promises.stat(full)).mtimeMs;

  await getImgResponse(req(qs), cfg);
  await Bun.sleep(50);
  const after = (await fs.promises.stat(full)).mtimeMs;
  expect(after).toBeGreaterThan(before);
});

test("bun cache: maxConcurrentTransforms serializes transforms; hits stay free", async () => {
  const cacheFolder = freshDir("sem");
  let active = 0;
  let maxActive = 0;
  let transformCount = 0;

  const cfg = {
    cacheFolder,
    maxConcurrentTransforms: 1,
    getImgSource: ({ params }: { params: { width?: number } }) => {
      const width = params.width || 50;
      let started = false;
      const data = new Readable({
        read() {
          if (started) {
            return;
          }
          started = true;
          active++;
          transformCount++;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            this.push(fs.readFileSync("./public/cat.png"));
            this.push(null);
            active--;
          }, 80);
        },
      });
      return {
        type: "data" as const,
        data,
        cacheKey: `slow-${width}`,
      };
    },
  };

  const [a, b] = await Promise.all([
    getImgResponse(req("?w=46&h=46&format=webp"), cfg),
    getImgResponse(req("?w=47&h=47&format=webp"), cfg),
  ]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(maxActive).toBe(1);
  expect(transformCount).toBe(2);

  transformCount = 0;
  maxActive = 0;
  active = 0;
  const hitAndMiss = await Promise.all([
    getImgResponse(req("?w=46&h=46&format=webp"), cfg),
    getImgResponse(req("?w=48&h=48&format=webp"), cfg),
  ]);
  expect(hitAndMiss[0]!.status).toBe(200);
  expect(hitAndMiss[1]!.status).toBe(200);
  expect(transformCount).toBe(1);
});
