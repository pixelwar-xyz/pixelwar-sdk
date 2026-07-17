#!/usr/bin/env node
/**
 * pixelwar — terminal client for PixelWar.xyz
 *
 * Env: PIXELWAR_API_URL (default https://api.pixelwar.xyz)
 *      PIXELWAR_PRIVATE_KEY (hex key for real payments; omit in mock mode)
 *      PIXELWAR_RPC_URL (optional RPC for the pre-sign balance check)
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PixelWarClient } from "./client.js";
import { decodePng } from "./png.js";
import { DoNotRepayError } from "./types.js";
import type { HistoryOptions } from "./types.js";

const args = process.argv.slice(2);
const cmd = args[0];

const client = new PixelWarClient({
  baseUrl: process.env.PIXELWAR_API_URL ?? "https://api.pixelwar.xyz",
  ...(process.env.PIXELWAR_PRIVATE_KEY
    ? { privateKey: process.env.PIXELWAR_PRIVATE_KEY as `0x${string}` }
    : {}),
  ...(process.env.PIXELWAR_SOLANA_PRIVATE_KEY
    ? { solanaPrivateKey: process.env.PIXELWAR_SOLANA_PRIVATE_KEY }
    : {}),
  ...(process.env.PIXELWAR_RPC_URL ? { rpcUrl: process.env.PIXELWAR_RPC_URL } : {}),
});

const usage = `pixelwar — terminal client for pixelwar.xyz

usage:
  pixelwar meta                          canvas metadata + versioned ruleset
  pixelwar pixel <x> <y>                 inspect one pixel (current decayed price)
  pixelwar history <x> <y>               pixel paint history (its war record)
  pixelwar history [--type paint] [--after N] [--wallet 0x…] [--limit N]
                                         platform event log (cursor-paginated)
  pixelwar quote <x,y,#color> [...]      price a batch without paying
  pixelwar paint <x,y,#color> [...] [--dry-run] [--network <chain>]
                                         paint pixels (x402 paid!)
  pixelwar paint --file <specs.txt> [--batch N] [--journal J] [--dry-run] [--network <chain>]
                                         paint a whole spec file in journaled batches
  pixelwar draw <image.png> --at <x,y> [--batch N] [--journal J] [--dry-run] [--network <chain>]
                 [--skip-color #rrggbb]  paint a PNG (transparent pixels skipped)
  pixelwar replay <idempotency-key>      recover a paint result without re-paying
  pixelwar wallet <address>              public career: territory, spend, spoils
  pixelwar payouts <address>             on-chain payouts (conquest spoils + refunds)
  pixelwar stats                         global stats
  pixelwar leaderboard                   top wallets: spend/territory/spoils/conquests
  pixelwar watch                         stream live paint events
  pixelwar png <file>                    save canvas snapshot

batched painting (--file / draw) writes a journal after every batch: if the
process dies, re-run the same command and it resumes — finished batches are
never re-paid (each carries a stable Idempotency-Key the server replays).

env:
  PIXELWAR_API_URL        API base url (default https://api.pixelwar.xyz)
  PIXELWAR_PRIVATE_KEY    EVM wallet key for payments (0x hex)
  PIXELWAR_SOLANA_PRIVATE_KEY  Solana wallet key (base58) for --network solana-devnet
  PIXELWAR_RPC_URL        RPC for the pre-sign balance check (default: a public RPC
                          for the payment chain; set it to THAT chain's RPC if used
                          together with --network)

examples:
  pixelwar paint 500,500,#ff0044 501,500,#ff0044
  pixelwar draw logo.png --at 784,570 --dry-run`;

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

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["dry-run"]);

function splitArgs(argv: string[]): {
  positionals: string[];
  flags: Record<string, string>;
  bools: Set<string>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      bools.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`flag ${arg} needs a value`);
      process.exit(1);
    }
    flags[name] = value;
    i++;
  }
  return { positionals, flags, bools };
}

function parseFlags(argv: string[]): Record<string, string> {
  const { positionals, flags } = splitArgs(argv);
  if (positionals.length > 0) {
    console.error(`unexpected argument: "${positionals[0]}"`);
    process.exit(1);
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

// --- journaled batch painting --------------------------------------------------

type Spec = { x: number; y: number; color: string };

interface JournalBatch {
  key: string;
  pixels: Spec[];
  /** "held" = a do_not_repay outcome: only a server replay may resolve it. */
  status: "pending" | "done" | "held";
  txHash?: string | null;
  totalPaid?: string;
}

