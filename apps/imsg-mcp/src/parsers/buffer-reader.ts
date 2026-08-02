/**
 * Buffer reader with cursor tracking for binary format parsing.
 * Forked from imessage-parser's BufferReader to remove the upstream dependency.
 */
export class BufferReader {
  private buffer: Buffer;
  private offset: number;

  constructor(buffer: Buffer, initialOffset = 0) {
    this.buffer = buffer;
    this.offset = initialOffset;
  }

  get position(): number {
    return this.offset;
  }

  get length(): number {
    return this.buffer.length;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  seek(position: number): void {
    if (position < 0 || position > this.buffer.length) {
      throw new Error(`Invalid seek position: ${position}`);
    }
    this.offset = position;
  }

  skip(bytes: number): void {
    this.offset += bytes;
  }

  readUInt8(): number {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUInt16LE(): number {
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readBytes(length: number): Buffer {
    if (this.offset + length > this.buffer.length) {
      throw new Error("Attempt to read beyond buffer length");
    }
    const bytes = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  readString(length: number, encoding: BufferEncoding = "utf8"): string {
    const bytes = this.readBytes(length);
    return bytes.toString(encoding);
  }

  findPattern(pattern: Buffer | string): number {
    const searchBuffer = typeof pattern === "string" ? Buffer.from(pattern) : pattern;
    const index = this.buffer.indexOf(searchBuffer, this.offset);
    return index >= 0 ? index : -1;
  }

  peekByte(): number | null {
    if (this.offset >= this.buffer.length) return null;
    return this.buffer[this.offset];
  }

  peekBytes(length: number): Buffer | null {
    if (this.offset + length > this.buffer.length) return null;
    return this.buffer.subarray(this.offset, this.offset + length);
  }
}
