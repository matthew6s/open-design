// Orbiting particle field — a canvas layer sized to its host block. Particles
// spiral inward toward a dense ring around the host's center, shrink, and are
// re-cast further out, so the field reads as a slow, quiet orbit rather than
// a starfield drifting in one direction.
//
// Ported from the 21st.dev community component
// `@designali-in/space-background` (Ali Imam). The registry item is
// login-gated, so the motion model was reproduced from its public preview
// bundle rather than installed; the port also swaps the upstream's
// viewport-fixed canvas for a host-sized one, adds devicePixelRatio scaling,
// and honors reduced-motion / hidden-tab the way the rest of this app does
// (see AppWashKineticGrid).

import { useEffect, useRef } from 'react';

import { DEFAULT_HOLE_FEATHER, holeAlphaAt, type HoleRect } from './space-hole';

/** Fallback particle tint when the host exposes no `--space-particle`. */
const AUTO_LIGHT = 'rgba(0, 0, 0, 0.85)';
const AUTO_DARK = 'rgba(255, 255, 255, 0.85)';

interface Particle {
  /** Current orbit radius; decays toward `ringRadius` one pixel per frame. */
  ring: number;
  /** Angular phase, advanced by `move` each frame. */
  phase: number;
  /** Angular speed. */
  move: number;
  /** Drawn dot radius; decays until it is re-cast. */
  radius: number;
  x: number;
  y: number;
}

interface SpaceBackgroundProps {
  /** How many particles populate the field. They fade in one per frame. */
  particleCount?: number;
  /** Radius of the dense inner ring the field collapses toward, in CSS px. */
  ringRadius?: number;
  /**
   * Explicit particle color. Omit to resolve `--space-particle` from the host
   * element, falling back to a luminance-matched neutral.
   */
  particleColor?: string;
  /**
   * Boxes the field paints around — host-local CSS px, origin top-left. Used to
   * keep the orbit off the text sitting inside it: the dots fade out as they
   * approach a hole instead of being clipped, so the edge reads as density
   * rather than as a cut-out.
   */
  holes?: readonly HoleRect[];
  /** How far a hole's fade reaches, in px. */
  holeFeather?: number;
  className?: string;
}

/** `#abc` / `#aabbcc` / `rgb()` / `rgba()` → channel triple, or null. */
function parseRgb(color: string | null | undefined): [number, number, number] | null {
  if (!color) return null;
  const value = color.trim();
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length < 6) return null;
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match?.[1]) return null;
  const [r, g, b] = match[1].split(/[,/\s]+/).filter(Boolean).map((p) => parseFloat(p));
  if (r === undefined || g === undefined || b === undefined) return null;
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [r, g, b];
}

/** WCAG relative luminance, used only to pick ink-on-light vs light-on-ink. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Resolve the tint: an explicit prop wins, then the `--space-particle` custom
 * property (read off the canvas, so a caller's `className` can set it), then a
 * neutral picked against the host's own background so the field stays legible
 * if this ever renders on a dark surface.
 */
function resolveParticleColor(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  explicit?: string,
): string {
  if (explicit) return explicit;
  const token = getComputedStyle(canvas).getPropertyValue('--space-particle').trim();
  if (token) return token;
  const backdrop = parseRgb(getComputedStyle(host).backgroundColor);
  if (backdrop) return relativeLuminance(backdrop) < 0.5 ? AUTO_DARK : AUTO_LIGHT;
  const prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? AUTO_DARK : AUTO_LIGHT;
}

