import { inflateSync } from "node:zlib";

/**
 * Minimal dependency-free PNG decoder for `pixelwar draw` (Node-only — do
 * NOT export from index.ts, it would drag node:zlib into browser bundles).
 *
 * Supports the overwhelming majority of exported pixel art: 8-bit depth,
 * color types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha), 6 (RGBA),
 * non-interlaced. Anything else fails loudly with a re-export hint.
 */

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  pixels: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(data: Buffer): DecodedImage {
  if (data.length < 8 || !data.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("not a PNG file");
  }
  let pos = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let paletteAlpha: Buffer | null = null;
  // tRNS for non-palette types: ONE fully-transparent color (spec §11.3.2).
  // Ignoring it would make users pay for background pixels they exported as
  // transparent (optimizers and indexed→RGB conversions emit this form).
  let trnsGray: number | null = null;
  let trnsRgb: [number, number, number] | null = null;

  while (pos + 12 <= data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString("ascii", pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") {
      // IHDR is always first, so colorType is known here.
      if (colorType === 3) paletteAlpha = Buffer.from(body);
      else if (colorType === 0 && body.length >= 2) trnsGray = body.readUInt16BE(0) & 0xff;
      else if (colorType === 2 && body.length >= 6) {
        trnsRgb = [
          body.readUInt16BE(0) & 0xff,
          body.readUInt16BE(2) & 0xff,
          body.readUInt16BE(4) & 0xff,
        ];
      }
    } else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    pos += 12 + len;
  }

  if (width === 0 || height === 0) throw new Error("PNG has no IHDR chunk");
  if (interlace !== 0) {
    throw new Error("interlaced (Adam7) PNGs are not supported — re-export without interlacing");
  }
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth} — re-export as 8-bit`);
  }
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("palette PNG is missing its PLTE chunk");
  if (idat.length === 0) throw new Error("PNG has no IDAT data");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("PNG pixel data is truncated");

  const out = Buffer.alloc(width * height * 4);
  let prev: Buffer = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    // Copy: unfiltering mutates in place, and `prev` must keep the previous
    // row's RECONSTRUCTED bytes.
    const line = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    unfilter(line, prev, filter, channels);

    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      switch (colorType) {
        case 2: {
          const r = line[x * 3]!,
            g = line[x * 3 + 1]!,
            b = line[x * 3 + 2]!;
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] =
            trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
          break;
        }
        case 6:
          line.copy(out, o, x * 4, x * 4 + 4);
          break;
        case 0: {
          const g = line[x]!;
          out[o] = out[o + 1] = out[o + 2] = g;
          out[o + 3] = g === trnsGray ? 0 : 255;
          break;
        }
        case 4: {
          const g = line[x * 2]!;
          out[o] = out[o + 1] = out[o + 2] = g;
          out[o + 3] = line[x * 2 + 1]!;
          break;
        }
        case 3: {
          const idx = line[x]!;
          if (idx * 3 + 2 >= palette!.length) throw new Error(`palette index ${idx} out of range`);
          out[o] = palette![idx * 3]!;
          out[o + 1] = palette![idx * 3 + 1]!;
          out[o + 2] = palette![idx * 3 + 2]!;
          out[o + 3] = paletteAlpha && idx < paletteAlpha.length ? paletteAlpha[idx]! : 255;
          break;
        }
      }
    }
    prev = line;
  }
  return { width, height, pixels: out };
}

/** Reverse one scanline's PNG filter in place (spec §6). */
function unfilter(line: Buffer, prev: Buffer, filter: number, bpp: number): void {
  switch (filter) {
    case 0:
      return;
    case 1: // Sub
      for (let i = bpp; i < line.length; i++) line[i] = (line[i]! + line[i - bpp]!) & 0xff;
      return;
    case 2: // Up
      for (let i = 0; i < line.length; i++) line[i] = (line[i]! + prev[i]!) & 0xff;
      return;
    case 3: // Average
      for (let i = 0; i < line.length; i++) {
        const left = i >= bpp ? line[i - bpp]! : 0;
        line[i] = (line[i]! + ((left + prev[i]!) >> 1)) & 0xff;
      }
      return;
    case 4: // Paeth
      for (let i = 0; i < line.length; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        line[i] = (line[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      return;
    default:
      throw new Error(`invalid PNG filter type ${filter}`);
  }
}
