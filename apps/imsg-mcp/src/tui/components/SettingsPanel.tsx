/**
 * SettingsPanel (Stage 6) — render-only view of the media-interpretation config.
 *
 * All state + edits live in the reducer + `settings-model` (pure). This just
 * paints the flat row list, printing a section header when the section changes
 * (mirrors CommandPalette's grouped layout) and a ▸ cursor on the selected row.
 *
 * Read-heavy by design: provider rows show key *presence* (a check), never the
 * key value — editing keys stays in the wizard/file.
 */
import { Box, Text } from "ink";
import type { SettingsRow } from "../settings-model.js";
import { useTheme } from "../themes/ThemeContext.js";

interface Props {
  rows: SettingsRow[];
  cursor: number;
  configPath: string;
  warnings: string[];
  width: number;
  height: number;
}

export function SettingsPanel({ rows, cursor, configPath, warnings, width, height }: Props) {
  const theme = useTheme();

  // Windowed list — keep the cursor on screen even with many chain/provider rows.
  const chromeH = 6; // header + footer hints + config path + borders
  const bodyH = Math.max(4, height - chromeH);
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(bodyH / 2), Math.max(0, rows.length - bodyH)),
  );
  const end = Math.min(rows.length, start + bodyH);
  const visible = rows.slice(start, end);

  const labelW = Math.max(24, Math.floor(width * 0.5));

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor={theme.drawer.border}
      overflow="hidden"
    >
      {/* Header */}
      <Box paddingX={1} backgroundColor={theme.header.focused.bg}>
        <Text color={theme.header.focused.fg} bold>
          Settings — Media Interpretation
        </Text>
      </Box>

      {warnings.length > 0 && (
        <Box paddingX={1}>
          <Text color={theme.edited} wrap="truncate">
            ⚠ {warnings[0]}
          </Text>
        </Box>
      )}

      {/* Rows */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {visible.map((row, i) => {
          const realIdx = start + i;
          const selected = realIdx === cursor;
          const prev = realIdx > 0 ? rows[realIdx - 1] : undefined;
          const showHeader = !prev || prev.section !== row.section;
          const key = `${row.section}-${row.kind}-${row.chain ?? ""}-${row.index ?? realIdx}`;
          return (
            <Box key={key} flexDirection="column">
              {showHeader && (
                <Box marginTop={realIdx === 0 ? 0 : 1}>
                  <Text color={theme.help.desc} dimColor>
                    ── {row.section} ──
                  </Text>
                </Box>
              )}
              <Box backgroundColor={selected ? theme.sidebar.selected : undefined}>
                <Box flexShrink={0}>
                  <Text color={selected ? theme.sidebar.selectedFg : theme.drawer.label}>
                    {selected ? "▸ " : row.selectable ? "  " : "· "}
                  </Text>
                </Box>
                <Box width={labelW}>
                  <Text
                    color={
                      selected
                        ? theme.sidebar.selectedFg
                        : row.selectable
                          ? theme.drawer.value
                          : theme.help.desc
                    }
                    bold={selected}
                    wrap="truncate"
                  >
                    {row.label}
                  </Text>
                </Box>
                <Box flexGrow={1} justifyContent="flex-end">
                  <Text
                    color={selected ? theme.sidebar.selectedFg : theme.info.value}
                    bold={selected}
                    wrap="truncate"
                  >
                    {row.value}
                  </Text>
                </Box>
              </Box>
              {selected && row.hint && (
                <Box paddingLeft={2}>
                  <Text color={theme.help.desc}>{row.hint}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Key hints */}
      <Box paddingX={1}>
        <Text color={theme.help.desc}>
          <Text color={theme.help.key}>j/k</Text> move{"  "}
          <Text color={theme.help.key}>␣</Text> toggle{"  "}
          <Text color={theme.help.key}>←/→</Text> adjust{"  "}
          <Text color={theme.help.key}>K/J</Text> reorder{"  "}
          <Text color={theme.help.key}>q</Text> close
        </Text>
      </Box>
      {/* Config source path — where edits persist. */}
      <Box paddingX={1}>
        <Text color={theme.help.desc} wrap="truncate">
          Saved to {configPath || "(default config path)"}
        </Text>
      </Box>
    </Box>
  );
}
