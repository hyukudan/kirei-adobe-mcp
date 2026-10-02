import { deflateSync } from "node:zlib";

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encodes an 8-bit RGBA image as a valid, non-interlaced PNG for tests. */
export function encodePngBase64(width: number, height: number, pixels: readonly number[]): string {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new Error("invalid PNG dimensions");
  if (pixels.length !== width * height * 4 || pixels.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("invalid RGBA pixels");
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBytes = Buffer.from(type, "ascii");
    const body = Buffer.concat([typeBytes, data]);
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    body.copy(result, 4);
    result.writeUInt32BE(crc32(body), 8 + data.length);
    return result;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    Buffer.from(pixels.slice(y * width * 4, (y + 1) * width * 4)).copy(scanlines, row + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
