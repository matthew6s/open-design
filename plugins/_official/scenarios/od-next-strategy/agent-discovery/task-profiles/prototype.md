# Open Design Prototype execution profile v1

Use this profile for a website, landing page, web application, desktop
interface, mobile application, or other interactive product prototype. A
request such as “帮我做一个官网” is Prototype work. Analysis, summaries,
requirements documents, and copy-only requests are not Prototype work unless
the user also asks for an implemented interactive artifact.

Follow the ordinary Agent-turn orchestration supplied with this load. This
profile is strategy-neutral and does not activate OD Next v2.

## Resolve the product shape

Determine the surface and target device, audience, primary job, required
screens, core flow, fidelity, existing baseline, locked content, brand or
visual references, and runnable entry. If unspecified, prefer high fidelity
and infer reversible details from the product context. Ask only when a missing
choice would materially change the artifact or cause substantial rework.

For an existing project, continue its framework, routes, content conventions,
and design language unless the user explicitly asks to replace them.

## Deliverable contract

- Produce editable source with a stable runnable entry. For a simple web
  prototype, prefer a root `index.html`; for an existing application, keep
  its established entry and build workflow.
- Implement the declared core flow end to end. Buttons, navigation, forms,
  menus, and primary controls must perform their stated behavior.
- Keep requested content, routes, and reference assets intact. Do not redesign
  unrelated regions.
- Validate the actual entry at the requested viewport(s), including 375px and
  a wide desktop viewport for responsive web work, when tooling permits.

## Design quality

- Form one clear visual direction from the product, audience, and usage
  context. Typography, color, spacing, radii, imagery, icons, and motion must
  reinforce the same character.
- Make the page goal, main information, and primary action evident at first
  glance. Build hierarchy with type, contrast, whitespace, alignment, and
  position—not decoration or a stack of interchangeable cards.
- Avoid generic generated-UI habits unless the product calls for them: beige
  page washes, purple gradients, excessive glass, neon glow, huge radii,
  decorative card nesting, and controls that expose the design tool rather
  than the product.
- Use semantic controls, visible keyboard focus, accessible names, useful alt
  text, non-color status cues, and reduced-motion support. Body text should
  meet 4.5:1 contrast.
- Design the states required by the flow: default, hover/focus, selected,
  loading, empty, success, failure, and disabled. Every overlay has an
  explicit exit and return path.

## Responsive and content behavior

- Reorganize at roughly 375 / 768 / 1024 / 1440 rather than scaling the whole
  interface. Mobile must not scroll horizontally or disable zoom.
- Touch targets are at least 44×44px with reasonable separation. Fixed bars
  reserve space for the content they cover.
- Authored headings and labels should be edited to fit rather than silently
  clamped. User or data values may truncate in lists only when the full value
  remains reachable in a detail or expansion path. Prices, times, quantities,
  statuses, primary actions, and errors remain fully visible.
- Inputs have persistent labels. Validation explains both the problem and the
  remedy; destructive actions require confirmation.
- Reserve media geometry and async content space to avoid layout shift. Use
  plausible, consistent content and never fabricate brand facts or promises.

## Mobile device resources

When a successful load receipt provides handset shells, its
`materializedRoot` is the only resource root. Use the matching resource:

- iPhone/iOS: `device-frames/iphone.html`
- Android/Material/HarmonyOS: `device-frames/android.html`
- Unspecified phone platform: `device-frames/neutral.html`
- Responsive website, landing page, desktop app, or tablet: no handset shell

Preserve the shell hardware and system chrome and place the product only in
its documented app-content slot. Keep one handset across a navigable flow;
swap screen content inside it. If `layout.css` is present, use it as structural
layout primitives and let product styles own palette, typography, and spacing.

## Completion floor

- The runnable entry opens without a material runtime error.
- The core flow works; key controls are not decorative.
- Content does not overlap or clip at required viewports.
- Responsive, keyboard, focus, contrast, and reduced-motion behavior are
  proportionate to the requested fidelity.
- User-provided content and non-target regions remain preserved.
