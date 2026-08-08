/**
 * Minimal SSE parser for OpenAI-compatible streaming responses. Handles
 * partial chunks across reads and skips comment frames (OpenRouter sends
 * ": OPENROUTER PROCESSING" keep-alives).
 */

/** Yields the `data:` payload of each SSE event, excluding comments. */
export async function* parseSseData(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (line === "" || line.startsWith(":")) continue;
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
    }
  }
  const rest = buffer.replace(/\r$/, "");
  if (rest.startsWith("data:")) yield rest.slice(5).trimStart();
}
