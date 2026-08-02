/**
 * ComposeRecipientModal — two-stage compose for sending to a new thread.
 *
 * Triggered by `N` (or `c` from sidebar when no thread is selected).
 *
 * Stage 1: recipient entry
 *   - Live-validated as the user types. Resolution surfaces:
 *     - "phone" / "email" badge for direct handles
 *     - "contact" badge for resolved contact-name lookups
 *     - Candidate list when the typed string matches multiple contacts
 *     - Error message when nothing matches
 *   - Tab or Enter commits to stage 2 (only when a single resolution is
 *     locked in).
 *
 * Stage 2: message body
 *   - Standard text input. Enter sends, Esc cancels back to stage 1.
 *
 * The modal is opaque (backgroundColor) and uses flexShrink={0} on every
 * row — same defensive layout used by the SendViaModal fix from the live
 * audit pass.
 */
import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { RecipientResolution, ResolvedRecipient } from "../../recipient.js";
import { useTheme } from "../themes/ThemeContext.js";

type Stage = "recipient" | "body";

interface Props {
  /** Live resolver — called on every keystroke against the trimmed input. */
  resolve: (input: string) => RecipientResolution;
  /** Final send. Returns {success, error?}. */
  onSend: (handle: string, text: string) => Promise<{ success: boolean; error?: string }>;
  /** Close without sending. */
  onCancel: () => void;
}

export function ComposeRecipientModal({ resolve, onSend, onCancel }: Props) {
  const theme = useTheme();
  const [stage, setStage] = useState<Stage>("recipient");
  const [recipientInput, setRecipientInput] = useState("");
  const [lockedRecipient, setLockedRecipient] = useState<ResolvedRecipient | null>(null);
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string>("");

  const resolution = useMemo<RecipientResolution>(
    () => (recipientInput.trim() ? resolve(recipientInput) : { kind: "error", message: "" }),
    [recipientInput, resolve],
  );

  // Esc cancels at any stage. We listen at modal level so it fires
  // regardless of which inner input has focus.
  // Digit 1-9 picks an ambiguous-candidate when one is shown — same
  // pattern as the existing `contact:N` selector. Caps at the first 9
  // candidates (matches the visual cap below).
  useInput((input, key) => {
    if (key.escape) {
      if (stage === "body") {
        // Back out to recipient stage rather than full-cancel.
        setStage("recipient");
        setStatus("");
        return;
      }
      onCancel();
      return;
    }
    if (stage === "recipient" && resolution.kind === "ambiguous" && /^[1-9]$/.test(input)) {
      const idx = Number.parseInt(input, 10) - 1;
      const pick = resolution.candidates[idx];
      if (pick) {
        setLockedRecipient(pick);
        setStage("body");
        setStatus("");
      }
    }
  });

  const commitRecipient = () => {
    switch (resolution.kind) {
      case "phone":
      case "email":
      case "contact":
        setLockedRecipient(resolution);
        setStage("body");
        setStatus("");
        return;
      case "ambiguous":
        // Numbered picker shows in render; nudge user toward it.
        setStatus(`Ambiguous — ${resolution.candidates.length} matches. Press 1-9 to pick.`);
        return;
      case "error":
        setStatus(resolution.message);
        return;
    }
  };

  const handleSend = async () => {
    if (!lockedRecipient || !body.trim()) return;
    setStatus("Sending…");
    const result = await onSend(lockedRecipient.handle, body.trim());
    if (result.success) {
      onCancel(); // close modal on success — caller handles UX (status toast)
    } else {
      setStatus(`Send failed: ${result.error ?? "unknown error"}`);
    }
  };

  // Render
  // Show the normalized handle in the badge when it differs from the raw
  // input — gives the user transparency about how their typing was parsed.
  // E.g. typing `0401990797` shows `[phone → +61401990797]`, typing
  // `+61401990797` directly shows just `[phone]` (no transformation).
  const badge = (() => {
    const trimmedInput = recipientInput.trim();
    const showResolved = (handle: string) =>
      handle.toLowerCase() === trimmedInput.toLowerCase() ? "" : ` → ${handle}`;
    if (resolution.kind === "phone") return `[phone${showResolved(resolution.handle)}]`;
    if (resolution.kind === "email") return `[email${showResolved(resolution.handle)}]`;
    if (resolution.kind === "contact") return `[contact → ${resolution.displayName}]`;
    if (resolution.kind === "ambiguous") return `[${resolution.candidates.length} matches]`;
    return "";
  })();

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
          {stage === "recipient" ? "New message — recipient" : "New message — body"}
        </Text>
      </Box>

      {stage === "recipient" && (
        <>
          <Box flexShrink={0}>
            <Text color={theme.help.desc}>To: </Text>
            <TextInput
              defaultValue=""
              placeholder="phone, email, or contact name"
              onChange={(v) => setRecipientInput(v)}
              onSubmit={commitRecipient}
            />
            {badge && <Text color={theme.info.label}>{` ${badge}`}</Text>}
          </Box>
          {resolution.kind === "ambiguous" && (
            <Box flexDirection="column" flexShrink={0}>
              {resolution.candidates.slice(0, 9).map((c, i) => (
                <Box key={c.handle} flexShrink={0}>
                  <Text color={theme.help.key} bold>{`  ${i + 1}`}</Text>
                  <Text color={theme.help.desc}>{`: ${c.displayName}`}</Text>
                </Box>
              ))}
              {resolution.candidates.length > 9 && (
                <Box flexShrink={0}>
                  <Text
                    color={theme.help.desc}
                  >{`  …and ${resolution.candidates.length - 9} more (refine search)`}</Text>
                </Box>
              )}
              <Box flexShrink={0}>
                <Text color={theme.help.desc}>Press 1-9 to pick a match</Text>
              </Box>
            </Box>
          )}
          {resolution.kind === "error" && resolution.message && (
            <Box flexShrink={0}>
              <Text color={theme.edited}>{resolution.message}</Text>
            </Box>
          )}
          <Box flexShrink={0}>
            <Text color={theme.help.desc}>Enter: continue · Esc: cancel</Text>
          </Box>
        </>
      )}

      {stage === "body" && lockedRecipient && (
        <>
          <Box flexShrink={0}>
            <Text color={theme.help.desc}>{`To: ${lockedRecipient.displayName}`}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={theme.help.desc}>{"> "}</Text>
            <TextInput
              defaultValue=""
              placeholder="Type your message…"
              onChange={(v) => setBody(v)}
              onSubmit={handleSend}
            />
          </Box>
          <Box flexShrink={0}>
            <Text color={theme.help.desc}>Enter: send · Esc: back to recipient</Text>
          </Box>
        </>
      )}

      {status && (
        <Box flexShrink={0}>
          <Text color={theme.edited}>{status}</Text>
        </Box>
      )}
    </Box>
  );
}
