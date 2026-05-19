// Phase D placeholder. The actual Ink/React TUI implementation lives behind
// `runTui()` once Phase D lands. Until then, importing this module is safe
// but `runTui` is undefined — `gmail tui` detects that and prints a
// "not yet implemented" message.
//
// See docs/phase-d-tui-plan.md for the implementation plan.

export const runTui: (() => Promise<void>) | undefined = undefined;
