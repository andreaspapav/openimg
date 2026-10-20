import {
  useCallback,
  useState,
  type ReactEventHandler,
  type Ref,
  type RefCallback,
} from "react";
import { preload } from "react-dom";
import { imageConfig } from "./config";
import { buildImageProps, type ImageProps } from "./get-image-props";

type LoadStatus = { src: string; error: boolean };

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

/**
 * Responsive image that renders a <picture> with one <source> per modern
 * format and an <img> fallback, all served by the image processor.
 *
 * ```tsx
 * import hero from "~/assets/hero.jpg";
 *
 * <Image src={hero} alt="" width={1200} height={600} priority />
 * <Image src={product.imageUrl} alt={product.name} fill sizes="(min-width: 768px) 33vw, 100vw" />
 * ```
 */
export function Image({ ref, onLoad, onError, ...props }: ImageProps) {
  // Which src finished loading. Keyed by src so a new src shows its
  // placeholder again
  const [status, setStatus] = useState<LoadStatus | null>(null);

  const src = typeof props.src === "object" ? props.src.src : props.src;
  const current = status?.src === src ? status : null;
  const { sources, img, preload: preloadArgs } = buildImageProps(
    props,
    imageConfig,
    { complete: current !== null, error: current?.error ?? false }
  );

  if (preloadArgs) {
    preload(preloadArgs.href, preloadArgs.options);
  }

  // Server-rendered images can finish before hydration attaches onLoad and
  // onError, so check the element itself on mount
  const imgRef: RefCallback<HTMLImageElement> = useCallback(
    (node) => {
      if (node?.complete && node.getAttribute("src")) {
        setStatus({ src, error: node.naturalWidth === 0 });
      }
      setRef(ref, node);
      return () => setRef(ref, null);
    },
    [ref, src]
  );

  const handleLoad: ReactEventHandler<HTMLImageElement> = (event) => {
    setStatus({ src, error: false });
    onLoad?.(event);
  };

  const handleError: ReactEventHandler<HTMLImageElement> = (event) => {
    setStatus({ src, error: true });
    onError?.(event);
  };

  const element = (
    <img {...img} ref={imgRef} onLoad={handleLoad} onError={handleError} />
  );

  if (sources.length === 0) {
    return element;
  }
  return (
    <picture>
      {sources.map((source) => (
        <source key={source.type} {...source} />
      ))}
      {element}
    </picture>
  );
}
