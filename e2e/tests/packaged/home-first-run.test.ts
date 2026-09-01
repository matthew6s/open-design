import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  PACKAGED_HOME_FIRST_RUN_PROMPT,
  packagedHomeFirstRunExpression,
} from '@/vitest/packaged-home-first-run';

class FixtureElement {
  __lexicalEditor?: {
    parseEditorState(value: string): unknown;
    setEditorState(value: unknown): void;
  };

  isContentEditable = false;
  textContent = '';

  constructor(private readonly visible = true) {}

  focus(): void {}

  getClientRects(): ArrayLike<unknown> {
    return this.visible ? [{}] : [];
  }
}

type FixtureDocumentOptions = {
  composerAfterQueries?: number;
  composerContentEditable?: boolean;
  composerVisible?: boolean;
  loadingVisible?: boolean;
  onboardingVisible?: boolean;
};

function renderFixture(options: FixtureDocumentOptions = {}) {
  const input = new FixtureElement(options.composerVisible ?? true);
  input.isContentEditable = options.composerContentEditable ?? true;
  input.__lexicalEditor = {
    parseEditorState: (value) => JSON.parse(value),
    setEditorState: (value) => {
      const root = value as {
        root?: { children?: Array<{ children?: Array<{ text?: string }> }> };
      };
      input.textContent = root.root?.children?.[0]?.children?.[0]?.text ?? '';
    },
  };

  const loading = options.loadingVisible ? new FixtureElement() : null;
  const onboarding = options.onboardingVisible ? new FixtureElement() : null;
  let composerQueries = 0;

  return {
    document: {
      addEventListener: () => undefined,
      querySelector: (selector: string) => {
        if (selector === '[data-testid="home-hero-input"]') {
          composerQueries += 1;
          return composerQueries > (options.composerAfterQueries ?? 0) ? input : null;
        }
        if (selector === '.od-loading-shell, .centered-loader') return loading;
        if (selector === '.entry-shell--onboarding, .entry-onboarding-modal') return onboarding;
        return null;
      },
    },
    input,
    composerQueries: () => composerQueries,
  };
}

async function evaluateExpression(
  expression: string,
  fixture: ReturnType<typeof renderFixture>,
  pathname = '/',
): Promise<unknown> {
  const sandbox = {
    document: fixture.document,
    Element: FixtureElement,
    HTMLElement: FixtureElement,
    Headers,
    location: { href: `od://app${pathname}`, pathname },
    performance: {
      getEntriesByType: () => [{}],
      timeOrigin: 1234,
    },
    Request,
    Response,
    fetch: async () => new Response('{}', { status: 200 }),
    setTimeout,
  };
  return await runInNewContext(expression, sandbox);
}

describe('packaged Home first-run readiness', () => {
  it('waits for the visible editable composer before installing first-run instrumentation', async () => {
    const fixture = renderFixture({ composerAfterQueries: 2, loadingVisible: true });

    const value = await evaluateExpression(packagedHomeFirstRunExpression(), fixture);

    expect(fixture.composerQueries()).toBeGreaterThanOrEqual(3);
    expect(fixture.input.textContent).toBe(PACKAGED_HOME_FIRST_RUN_PROMPT);
    expect(value).toMatchObject({
      inputTextBeforeSubmit: PACKAGED_HOME_FIRST_RUN_PROMPT,
      submitClicked: false,
    });
  });

  it('diagnoses a composer that never becomes ready', async () => {
    const fixture = renderFixture({
      composerContentEditable: false,
      composerVisible: false,
      loadingVisible: true,
      onboardingVisible: true,
    });
    const expression = packagedHomeFirstRunExpression({
      readinessPollIntervalMs: 1,
      readinessTimeoutMs: 10,
    });

    await expect(evaluateExpression(expression, fixture, '/onboarding')).rejects.toThrow(
      /pathname.*\/onboarding.*loadingVisible.*true.*onboardingVisible.*true.*composerFound.*true.*composerVisible.*false.*composerContentEditable.*false/,
    );
  });
});
