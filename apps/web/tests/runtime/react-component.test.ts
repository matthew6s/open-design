// These cases predate the Sucrase change and were rewritten, not deleted. They
// pinned the old mechanism — `const React = window.React`, a
// `window.__OpenDesignComponent` global, `(0, eval)(compiled)`, a
// `@babel/standalone` script tag — all of which is gone. What they were really
// protecting is which authoring shapes a user can write and still get a
// preview, and that is unchanged, so each one is restated against the compiled
// output the harness now receives.

import { describe, expect, it } from 'vitest';

import { buildReactComponentSrcdoc, prepareReactComponentSource } from '../../src/runtime/react-component';

describe('prepareReactComponentSource', () => {
  it('adapts a default function export for iframe rendering', () => {
    const out = prepareReactComponentSource(`
import React from 'react';
export default function Card() {
  return <div>Card</div>;
}
`);
    expect(out).not.toContain('import React');
    expect(out).toContain('function Card()');
    // The harness renders whatever `module.exports.default` holds.
    expect(out).toMatch(/exports\.default/);
  });

  it('adapts a named component export for iframe rendering', () => {
    const out = prepareReactComponentSource('export const Preview = () => <main />;');
    expect(out).toContain('Preview');
    expect(out).toMatch(/exports\.Preview/);
  });

  it('preserves React hook imports as runtime bindings', () => {
    const out = prepareReactComponentSource(`
import { useState, useEffect as useReactEffect } from 'react';
export default function Counter() {
  const [count, setCount] = useState(0);
  useReactEffect(() => setCount(1), []);
  return <button>{count}</button>;
}
`);
    expect(out).not.toContain('import { useState');
    // Renamed named imports keep working; the local alias is what the body uses.
    expect(out).toMatch(/require\(['"]react['"]\)/);
    expect(out).toContain('useEffect');
    expect(out).toContain('function Counter()');
  });

  it('detects default re-exports before removing export specifiers', () => {
    const out = prepareReactComponentSource(`
const Foo = () => <main />;
export { Foo as default };
`);
    expect(out).not.toContain('export { Foo as default }');
    expect(out).toMatch(/exports\.default/);
    expect(out).toContain('Foo');
  });
});

describe('buildReactComponentSrcdoc', () => {
  it('builds a standalone sandbox document that needs no compiler', () => {
    const doc = buildReactComponentSrcdoc('export default function App(){ return <div /> }', {
      title: 'App',
    });
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('react@18/umd/react.development.js');
    expect(doc).toContain('sandboxed iframe');
    // Compiled in the host: the document carries plain JavaScript, so it neither
    // fetches a compiler nor evals a string it built at runtime.
    expect(doc).not.toContain('@babel/standalone');
    expect(doc).not.toContain('(0, eval)');
    expect(doc).not.toMatch(/<[A-Za-z]+ *\/>/);
  });
});
