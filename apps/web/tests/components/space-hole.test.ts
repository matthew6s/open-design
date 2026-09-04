import { describe, expect, it } from 'vitest';

import { holeAlphaAt, holeRectsEqual } from '../../src/components/workspace/space-hole';

const BOX = { x: 100, y: 50, width: 80, height: 20 };

describe('holeAlphaAt', () => {
  it('paints nothing inside a hole', () => {
    expect(holeAlphaAt(140, 60, [BOX], 10)).toBe(0); // centre
    expect(holeAlphaAt(105, 60, [BOX], 10)).toBe(0); // just inside the left end
    expect(holeAlphaAt(140, 51, [BOX], 10)).toBe(0); // just under the top edge
  });

  // The hole is a stadium, not a rectangle: a line of text is rounded at its
  // ends, and its square corners hold no glyphs worth clearing.
  it('leaves the square corners of the box outside the hole', () => {
    expect(holeAlphaAt(100, 50, [BOX], 10)).toBeGreaterThan(0);
  });

  it('paints at full density once a full feather clear of the hole', () => {
    expect(holeAlphaAt(140, 90, [BOX], 10)).toBe(1);
    expect(holeAlphaAt(240, 60, [BOX], 10)).toBe(1);
  });

  // The soft edge is the whole point: a hard cut would read as a hole punched
  // in the field rather than as the field getting out of the way.
  it('ramps between the two, monotonically outward', () => {
    const near = holeAlphaAt(140, 74, [BOX], 20);
    const mid = holeAlphaAt(140, 80, [BOX], 20);
    const far = holeAlphaAt(140, 88, [BOX], 20);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThan(far);
    expect(far).toBeLessThanOrEqual(1);
  });

  it('takes the strongest hole when several overlap', () => {
    const second = { x: 300, y: 50, width: 40, height: 20 };
    // Just outside the first box, deep inside the second.
    expect(holeAlphaAt(310, 60, [BOX, second], 10)).toBe(0);
  });

  it('leaves the field untouched when there are no holes', () => {
    expect(holeAlphaAt(0, 0, [], 10)).toBe(1);
  });
});

describe('holeRectsEqual', () => {
  it('ignores sub-pixel churn so a measurement loop cannot feed itself', () => {
    expect(holeRectsEqual([BOX], [{ ...BOX, x: BOX.x + 0.2 }])).toBe(true);
  });

  it('sees a real move', () => {
    expect(holeRectsEqual([BOX], [{ ...BOX, y: BOX.y + 14 }])).toBe(false);
    expect(holeRectsEqual([BOX], [])).toBe(false);
  });
});
