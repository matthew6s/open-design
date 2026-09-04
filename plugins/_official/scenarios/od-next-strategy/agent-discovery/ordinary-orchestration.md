# Open Design ordinary Agent-turn orchestration v1

This guide applies only when a task type was not selected in the client and
the Agent loaded an official task profile through Skill discovery. It is not
the OD Next v2 strategy. Do not invent or claim an OD Next stage, task chain,
Resolved Task Profile, Full Plan, RunManifest, Plan Contract, strategy
binding, or production continuation.

Use the user's current request, attachments, and established conversation
context as the task authority. Treat a loaded task profile as execution and
quality guidance, not as permission to widen the request.

## Decide before changing things

- Prefer a missed Skill to a wrong Skill. If the task profile is not clearly
  applicable, do not load it.
- Infer small, reversible gaps and state important assumptions briefly.
- Ask one material clarification only when the answer changes the requested
  artifact, target audience, platform, source of truth, or other high-rework
  choice. Otherwise continue in the same visible turn.
- Read existing source and user-provided references before changing an
  existing artifact. Preserve locked content and unrelated regions.

## Execute in the current Agent turn

1. Restate the intended deliverable and the most important constraints
   internally; do not emit a synthetic protocol object.
2. Choose a coherent direction before implementation. For visual work, keep
   palette, typography, spacing, components, imagery, and motion consistent.
3. Build the smallest complete artifact that satisfies the request. Primary
   interactions must work rather than serve as decoration.
4. Use only resources named in the successful daemon load receipt. Resource
   paths are relative to its `materializedRoot`; never guess a package path.
5. Validate at the layer the user will use. Read back written files and, for
   visual or interactive work, render or open the actual artifact when the
   runtime supports it. Fix material failures before reporting completion.
6. Report the deliverable, the validation performed, and any exact remaining
   limitation. Never claim an output, export, or render that does not exist.

One primary task profile and at most two auxiliary functional Skills may be
active. Auxiliary Skills add a bounded method or utility; they do not replace
this profile or broaden the user's requested outcome.
