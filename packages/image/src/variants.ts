import type { ImageVariants } from "./get-image-props";

// "hero-640.webp", "hero-640w.webp", "hero-640.jpg?url"
const VARIANT_FILE = /-(\d+)w?\.(avif|webp|jpe?g|png)$/i;

/**
 * Builds `variants` from Vite's `import.meta.glob`, for files named
 * `<name>-<width>.<format>`:
 *
 * ```ts
 * const heroVariants = variantsFromGlob(
 *   import.meta.glob("~/assets/hero-*.{avif,webp,jpg}", {
 *     eager: true,
 *     import: "default",
 *     query: "?url",
 *   })
 * );
 * ```
 *
 * The glob pattern has to be written out in the app (Vite resolves it at
 * build time); this only turns the result into variants. Files that don't
 * match the naming are ignored.
 */
export function variantsFromGlob(files: Record<string, string>): ImageVariants {
  const variants: ImageVariants = {};
  for (const [file, src] of Object.entries(files)) {
    const match = VARIANT_FILE.exec(file.split(/[?#]/, 1)[0] ?? file);
    if (!match) {
      continue;
    }
    const extension = match[2]!.toLowerCase();
    const format = extension === "jpg" ? "jpeg" : (extension as keyof ImageVariants);
    (variants[format] ??= []).push({ width: Number(match[1]), src });
  }
  for (const list of Object.values(variants)) {
    list.sort((a, b) => a.width - b.width);
  }
  return variants;
}
