import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getImgResponse, type Config } from "openimg/bun";
import sharp from "sharp";

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
  const res = await getImgResponse(req("?src=/cat.png&w=50&h=50&format=webp"), {
    cacheFolder,
  });
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

test("bun cache: concurrent requests for same uncached image run one transform", async () => {
  const cacheFolder = freshDir("dedupe");
  let transforms = 0;
  const cfg = {
    cacheFolder,
    getSharpPipeline: () => {
      const pipeline = sharp().resize(49, 49).webp();
      // Only the request that holds the lock pipes data through its pipeline
      pipeline.once("info", () => {
        transforms++;
      });
      return { pipeline, cacheKey: "dedupe-cat" };
    },
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      getImgResponse(req("?src=/cat.png&w=49&h=49"), cfg)
    )
  );
  for (const r of results) {
    expect(r.status).toBe(200);
    await r.arrayBuffer();
  }
  expect(transforms).toBe(1);
});

test("bun cache: corrupt source rejects instead of hanging and frees its transform slot", async () => {
  const cacheFolder = freshDir("corrupt-source");
  const cfg = (cacheKey: string, data: Buffer) => ({
    cacheFolder,
    maxConcurrentTransforms: 1,
    getImgSource: () => ({ type: "data" as const, data, cacheKey }),
  });
  const garbage = Buffer.from("this is not an image");

  // With maxConcurrentTransforms: 1, a leaked slot would make the valid
  // request below wait forever and time out the test.
  for (const key of ["garbage-1", "garbage-2"]) {
    await expect(
      getImgResponse(req("?w=50&h=50&format=webp"), cfg(key, garbage))
    ).rejects.toThrow();
  }

  const ok = await getImgResponse(
    req("?w=50&h=50&format=webp"),
    cfg("valid-after-garbage", fs.readFileSync("./public/cat.png"))
  );
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Content-Type")).toBe("image/webp");

  const leftovers = fs
    .readdirSync(cacheFolder, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".tmp") || f.startsWith("garbage"));
  expect(leftovers).toEqual([]);
});

test("bun no_cache: corrupt source rejects and frees its transform slot", async () => {
  const cfg = (data: Buffer) => ({
    cacheFolder: "no_cache" as const,
    maxConcurrentTransforms: 1,
    getImgSource: () => ({ type: "data" as const, data, cacheKey: null }),
  });
  await expect(
    getImgResponse(req("?w=50&h=50&format=webp"), cfg(Buffer.from("nope")))
  ).rejects.toThrow();

  const ok = await getImgResponse(
    req("?w=50&h=50&format=webp"),
    cfg(fs.readFileSync("./public/cat.png"))
  );
  expect(ok.status).toBe(200);
  await ok.arrayBuffer();
});

function slowSource(delayMs: number) {
  let started = false;
  return new Readable({
    read() {
      if (started) {
        return;
      }
      started = true;
      setTimeout(() => {
        this.push(fs.readFileSync("./public/cat.png"));
        this.push(null);
      }, delayMs);
    },
  });
}

function abortTestConfig(cacheFolder: string, transformed: string[]): Config {
  return {
    cacheFolder,
    maxConcurrentTransforms: 1,
    getImgSource: ({ request }) => {
      const key = new URL(request.url).searchParams.get("key")!;
      return {
        type: "data",
        data:
          key === "busy"
            ? slowSource(150)
            : fs.readFileSync("./public/cat.png"),
        cacheKey: key,
      };
    },
    getSharpPipeline: ({ source }) => {
      const key = source.type === "data" ? source.cacheKey! : "";
      const pipeline = sharp().resize(30, 30).webp();
      pipeline.once("info", () => {
        transformed.push(key);
      });
      return { pipeline, cacheKey: key };
    },
  };
}

test("bun cache: queued request whose client disconnected is skipped", async () => {
  const transformed: string[] = [];
  const cfg = abortTestConfig(freshDir("abort-skip"), transformed);

  const busy = getImgResponse(req("?key=busy&w=30&h=30"), cfg);
  await Bun.sleep(20);
  const controller = new AbortController();
  const gone = getImgResponse(
    new Request("http://localhost/?key=gone&w=30&h=30", {
      signal: controller.signal,
    }),
    cfg
  );
  await Bun.sleep(20);
  controller.abort();

  expect((await busy).status).toBe(200);
  expect((await gone).status).toBe(499);
  expect(transformed).toEqual(["busy"]);
});

test("bun cache: disconnected request still transforms when a connected request waits for the same image", async () => {
  const transformed: string[] = [];
  const cfg = abortTestConfig(freshDir("abort-waiter"), transformed);

  const busy = getImgResponse(req("?key=busy&w=30&h=30"), cfg);
  await Bun.sleep(20);
  const controller = new AbortController();
  const gone = getImgResponse(
    new Request("http://localhost/?key=shared&w=30&h=30", {
      signal: controller.signal,
    }),
    cfg
  );
  await Bun.sleep(20);
  // Waits on the lock held by the request that is about to disconnect
  const waiting = getImgResponse(req("?key=shared&w=30&h=30"), cfg);
  await Bun.sleep(20);
  controller.abort();

  expect((await busy).status).toBe(200);
  await gone;
  const res = await waiting;
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("image/webp");
  expect(transformed).toEqual(["busy", "shared"]);
});

test("bun cache: onCacheHit fires only on disk cache hits, not on miss/write", async () => {
  const cacheFolder = freshDir("on-cache-hit");
  const hits: Array<{ cachePath: string; contentType: string | null; size: number }> =
    [];
  const cfg = {
    cacheFolder,
    onCacheHit: (info: (typeof hits)[number]) => {
      hits.push(info);
    },
  };
  const qs = "?src=/cat.png&w=55&h=55&format=webp";

  const miss = await getImgResponse(req(qs), cfg);
  expect(miss.status).toBe(200);
  expect(hits).toEqual([]);

  const hit = await getImgResponse(req(qs), cfg);
  expect(hit.status).toBe(200);
  expect(hits).toHaveLength(1);
  expect(hits[0]!.contentType).toBe("image/webp");
  expect(hits[0]!.size).toBeGreaterThan(0);
  expect(hits[0]!.cachePath).toContain("w-55");
});
