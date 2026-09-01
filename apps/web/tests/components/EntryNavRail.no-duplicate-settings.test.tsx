// @vitest-environment jsdom
//
// Settings-entry invariant: exactly one settings entry per identity state, and
// it is the rail item directly under 插件 (Plugins) in BOTH states.
//
// History: 飞书 recvq4hGF7BJkI ("Personal 用户，左侧栏有 2 个设置入口") removed
// the rail's own signed-out settings item because EntryShell's footer carried
// an `entry-settings-chip` for the same falsy-context condition. #5517 then
// dropped that footer chip (the footer only hosts the updater popup now) — and
// a signed-out rail has no account menu either, so the rail item came back as
// the only signed-out settings entry. Signed-in then had NO visible entry at
// all: settings hid inside the account hover menu, two interactions deep.
// Product (设置的按钮在插件下边) put the same rail item on the signed-in branch
// too and dropped the account-menu row, so the count stays exactly one.
// (Upstream #5971 restored the same entry as `entry-nav-settings`; this repo
// keeps the `entry-settings-button` testId the e2e suite contracts on.)

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

const signedInContext = {
  workspaceId: 'ws-personal',
  workspaceType: 'personal',
  workspaceMemberId: 'wm-1',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
  permissions: { canInviteMembers: false, canViewWorkspaceSettings: false },
} as unknown as WorkspaceCollabContext;

function renderRail(context: WorkspaceCollabContext | null, onOpenSettings = vi.fn()) {
  render(
    <I18nProvider initial="en">
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        context={context}
        onOpenSettings={onOpenSettings}
      />
    </I18nProvider>,
  );
  return onOpenSettings;
}

afterEach(() => {
  cleanup();
});

/** The rail item that follows 插件 in the destination column, by testId. */
function testIdAfterPlugins(): string | null {
  const group = document.querySelector('.entry-nav-rail__group');
  if (!group) return null;
  const items = Array.from(group.querySelectorAll('.entry-nav-rail__btn'));
  const pluginsIndex = items.findIndex(
    (el) => el.getAttribute('data-testid') === 'entry-nav-plugins',
  );
  if (pluginsIndex < 0) return null;
  return items[pluginsIndex + 1]?.getAttribute('data-testid') ?? null;
}

describe('EntryNavRail settings entry', () => {
  it('renders the settings item below 插件 when there is no cloud identity', () => {
    const onOpenSettings = renderRail(null);

    const settings = screen.getByTestId('entry-settings-button');
    expect(settings).toBeTruthy();
    expect(testIdAfterPlugins()).toBe('entry-settings-button');
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('renders the same item, in the same slot under 插件, when signed in', () => {
    const onOpenSettings = renderRail(signedInContext);

    // Exactly one — the account hover menu no longer carries a 设置 row, so a
    // second entry here would be the same dialog twice in one column.
    expect(screen.getAllByTestId('entry-settings-button')).toHaveLength(1);
    expect(testIdAfterPlugins()).toBe('entry-settings-button');
    fireEvent.click(screen.getByTestId('entry-settings-button'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
