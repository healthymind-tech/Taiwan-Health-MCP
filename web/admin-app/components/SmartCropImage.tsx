// Renders an <img>-replacement that auto-crops to the non-white subject. TFDA
// drug appearance photos float the pill in a mostly-white frame, often far from
// the center, so a plain <img> shows huge white margins. This measures the
// subject's bounding box once per URL (cached), then renders only that region
// via a scaled background + negative offset. Box dimensions are computed in JS
// (ResizeObserver on the parent) so sizing does not depend on CSS aspect-ratio
// transfer, which differs across browsers.
//
// Measurement is cheap by design: the probe is drawn into a small canvas
// (MAX_PROBE_DIM) and the bbox is scaled back to natural coordinates, and it is
// deferred until the element is near the viewport (IntersectionObserver), so a
// long list of thumbnails does not block the main thread.

import { useEffect, useRef, useState, type CSSProperties } from "react";

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fw: number;
  fh: number;
}

const cache = new Map<string, Promise<CropRect | null>>();
const MAX_PROBE_DIM = 256;

function measureCrop(src: string): Promise<CropRect | null> {
  const hit = cache.get(src);
  if (hit) return hit;
  const job = new Promise<CropRect | null>((resolve) => {
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => {
      try {
        const fw = probe.naturalWidth;
        const fh = probe.naturalHeight;
        if (!fw || !fh) return resolve(null);
        const scale = Math.min(1, MAX_PROBE_DIM / Math.max(fw, fh));
        const sw = Math.max(1, Math.round(fw * scale));
        const sh = Math.max(1, Math.round(fh * scale));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(probe, 0, 0, sw, sh);
        const data = ctx.getImageData(0, 0, sw, sh).data;
        let minX = sw;
        let minY = sh;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < sh; y++) {
          const row = y * sw;
          for (let x = 0; x < sw; x++) {
            const i = (row + x) * 4;
            if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0 || maxY < 0) return resolve(null);
        const inv = 1 / scale;
        const l = minX * inv;
        const t = minY * inv;
        const cw = (maxX - minX + 1) * inv;
        const ch = (maxY - minY + 1) * inv;
        const pad = 0.05;
        const left = Math.min(l, Math.round(cw * pad));
        const top = Math.min(t, Math.round(ch * pad));
        const right = Math.min(fw - l - cw, Math.round(cw * pad));
        const bottom = Math.min(fh - t - ch, Math.round(ch * pad));
        resolve({ x: Math.round(l - left), y: Math.round(t - top), w: Math.round(cw + left + right), h: Math.round(ch + top + bottom), fw, fh });
      } catch {
        resolve(null);
      }
    };
    probe.onerror = () => resolve(null);
    probe.src = src;
  });
  cache.set(src, job);
  return job;
}

export function SmartCropImage({
  src,
  alt,
  className,
  contain = false,
}: {
  src: string;
  alt: string;
  className?: string;
  /** Fit the crop inside the container (modal preview) instead of filling its width. */
  contain?: boolean;
}): JSX.Element {
  const [rect, setRect] = useState<CropRect | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let alive = true;
    const run = (): void => {
      setRect(null);
      measureCrop(src).then((r) => {
        if (alive) setRect(r);
      });
    };
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            io.disconnect();
            run();
          }
        },
        { rootMargin: "200px" },
      );
      io.observe(node);
      return () => {
        alive = false;
        io.disconnect();
      };
    }
    run();
    return () => {
      alive = false;
    };
  }, [src]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const node = ref.current;
    if (!node || !rect) return;
    const container = node.parentElement;
    if (!container) return;
    const update = (): void => {
      const cs = getComputedStyle(container);
      const cw = container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ch = container.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const s = contain ? Math.min(cw / rect.w, ch / rect.h) : cw / rect.w;
      setSize({ w: Math.max(1, Math.round(rect.w * s)), h: Math.max(1, Math.round(rect.h * s)) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => ro.disconnect();
  }, [contain, rect]);

  const style: CSSProperties = rect && size
    ? {
        width: size.w,
        height: size.h,
        backgroundImage: `url(${JSON.stringify(src)})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${rect.fw * (size.w / rect.w)}px ${rect.fh * (size.h / rect.h)}px`,
        backgroundPosition: `${-(rect.x * (size.w / rect.w))}px ${-(rect.y * (size.h / rect.h))}px`,
      }
    : {
        aspectRatio: "4 / 3",
        backgroundImage: `url(${JSON.stringify(src)})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: "contain",
        backgroundPosition: "center",
      };
  return (
    <div
      ref={ref}
      className={`smart-crop ${contain ? "smart-crop--contain " : ""}${className ?? ""}`.trim()}
      style={style}
      role="img"
      aria-label={alt}
      title={alt}
    />
  );
}
