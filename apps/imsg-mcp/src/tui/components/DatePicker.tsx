/**
 * Three-field date picker (YYYY / MM / DD) with arrow-key navigation.
 *
 *   ←/→     cycle active field
 *   ↑/↓     increment/decrement value
 *   0–9     type digit (right-shifts onto the field; full field auto-advances)
 *   Bksp    delete last digit of active field
 *   Enter   submit
 *
 * Returns the picked date as an ISO string ("YYYY-MM-DD") to keep the modal's
 * existing parser path unchanged.
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useTheme } from "../themes/ThemeContext.js";

type Field = "year" | "month" | "day";
const ORDER: Field[] = ["year", "month", "day"];

interface Props {
  initial?: Date;
  focused: boolean;
  onSubmit: (isoDate: string) => void;
  onCancel: () => void;
}

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function daysInMonth(year: number, monthOneBased: number): number {
  return new Date(year, monthOneBased, 0).getDate();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export function DatePicker({ initial, focused, onSubmit, onCancel }: Props) {
  const theme = useTheme();
  const now = initial ?? new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [day, setDay] = useState(now.getDate());
  const [active, setActive] = useState<Field>("year");

  const fieldValue = (f: Field) => (f === "year" ? year : f === "month" ? month : day);

  const setField = (f: Field, v: number) => {
    if (f === "year") {
      const y = clamp(v, MIN_YEAR, MAX_YEAR);
      setYear(y);
      // Re-clamp day to month/year (Feb 29 → Feb 28 on non-leap)
      setDay((d) => clamp(d, 1, daysInMonth(y, month)));
    } else if (f === "month") {
      const m = clamp(v, 1, 12);
      setMonth(m);
      setDay((d) => clamp(d, 1, daysInMonth(year, m)));
    } else {
      setDay(clamp(v, 1, daysInMonth(year, month)));
    }
  };

  useInput(
    (input, key) => {
      if (!focused) return;
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        onSubmit(iso);
        return;
      }
      if (key.leftArrow) {
        const i = ORDER.indexOf(active);
        setActive(ORDER[(i + ORDER.length - 1) % ORDER.length]);
        return;
      }
      if (key.rightArrow) {
        const i = ORDER.indexOf(active);
        setActive(ORDER[(i + 1) % ORDER.length]);
        return;
      }
      if (key.upArrow) {
        setField(active, fieldValue(active) + 1);
        return;
      }
      if (key.downArrow) {
        setField(active, fieldValue(active) - 1);
        return;
      }
      if (input && /^[0-9]$/.test(input)) {
        const digit = Number.parseInt(input, 10);
        if (active === "year") {
          // Shift left and append. Year field is 4 digits.
          const next = (year % 1000) * 10 + digit;
          setField("year", next);
        } else if (active === "month") {
          // 2-digit shift
          const next = (month % 10) * 10 + digit;
          setField("month", next < 1 ? 1 : next);
        } else {
          const next = (day % 10) * 10 + digit;
          setField("day", next < 1 ? 1 : next);
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (active === "year") setField("year", Math.floor(year / 10) || MIN_YEAR);
        else if (active === "month") setField("month", Math.floor(month / 10) || 1);
        else setField("day", Math.floor(day / 10) || 1);
      }
    },
    { isActive: focused },
  );

  const fieldStr = (f: Field, width: number) => String(fieldValue(f)).padStart(width, "0");

  const renderField = (f: Field, width: number) => {
    const isActive = active === f;
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
        <Text color={theme.help.desc}>←/→ field · ↑/↓ adjust · digits to type · Enter to jump</Text>
      </Box>
    </Box>
  );
}
