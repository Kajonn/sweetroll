import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { processImage, decodeImageBase64 } from "./image-processing.js";

describe("safe image processing", () => {
  const clean = async () => "clean" as const;
  it("fully decodes, scans and strips metadata before producing safe bytes", async () => {
    const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } }).jpeg().withMetadata({ exif: { IFD0: { Artist: "Private author" } } }).toBuffer();
    const scan = vi.fn(clean);
    const image = await processImage({ dataBase64: bytes.toString("base64"), contentType: "image/jpeg" }, scan);
    expect(scan).toHaveBeenCalledExactlyOnceWith(bytes);
    const metadata = await sharp(image.bytes).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(image).toMatchObject({ width: 20, height: 10, contentType: "image/jpeg" });
    expect(image.thumbnail.length).toBeLessThanOrEqual(64 * 1024);
    expect((await sharp(image.thumbnail).metadata()).format).toBe("webp");
  });
  it("rejects infected images and fails closed when scanning is unavailable", async () => {
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
    const input = { dataBase64: bytes.toString("base64"), contentType: "image/png" as const };
    await expect(processImage(input, async () => "infected")).rejects.toMatchObject({ code: "unprocessable" });
    await expect(processImage(input, async () => { throw new Error("scanner unavailable"); })).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
  it("rejects MIME spoofing, truncated decodes and excessive dimensions", async () => {
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
    await expect(processImage({ dataBase64: bytes.toString("base64"), contentType: "image/jpeg" }, clean)).rejects.toMatchObject({ code: "unprocessable" });
    await expect(processImage({ dataBase64: bytes.subarray(0, 35).toString("base64"), contentType: "image/png" }, clean)).rejects.toMatchObject({ code: "unprocessable" });
    const wide = await sharp({ create: { width: 4097, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
    await expect(processImage({ dataBase64: wide.toString("base64"), contentType: "image/png" }, clean)).rejects.toMatchObject({ code: "unprocessable" });
  });
  it.each(["A===", "AA=A", "AAAA=", "!!!!", ""])("rejects malformed base64 %s", value => {
    expect(() => decodeImageBase64(value)).toThrow();
  });
  it("bounds encoded input before decoding", () => {
    expect(() => decodeImageBase64("A".repeat(7 * 1024 * 1024))).toThrow(expect.objectContaining({ code: "too_large" }));
  });
});
