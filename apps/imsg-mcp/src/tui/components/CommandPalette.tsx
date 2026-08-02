/**
 * CommandPalette — fuzzy-searchable list of every action in the TUI.
 *
 * Empty query → grouped cheat sheet of all commands by category (acts as
 * the canonical keybinding reference). Typing → fuzzy rank via
 * `rankFuzzy` from `src/fuzzy.ts`.
 *
 * Input model: the palette owns its own `useInput` (gated on `mode === "palette"`
 * via App.tsx). Enter runs the highlighted command; arrows / Ctrl-n/Ctrl-p
 * move the cursor; Esc / Ctrl-P close.
 */
import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo } from "react";
import { rankFuzzy } from "../../fuzzy.js";
import type { Command, CommandContext } from "../keymap.js";
import { useTheme } from "../themes/ThemeContext.js";

interface Props {
  commands: Command[];
  query: string;
  cursor: number;
  width: number;
  height: number;
  ctx: CommandContext;
  onQueryChange: (q: string) => void;
  onCursorMove: (delta: number) => void;
  onSelectCursor: (idx: number) => void;
  onClose: () => void;
}

interface RankedRow {
  command: Command;
  score: number;
  /** Only set in empty-query mode — the first row of a new category prints a header. */
  headerCategory?: string;
}

/** Build the rows to render: fuzzy-ranked when there's a query, grouped otherwise. */
function buildRows(commands: Command[], query: string): RankedRow[] {
  const q = query.trim();
  if (q === "") {
    // Empty query — list every command grouped by category.
    const byCat = new Map<string, Command[]>();
    for (const c of commands) {
      if (!byCat.has(c.category)) byCat.set(c.category, []);
      byCat.get(c.category)!.push(c);
    }
    const rows: RankedRow[] = [];
    for (const [cat, cmds] of byCat) {
      let first = true;
      for (const cmd of cmds) {
        rows.push({ command: cmd, score: 1, headerCategory: first ? cat : undefined });
        first = false;
      }
    }
    return rows;
  }
  // Lower minScore (0.3) — palette queries are short and abbreviated.
  const ranked = rankFuzzy(
    q,
    commands,
    (c) => `${c.title} ${c.category} ${c.description ?? ""} ${c.keybinding ?? ""}`,
    0.3,
  );
  return ranked.map((r) => ({ command: r.item, score: r.score }));
}

export function CommandPalette({
  commands,
  query,
  cursor,
  width,
  height,
  ctx,
  onQueryChange,
  onCursorMove,
  onSelectCursor,
  onClose,
}: Props) {
  const theme = useTheme();

  const rows = useMemo(() => buildRows(commands, query), [commands, query]);

  // Clamp the cursor if results shrank below it (e.g. user added a letter
  // that filtered out previously-visible entries).
  useEffect(() => {
    if (rows.length === 0) return;
    if (cursor > rows.length - 1) onSelectCursor(rows.length - 1);
  }, [rows.length, cursor, onSelectCursor]);

  // Visible window — keep the cursor on screen.
  const headerH = 3; // title + query + spacer
  const footerH = 1;
  const bodyH = Math.max(3, height - headerH - footerH - 2);
  const visibleStart = Math.max(0, Math.min(cursor - Math.floor(bodyH / 2), rows.length - bodyH));
  const visibleEnd = Math.min(rows.length, visibleStart + bodyH);
  const visibleRows = rows.slice(visibleStart, visibleEnd);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "p")) {
      onClose();
      return;
    }
    if (key.return) {
      const row = rows[cursor];
      if (row) {
        // Close BEFORE running so commands that themselves change mode (e.g.
        // ENTER_COMPOSE) end up in the right final state, rather than being
        // overridden by a trailing CLOSE_PALETTE.
        onClose();
        void Promise.resolve(row.command.run(ctx)).catch(() => {});
      }
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      onCursorMove(1);
      return;
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      onCursorMove(-1);
      return;
    }
    if (key.pageDown) {
      onCursorMove(bodyH);
      return;
    }
    if (key.pageUp) {
      onCursorMove(-bodyH);
      return;
    }
  });

  const modalWidth = Math.min(Math.max(60, Math.floor(width * 0.7)), 120);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.status.accent}
      backgroundColor={theme.header.dim.bg}
      paddingX={1}
      flexShrink={0}
      width={modalWidth}
    >
      <Box flexShrink={0}>
        <Text color={theme.status.accent} bold>
          Command Palette
        </Text>
        <Text color={theme.help.desc}>
          {"  "}({rows.length} {rows.length === 1 ? "command" : "commands"})
        </Text>
      </Box>

      <Box flexShrink={0}>
        <Text color={theme.info.label}>{"› "}</Text>
        <TextInput defaultValue={query} onChange={onQueryChange} placeholder="Search commands…" />
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {rows.length === 0 ? (
          <Box>
            <Text color={theme.help.desc}>No commands match "{query}".</Text>
          </Box>
        ) : (
          visibleRows.map((row, i) => {
            const realIdx = visibleStart + i;
            const selected = realIdx === cursor;
            return (
              <PaletteRow
                key={`${row.command.id}-${realIdx}`}
                row={row}
                selected={selected}
                width={modalWidth - 4}
              />
            );
          })
        )}
      </Box>

      <Box flexShrink={0}>
        <Text color={theme.help.key}>↑↓</Text>
        <Text color={theme.help.desc}>:move </Text>
        <Text color={theme.help.key}>Enter</Text>
        <Text color={theme.help.desc}>:run </Text>
        <Text color={theme.help.key}>Esc</Text>
        <Text color={theme.help.desc}>:close</Text>
      </Box>
    </Box>
  );
}

function PaletteRow({
  row,
  selected,
  width,
}: {
  row: RankedRow;
  selected: boolean;
  width: number;
}) {
  const theme = useTheme();
  const keybindW = 14;
  const titleW = Math.max(20, width - keybindW - 2);
  const { command, headerCategory } = row;
  const title = command.title;
  const desc = command.description ?? "";

  return (
    <Box flexDirection="column">
      {headerCategory && (
        <Box>
          <Text color={theme.help.desc} dimColor>
            ── {headerCategory} ──
          </Text>
        </Box>
      )}
      <Box backgroundColor={selected ? theme.sidebar.selected : undefined}>
        <Box width={titleW}>
          <Text color={selected ? theme.sidebar.selectedFg : undefined}>
            {selected ? "▸ " : "  "}
          </Text>
          <Text
            color={selected ? theme.sidebar.selectedFg : theme.info.value}
            bold={selected}
            wrap="truncate"
          >
            {title}
          </Text>
          {desc && (
            <Text color={theme.help.desc} wrap="truncate">
              {"  "}
              {desc}
            </Text>
          )}
        </Box>
        <Box width={keybindW} justifyContent="flex-end">
          {command.keybinding ? (
            <Text color={theme.help.key}>{command.keybinding}</Text>
          ) : (
            <Text color={theme.help.desc} dimColor>
              —
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
