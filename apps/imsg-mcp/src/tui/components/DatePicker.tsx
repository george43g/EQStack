/**
 * Three-field date picker (YYYY / MM / DD).
 *
 *   ←/→  or h/l   cycle active field
 *   ↑/↓  or k/j   increment/decrement value
 *   0–9           type digit (first digit replaces the field, then appends;
 *                 a full field auto-advances — see date-picker-model.ts)
 *   Bksp          delete last digit of active field
 *   Enter         submit
 *   other letters fire `onTextIntent` so the parent can flip to free-text
 *                 mode seeded with what was typed ("y…" → "yesterday")
 *
 * All state transitions live in date-picker-model.ts (pure, unit-tested).
 * Returns the picked date as an ISO string ("YYYY-MM-DD") to keep the
 * modal's existing parser path unchanged.
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import {
  adjust,
  applyDigits,
  backspaceField,
  type Field,
  initPickerState,
  moveField,
  toIso,
} from "../date-picker-model.js";
import { useTheme } from "../themes/ThemeContext.js";

interface Props {
  initial?: Date;
  focused: boolean;
  onSubmit: (isoDate: string) => void;
  onCancel: () => void;
  /**
   * Fired when the user types something the picker doesn't own (letters,
   * punctuation, or a pasted chunk containing non-digits). The parent modal
   * switches to free-text mode seeded with this string — so typing
   * "yesterday" from the default picker mode Just Works instead of being
   * silently ignored (the original "free-text silently refused" bug).
   * h/j/k/l are picker navigation and never reach this.
   */
  onTextIntent?: (seed: string) => void;
}

export function DatePicker({ initial, focused, onSubmit, onCancel, onTextIntent }: Props) {
  const theme = useTheme();
  const [state, setState] = useState(() => initPickerState(initial ?? new Date()));

  useInput(
    (input, key) => {
      if (!focused) return;
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        onSubmit(toIso(state));
        return;
      }
      if (key.leftArrow || input === "h") {
        setState((s) => moveField(s, -1));
        return;
      }
      if (key.rightArrow || input === "l") {
        setState((s) => moveField(s, 1));
        return;
      }
      if (key.upArrow || input === "k") {
        setState((s) => adjust(s, 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setState((s) => adjust(s, -1));
        return;
      }
      if (key.backspace || key.delete) {
        setState((s) => backspaceField(s));
        return;
      }
      // Chunked-keystroke law: a fast burst or paste arrives as ONE input
      // string. Pure-digit chunks are keys we own — fan them into the model.
      if (input && /^[0-9]+$/.test(input)) {
        setState((s) => applyDigits(s, input));
        return;
      }
      // Anything else printable = the user is trying to type a date phrase.
      if (input && !key.ctrl && !key.meta && !key.tab) {
        onTextIntent?.(input);
      }
    },
    { isActive: focused },
  );

  const fieldStr = (f: Field, width: number) => {
    const v = f === "year" ? state.year : f === "month" ? state.month : state.day;
    return String(v).padStart(width, "0");
  };

  const renderField = (f: Field, width: number) => {
    const isActive = state.active === f;
    return (
      <Text
        color={isActive ? theme.status.accent : theme.drawer.value}
        bold={isActive}
        inverse={isActive}
      >
        {fieldStr(f, width)}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      <Box>
        {renderField("year", 4)}
        <Text color={theme.help.desc}>-</Text>
        {renderField("month", 2)}
        <Text color={theme.help.desc}>-</Text>
        {renderField("day", 2)}
      </Box>
      <Box>
        <Text color={theme.help.desc}>
          ←→/h/l field · ↑↓/k/j adjust · digits type · letters → free-text · Enter to jump
        </Text>
      </Box>
    </Box>
  );
}
