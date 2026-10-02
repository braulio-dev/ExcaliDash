import { describe, expect, it } from "vitest";
import { applySceneOperations } from "./sceneOps";
import { renderSceneSvg } from "./render";
import { exportDrawing } from "./exportImage";
import { imageSize, resolveImage, ImageSourceError } from "./images";

// 1x1 transparent PNG.
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const sample = () =>
  applySceneOperations([], [
    { op: "add", element: { type: "frame", id: "f1", x: 0, y: 0, width: 400, height: 260, name: "Registro actual" } },
    { op: "add", element: { type: "rectangle", id: "a", x: 20, y: 40, label: "Cliente envía correo", frameId: "f1" } },
    { op: "add", element: { type: "diamond", id: "d", x: 220, y: 30, width: 150, height: 100, label: "¿Completo?", frameId: "f1" } },
    { op: "add", element: { type: "arrow", id: "ad", startId: "a", endId: "d", frameId: "f1" } },
    { op: "add", element: { type: "ellipse", id: "out", x: 600, y: 0, width: 80, height: 80 } },
  ]).elements;

describe("renderSceneSvg", () => {
  it("renders shapes, labels, arrows and frame titles", () => {
    const { svg, width, height } = renderSceneSvg(sample(), { background: "#ffffff" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Registro actual");
    expect(svg).toContain("Cliente envía correo");
    expect(svg).toContain("¿Completo?");
    expect(svg).toContain('clip-path="url(#clip-f1)"');
    expect(width).toBeGreaterThan(680);
    expect(height).toBeGreaterThan(260);
  });

  it("exports one frame at its exact bounds, without outside elements", () => {
    const { width, height, elementCount } = renderSceneSvg(sample(), { frameId: "f1" });
    expect([width, height]).toEqual([400, 260]);
    expect(elementCount).toBe(6); // frame, 2 shapes, their 2 labels and the arrow
  });

  it("escapes text", () => {
    const els = applySceneOperations([], [{ op: "add", element: { type: "text", text: "<script>&" } }]).elements;
    expect(renderSceneSvg(els).svg).toContain("&lt;script&gt;&amp;");
  });
});

describe("exportDrawing", () => {
  it("produces a PNG with an inlined image", async () => {
    const els = applySceneOperations([], [
      { op: "add", element: { type: "image", id: "i", fileId: "file1", x: 0, y: 0, width: 40, height: 40 } },
      { op: "add", element: { type: "rectangle", x: 60, y: 0 } },
    ]).elements;
    const result = await exportDrawing({
      prisma: {} as any,
      drawingId: "d",
      elements: els,
      files: { file1: { dataURL: PNG_1X1, mimeType: "image/png" } },
      format: "png",
      scale: 2,
      options: { background: "#ffffff" },
    });
    expect(result.format).toBe("png");
    if (result.format !== "png") return;
    expect(result.png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(result.width).toBeGreaterThan(400);
  });
});

describe("images", () => {
  it("reads sizes from headers", () => {
    const png = Buffer.from(PNG_1X1.split(",")[1], "base64");
    expect(imageSize(png, "image/png")).toEqual({ width: 1, height: 1 });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>');
    expect(imageSize(svg, "image/svg+xml")).toEqual({ width: 120, height: 80 });
  });

  it("turns a data URL into a content-addressed file", async () => {
    const resolved = await resolveImage({ dataUrl: PNG_1X1 });
    expect(resolved.fileId).toMatch(/^[0-9a-f]{40}$/);
    expect(resolved.file).toMatchObject({ id: resolved.fileId, mimeType: "image/png", dataURL: PNG_1X1 });
    expect([resolved.width, resolved.height]).toEqual([1, 1]);
  });

  it("refuses unsafe or unsupported sources", async () => {
    await expect(resolveImage({ url: "http://example.com/a.png" })).rejects.toThrow(/https/);
    await expect(resolveImage({ url: "https://127.0.0.1/a.png" })).rejects.toThrow(/public host/);
    await expect(resolveImage({ url: "https://localhost/a.png" })).rejects.toThrow(ImageSourceError);
    await expect(resolveImage({ dataUrl: "data:text/html;base64,PGI+" })).rejects.toThrow(ImageSourceError);
    await expect(resolveImage({})).rejects.toThrow(/url/);
  });
});
