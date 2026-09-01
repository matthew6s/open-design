import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const entryLayoutCss = readFileSync(
  new URL('../../src/styles/home/entry-layout.css', import.meta.url),
  'utf8',
);

// Comments are stripped first so a doc comment above a rule cannot glue
// itself onto the selector and hide the block from the matcher.
const entryLayoutRules = entryLayoutCss.replace(/\/\*[\s\S]*?\*\//g, '');

function cssDeclarations(selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(entryLayoutRules)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

describe('onboarding layout styles', () => {
  // Acceptance #138 — the About-you step's Back link must hug the content
  // column's left edge, above the panel title. The onboarding panel is a grid
  // whose items stretch, and the global button primitive centers button
  // content, so without an explicit inline-axis `start` the stretched link
  // floats its label mid-column.
  it('pins the onboarding back link to the content column start', () => {
    const backBlock = cssDeclarations('.onboarding-view__back-to-cloud');

    expect(backBlock).toMatch(/(?:^|[;\n])\s*justify-self:\s*start\s*;/);
    expect(backBlock).toMatch(/(?:^|[;\n])\s*align-self:\s*start\s*;/);
  });

  it('lets AMR benefit chips wrap inside the featured card', () => {
    const asideBlock = cssDeclarations('.onboarding-view__benefit-aside');
    const benefitsBlock = cssDeclarations(
      '.onboarding-view__benefit-aside .onboarding-view__benefits',
    );

    expect(asideBlock).toMatch(/(?:^|[;\n])\s*width:\s*100%\s*;/);
    expect(asideBlock).toMatch(/(?:^|[;\n])\s*justify-self:\s*stretch\s*;/);
    expect(benefitsBlock).toMatch(/(?:^|[;\n])\s*flex-wrap:\s*wrap\s*;/);
    expect(benefitsBlock).not.toMatch(/(?:^|[;\n])\s*flex-wrap:\s*nowrap\s*;/);
  });

  // The retry card and the standalone 取消登录 row are gone: while a login is
  // in flight the primary capsule itself carries the two controls (打开登录页 +
  // 取消登录) on its trailing edge. The label yields, the controls never do.
  it('keeps the signing-in controls intact on the primary capsule', () => {
    const busyBlock = cssDeclarations('.onboarding-cloud__primary--busy');
    const labelBlock = cssDeclarations('.onboarding-cloud__busy-label');
    const actionsBlock = cssDeclarations('.onboarding-cloud__busy-actions');
    const openBlock = cssDeclarations('.onboarding-cloud__busy-open');
    const cancelBlock = cssDeclarations('.onboarding-cloud__busy-cancel');

    expect(busyBlock).toMatch(/(?:^|[;\n])\s*justify-content:\s*space-between\s*;/);
    expect(busyBlock).toMatch(/(?:^|[;\n])\s*flex-wrap:\s*wrap\s*;/);
    expect(labelBlock).toMatch(/(?:^|[;\n])\s*flex:\s*1\s+1\s+auto\s*;/);
    expect(labelBlock).toMatch(/(?:^|[;\n])\s*min-width:\s*0\s*;/);
    expect(actionsBlock).toMatch(/(?:^|[;\n])\s*flex:\s*0\s+0\s+auto\s*;/);
    expect(openBlock).toMatch(/(?:^|[;\n])\s*flex:\s*0\s+0\s+auto\s*;/);
    expect(cancelBlock).toMatch(/(?:^|[;\n])\s*flex:\s*0\s+0\s+auto\s*;/);
  });
});
