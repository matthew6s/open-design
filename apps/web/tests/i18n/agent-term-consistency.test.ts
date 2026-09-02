import { describe, expect, it } from 'vitest';
import { ar } from '../../src/i18n/locales/ar';
import { fa } from '../../src/i18n/locales/fa';
import { tr } from '../../src/i18n/locales/tr';
import { zhCN } from '../../src/i18n/locales/zh-CN';
import { zhTW } from '../../src/i18n/locales/zh-TW';
import type { Dict } from '../../src/i18n/types';

/**
 * Each locale gets exactly one word for the "AI agent" concept.
 *
 * The dictionaries drifted because run-error cards were added in batches over
 * several months and each batch picked its own wording, so a single language
 * ended up naming one product concept two or three different ways
 * (see TRANSLATIONS.md → "agent" in the zh-CN ↔ zh-TW glossary).
 *
 * Two things are deliberately NOT policed here:
 *
 *  - Bare English "Agent". It is a ruled-in house style: developer-facing
 *    surfaces (MCP setup, integrations, `useEverywhere`) keep the English
 *    proper noun while end-user surfaces translate it. Every locale does this
 *    and it is intentional.
 *  - Words that merely look like the agent term but mean something else in
 *    that language — a network proxy, a marketing agency, a generic tool, an
 *    MCP client. Those live in the per-locale allowlists below, keyed by the
 *    dictionary key so a reviewer can check each one against its English
 *    source.
 */

/** Collect the dictionary keys whose value contains `pattern`. */
function keysMatching(dict: Dict, pattern: RegExp): string[] {
  return Object.entries(dict)
    .filter(([, value]) => typeof value === 'string' && pattern.test(value))
    .map(([key]) => key)
    .sort();
}

describe('agent terminology is consistent within each locale', () => {
  it('zh-TW names the agent 智能體 and nothing else', () => {
    // 代理 is also the Chinese word for a network proxy, and 代理商 is a
    // marketing agency. These keys use it in one of those senses.
    const nonAgentProxyOrAgency = [
      'chat.connectionDropped',
      'chat.runError.clientEnvironmentCause.proxy',
      'chat.runError.clientEnvironmentMessage',
      'chat.runError.upstreamUnavailableMessage',
      'settings.baseUrlDefaultHint',
      'settings.cliEnvHint',
      'settings.cliEnvTitle',
      'settings.onboardingRoleAgency',
      'settings.onboardingUseAgency',
    ].sort();

    // Retired spellings of the agent concept.
    expect(keysMatching(zhTW, /智慧體/)).toEqual([]);
    expect(keysMatching(zhTW, /智慧代理/)).toEqual([]);
    expect(keysMatching(zhTW, /代理人/)).toEqual([]);

    // A Traditional Chinese file must never carry the Simplified spelling.
    expect(keysMatching(zhTW, /智能体/)).toEqual([]);

    // Whatever 代理 is left must be a proxy or an agency, never an agent.
    expect(keysMatching(zhTW, /代理/)).toEqual(nonAgentProxyOrAgency);
  });

  it('zh-CN names the agent 智能体 and nothing else', () => {
    const nonAgentProxyOrAgency = [
      'chat.connectionDropped',
      'chat.runError.clientEnvironmentCause.proxy',
      'chat.runError.clientEnvironmentMessage',
      'chat.runError.upstreamUnavailableMessage',
      'settings.baseUrlDefaultHint',
      'settings.cliEnvHint',
      'settings.cliEnvTitle',
      'settings.onboardingRoleAgency',
      'settings.onboardingUseAgency',
    ].sort();

    // A Simplified Chinese file must never carry the Traditional spelling.
    expect(keysMatching(zhCN, /智能體/)).toEqual([]);
    expect(keysMatching(zhCN, /智慧体/)).toEqual([]);
    expect(keysMatching(zhCN, /代理人/)).toEqual([]);

    expect(keysMatching(zhCN, /代理/)).toEqual(nonAgentProxyOrAgency);
  });

  it('ar names the agent وكيل, never عميل', () => {
    // عميل means "client" / "customer". It is correct for an MCP *client* and
    // for agency clients; it is wrong for the coding agent.
    const nonAgentClient = [
      'chat.example2Prompt',
      'settings.mediaProviderComingSoonHint',
      'settings.onboardingUseAgency',
      'useEverywhere.section.cli.intro',
      'useEverywhere.section.mcp.bullet1',
      'useEverywhere.section.mcp.footer',
      'useEverywhere.section.mcp.intro',
      'useEverywhere.section.mcp.snippet1',
    ].sort();

    expect(keysMatching(ar, /عميل|عملاء/)).toEqual(nonAgentClient);
  });

  it('fa names the agent عامل, never the transliteration ایجنت', () => {
    expect(keysMatching(fa, /ایجنت/)).toEqual([]);
  });

  it('tr names the agent ajan, never aracı', () => {
    // Turkish `araç` means "tool" and inflects to aracı / aracını / aracınız,
    // and `aracılığıyla` means "by way of". Those are unrelated to the agent
    // and must survive untouched.
    const nonAgentToolOrVia = [
      'chat.runError.cliMissingMessage',
      'common.exportImageFailed',
      'dsManager.emptyTemplates',
      'fileViewer.exportImageFailed',
      'fileViewer.markTool',
      'settings.agentInstall.pathHint',
      'settings.codeAgentHint',
      'settings.memoryStarterUserDesc',
      'settings.onboardingSourceAiTool',
      'useEverywhere.section.cli.bullet2',
      'useEverywhere.section.mcp.bullet2',
      'useEverywhere.section.mcp.intro',
      'useEverywhere.section.overview.intro',
    ].sort();

    expect(keysMatching(tr, /aracı/i)).toEqual(nonAgentToolOrVia);
  });
});
