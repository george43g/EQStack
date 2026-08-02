/**
 * Send-via modal — pick an installed external chat app and launch its URL
 * scheme deep-link for the current thread's handle. Triggered by `S` in
 * thread pane (TUI handler in App.tsx).
 *
 * Renders a numbered list of installed apps. Press `1`–`9` to launch,
 * Esc to cancel. The TUI's mode-level `useInput` handler in App.tsx
 * actually does the launching; this component is presentation-only.
 */
import { Box, Text } from "ink";
import type { ChatAppDef } from "../../url-schemes.js";
import { useTheme } from "../themes/ThemeContext.js";

interface Props {
  handle: string;
  apps: ChatAppDef[];
}

export function SendViaModal({ handle, apps }: Props) {
  const theme = useTheme();
  // The modal renders as a sibling of the main body Box. Because the body
  // takes `flexGrow={1}` of the parent column, the modal gets only the
  // leftover vertical space — which can be less than its natural content
  // height. Without explicit anti-shrink the modal collapses rows together
  // (ate the FaceTime row, ate the 'H' of "Handle", merged "WhatsApp" into
  // "SMS", etc).
  // Two-pronged defense:
  //   1. `flexShrink={0}` on the outer modal so the modal owns its full
  //      natural height — it pushes the body content up instead of being
  //      compressed itself.
  //   2. `flexShrink={0}` on every row Box so individual rows can't get
  //      collapsed even if their parent is space-constrained.
  // Plus an opaque backgroundColor so any overlap with body content paints
  // over instead of leaking through transparent regions.
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.status.accent}
      backgroundColor={theme.header.dim.bg}
      paddingX={1}
      flexShrink={0}
    >
      <Box flexShrink={0}>
        <Text color={theme.status.accent} bold>
          Send via external app
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={theme.help.desc}>Handle: {handle}</Text>
      </Box>
      {apps.length === 0 ? (
        <Box flexShrink={0}>
          <Text color={theme.help.desc}>No compatible apps installed.</Text>
        </Box>
      ) : (
        apps.map((a, i) => (
          <Box key={a.name} flexShrink={0}>
            <Text color={theme.help.key}>{i + 1}</Text>
            <Text color={theme.help.desc}>
              {": "}
              {a.name}
              {a.supportsBody ? "" : " (no body support)"}
            </Text>
          </Box>
        ))
      )}
      <Box flexShrink={0}>
        <Text color={theme.help.desc}>1-9: launch · Esc: cancel</Text>
      </Box>
    </Box>
  );
}
