// @vitest-environment jsdom
//
// Scenario-card rail coverage.
//   - The default create rail renders illustrated scenario cards carrying a
//     title AND a one-line description.
//   - The rail leads with Website clone, then the slide deck ("Slides"), per the
//     curated create order.
//   - The finer-grained scenarios (wireframe / mobile / document) exist and
//     route to a working scenario plugin.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const placeholderCarouselMock = vi.hoisted(() => ({
  reportScenario: false,
  reportedScenarioId: null as string | null,
}));

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: ({
    scenarios,
    active,
    onScenarioChange,
  }: {
    scenarios: Array<{ id: string; chipId?: string | null; text: string }>;
    active: boolean;
    onScenarioChange: (scenario: { id: string; chipId?: string | null; text: string }) => void;
  }) => {
    const scenario = scenarios[0];
    if (
      placeholderCarouselMock.reportScenario &&
      active &&
      scenario &&
      placeholderCarouselMock.reportedScenarioId !== scenario.id
    ) {
      placeholderCarouselMock.reportedScenarioId = scenario.id;
      queueMicrotask(() => onScenarioChange(scenario));
    }
    return null;
  },
}));

import { HomeHero } from '../../src/components/HomeHero';
import { findChip, orderedCreateChips } from '../../src/components/home-hero/chips';

afterEach(() => {
  placeholderCarouselMock.reportScenario = false;
  placeholderCarouselMock.reportedScenarioId = null;
  cleanup();
});

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const props = {
    prompt: '',
    onPromptChange: () => undefined,
    onSubmit: () => undefined,
    activePluginTitle: null,
    activeChipId: null,
    onClearActivePlugin: () => undefined,
    pluginOptions: [],
    pluginsLoading: false,
    pendingPluginId: null,
    pendingChipId: null,
    onPickPlugin: () => undefined,
    onPickChip: () => undefined,
    contextItemCount: 0,
    error: null,
    ...overrides,
  } as React.ComponentProps<typeof HomeHero>;
  render(<HomeHero {...props} />);
}

// #5517 removed the illustrated scenario-card rail from Home; scenarios are
// picked from the composer footer's radial template picker instead.
// Types are a horizontal pill row under the working-directory row (product,
// 2026-08-21); anything that does not fit folds into its 全部 popover.
function typePill(chipId: string): HTMLElement | null {
  return (
    screen.queryByTestId(`home-hero-type-pill-${chipId}`) ??
    screen.queryByTestId(`home-hero-type-pill-${chipId}-more`)
  );
}

describe('HomeHero scenario cards', () => {
  it('labels each create scenario in the composer template picker', () => {
    renderHero();
    expect(typePill('prototype')?.textContent).toContain('Prototype');
    expect(typePill('deck')?.textContent).toContain('Slide deck');
  });

  it('leads the create rail with Prototype, then Slide deck, and trails the media scenarios', () => {
    const ordered = orderedCreateChips();
    const ids = ordered.map((chip) => chip.id);
    expect(ids.slice(0, 2)).toEqual(['prototype', 'deck']);
    // The pure-media outputs sit behind every core build scenario (see
    // CREATE_RAIL_ORDER), and the unlisted catalog tail — Brand Kit, which
    // dispatches into its own tab rather than seeding a scenario — follows
    // even those.
    for (const media of ['image', 'video', 'audio']) {
      expect(ids.indexOf(media)).toBeGreaterThan(ids.indexOf('document'));
    }
    expect(ids.indexOf('create-brand-kit')).toBeGreaterThan(ids.indexOf('audio'));
  });

  it('adds the finer-grained scenarios as templates routed to a scenario plugin', () => {
    renderHero();
    // Document is one of the three row types; Wireframe and Mobile left the
    // row (product, 2026-08-31) but stay in the catalog behind the composer's
    // template picker, still bound to a scenario plugin.
    expect(typePill('document')).toBeTruthy();
    for (const id of ['wireframe', 'mobile', 'document']) {
      expect(findChip(id)?.action.kind).toBe('apply-scenario');
    }
    // Wireframe reuses the web-prototype seed at lo-fi fidelity.
    expect(findChip('wireframe')?.action).toMatchObject({
      pluginId: 'example-web-prototype',
      projectKind: 'prototype',
      projectMetadata: { kind: 'prototype', fidelity: 'wireframe' },
    });
    expect(findChip('document')?.action).toMatchObject({
      pluginId: 'od-new-generation',
      projectKind: 'other',
    });
  });

  it('keeps empty carousel scenario submit disabled while plugins are loading', async () => {
    placeholderCarouselMock.reportScenario = true;
    const onSubmit = vi.fn();
    const onSubmitScenario = vi.fn();
    renderHero({
      pluginsLoading: true,
      onSubmit,
      onSubmitScenario,
    });

    await waitFor(() => expect(placeholderCarouselMock.reportedScenarioId).not.toBeNull());
    const submit = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSubmitScenario).not.toHaveBeenCalled();
  });
});