interface Journal {
  version: 1;
  api: string;
  /** Payer the batch keys belong to — replay is keyed by (key, payer). */
  wallet: string | null;
  /** Hash of the full ordered spec list: same count ≠ same job. */
  specsHash: string;
  pixelCount: number;
  batchSize: number;
  /**
   * The chain every batch pays on — pinned at job start (explicit --network,
   * else the server's primary at first quote) so a resume or mid-job server
   * reorder can never split one job's payments across chains. Absent only in
   * journals written before multi-chain; those pin on their next batch.
   */
  network?: string | null;
  batches: JournalBatch[];
}

const hashSpecs = (specs: Spec[]): string =>
  createHash("sha256").update(JSON.stringify(specs)).digest("hex");

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseBatchSize(value: string | undefined): number {
  if (value === undefined) return 250;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000) {
    console.error(`invalid --batch: "${value}" (expected 1-1000; the server caps batches at 1000)`);
    process.exit(1);
  }
  return Number(value);
}

/**
 * Paint a large pixel list in journaled batches. The journal is written
 * after EVERY batch: re-running the same command resumes, and finished
 * batches are never re-paid (stable per-batch Idempotency-Keys — the server
 * replays their stored result even if we crashed before recording it).
 */
async function paintBatched(
  specs: Spec[],
  opts: { batchSize: number; journalPath: string; dryRun: boolean; network?: string },
): Promise<void> {
  let journal: Journal;
  const specsHash = hashSpecs(specs);
  // Atomic replace: a crash mid-write must never corrupt the journal — a
  // corrupt journal means fresh keys on the next run, i.e. paying twice.
  const save = () => {
    writeFileSync(`${opts.journalPath}.tmp`, JSON.stringify(journal, null, 1));
    renameSync(`${opts.journalPath}.tmp`, opts.journalPath);
  };

  if (existsSync(opts.journalPath)) {
    journal = JSON.parse(readFileSync(opts.journalPath, "utf8")) as Journal;
    // Content must match EXACTLY: same pixel count is not the same job (a
    // moved --at, edited colors, or different --skip-color keeps the count
    // but would silently paint the journal's OLD pixels).
    if (journal.version !== 1 || journal.specsHash !== specsHash) {
      console.error(
        `journal ${opts.journalPath} belongs to a different job (its pixels differ from this command's) — ` +
          `finish/delete it, or pass a different --journal`,
      );
      process.exit(1);
    }
    // Replay and idempotency are keyed by (key, payer): resuming with a
    // different wallet would miss every stored result and pay everything
    // again from the new wallet.
    if ((journal.wallet ?? null) !== (client.address ?? null)) {
      console.error(
        `journal ${opts.journalPath} was created by wallet ${journal.wallet ?? "(none)"} but the current key is ` +
          `${client.address ?? "(none)"} — restore the original PIXELWAR_PRIVATE_KEY to resume safely`,
      );
      process.exit(1);
    }
    // One job, one chain: a resume must keep paying where the finished
    // batches paid. An explicit conflicting --network is a different job.
    if (opts.network && journal.network && opts.network !== journal.network) {
      console.error(
        `journal ${opts.journalPath} pays on ${journal.network} but --network ${opts.network} was given — ` +
          `finish the journal on its own chain, or delete it to start over`,
      );
      process.exit(1);
    }
    const done = journal.batches.filter((b) => b.status === "done").length;
    console.error(
      `resuming from ${opts.journalPath}: ${done}/${journal.batches.length} batches already painted`,
    );
  } else {
    journal = {
      version: 1,
      api: client.baseUrl,
      wallet: client.address,
      specsHash,
      pixelCount: specs.length,
      batchSize: opts.batchSize,
      network: opts.network ?? null,
      batches: chunk(specs, opts.batchSize).map((pixels) => ({
        key: randomUUID(),
        pixels,
        status: "pending" as const,
      })),
    };
    if (!opts.dryRun) save();
  }

  const total = journal.batches.length;
  let painted = 0;
  let totalPaid = 0n;
  let estimate = 0n;
  let pendingCount = 0;

  for (const [i, batch] of journal.batches.entries()) {
    if (batch.status === "done") {
      painted += batch.pixels.length;
      if (batch.totalPaid) totalPaid += BigInt(batch.totalPaid);
      continue;
    }

    if (batch.status === "held") {
      // A do_not_repay outcome: funds may have moved. The ONLY safe exit is
      // a server-side replay of the stored result — never a new payment.
      const replayed = opts.dryRun ? null : await client.paintReplay(batch.key);
      if (replayed) {
        batch.status = "done";
        batch.txHash = replayed.txHash;
        batch.totalPaid = replayed.totalPaid;
        save();
        painted += batch.pixels.length;
        totalPaid += BigInt(replayed.totalPaid);
        console.error(`batch ${i + 1}/${total}: recovered via replay (key ${batch.key}) — no new payment`);
        continue;
      }
      console.error(
        `\nSTOP: batch ${i + 1}/${total} is HELD from a previous run (do_not_repay) and the server has no stored result yet.`,
      );
      console.error(
        `Its payment may still be reconciling — poll \`pixelwar replay ${batch.key}\` or re-run this command later. NEVER paint it manually.`,
      );
      process.exit(1);
    }

    pendingCount++;
    const quote = await client.quote(batch.pixels);
    if (opts.dryRun) {
      estimate += BigInt(quote.total);
      console.error(`batch ${i + 1}/${total}: ${batch.pixels.length}px = ${quote.totalUsdc} USDC`);
      continue;
    }
    // Pin the job's chain on first payment if it wasn't set explicitly: the
    // quote echoes the server's CURRENT primary, and persisting it means
    // later batches/resumes fail loudly if the server's offer changes rather
    // than silently switching chains mid-job.
    if (!journal.network) {
      journal.network = opts.network ?? quote.network;
      save();
    }
    console.error(
      `batch ${i + 1}/${total}: ${batch.pixels.length}px for ${quote.totalUsdc} USDC on ${journal.network} (key ${batch.key})`,
    );
    try {
      const result = await client.paint(batch.pixels, {
        maxTotal: quote.total,
        idempotencyKey: batch.key,
        network: journal.network,
      });
      batch.status = "done";
      batch.txHash = result.txHash;
      batch.totalPaid = result.totalPaid;
      save();
      painted += batch.pixels.length;
      totalPaid += BigInt(result.totalPaid);
    } catch (err) {
      if (err instanceof DoNotRepayError) {
        // Persist the held state: a blind re-run must NOT re-enter paint()
        // for this batch while the server is reconciling.
        batch.status = "held";
        save();
        console.error(`\nSTOP: ${err.message}`);
        console.error(`Funds for batch ${i + 1} may have moved — do NOT re-run yet.`);
        console.error(`Poll:   pixelwar replay ${batch.key}`);
        console.error(
          `A result there means the batch landed; re-running this exact command also resolves ` +
            `held batches through replay only — it will never re-pay them.`,
        );
      } else {
        save();
        console.error(`\nbatch ${i + 1}/${total} failed: ${(err as Error).message}`);
        console.error(
          `Fix the cause and re-run this exact command — ${opts.journalPath} resumes where it stopped.`,
        );
      }
      process.exit(1);
    }
  }

  if (opts.dryRun) {
    const already = total - pendingCount;
    console.error(
      `dry run: ${pendingCount} pending batches ≈ ${usdc(estimate)} USDC` +
        (already > 0 ? ` (+${already} batches already painted for ${usdc(totalPaid)} USDC)` : "") +
        ` — prices can move until you pay`,
    );
    return;
  }
  console.error(
    `done: ${painted}px painted for ${usdc(totalPaid)} USDC — journal ${opts.journalPath} complete (safe to delete)`,
  );
}

