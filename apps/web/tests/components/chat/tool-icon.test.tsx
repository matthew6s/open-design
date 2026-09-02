// @vitest-environment jsdom
/**
 * 行首那一格**永远是图标,不许出现圆点**(用户 2026-08-25 裁决,推翻交付稿的兜底)。
 *
 * 交付稿的兜底是 `.ti:empty::before` 画一颗 5px 的点(33 个行首格里 22 个是点)。
 * 产品要求每一格都能指到一个图标 —— 于是两件事一起做:
 *   ① 认得出来的工具归到对的那一类(PowerShell 是执行,不是「未知」);
 *   ② 认不出来的给一个**中性兜底图标**,而不是硬塞进某一类谎报它干了什么。
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { toolIcon } from '../../../src/components/chat/primitives/icons';
import { toolKind } from '../../../src/runtime/chat/tool-kind';
import type { ToolKind } from '../../../src/runtime/chat/tool-kind';

const ALL: ToolKind[] = ['read', 'write', 'edit', 'delete', 'search', 'exec', 'image', 'other'];

describe('行首图标', () => {
  it('每一类都有图标 —— 包括「认不出来」那一类', () => {
    for (const kind of ALL) {
      const icon = toolIcon(kind);
      expect(icon, `${kind} 没有图标,会退化成圆点`).not.toBeNull();
      const { container } = render(<span>{icon}</span>);
      expect(container.querySelector('svg'), `${kind} 的图标不是 svg`).not.toBeNull();
    }
  });

  it('删除使用垃圾桶语义图标,不再复用铅笔', () => {
    const { container: deleteContainer } = render(<span>{toolIcon('delete')}</span>);
    // 铅笔现在只归「改写」—— 稿子 729fa43ce7 把「新建」换成了实心节点字形(W72)
    const { container: editContainer } = render(<span>{toolIcon('edit')}</span>);
    expect(deleteContainer.innerHTML).not.toBe(editContainer.innerHTML);
    expect(deleteContainer.querySelectorAll('path')).toHaveLength(4);
  });

  it('新建和改写是两枚不同的图标 —— 不再共用一支铅笔(W72)', () => {
    const { container: create } = render(<span>{toolIcon('write')}</span>);
    const { container: edit } = render(<span>{toolIcon('edit')}</span>);
    expect(create.innerHTML, '新建和改写还共用同一枚图标').not.toBe(edit.innerHTML);
  });

  it('PowerShell 认成「跑命令的工具」,再按命令内容分类(D7)', () => {
    // 名单里漏了 PowerShell 时,这两条都会掉进 other、行首只剩一颗点
    expect(toolKind('PowerShell', { command: 'npm run build' })).toBe('exec');
    // 嗅的是命令不是工具名:同一个 PowerShell 跑 `ls` 就该是「搜索」
    expect(toolKind('pwsh', { command: 'ls' })).toBe('search');
    expect(toolKind('PowerShell', { command: 'cat 规格.md' })).toBe('read');
  });

  it('会去查东西的工具归到搜索(元工具除外 —— 那是 T4,产品没拍)', () => {
    expect(toolKind('WebSearch', { query: 'x' })).toBe('search');
    expect(toolKind('ToolSearch', { query: 'select:TaskCreate' })).toBe('other');
  });

  it('会去取内容的工具归到读取', () => {
    expect(toolKind('WebFetch', { url: 'https://example.com' })).toBe('read');
  });

  it('真认不出来的仍然是 other —— 不硬凑类别,只给兜底图标', () => {
    expect(toolKind('Agent', { description: 'Read skill assets' })).toBe('other');
    expect(toolIcon(toolKind('Agent', {}))).not.toBeNull();
  });
});
