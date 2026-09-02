---
name: discovery-question-form
description: Structured clarification form for unresolved material requirements.
od:
  scenario: general
  mode: discovery
---

# Discovery question form

This atom defines the `<question-form>` protocol. It does not decide whether
clarification is required. Follow the active skill and core prompt's
requirements-clarification policy. When they identify unresolved information
that would materially change the design direction, content structure, or
delivery format, surface the smallest possible set of questions that unblocks
the workflow.

The questions are rendered as a `<question-form>` artifact inline in the
originating assistant message. This is assistant text parsed by the host, not a
plugin GenUI surface or a native tool call. Submitted answers return as the
next user message, beginning with `[form answers — <form-id>]`.

## Activation boundary

- A first turn or new project does not by itself require a form.
- A `discovery` pipeline stage only makes this protocol available; declaring
  or entering the stage does not trigger a form.
- Missing metadata is not automatically a question. First use the request,
  conversation, plugin inputs, memory, active skill, and design system.
- If enough information is available to proceed safely, do not emit a form.
- If a material blocker remains, ask only for that unresolved information.

## Emission shape

Emit the form as a `question-form` block whose body is a JSON object with a
top-level `questions` array. Do not emit a bare question object by itself; the
renderer only recognizes the wrapped form contract.

```html
<question-form id="discovery" title="Quick brief — 30 seconds">
{
  "description": "I'll lock these in before building. Skip what doesn't apply — I'll fill defaults.",
  "questions": [
    {
      "id": "audience",
      "label": "Who's the primary audience?",
      "type": "checkbox",
      "options": ["VC", "Customer", "Internal team"],
      "maxSelections": 2,
      "required": true
    }
  ]
}
</question-form>
```

## Question object shape

Each entry in the top-level `questions` array uses:

- `id`: stable answer key, for example `audience`.
- `label`: user-facing question copy.
- `type`: one of `radio`, `checkbox`, `select`, `text`, `textarea`,
  `number`, `range`, `date`, `time`, `datetime-local`, `color`, `url`,
  `email`, `tel`, `file`, `switch`, or `direction-cards`.
- `options`: required for choice controls except `direction-cards`; strings are
  allowed, or objects with localized `label` and stable `value`.
- Keep a single question to at most 6-7 options. Users cannot weigh more than that at a glance; if you have more, merge the near-duplicates or drop the ones least likely to change what gets built.
- Choose between `radio` and `select` by how many options a single-choice question has, not by how important they are: `radio` for a short list the user reads straight through, `select` once the list runs long (languages, timezones, countries, voices). A `checkbox` question always stays a plain list.
- On a `select` you may give each option an optional `group` (the first group renders expanded; the rest collapse behind a host-labelled "More options" toggle) and an optional `trailingLabel` (a short code shown at the end of the row, such as `ZH-CN`). Both are optional - omit them and the question renders as a plain list.
- Write option labels in the words the user would use, not industry jargon: "Magazine-style layout" rather than "Editorial", "Plain and functional" rather than "Brutalist". Where an option's `value` is a stable identifier the host matches on, reword only the `label` and never the `value`.
- Keep each option `label` to roughly 40 characters (about six words) so it fits one row without wrapping. Put any longer explanation in that option's `description` field instead of padding the label.
- `direction-cards`: a Host-owned visual-style catalog trigger. Emit only the
  question's `id`, localized `label`, `type`, and `required` when appropriate;
  omit `options`, `cards`, `variant`, and `defaultValue`.
- `allowCustom`: leave unset or set to `true` for finite-choice controls so
  users can type their own answer instead of accepting only generated options.
  Set `allowCustom: false` only when the downstream system needs an exact
  machine id.
- `customLabel` / `customPlaceholder`: optional localized copy for that custom
  answer input.
- `maxSelections`: include this for checkbox controls with a limited selection
  count.
- `required`: set to `true` only when the answer is needed before work can
  continue.

## Convergence

The discovery atom completes when the next user message contains an answer
for every required question. Treat those submitted answers as conversation
context and do not ask the same questions again unless later input invalidates
an answer.
