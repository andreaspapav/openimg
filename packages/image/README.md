# Image

Responsive `<Image>` for the React Router app, replacing `openimg/react` and
the custom `ResponsiveImage`. It renders a `<picture>` with one `<source>` per
modern format and an `<img>` fallback, with URLs pointing at the image
processor (`?src=…&w=…&h=…&fit=…&format=…`).

No context provider: settings live in `src/config.ts`.

## Moving it into the app

1. Copy `src/` to e.g. `app/components/image/`.
2. Edit `config.ts`:
   ```ts
   endpoint: import.meta.env.VITE_IMG_ENDPOINT ?? "/img",
   // Relative srcs (Vite assets, /public) are made absolute with this, so the
   // processor can fetch them. Add this origin to the processor's allowlist.
   assetOrigin: import.meta.env.VITE_APP_ORIGIN,
   // Optional: skip the processor while developing
   unoptimized: import.meta.env.DEV,
   ```
3. The tests (`*.test.ts(x)`) are Vitest tests and run as they are. Add
   `vitest.setup.ts` to the app's Vitest `setupFiles` (or merge its lines into
   the existing setup), and run them in a DOM environment: `happy-dom` or
   `jsdom`, either in the config or with `// @vitest-environment happy-dom`
   at the top of each file. They need `@testing-library/react`,
   `@testing-library/dom` and `@testing-library/jest-dom`.

## Usage

```tsx
import hero from "~/assets/hero.jpg";

// Fixed size: 1x/2x srcset
<Image src={hero} alt="" width={1200} height={600} priority />

// Fluid: width descriptors chosen from `sizes`
<Image src={url} alt={name} width={800} height={600} sizes="(min-width: 768px) 50vw, 100vw" className="w-full h-auto" />

// Fill a positioned parent
<div className="relative aspect-video">
  <Image src={url} alt={name} fill sizes="100vw" style={{ objectFit: "cover" }} />
</div>

// Stored upload with a blur placeholder
<Image src={{ src: img.url, width: img.width, height: img.height, blurDataURL: img.blurDataURL }} alt="" placeholder="blur" />
```

| Prop | |
| --- | --- |
| `src` | URL, path, Vite asset URL, or `{ src, width, height, blurDataURL? }` |
| `alt` | Required; `""` for decorative images |
| `width`, `height` | Rendered size and aspect ratio. Optional with `fill` or a static image |
| `fill` | Absolutely fill the nearest positioned parent |
| `sizes` | Switches the srcset from 1x/2x to width descriptors |
| `fit` | Processor crop: `"cover"` (default) or `"contain"` |
| `priority` | LCP image: preload, eager loading, `fetchpriority="high"` |
| `placeholder` | `"empty"`, `"blur"` (`blurDataURL` smoothed by an SVG blur filter), or a data URL shown as-is |
| `unoptimized` | Use the original `src`. SVG, GIF, `data:` and `blob:` are never optimized |
| `params` | Extra query parameters for every URL of this image, passed to the loader (e.g. `{ quality: "70", position: "top" }`) |
| `loader` | Custom URL builder for this image. Default: `config.loader` |
| `formats` | Override `config.formats` for this image |

Every other `<img>` attribute, `ref`, `onLoad` and `onError` go to the `<img>`.
`getImageProps(props)` returns the computed `sources`, `img` attributes and
preload arguments without rendering, for art direction or CSS backgrounds.

## Coming from OpenImgContextProvider

The provider's `getSrc` becomes `loader` in `config.ts`, and the Image's
`params` prop works as before. The loader gets the same values, with the
endpoint in `config.endpoint`:

| openimg `GetSrcArgs` | `ImageLoaderArgs` + config |
| --- | --- |
| `src`, `width`, `height`, `fit`, `format`, `params` | same names (`height` is unset when the aspect ratio is unknown) |
| `optimizerEndpoint` | `config.endpoint` |

```ts
// config.ts
loader: ({ src, width, height, fit, format, params }, config) => {
  // your existing getSrc body, e.g. objectKey vs src and passport signatures
},
```

```tsx
<Image src={url} alt="" width={800} height={600} params={{ quality: "70" }} />
<Image src={url} alt="" width={800} height={600} params={{ objectKey, exp, sig }} />
```

`defaultLoader` builds the same URLs as openimg's `defaultGetSrc`, so a
loader that only adds params needs no changes beyond the move.

## Blur placeholders

`blurDataURL` is a plain string: a tiny image as a data URL, stored with the
image record. The image processor's `POST /uploads` already returns it, with
the stored image's dimensions:

```ts
// { key, width, height, placeholder }
<Image
  src={{ src: imageUrl(key), width, height, blurDataURL: placeholder }}
  alt=""
  placeholder="blur"
/>
```

With `placeholder="blur"` the component wraps it in an inline SVG with a
Gaussian blur, so the 16px image scales up smooth instead of blocky. The SVG
adds about 600 characters per image to the HTML.

## Processor notes

- Once every page uses this component, set the processor's
  `IMAGE_ALLOWED_WIDTHS` to `[...imageSizes, ...deviceSizes]` from
  `config.ts` (comma-separated). Every URL this component builds uses one of
  those widths, and the processor rejects others. Keep the two lists in sync.
- `fill` images with an unknown ratio send `w` only; the processor resizes
  those keeping the aspect ratio and never enlarges.
- Relative `src` without `assetOrigin` is read from the processor's
  `./public` folder.
