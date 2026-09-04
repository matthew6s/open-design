// Where the particle field must not paint, and how softly it gets out of the
// way. Kept separate from the canvas component so the falloff is testable
// without a rendering context — the component only multiplies alpha by it.

/** A rectangle the field paints around, in host-local CSS px (origin top-left). */
export interface HoleRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radius. Defaults to half the short side, i.e. a stadium. */
  radius?: number;
}

/** Feather distance, in px, over which a hole fades back to full density. */
export const DEFAULT_HOLE_FEATHER = 18;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Signed distance from a point to a rounded rect's edge; negative inside. */
function roundedRectDistance(x: number, y: number, rect: HoleRect): number {
  const halfWidth = Math.max(rect.width, 0) / 2;
  const halfHeight = Math.max(rect.height, 0) / 2;
  const radius = Math.max(
    0,
    Math.min(rect.radius ?? Math.min(halfWidth, halfHeight), halfWidth, halfHeight),
  );
  const centerX = rect.x + halfWidth;
  const centerY = rect.y + halfHeight;
  const dx = Math.max(Math.abs(x - centerX) - (halfWidth - radius), 0);
  const dy = Math.max(Math.abs(y - centerY) - (halfHeight - radius), 0);
  const outside = Math.hypot(dx, dy) - radius;
  if (outside > 0) return outside;
  // Inside the box: distance to the nearest edge, negated.
  const insideX = halfWidth - Math.abs(x - centerX);
  const insideY = halfHeight - Math.abs(y - centerY);
  return -Math.min(insideX, insideY);
}

/**
 * How visible a particle at this point may be: 0 inside a hole, 1 once it is a
 * full `feather` clear of every hole, and a linear ramp between.
 *
 * The holes are the TEXT's own line boxes, not the block that contains them —
 * the block is up to 460px wide while the ring it sits in has a 105px radius,
 * so erasing the block would erase the ring. Per-line rects keep the field
 * intact everywhere the words are not.
 */
export function holeAlphaAt(
  x: number,
  y: number,
  holes: readonly HoleRect[],
  feather: number = DEFAULT_HOLE_FEATHER,
): number {
  if (holes.length === 0) return 1;
  const span = feather > 0 ? feather : 1;
  let alpha = 1;
  for (const hole of holes) {
    const distance = roundedRectDistance(x, y, hole);
    const next = clamp01(distance / span);
    if (next < alpha) alpha = next;
    if (alpha === 0) return 0;
  }
  return alpha;
}

/** True when two rect lists describe the same holes, to the nearest px. */
export function holeRectsEqual(a: readonly HoleRect[], b: readonly HoleRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      Math.round(left.x) !== Math.round(right.x) ||
      Math.round(left.y) !== Math.round(right.y) ||
      Math.round(left.width) !== Math.round(right.width) ||
      Math.round(left.height) !== Math.round(right.height)
    ) {
      return false;
    }
  }
  return true;
}
