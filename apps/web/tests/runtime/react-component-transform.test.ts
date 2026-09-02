// Red spec: the hand-rolled module rewriting corrupts source, and the harness
// cannot run without the public internet.
//
// `prepareReactComponentSource` understands import/export syntax with four
// regular expressions. Observed against the current implementation, not
// hypothesised:
//
//   input   const HINT = "写 export default function 就能预览";
//   output  const HINT = "写 就能预览";
//           (typeof function !== 'undefined' ? function : null)
//
// The string's contents are edited, and the emitted fallback expression is not
// valid JavaScript — `typeof function` is a syntax error, so the whole preview
// dies rather than degrading. `export * from './x'` survives verbatim into a
// classic script, which is also a syntax error. A relative import is deleted in
// silence, so the user gets `Button is not defined` with nothing pointing at the
// cause.
//
// Separately, the generated document loads React, ReactDOM and Babel from
// unpkg.com with no fallback, so this surface cannot work in the packaged client
// offline or behind a firewall. The Preview Lab corpus run already shows this
// failure class: 8 of its 12 white screens were `external-network-required`.

import { describe, expect, it } from 'vitest';
import {
  buildReactComponentSrcdoc,
  prepareReactComponentSource,
} from '../../src/runtime/react-component';

describe('react component source preparation', () => {
  // Control: the ordinary shape works today, so a failure below is a defect in
  // handling the awkward input rather than the transform being broken outright.
  it('compiles a plain default export into something the harness can run', () => {
    const out = prepareReactComponentSource(
      "import React from 'react';\nexport default function App(){ return <div>hi</div>; }",
    );
    expect(out).toContain('App');
    expect(out).toMatch(/require\(['"]react['"]\)/);
    // JSX and TypeScript are gone by the time the sandbox sees this, so the
    // document no longer has to fetch a compiler to finish the job.
    expect(out).not.toMatch(/<[A-Za-z]/);
  });

  it('does not edit code that merely looks like an export', () => {
    const out = prepareReactComponentSource(
      'import React from \'react\';\n'
      + 'const HINT = "写 export default function 就能预览";\n'
      + 'export default function App(){ return null; }',
    );
    expect(out).toContain('"写 export default function 就能预览"');
  });

  it('never emits a reserved word where a component name belongs', () => {
    const out = prepareReactComponentSource(
      'import React from \'react\';\n'
      + 'const HINT = "写 export default function 就能预览";\n'
      + 'export default function App(){ return null; }',
    );
    // `typeof function` is a syntax error; the document fails to parse at all.
    expect(out).not.toMatch(/typeof\s+function\b/);
  });

  it('leaves no module syntax behind for a classic script to choke on', () => {
    const out = prepareReactComponentSource(
      "import React from 'react';\n"
      + "export * from './helpers';\n"
      + 'export default function App(){ return null; }',
    );
    expect(out).not.toMatch(/^\s*export\s/m);
  });

  it('says so when an import cannot be resolved, instead of dropping it', () => {
    const out = prepareReactComponentSource(
      "import React from 'react';\n"
      + "import { Button } from './Button';\n"
      + 'export default function App(){ return <Button />; }',
    );
    // Silently deleting the import turns a missing-module problem into
    // `Button is not defined`, which points at nothing.
    expect(out).toMatch(/Button/);
  });
});

describe('react component preview document', () => {
  it('no longer downloads a compiler', () => {
    const doc = buildReactComponentSrcdoc('export default function App(){ return null; }', {
      title: 'demo',
    });
    // The heaviest of the three external scripts, and the one that made the
    // document unable to render its own source without the network.
    expect(doc).not.toMatch(/babel/i);
  });

  // Remaining half of the offline defect. React and ReactDOM are still fetched
  // from unpkg with no fallback, so the packaged client offline — and any
  // machine that cannot reach unpkg — still cannot render this surface. It now
  // fails readably ("React preview runtime failed to load") rather than as a
  // white screen, because compilation already succeeded in the host.
  //
  // Decided approach, not yet built: generate the UMD builds into `public/`
  // from the installed `react` / `react-dom` at install and build time, and
  // gitignore the output. React is already a dependency of this app, so it is
  // the single source of truth and drift is structurally impossible — no
  // vendored copy in git, and nothing for anyone to remember to re-sync. A CDN
  // swap (R2 or otherwise) was considered and rejected: it relocates the
  // external dependency instead of removing it, and offline still fails.
  //
  // Unverified and deliberately not assumed: whether a classic <script src>
  // from `public/` loads inside the opaque-origin sandbox under the packaged
  // client's `od://` protocol. That needs a real DMG, offline. Do not claim
  // "works offline in the packaged client" until it has been run there.
  it.todo('runs without reaching the public internet at all');
});

describe('a component that does not compile', () => {
  // Moving compilation into the host moved where a syntax error lands. It used
  // to be caught inside the sandbox by the in-page compiler and rendered into
  // the error panel; if it now escapes `buildReactComponentSrcdoc`, it throws
  // inside FileViewer's render path and takes the whole viewer down instead of
  // showing the user which line is wrong.
  it('reports the error in the document instead of throwing at the host', () => {
    const broken = 'export default function App() { return <div>; }';
    let doc = '';
    expect(() => { doc = buildReactComponentSrcdoc(broken, { title: 'broken' }); }).not.toThrow();
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('od-react-error');
  });
});