/** Read pixel specs (whitespace/newline-separated x,y,#rrggbb tokens) from a file. */
function readSpecsFile(path: string): Spec[] {
  if (!existsSync(path)) {
    console.error(`spec file not found: ${path}`);
    process.exit(1);
  }
  const tokens = readFileSync(path, "utf8").split(/\s+/).filter(Boolean);
  return parsePixels(tokens);
}

// --- commands --------------------------------------------------------------------

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
      const { positionals, flags, bools } = splitArgs(args.slice(1));

      if (flags.file) {
        const specs = readSpecsFile(flags.file);
        await paintBatched(specs, {
          batchSize: parseBatchSize(flags.batch),
          journalPath: flags.journal ?? `${flags.file}.journal.json`,
          dryRun: bools.has("dry-run"),
          ...(flags.network ? { network: flags.network } : {}),
        });
        break;
      }

      const pixels = parsePixels(positionals);
      const quote = await client.quote(pixels);
      if (bools.has("dry-run")) {
        json(quote);
        console.error(`dry run: nothing was painted or paid`);
        break;
      }
      const key = randomUUID();
      // Print BEFORE paying: if this process dies mid-payment, the key is the
      // only handle to recover the result without paying twice.
      console.error(
        `painting ${pixels.length}px for ${quote.totalUsdc} USDC… (key ${key} — recover with: pixelwar replay ${key})`,
      );
      // The quote IS the spend ceiling: if prices move before payment, the
      // SDK refuses to sign a higher amount instead of silently paying more.
      let result;
      try {
        result = await client.paint(pixels, {
          maxTotal: quote.total,
          idempotencyKey: key,
          // Optional: pay on a specific chain (else the server's primary).
          ...(flags.network ? { network: flags.network } : {}),
        });
      } catch (err) {
        if (err instanceof DoNotRepayError) {
          console.error(`\nSTOP: ${err.message}`);
          console.error(
            `Your funds may have moved — do NOT re-run this command (a re-run signs a NEW payment).`,
          );
          console.error(`Poll:   pixelwar replay ${key}`);
          console.error(`A result there is your receipt; a 404 means keep waiting, never re-pay.`);
          process.exit(1);
        }
        throw err;
      }
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
    case "draw": {
      const { positionals, flags, bools } = splitArgs(args.slice(1));
      const file = positionals[0];
      if (!file) {
        console.error("usage: pixelwar draw <image.png> --at x,y [--batch N] [--journal J] [--dry-run] [--skip-color #rrggbb]");
        process.exit(1);
      }
      if (!existsSync(file)) {
        console.error(`image not found: ${file}`);
        process.exit(1);
      }
      if (!flags.at || !/^\d+,\d+$/.test(flags.at)) {
        console.error(`--at is required as x,y (canvas coordinates of the image's top-left corner)`);
        process.exit(1);
      }
      const [atX, atY] = flags.at.split(",").map(Number) as [number, number];
      let skipColor: string | null = null;
      if (flags["skip-color"] !== undefined) {
        if (!/^#[0-9a-fA-F]{6}$/.test(flags["skip-color"])) {
          console.error(`invalid --skip-color: "${flags["skip-color"]}" (expected #rrggbb)`);
          process.exit(1);
        }
        skipColor = flags["skip-color"].toLowerCase();
      }

      const img = decodePng(readFileSync(file));
      const meta = await client.meta();
      if (atX + img.width > meta.width || atY + img.height > meta.height) {
        console.error(
          `image (${img.width}x${img.height} at ${atX},${atY}) exceeds the ${meta.width}x${meta.height} canvas`,
        );
        process.exit(1);
      }

      const specs: Spec[] = [];
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const o = (y * img.width + x) * 4;
          if (img.pixels[o + 3]! < 128) continue; // transparent → don't paint
          const color = `#${img.pixels[o]!.toString(16).padStart(2, "0")}${img.pixels[o + 1]!
            .toString(16)
            .padStart(2, "0")}${img.pixels[o + 2]!.toString(16).padStart(2, "0")}`;
          if (color === skipColor) continue;
          specs.push({ x: atX + x, y: atY + y, color });
        }
      }
      if (specs.length === 0) {
        console.error("image has no paintable pixels (all transparent or skip-colored)");
        process.exit(1);
      }
      console.error(
        `${file}: ${img.width}x${img.height}, ${specs.length} paintable pixels at (${atX},${atY})`,
      );
      await paintBatched(specs, {
        batchSize: parseBatchSize(flags.batch),
        journalPath: flags.journal ?? `${file}.journal.json`,
        dryRun: bools.has("dry-run"),
        ...(flags.network ? { network: flags.network } : {}),
      });
      break;
    }
    case "replay": {
      const key = args[1];
      if (!key) {
        console.error("usage: pixelwar replay <idempotency-key>");
        process.exit(1);
      }
      // paintReplay throws when no wallet is configured in real-payment mode
      // (results are keyed by payer) — surfaced via the outer catch.
      const result = await client.paintReplay(key);
      if (result) {
        json(result);
      } else {
        console.error(
          "no stored result for this key (yet) — the payment may still be reconciling, or it never landed; poll again before re-paying",
        );
        process.exit(3);
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