export function SpaceBackground({
  particleCount = 420,
  ringRadius = 150,
  particleColor,
  holes,
  holeFeather = DEFAULT_HOLE_FEATHER,
  className,
}: SpaceBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Read through a ref, never a dependency: the holes are re-measured on every
  // text change, and a new array identity in the effect's deps would re-seed
  // the whole field — the orbit would restart every time a status line lands.
  const holesRef = useRef<readonly HoleRect[]>(holes ?? []);
  holesRef.current = holes ?? [];
  const featherRef = useRef(holeFeather);
  featherRef.current = holeFeather;
  // The last committed paint, so a hole measurement can refresh the settled
  // reduced-motion frame (which is painted once and never again).
  const repaintRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const host = canvas.parentElement;
    if (!host) return;

    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let color = resolveParticleColor(canvas, host, particleColor);
    let width = 1;
    let height = 1;
    const particles: Particle[] = [];
    // Particles light up one per frame instead of all at once, so the field
    // assembles itself on mount rather than popping in fully formed.
    let lit = 0;

    /** Re-cast a spent particle somewhere in the outer field. */
    function cast(particle: Particle): void {
      particle.ring = Math.random() * ringRadius * 3;
      particle.radius = Math.random() * 5;
    }

    for (let i = 0; i < particleCount; i++) {
      const phase = Math.random() * Math.PI * 2;
      particles.push({
        ring: Math.random() * ringRadius * 3,
        phase,
        move: (Math.random() * 4 + 1) / 500,
        radius: Math.random() * 5,
        x: Math.cos(phase + Math.PI) * ringRadius,
        y: Math.sin(phase + Math.PI) * ringRadius,
      });
    }

    // The canvas origin sits at the host's center with Y pointing up, so the
    // orbit math is plain polar coordinates.
    function resize(): void {
      if (!canvas || !ctx || !host) return;
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, -dpr, (width * dpr) / 2, (height * dpr) / 2);
    }

    function step(particle: Particle): void {
      if (particle.radius < 0.8) cast(particle);
      particle.radius *= 0.994;
      particle.ring = Math.max(particle.ring - 1, ringRadius);
      particle.phase += particle.move;
      particle.x = Math.cos(particle.phase + Math.PI) * particle.ring;
      particle.y = Math.sin(particle.phase + Math.PI) * particle.ring;
    }

    // Distance taper: a particle's `radius` is its LIFE, not its distance — it
    // is cast at full size out in the field and decays as it spirals in, which
    // drew the outermost dots as the biggest ones on screen. Paint them down by
    // how far out they still are (full size once they reach the ring, ~40% of
    // it at the outer edge), so the field reads as depth instead of a scatter
    // of blobs around a fine ring. Purely a paint scale: the decay, lifetime
    // and re-cast cadence above are untouched.
    const OUTER_SCALE = 0.4;
    const spread = Math.max(1, ringRadius * 3 - ringRadius);
    function drawnRadius(particle: Particle): number {
      const outward = Math.min(1, Math.max(0, (particle.ring - ringRadius) / spread));
      return Math.max(0, particle.radius * (1 - (1 - OUTER_SCALE) * outward));
    }

    /* Holes arrive in host-local, Y-down CSS px; the canvas draws from the
       host's CENTER with Y up. Convert once per frame rather than per particle,
       and hand the particle loop coordinates in its own space. */
    function holesInCanvasSpace(): HoleRect[] {
      const source = holesRef.current;
      if (source.length === 0) return [];
      const out: HoleRect[] = [];
      for (const hole of source) {
        out.push({
          x: hole.x - width / 2,
          y: height / 2 - (hole.y + hole.height),
          width: hole.width,
          height: hole.height,
          ...(hole.radius === undefined ? {} : { radius: hole.radius }),
        });
      }
      return out;
    }

    function paint(): void {
      if (!ctx) return;
      ctx.clearRect(-width, -height, width * 2, height * 2);
      ctx.fillStyle = color;
      const holeRects = holesInCanvasSpace();
      const feather = featherRef.current;
      for (let i = 0; i < lit; i++) {
        const particle = particles[i];
        if (!particle) continue;
        // A density fade, not a clip: a dot that would land on the text simply
        // does not get drawn, and its neighbours dim on the way in, which is
        // what makes the edge soft without a blur pass.
        const alpha = holeRects.length === 0
          ? 1
          : holeAlphaAt(particle.x, particle.y, holeRects, feather);
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, drawnRadius(particle), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    repaintRef.current = paint;

    resize();

    const ro = new ResizeObserver(() => {
      resize();
      if (reducedMotion) paint();
    });
    ro.observe(host);

    if (reducedMotion) {
      // One settled frame: advance the field far enough that it reads as an
      // orbit caught mid-flight rather than a perfect ring of fresh particles.
      lit = particles.length;
      for (let f = 0; f < 240; f++) for (const particle of particles) step(particle);
      paint();
      return () => ro.disconnect();
    }

    let raf = 0;
    const frame = () => {
      if (!document.hidden) {
        if (lit < particles.length) lit++;
        for (let i = 0; i < lit; i++) {
          const particle = particles[i];
          if (particle) step(particle);
        }
        paint();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // The tint follows the host's theme, which the app can swap at runtime.
    const themeObserver = new MutationObserver(() => {
      color = resolveParticleColor(canvas, host, particleColor);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
    };
  }, [particleCount, ringRadius, particleColor]);

  // The animated field picks new holes up on its next frame; the reduced-motion
  // field has already painted its only frame, so it needs telling.
  useEffect(() => {
    repaintRef.current?.();
  }, [holes, holeFeather]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        zIndex: 0,
        display: 'block',
        pointerEvents: 'none',
      }}
    />
  );
}
