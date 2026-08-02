import { closeSync, openSync, readSync } from "node:fs";

/**
 * Check if a file is a Git LFS pointer by reading only the first 80 bytes.
 * Returns true (skip the file) when the file is missing, unreadable, or an LFS pointer.
 */
export function isGitLfsPointer(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return true;
  }
  try {
    const buf = Buffer.alloc(80);
    readSync(fd, buf, 0, 80, 0);
    return buf.toString("utf-8").startsWith("version https://git-lfs.github.com/spec/v1");
  } catch {
    return true;
  } finally {
    closeSync(fd);
  }
}
