import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { holeRectsEqual, type HoleRect } from '../workspace/space-hole';

/** Breathing room around each line box, so glyphs never touch a dot. */
const INFLATE_X = 6;
const INFLATE_Y = 3;


function rectsFromLineBoxes(element: HTMLElement): DOMRect[] {
  if (typeof document.createRange !== 'function') return [];
  const range = document.createRange();
  range.selectNodeContents(element);
  const list = typeof range.getClientRects === 'function' ? range.getClientRects() : null;
  range.detach?.();
  if (!list) return [];
  const rects: DOMRect[] = [];
  for (const rect of Array.from(list)) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    rects.push(rect);
  }
  return rects;
}

/**
 * The boxes a particle field must paint around to leave this element's TEXT
 * legible, in host-local CSS px.
 *
 * Per line box, not per block: a centered block is as wide as its `max-width`
 * while its lines are only as wide as their words, and the field it sits in has
 * a radius of ~105px — one block-sized hole would erase the orbit entirely.
 * `Range.getClientRects()` is what gives line-level geometry without laying the
 * text out a second time.
 *
 * Re-measures on resize AND whenever `deps` changes, because the feed scrolls
 * its own content: lines move while the block's size does not.
 */
export function useTextHoleRects(
  ref: { current: HTMLElement | null },
  deps: unknown,
): HoleRect[] {
  const [rects, setRects] = useState<HoleRect[]>([]);
  const rectsRef = useRef<HoleRect[]>([]);

  const measure = useRef<() => void>(() => undefined);
  measure.current = () => {
    const element = ref.current;
    const host = element?.parentElement ?? null;
    if (!element || !host) return;
    const origin = host.getBoundingClientRect();
    const lineBoxes = rectsFromLineBoxes(element);
    const source: Array<{ left: number; top: number; width: number; height: number }> =
      lineBoxes.length > 0
        ? lineBoxes.map((rect) => ({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }))
        : (() => {
            // jsdom and any engine without range rects: one box around the
            // block. It carries no padding of its own — it is sized to the box
            // inscribed in the ring and holds nothing but the lines — so the
            // block box IS the text area here.
            const box = element.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) return [];
            return [
              { left: box.left, top: box.top, width: box.width, height: box.height },
            ];
          })();

    const next: HoleRect[] = source
      .filter((box) => box.width > 0 && box.height > 0)
      .map((box) => ({
        x: box.left - origin.left - INFLATE_X,
        y: box.top - origin.top - INFLATE_Y,
        width: box.width + INFLATE_X * 2,
        height: box.height + INFLATE_Y * 2,
      }));

    // A ResizeObserver that writes state on every callback re-enters itself
    // through the layout it just caused. Only commit a genuine change.
    if (holeRectsEqual(rectsRef.current, next)) return;
    rectsRef.current = next;
    setRects(next);
  };

  useLayoutEffect(() => {
    measure.current();
  }, [deps]);

  useEffect(() => {
    const element = ref.current;
    const host = element?.parentElement ?? null;
    if (!element) return;
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(element);
    if (host) observer.observe(host);
    return () => observer.disconnect();
  }, [ref]);

  return rects;
}
