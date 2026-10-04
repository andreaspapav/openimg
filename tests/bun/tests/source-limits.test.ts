import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getImgResponse, type Config } from "openimg/bun";

const ROOT = "./data/source-limits";
const CAT = fs.readFileSync("./public/cat.png");

// Stand-in for a customer's image server
let hits: Record<string, number> = {};
let origin = "";
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const pathname = new URL(req.url).pathname;
      hits[pathname] = (hits[pathname] ?? 0) + 1;
      if (pathname === "/slow.png") {
        await Bun.sleep(1000);
        return new Response(CAT);
      }
      if (pathname === "/missing.png") {
        return new Response("not found", { status: 404 });
      }
      if (pathname === "/error.png") {
        return new Response("oops", { status: 500 });
      }
      return new Response(CAT, { headers: { "Content-Type": "image/png" } });
    },
  });
  origin = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function freshDir(name: string) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

function req(qs: string) {
  return new Request("http://localhost/" + qs);
}

function remote(file: string) {
  return req(`?src=${origin}/${file}&w=40&h=40&format=webp`);
}

function remoteConfig(name: string, extra: Partial<Config> = {}): Config {
  return {
    cacheFolder: freshDir(name),
    allowlistedOrigins: [origin],
    failedImageTtlMs: 60_000,
    ...extra,
  };
}

test("bun failedImageTtlMs: broken image returns 422 and is not decoded again", async () => {
  let reads = 0;
  const cfg: Config = {
    cacheFolder: freshDir("broken"),
    failedImageTtlMs: 60_000,
    getImgSource: () => ({
      type: "data",
      data: new Readable({
        read() {
          reads++;
          this.push(Buffer.from("this is not an image"));
          this.push(null);
        },
      }),
      cacheKey: "broken-image",
    }),
  };

  const first = await getImgResponse(req("?w=40&h=40&format=webp"), cfg);
  expect(first.status).toBe(422);
  expect(first.headers.get("Cache-Control")).toBe("public, max-age=60");

  const second = await getImgResponse(req("?w=40&h=40&format=webp"), cfg);
  expect(second.status).toBe(422);
  expect(reads).toBe(1);
});

test("bun failedImageTtlMs: error responses don't carry config.headers", async () => {
  const cfg: Config = {
    cacheFolder: freshDir("headers"),
    failedImageTtlMs: 60_000,
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    getImgSource: () => ({
      type: "data",
      data: Buffer.from("nope"),
      cacheKey: "broken-headers",
    }),
  };
  const res = await getImgResponse(req("?w=40&h=40&format=webp"), cfg);
  expect(res.status).toBe(422);
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
});

test("bun failedImageTtlMs: missing remote source (404) is remembered", async () => {
  const cfg = remoteConfig("missing");
  hits = {};
  const first = await getImgResponse(remote("missing.png"), cfg);
  expect(first.status).toBe(404);
  expect(first.headers.get("Cache-Control")).toBe("public, max-age=60");
  const second = await getImgResponse(remote("missing.png"), cfg);
  expect(second.status).toBe(404);
  expect(hits["/missing.png"]).toBe(1);
});

test("bun failedImageTtlMs: remote 5xx is passed through and not remembered", async () => {
  const cfg = remoteConfig("upstream-error");
  hits = {};
  expect((await getImgResponse(remote("error.png"), cfg)).status).toBe(500);
  expect((await getImgResponse(remote("error.png"), cfg)).status).toBe(500);
  expect(hits["/error.png"]).toBe(2);
});

test("bun fetchTimeoutMs: slow remote source returns 504 and is not remembered", async () => {
  const cfg = remoteConfig("timeout", { fetchTimeoutMs: 100 });
  hits = {};
  const start = performance.now();
  const res = await getImgResponse(remote("slow.png"), cfg);
  expect(performance.now() - start).toBeLessThan(900);
  expect(res.status).toBe(504);
  expect(res.headers.get("Cache-Control")).toBe("no-store");

  await getImgResponse(remote("slow.png"), cfg);
  expect(hits["/slow.png"]).toBe(2);
});

test("bun fetchTimeoutMs: throws without failedImageTtlMs", async () => {
  const cfg = remoteConfig("timeout-throw", {
    fetchTimeoutMs: 100,
    failedImageTtlMs: undefined,
  });
  await expect(getImgResponse(remote("slow.png"), cfg)).rejects.toThrow();
});

test("bun maxSourceBytes: rejects remote source by Content-Length", async () => {
  const cfg = remoteConfig("too-large-remote", { maxSourceBytes: 1_000_000 });
  const res = await getImgResponse(remote("cat.png"), cfg);
  expect(res.status).toBe(422);
  expect(res.statusText).toBe("Source image too large");
});

test("bun maxSourceBytes: rejects streamed source without Content-Length", async () => {
  const cfg: Config = {
    cacheFolder: freshDir("too-large-stream"),
    failedImageTtlMs: 60_000,
    maxSourceBytes: 1_000_000,
    getImgSource: () => ({
      type: "data",
      data: Readable.from([CAT]),
      cacheKey: "too-large-stream",
    }),
  };
  const res = await getImgResponse(req("?w=40&h=40&format=webp"), cfg);
  expect(res.status).toBe(422);
  expect(res.statusText).toBe("Source image too large");
});

test("bun maxSourceBytes: rejects local file source", async () => {
  const cfg: Config = {
    cacheFolder: freshDir("too-large-fs"),
    failedImageTtlMs: 60_000,
    maxSourceBytes: 1_000_000,
  };
  const res = await getImgResponse(req("?src=/cat.png&w=40&h=40"), cfg);
  expect(res.status).toBe(422);
});

test("bun maxSourceBytes: sources under the limit still work", async () => {
  const cfg = remoteConfig("under-limit", { maxSourceBytes: 50_000_000 });
  const res = await getImgResponse(remote("cat.png"), cfg);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("image/webp");
});

test("bun limitInputPixels: rejects images with too many pixels", async () => {
  const cfg: Config = {
    cacheFolder: freshDir("pixels"),
    failedImageTtlMs: 60_000,
    limitInputPixels: 1_000_000, // cat.png is 4284 x 5712
  };
  const res = await getImgResponse(req("?src=/cat.png&w=40&h=40"), cfg);
  expect(res.status).toBe(422);
  expect(res.statusText).toBe("Unprocessable image");
});
