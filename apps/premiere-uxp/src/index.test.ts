import { decodeImageDimensions } from "@adobe-mcp/bridge-core";
import { encodePngBase64 } from "@adobe-mcp/bridge-core/testkit";
import { describe, expect, it } from "vitest";
import { DefaultUxpPremiereHost, type PremiereUxpRuntime } from "./index.js";

describe("Premiere UXP preview host", () => {
  it("exports a proportional PNG from the active sequence and cleans its temporary file", async () => {
    let exportDimensions: { width: number; height: number } | undefined;
    let deleted = false;
    let imageBase64 = "";
    const runtime: PremiereUxpRuntime = {
      project: {
        activeSequence: {
          frameSize: { width: 200, height: 100 },
          revision: "rev-1",
          exportFramePNG: async (_time, _nativeFile, dimensions) => {
            exportDimensions = dimensions;
            imageBase64 = encodePngBase64(dimensions!.width, dimensions!.height, new Array(dimensions!.width * dimensions!.height * 4).fill(128));
          },
        },
      },
      createPreviewFile: async () => ({
        nativeFile: {},
        file: {
          async read() { return imageBase64; },
          async delete() { deleted = true; },
        },
      }),
    };

    const result = await new DefaultUxpPremiereHost(runtime).capturePreview({ format: "png", maxDimension: 100 });
    const preview = result as { imageBase64: string; width: number; height: number; mimeType: string };
    expect(exportDimensions).toEqual({ width: 100, height: 50 });
    expect(decodeImageDimensions(preview.imageBase64)).toEqual({ format: "png", width: 100, height: 50 });
    expect(preview).toMatchObject({ width: 100, height: 50, mimeType: "image/png" });
    expect(deleted).toBe(true);
  });

  it("cleans the temporary file when the host export fails", async () => {
    let deleted = false;
    const runtime: PremiereUxpRuntime = {
      project: { activeSequence: { frameSize: { width: 200, height: 100 }, revision: "rev-1", exportFramePNG: async () => { throw new Error("export failed"); } } },
      createPreviewFile: async () => ({ nativeFile: {}, file: { async read() { return ""; }, async delete() { deleted = true; } } }),
    };
    await expect(new DefaultUxpPremiereHost(runtime).capturePreview({ format: "png", maxDimension: 100 })).rejects.toThrow("export failed");
    expect(deleted).toBe(true);
  });
});
