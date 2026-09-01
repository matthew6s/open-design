import type { CSSProperties } from 'react';

import { RemixIcon } from './RemixIcon';

interface Props {
  id: string;
  size?: number;
  className?: string;
}

// Agents that ship a bundled brand asset under `apps/web/public/agent-icons/`.
// SVG is preferred (resolution-independent, single file ≤ a few KB); PNG is
// the fallback for vendors that don't publish an SVG mark anywhere (Devin
// only ships a rasterised icon on devin.ai). New brand: drop the optimised
// file in that folder and add the id here.
const ICON_EXT: Record<string, 'svg' | 'png'> = {
  amr: 'svg',
  claude: 'svg',
  codex: 'svg',
  gemini: 'svg',
  opencode: 'svg',
  'cursor-agent': 'svg',
  copilot: 'svg',
  qwen: 'svg',
  qoder: 'svg',
  deepseek: 'svg',
  reasonix: 'svg',
  mimo: 'svg',
  hermes: 'svg',
  'grok-build': 'svg',
  kimi: 'svg',
  pi: 'svg',
  kiro: 'svg',
  kilo: 'svg',
  vibe: 'svg',
  antigravity: 'svg',
  aider: 'png',
  'trae-cli': 'png',
  devin: 'png',
};

// Runtime variants that share the same vendor mark. Keep one bundled asset
// instead of duplicating identical SVG files under transport-specific ids.
const ICON_ASSET_ID: Record<string, string> = {
  'deepseek-harness': 'deepseek',
};

// SVG marks that are single-color silhouettes (no baked brand colors).
// Rendered as a CSS-masked `<span>` so `background-color: currentColor`
// can paint them in whatever text color the surrounding theme resolves
// to — light text under dark theme, dark text under light theme. The
// SVG file itself uses an explicit dark fill (`#1c1b1a`, baked) instead
// of `currentColor`, so if anything outside this component ever loads
// the asset through `<img>` it still renders as a legible dark mark
// rather than collapsing to the SVG document's default black-on-…-black.
const MONO_ICONS = new Set([
  'cursor-agent',
  'opencode',
  'hermes',
  'mimo',
  'kilo',
  'grok-build',
]);

/** The bring-your-own-key runtime, mirrored in EntryShell's grid. */
const BYOK_AGENT_ID = 'byok-opencode';

export function AgentIcon({ id, size = 36, className }: Props) {
  const cls = 'agent-icon' + (className ? ' ' + className : '');
  // BYOK has no vendor behind it — the runtime is whatever provider key the
  // user brings — so it wears the product's key glyph (per product) instead of
  // the initial-letter tile the fallback below would give it. currentColor, so
  // it takes the surrounding text colour in either theme.
  if (id === BYOK_AGENT_ID) {
    return <RemixIcon name="key-2-fill" size={size} className={cls} />;
  }
  const assetId = ICON_ASSET_ID[id] ?? id;
  const ext = ICON_EXT[assetId];
  if (ext) {
    if (ext === 'svg' && MONO_ICONS.has(assetId)) {
      const src = `/agent-icons/${assetId}.svg`;
      const style: CSSProperties = {
        width: size,
        height: size,
        WebkitMaskImage: `url("${src}")`,
        maskImage: `url("${src}")`,
      };
      return (
        <span
          className={cls + ' agent-icon-mono'}
          style={style}
          aria-hidden="true"
        />
      );
    }
    return (
      <img
        src={`/agent-icons/${assetId}.${ext}`}
        alt=""
        width={size}
        height={size}
        className={cls}
        aria-hidden="true"
        draggable={false}
      />
    );
  }
  // Fallback for brands we don't ship artwork for. A neutral rounded
  // square with the initial letter — reads as "no official mark yet"
  // without inventing brand artwork we can't license.
  const initial = (id.match(/[a-z]/i)?.[0] ?? '?').toUpperCase();
  return (
    <span
      className={cls + ' agent-icon-fallback'}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        lineHeight: 1,
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
