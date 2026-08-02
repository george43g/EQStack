import { Box, Text } from "ink";
import { formatReplyPreview } from "../../reply-preview.js";
import type { Message } from "../../types.js";
import { TAPBACK_EMOJI } from "../theme.js";
import { useTheme } from "../themes/ThemeContext.js";

interface Props {
  message: Message;
  width: number;
  height: number;
  /** Which attachment j/k has selected (only meaningful when >1). */
  selectedAttachmentIdx?: number;
}

function formatFullDate(date: Date): string {
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/**
 * Drawer-row label. Wrapped in a flexShrink={0} Box so a sibling
 * `<Text wrap="truncate">` value (e.g. GUID) doesn't squeeze the label
 * to zero width — without this, "GUID: 9C768341..." rendered as
 * "GUID9C768341..." because the truncating value won the row's width
 * negotiation and the label's colon+space got eaten.
 */
function Label({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Box flexShrink={0}>
      <Text color={theme.drawer.label}>{children}: </Text>
    </Box>
  );
}

export function MessageDrawer({ message: m, width, height, selectedAttachmentIdx = 0 }: Props) {
  const theme = useTheme();
  const hasAttachments = m.attachments && m.attachments.length > 0;
  const multiAttachment = (m.attachments?.length ?? 0) > 1;

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
          Message Details
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={0} gap={0}>
        {/* Sender */}
        <Box>
          <Label>From</Label>
          <Text color={theme.drawer.value}>{m.isFromMe ? "Me" : (m.displayName ?? m.handle)}</Text>
        </Box>

        {/* Handle */}
        {!m.isFromMe && m.displayName && (
          <Box>
            <Label>Handle</Label>
            <Text color={theme.drawer.value}>{m.handle}</Text>
          </Box>
        )}

        {/* Date */}
        <Box>
          <Label>Sent</Label>
          <Text color={theme.drawer.value}>{formatFullDate(m.date)}</Text>
        </Box>

        {/* Read/Delivered */}
        {m.dateDelivered && (
          <Box>
            <Label>Delivered</Label>
            <Text color={theme.drawer.value}>{formatFullDate(m.dateDelivered)}</Text>
          </Box>
        )}
        {m.dateRead && (
          <Box>
            <Label>Read</Label>
            <Text color={theme.drawer.value}>{formatFullDate(m.dateRead)}</Text>
          </Box>
        )}

        {/* Service */}
        <Box>
          <Label>Service</Label>
          <Text color={m.service === "SMS" ? theme.sms : theme.info.label}>{m.service}</Text>
        </Box>

        {/* Chat ID */}
        <Box>
          <Label>Chat</Label>
          <Text color={theme.drawer.value}>{m.chatId}</Text>
        </Box>

        {/* GUID */}
        <Box>
          <Label>GUID</Label>
          <Text color={theme.drawer.value} wrap="truncate">
            {m.guid}
          </Text>
        </Box>

        {/* Send failure */}
        {m.sendError !== undefined && (
          <Box>
            <Label>Status</Label>
            <Text color={theme.edited} bold>
              NOT DELIVERED — send failed (error {m.sendError})
            </Text>
          </Box>
        )}

        {/* Unsent / retracted — the sender took this message back. */}
        {m.isRetracted && (
          <Box>
            <Label>Status</Label>
            <Text color={theme.edited} bold>
              Unsent (retracted by sender)
            </Text>
          </Box>
        )}

        {/* Edited */}
        {m.isEdited && (
          <Box>
            <Label>Status</Label>
            <Text color={theme.edited}>Edited</Text>
          </Box>
        )}

        {/* Reactions */}
        {m.reactions && m.reactions.length > 0 && (
          <Box flexDirection="column">
            <Text color={theme.drawer.label}>Reactions:</Text>
            {m.reactions
              .filter((r) => !r.isRemoval)
              .map((r) => (
                <Box
                  key={`${r.fromHandle}-${r.type}-${r.emoji ?? ""}-${r.targetMessageGuid}-${r.targetMessagePart}`}
                  paddingLeft={1}
                >
                  <Text color={theme.drawer.value}>
                    {r.emoji ?? TAPBACK_EMOJI[r.type] ?? r.type} {r.fromHandle ?? "unknown"}
                  </Text>
                </Box>
              ))}
          </Box>
        )}

        {/* Attachments */}
        {hasAttachments && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.attachment} bold>
              Attachments ({m.attachments!.length}):
            </Text>
            {m.attachments!.map((att, i) => {
              const isSel = multiAttachment && i === selectedAttachmentIdx;
              return (
                <Box
                  key={`${att.filename}-${att.transferName ?? ""}-${att.mimeType ?? ""}-${att.totalBytes}`}
                  flexDirection="column"
                >
                  <Box>
                    <Box flexShrink={0}>
                      <Text color={isSel ? theme.sent.bg : theme.drawer.label}>
                        {multiAttachment ? (isSel ? "▸" : " ") : " "}
                      </Text>
                    </Box>
                    <Text color={theme.drawer.value} bold={isSel} wrap="truncate">
                      {att.transferName ?? att.filename}
                    </Text>
                  </Box>
                  <Box paddingLeft={1}>
                    <Text color={theme.drawer.label}>
                      {att.mimeType ?? "unknown"} ·{" "}
                      {att.totalBytes > 0 ? formatBytes(att.totalBytes) : "?"}
                    </Text>
                  </Box>
                </Box>
              );
            })}
            <Box marginTop={1} flexDirection="column">
              {multiAttachment && (
                <Text color={theme.help.desc}>
                  <Text color={theme.help.key}>j/k</Text>: select attachment
                </Text>
              )}
              <Text color={theme.help.desc}>
                <Text color={theme.help.key}>o</Text>: open{"  "}
                <Text color={theme.help.key}>s</Text>: save to ~/Downloads{"  "}
                <Text color={theme.help.key}>y</Text>: copy path{"  "}
                <Text color={theme.help.key}>f</Text>: reveal in Finder
              </Text>
            </Box>
          </Box>
        )}

        {/* Full message text */}
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.drawer.label}>Full text:</Text>
          <Box borderStyle="single" borderColor={theme.drawer.border} paddingX={1}>
            <Text color={theme.drawer.value} wrap="wrap">
              {m.text ?? (m.isRetracted ? "(message unsent)" : "(no text)")}
            </Text>
          </Box>
        </Box>

        {/* Reply context */}
        {m.isReply && m.replyTo && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.drawer.label}>Reply to:</Text>
            <Text color={theme.replyContext} italic wrap="wrap">
              {formatReplyPreview(m.replyTo) ?? "(unknown)"}
            </Text>
          </Box>
        )}

        {/* Edit history timeline */}
        {(() => {
          const versions = (m.editHistory?.parts ?? []).flatMap((p) => p.versions);
          const retracted = m.editHistory?.retractedParts ?? [];
          if (versions.length === 0 && retracted.length === 0) return null;
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.drawer.label}>
                Edit history{versions.length ? ` (${versions.length} versions)` : ""}:
              </Text>
              {versions.map((v, i) => (
                <Box key={`ev-${i}-${v.date?.getTime() ?? i}`} flexDirection="column">
                  <Text color={theme.help.desc}>
                    {`${i + 1}. `}
                    {v.date ? formatFullDate(v.date) : "unknown time"}
                  </Text>
                  <Text color={theme.drawer.value} wrap="wrap">
                    {`   ${v.text ?? "(no text)"}`}
                  </Text>
                </Box>
              ))}
              {retracted.length > 0 && (
                <Text color={theme.edited}>{`Retracted part(s): ${retracted.join(", ")}`}</Text>
              )}
            </Box>
          );
        })()}

        {/* Media interpretation — voice-note transcript / image·video caption.
            Shown from the cached/instant result; `R` (re)interprets on demand. */}
        {(() => {
          const interp = m.interpretedMedia;
          const isVoiceNote =
            Boolean(m.appleAudioTranscript) ||
            (m.attachments ?? []).some(
              (a) =>
                (a.mimeType ?? "").startsWith("audio/") ||
                /\.(caf|amr|m4a|mp3|wav|aac)$/i.test(a.filename ?? ""),
            );
          if (!interp && !isVoiceNote) return null;
          const label =
            interp?.kind === "image"
              ? "Caption"
              : interp?.kind === "video"
                ? "Video caption"
                : "Transcript";
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.drawer.label}>
                {label}
                {interp ? ` (${interp.source})` : ""}:
              </Text>
              <Box borderStyle="single" borderColor={theme.drawer.border} paddingX={1}>
                <Text
                  color={interp ? theme.drawer.value : theme.help.desc}
                  italic={!interp}
                  wrap="wrap"
                >
                  {interp?.text ?? "Not interpreted yet."}
                </Text>
              </Box>
              <Text color={theme.help.desc}>
                <Text color={theme.help.key}>R</Text>: {interp ? "re-interpret" : "interpret"}
              </Text>
            </Box>
          );
        })()}
      </Box>

      {/* Footer hint */}
      <Box flexGrow={1} />
      <Box paddingX={1}>
        <Text color={theme.help.desc}>Esc/q to close</Text>
      </Box>
    </Box>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
