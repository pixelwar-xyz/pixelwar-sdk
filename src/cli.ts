#!/usr/bin/env node
/**
 * pixelwar — terminal client for PixelWar.xyz
 *
 * Env: PIXELWAR_API_URL (default https://api.pixelwar.xyz)
 *      PIXELWAR_PRIVATE_KEY (hex key for real payments; omit in mock mode)
 */
import { writeFileSync } from "node:fs";
import { PixelWarClient } from "./client.js";
import type { HistoryOptions } from "./types.js";

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
  pixelwar meta                          canvas metadata + versioned ruleset
  pixelwar pixel <x> <y>                 inspect one pixel (current decayed price)
  pixelwar history <x> <y>               pixel paint history (its war record)
  pixelwar history [--type paint] [--after N] [--wallet 0x…] [--limit N]
                                         platform event log (cursor-paginated)
  pixelwar quote <x,y,#color> [...]      price a batch without paying
  pixelwar paint <x,y,#color> [...]      paint pixels (x402 paid!)
  pixelwar wallet <address>              public career: territory, spend, spoils
  pixelwar payouts <address>             on-chain payouts (conquest spoils + refunds)
  pixelwar stats                         global stats
  pixelwar leaderboard                   top wallets: spend/territory/spoils/conquests
  pixelwar watch                         stream live paint events
  pixelwar png <file>                    save canvas snapshot

env:
  PIXELWAR_API_URL        API base url (default https://api.pixelwar.xyz)
  PIXELWAR_PRIVATE_KEY    wallet key for payments

example:
  pixelwar paint 500,500,#ff0044 501,500,#ff0044`;

function parseCoord(value: string | undefined, name: string): number {
  // Strict digits only: Number("") is 0, Number("0x10")/"1e3" parse — all
  // of which would silently paint (and pay for) the wrong pixel.
  if (value === undefined || !/^\d+$/.test(value)) {
    console.error(`invalid ${name}: "${value ?? ""}" (expected a non-negative integer)`);
    process.exit(1);
  }
  return Number(value);
}

function parseAddress(value: string | undefined): string {
  if (value === undefined || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    console.error(`invalid address: "${value ?? ""}" (expected 0x + 40 hex chars)`);
    process.exit(1);
  }
  return value;
}

function parsePixels(specs: string[]) {
  if (specs.length === 0) {
    console.error("no pixels given (expected x,y,#rrggbb …)");
    process.exit(1);
  }
  // Dedupe repeated coordinates, last color wins (same Map semantics as the
  // server's /v1/quote) — /v1/paint rejects duplicate coordinates with 400,
  // so without this a batch could quote fine and then fail to paint.
  const byCoord = new Map<string, { x: number; y: number; color: string }>();
  for (const spec of specs) {
    const [x, y, color] = spec.split(",");
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      console.error(`bad pixel spec: "${spec}" (expected x,y,#rrggbb)`);
      process.exit(1);
    }
    const px = parseCoord(x, "x");
    const py = parseCoord(y, "y");
    byCoord.set(`${px},${py}`, { x: px, y: py, color });
  }
  return [...byCoord.values()];
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      console.error(`unexpected argument: "${arg}"`);
      process.exit(1);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`flag ${arg} needs a value`);
      process.exit(1);
    }
    flags[arg.slice(2)] = value;
    i++;
  }
  return flags;
}

/** Atomic USDC (6 decimals) → human string, exact. */
function usdc(atomic: bigint): string {
  const neg = atomic < 0n;
  const v = neg ? -atomic : atomic;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${v / 1_000_000n}${frac ? `.${frac}` : ""}`;
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
    case "history": {
      const rest = args.slice(1);
      // Two bare integers → single-pixel war record; otherwise the platform log.
      if (rest.length === 2 && /^\d+$/.test(rest[0] ?? "") && /^\d+$/.test(rest[1] ?? "")) {
        json(await client.pixelHistory(parseCoord(rest[0], "x"), parseCoord(rest[1], "y")));
        break;
      }
      const flags = parseFlags(rest);
      const opts: HistoryOptions = {};
      if (flags.after !== undefined) opts.after = flags.after;
      if (flags.type !== undefined) opts.type = flags.type;
      if (flags.wallet !== undefined) opts.wallet = parseAddress(flags.wallet);
      if (flags.limit !== undefined) opts.limit = Number(flags.limit);
      const page = await client.history(opts);
      json(page);
      if (page.nextCursor) {
        console.error(`more events available: --after ${page.nextCursor}`);
      }
      break;
    }
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
      // Human summary: who got paid conquest spoils, and any decay refund.
      const spoilsByOwner = new Map<string, bigint>();
      for (const p of result.pixels) {
        if (p.previousOwner && p.spoils !== "0") {
          const owner = p.previousOwner.toLowerCase();
          spoilsByOwner.set(owner, (spoilsByOwner.get(owner) ?? 0n) + BigInt(p.spoils));
        }
      }
      for (const [owner, amount] of spoilsByOwner) {
        console.error(`spoils: ${usdc(amount)} USDC → ${owner} (on-chain)`);
      }
      if (result.refund !== "0") {
        console.error(`refund: ${usdc(BigInt(result.refund))} USDC → you (decay since quote)`);
      }
      break;
    }
    case "wallet":
      json(await client.wallet(parseAddress(args[1])));
      break;
    case "payouts":
      json(await client.walletPayouts(parseAddress(args[1])));
      break;
    case "stats":
      json(await client.stats());
      break;
    case "leaderboard":
      json(await client.leaderboard());
      break;
    case "watch": {
      console.error("watching live paints (ctrl-c to stop)…");
      let failed = false;
      await client.live({
        onPaint: (e) => {
          const spoils = e.pixels.reduce((sum, p) => sum + BigInt(p.spoils), 0n);
          console.log(
            `${e.at} ${e.painter} painted ${e.pixelCount}px for ${e.totalPaidUsdc} USDC` +
              `${spoils > 0n ? ` (spoils ${usdc(spoils)} USDC to prior owners)` : ""}` +
              `${e.txHash ? ` tx=${e.txHash}` : ""}`,
          );
        },
        onError: (msg) => {
          failed = true;
          console.error(`connection error: ${msg}`);
        },
        onClose: () => {
          console.error("connection closed");
          process.exit(failed ? 1 : 0);
        },
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
