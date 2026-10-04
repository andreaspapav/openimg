1. Set idleTimeout: 120 in Bun.serve. This is a one-line change; do it now.
2. Prefer WebP to AVIF if you serve both. AVIF encoding is several times slower.

idleTimeout goes in your server, not openimg
openimg doesn't start a server. It only exports getImgResponse(request, config), and your app calls it from its own Bun.serve. So set the timeout where you create the server:


Bun.serve({
  idleTimeout: 120, // seconds, max 255; default is 10
  fetch(req) {
    return getImgResponse(req, { maxConcurrentTransforms: 2, /* ... */ });
  },
});
If you use a framework, it goes in that framework's server options instead: for example serve: { idleTimeout } in Elysia, or export default { fetch: app.fetch, idleTimeout: 120 } with Hono on Bun. This setting applies to every route on that server. Recent Bun versions can also raise it only for image requests with server.timeout(req, seconds) inside fetch, but check that your Bun version has it.

Switching from AVIF to WebP
Where the AVIF requests come from decides where to switch:

If your frontend uses openimg/react, its default targetFormats is ["avif", "webp"], so any browser that supports AVIF requests AVIF. Pass WebP only on the provider:


<OpenImgContextProvider targetFormats={["webp"]}>
If you build the image URLs yourself, change format=avif to format=webp there.

Optionally, also map it on the server. In a custom getImgParams, turn format=avif into webp. Pages and HTML your CDN cached before the switch will keep requesting format=avif for a while, and this stops those requests from doing slow AVIF encodes. They'd simply receive WebP, which every browser that supports AVIF also supports:


getImgParams: ({ request }) => {
  const params = getImgParams({ request });
  if (params instanceof Response) return params;
  return params.format === "avif" ? { ...params, format: "webp" } : params;
},
getImgParams is the default implementation that openimg exports, so this only rewrites the format and leaves everything else as before.

After the switch, the .avif files already cached stop being requested. If you enable touchCacheOnHit, your 30-day cleanup job removes them automatically.


getImgResponse(req, {
  maxConcurrentTransforms: 2,
  touchCacheOnHit: true,
  fetchTimeoutMs: 15_000,          // customer servers get 15 s
  maxSourceBytes: 25_000_000,      // 25 MB
  limitInputPixels: 50_000_000,    // ~50 MP, about 200 MB decoded
  failedImageTtlMs: 60 * 60 * 1000 // retry broken images after 1 h
  // ...your existing headers, allowlistedOrigins, cacheFolder
});