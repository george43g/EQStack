import { Box, Text } from "ink";
import { useMemo } from "react";
import type { Conversation } from "../../types.js";
import { matchesConversationFilter } from "../filter.js";
import { findModule } from "../modules/registry.js";
import type { ModuleInstance } from "../modules/types.js";
import { useTheme } from "../themes/ThemeContext.js";
import { ConversationItem } from "./ConversationItem.js";
import { DefaultModuleSidebarItem } from "./DefaultModuleSidebarItem.js";

interface Props {
  conversations: Conversation[];
  moduleInstances: ModuleInstance[];
  selectedIdx: number;
  /** Index into `moduleInstances` when a virtual row is selected; null otherwise. */
  selectedModuleIdx: number | null;
  /** Cursor into the FILTERED result set — drives the highlight while filtering. */
  filterCursor: number;
  scrollOffset: number;
  filterQuery: string;
  focused: boolean;
  width: number;
  height: number;
  /** True while the initial conversation load is still in flight. Without it
   *  the boot frame claims "No conversations" — a confident lie on an account
   *  with thousands of them (see App's deferred initial load). */
  loading?: boolean;
}

export function Sidebar({
  conversations,
  moduleInstances,
  selectedIdx,
  selectedModuleIdx,
  filterCursor,
  scrollOffset,
  filterQuery,
  focused,
  width,
  height,
  loading,
}: Props) {
  const theme = useTheme();
  const filtered = useMemo(() => {
    if (!filterQuery) return conversations;
    const q = filterQuery.toLowerCase();
    return conversations.filter((c) => matchesConversationFilter(c, q));
  }, [conversations, filterQuery]);

  // Each row takes ~4 rows (3 content + 1 separator). Module rows match this
  // rhythm so the cursor math in App.tsx doesn't need a per-row height table.
  const itemHeight = 4;
  const headerH = 1 + (filterQuery ? 1 : 0);
  const borderH = 2;
  const visibleCount = Math.floor((height - headerH - borderH) / itemHeight);

  // Combined visible list: [...moduleInstances, ...conversations].
  // The scrollOffset is an index into the combined list.
  const combined: Array<
    { kind: "module"; instance: ModuleInstance } | { kind: "conv"; conv: Conversation }
  > = [
    ...moduleInstances.map((instance) => ({ kind: "module" as const, instance })),
    ...filtered.map((conv) => ({ kind: "conv" as const, conv })),
  ];
  const visible = combined.slice(scrollOffset, scrollOffset + visibleCount);
  const moduleCount = moduleInstances.length;

  // The displayed cursor index in the combined list. While filtering, the
  // conversation cursor is a position into `filtered` (filterCursor) — not the
  // full-array selectedIdx — because `combined` is built from `filtered`.
  const convCursor = filterQuery ? filterCursor : selectedIdx;
  const combinedCursor = selectedModuleIdx != null ? selectedModuleIdx : moduleCount + convCursor;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor={focused ? theme.header.focused.fg : theme.border}
      overflow="hidden"
    >
      <Box paddingX={1} backgroundColor={focused ? theme.header.focused.bg : theme.header.dim.bg}>
        <Text color={focused ? theme.header.focused.fg : theme.header.dim.fg} bold={focused}>
          Conversations ({filtered.length}
          {moduleCount > 0 ? ` + ${moduleCount} tool${moduleCount === 1 ? "" : "s"}` : ""})
        </Text>
      </Box>

      {filterQuery && (
        <Box paddingX={1}>
          <Text color={theme.status.accent}>/ </Text>
          <Text color={theme.compose.fg}>{filterQuery}</Text>
        </Box>
      )}

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.length === 0 ? (
          <Box paddingX={1}>
            <Text color={theme.sidebar.snippet}>
              {loading && conversations.length === 0
                ? "Loading conversations…"
                : "No conversations"}
            </Text>
          </Box>
        ) : (
          visible.map((row, i) => {
            const realIdx = scrollOffset + i;
            const selected = realIdx === combinedCursor;
            const relNum = selected ? `${realIdx}` : `${Math.abs(realIdx - combinedCursor)}`;
            const isLast = i === visible.length - 1;

            if (row.kind === "module") {
              const mod = findModule(row.instance.moduleId);
              const ItemComponent = mod?.SidebarItem ?? DefaultModuleSidebarItem;
              return (
                <ItemComponent
                  key={row.instance.id}
                  instance={row.instance}
                  selected={selected}
                  focused={!!focused}
                  width={width - 2}
                  lineNum={relNum}
                  isLast={isLast}
                />
              );
            }

            return (
              <ConversationItem
                key={row.conv.threadSlug}
                conversation={row.conv}
                selected={selected}
                width={width - 2}
                lineNum={relNum}
                focused={focused}
                isLast={isLast}
              />
            );
          })
        )}
      </Box>
    </Box>
  );
}
