# Cache maintenance

openimg/bun stores optimized images as plain files under `cacheFolder`. There is no in-process index and no built-in eviction. Use an external job to delete unused files and leftover temp writes.

## Layout

- Cache paths are derived from the source and transform params (same as before).
- Incomplete writes use the suffix `*.tmp` in the same directory, then rename into place. A crash can leave `.tmp` files; they are safe to delete.
- When `touchCacheOnHit` is enabled, mtime means "last used" (last request that reached openimg, typically after a CDN miss). Many volumes mount with `noatime`, so do not rely on atime.

## Cron cleanup

Run on **one** instance only if several machines share a volume.

Delete files not used in 30 days:

```bash
find /data/images -type f ! -name '*.tmp' -mtime +30 -delete
```

Delete stale temp files older than an hour:

```bash
find /data/images -type f -name '*.tmp' -mmin +60 -delete
```

## In-process timer (Bun)

Same recipe inside the image server process (still only on one instance if the volume is shared):

```typescript
const cacheFolder = "./data/images";

setInterval(
  async () => {
    const { $ } = await import("bun");
    await $`find ${cacheFolder} -type f ! -name '*.tmp' -mtime +30 -delete`;
    await $`find ${cacheFolder} -type f -name '*.tmp' -mmin +60 -delete`;
  },
  24 * 60 * 60 * 1000
);
```

Or walk the tree with `fs` if you prefer not to shell out.

## Small VM tips

These are process/global settings for your server, not openimg config:

- `sharp.cache(false)` — openimg already caches outputs on disk
- optionally `sharp.concurrency(1)` under tight RAM
- `MALLOC_ARENA_MAX=2` on glibc-based (Debian/Ubuntu) images to limit allocator arenas

## CDN note

If a CDN sits in front, openimg only sees cache misses. Deleting a file that the CDN still serves only forces one regeneration when the CDN revalidates.
