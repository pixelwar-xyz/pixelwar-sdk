#!/usr/bin/env node
/**
 * pixelwar — terminal client for PixelWar.xyz
 *
 * Env: PIXELWAR_API_URL (default https://api.pixelwar.xyz)
 *      PIXELWAR_PRIVATE_KEY (hex key for real payments; omit in mock mode)
 */
import { writeFileSync } from "node:fs";
import { PixelWarClient } from "./client.js";

const args = process.argv.slice(2);
const cmd = args[0];

const client = new PixelWarClient({
  baseUrl: process.env.PIXELWAR_API_URL ?? "https://api.pixelwar.xyz",
  ...(process.env.PIXELWAR_PRIVATE_KEY
    ? { privateKey: process.env.PIXELWAR_PRIVATE_KEY as `0x${string}` }
    : {}),
});

const usage = `pixelwar — terminal client for pixelwar.xyz

usage:
  pixelwar meta                          canvas metadata + pricing rules
  pixelwar pixel <x> <y>                 inspect one pixel
  pixelwar history <x> <y>               pixel paint history
  pixelwar quote <x,y,#color> [...]      price a batch without paying
  pixelwar paint <x,y,#color> [...]      paint pixels (x402 paid!)
  pixelwar stats                         global stats
  pixelwar leaderboard                   top wallets
  pixelwar watch                         stream live paint events
  pixelwar png <file>                    save canvas snapshot

env:
  PIXELWAR_API_URL        API base url (default https://api.pixelwar.xyz)
  PIXELWAR_PRIVATE_KEY    wallet key for payments (not needed in mock mode)

example:
  pixelwar paint 500,500,#ff0044 501,500,#ff0044`;

function parseCoord(value: string | undefined, name: string): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 0) {
    console.error(`invalid ${name}: "${value ?? ""}" (expected a non-negative integer)`);
    process.exit(1);
  }
  return n;
}

function parsePixels(specs: string[]) {
  if (specs.length === 0) {
    console.error("no pixels given (expected x,y,#rrggbb …)");
    process.exit(1);
  }
  return specs.map((spec) => {
    const [x, y, color] = spec.split(",");
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      console.error(`bad pixel spec: "${spec}" (expected x,y,#rrggbb)`);
      process.exit(1);
    }
    return { x: parseCoord(x, "x"), y: parseCoord(y, "y"), color };
  });
}

const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));

try {
  switch (cmd) {
    case "meta":
      json(await client.meta());
      break;
    case "pixel":
      json(await client.pixel(parseCoord(args[1], "x"), parseCoord(args[2], "y")));
      break;
    case "history":
      json(await client.history(parseCoord(args[1], "x"), parseCoord(args[2], "y")));
      break;
    case "quote": {
      const q = await client.quote(parsePixels(args.slice(1)));
      json(q);
      break;
    }
    case "paint": {
      const pixels = parsePixels(args.slice(1));
      const quote = await client.quote(pixels);
      console.error(`painting ${pixels.length}px for ${quote.totalUsdc} USDC…`);
      // The quote IS the spend ceiling: if prices move before payment, the
      // SDK refuses to sign a higher amount instead of silently paying more.
      const result = await client.paint(pixels, { maxTotal: quote.total });
      json(result);
      break;
    }
    case "stats":
      json(await client.stats());
      break;
    case "leaderboard":
      json(await client.leaderboard());
      break;
    case "watch": {
      console.error("watching live paints (ctrl-c to stop)…");
      await client.live({
        onPaint: (e) =>
          console.log(
            `${e.at} ${e.painter} painted ${e.pixelCount}px for ${e.totalPaidUsdc} USDC${e.txHash ? ` tx=${e.txHash}` : ""}`,
          ),
        onClose: () => process.exit(0),
      });
      await new Promise(() => {});
      break;
    }
    case "png": {
      const file = args[1] ?? "canvas.png";
      writeFileSync(file, await client.canvasPng());
      console.error(`saved ${file}`);
      break;
    }
    default:
      console.log(usage);
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
