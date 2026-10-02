import crypto from "crypto";
import dns from "dns/promises";
import net from "net";

// Turns an agent-supplied image (data URL or public https URL) into an
// Excalidraw file entry plus its natural size. Remote fetches are https-only,
// refuse private/loopback addresses, and are capped in size and time.

export class ImageSourceError extends Error {}

export type ImageSource = { url?: string; dataUrl?: string };
export type ResolvedImage = {
  fileId: string;
  file: { id: string; mimeType: string; dataURL: string; created: number };
  width: number;
  height: number;
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

const isPrivateAddress = (address: string): boolean => {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
};

const assertPublicHttps = async (raw: string): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImageSourceError("Image url is not a valid URL");
  }
  if (url.protocol !== "https:") throw new ImageSourceError("Image urls must use https");
  const addresses = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new ImageSourceError(`Could not resolve ${url.hostname}`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new ImageSourceError("Image urls must point to a public host");
  }
  return url;
};

const fetchImage = async (raw: string): Promise<{ buffer: Buffer; mimeType: string }> => {
  let url = await assertPublicHttps(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicHttps(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (!res.ok) throw new ImageSourceError(`Fetching the image failed with HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
      throw new ImageSourceError("Image is larger than 5 MB");
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new ImageSourceError("Image is larger than 5 MB");
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    return { buffer, mimeType };
  }
  throw new ImageSourceError("Too many redirects");
};

const parseDataUrl = (dataUrl: string) => {
  const match = /^data:(image\/[a-z0-9+.-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new ImageSourceError("dataUrl must be a base64 image data URL");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > MAX_IMAGE_BYTES) throw new ImageSourceError("Image is larger than 5 MB");
  return { buffer, mimeType: match[1].toLowerCase() };
};

// Natural pixel size from the file header; null when it cannot be read.
export const imageSize = (buf: Buffer, mimeType: string): { width: number; height: number } | null => {
  try {
    if (mimeType === "image/png" && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mimeType === "image/gif" && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mimeType === "image/jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (mimeType === "image/webp" && buf.length >= 30) {
      const chunk = buf.toString("ascii", 12, 16);
      if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (mimeType === "image/svg+xml") {
      const head = buf.toString("utf8", 0, 4096);
      const num = (name: string) => Number(new RegExp(`\\s${name}="([\\d.]+)`).exec(head)?.[1]);
      const viewBox = /viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(head);
      const width = num("width") || Number(viewBox?.[1]);
      const height = num("height") || Number(viewBox?.[2]);
      if (width && height) return { width, height };
    }
  } catch {
    return null;
  }
  return null;
};

export const resolveImage = async (source: ImageSource): Promise<ResolvedImage> => {
  if (!source.url && !source.dataUrl) throw new ImageSourceError("Give the image as `url` or `dataUrl`");
  const { buffer, mimeType } = source.dataUrl ? parseDataUrl(source.dataUrl) : await fetchImage(source.url!);
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new ImageSourceError(`Unsupported image type "${mimeType || "unknown"}"; use PNG, JPEG, GIF, WebP or SVG`);
  }
  // Excalidraw ids files by content hash.
  const fileId = crypto.createHash("sha1").update(buffer).digest("hex");
  const size = imageSize(buffer, mimeType) ?? { width: 300, height: 300 };
  return {
    fileId,
    file: { id: fileId, mimeType, dataURL: `data:${mimeType};base64,${buffer.toString("base64")}`, created: Date.now() },
    ...size,
  };
};
