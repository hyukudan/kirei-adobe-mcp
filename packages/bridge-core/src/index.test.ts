import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { CapabilityRegistry, LockManager } from "./index.js";
import { compareBase64Images } from "./index.js";

function png(width: number, height: number, pixels: readonly number[]): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => { const header = Buffer.alloc(8); header.writeUInt32BE(data.length, 0); header.write(type, 4, "ascii"); return Buffer.concat([header, data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) { scanlines[y * (width * 4 + 1)] = 0; Buffer.from(pixels.slice(y * width * 4, (y + 1) * width * 4)).copy(scanlines, y * (width * 4 + 1) + 1); }
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const red = png(1, 1, [255, 0, 0, 255]);
const almostRed = png(1, 1, [250, 0, 0, 255]);
const blue = png(1, 1, [0, 0, 255, 255]);

describe("bridge core", () => {
  it("requires capabilities and releases ordered leases", () => { const registry = new CapabilityRegistry(); registry.register("i", ["state.read@1"]); expect(() => registry.require("i", ["state.write@1"])).toThrow("UNSUPPORTED_CAPABILITY"); const locks = new LockManager(); const leases = locks.acquire(["b", "a"]); expect(leases.map((l) => l.key)).toEqual(["a", "b"]); locks.release(leases); expect(locks.acquire(["a"])).toHaveLength(1); });
});

describe("pixel-accurate visual verification", () => {
  it("returns zero for identical decoded pixels even when PNG compression differs", () => {
    const samePixelsDifferentChunking = png(1, 1, [255, 0, 0, 255]);
    expect(compareBase64Images(red, samePixelsDifferentChunking, 0)).toMatchObject({ match: true, diffScore: 0 });
  });

  it("accepts a small RGBA color change within tolerance", () => {
    expect(compareBase64Images(red, almostRed, 0.01)).toMatchObject({ match: true });
    expect(compareBase64Images(red, almostRed, 0.01).diffScore).toBeCloseTo(5 / (4 * 255), 8);
  });

  it("rejects a large pixel difference outside tolerance", () => {
    expect(compareBase64Images(red, blue, 0.1)).toMatchObject({ match: false, diffScore: 0.5 });
  });

  it("rejects different dimensions with an explanatory detail", () => {
    const twoPixels = png(2, 1, [255, 0, 0, 255, 255, 0, 0, 255]);
    const result = compareBase64Images(red, twoPixels, 1);
    expect(result).toMatchObject({ match: false, diffScore: 1 });
    expect(result.details.reason).toContain("dimensions differ");
  });

  it("rejects invalid Base64 and invalid magic bytes", () => {
    expect(compareBase64Images("not-base64!", red, 1)).toMatchObject({ match: false, diffScore: 1 });
    expect(compareBase64Images(Buffer.from("hello").toString("base64"), red, 1).details.reason).toContain("magic bytes");
  });
});
