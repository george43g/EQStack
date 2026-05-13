import path from "node:path";

/**
 * Resolve `filename` inside `baseDir` and refuse anything that escapes the
 * base. Mirrors the pattern that download_attachment has used since v1; this
 * helper exists so download_email (and any new code path that writes a file
 * derived from external input) can share it.
 *
 * Steps:
 *   1. Reduce filename to its basename so absolute paths and `../` prefixes
 *      are stripped before joining.
 *   2. Resolve both base and full path to absolute form.
 *   3. Verify the full path is within (or equal to) the resolved base.
 *
 * Throws Error("Invalid filename: path traversal detected") on violation.
 */
export function safeJoinWithinBase(baseDir: string, filename: string): string {
  const safeName = path.basename(filename);
  const resolvedBase = path.resolve(baseDir);
  const fullPath = path.resolve(resolvedBase, safeName);
  // path.relative is robust against the `baseDir === "/"` edge case where
  // a naive `startsWith(resolvedBase + path.sep)` would compare against "//".
  const rel = path.relative(resolvedBase, fullPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    if (fullPath !== resolvedBase) {
      throw new Error("Invalid filename: path traversal detected");
    }
  }
  return fullPath;
}
