import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PixelWarClient } from "./client.js";
import type { PixelPaint } from "./types.js";

/**
 * Creature — a diff-painted, budget-capped animated sprite.
 *
 * Ruleset 1.4.0 makes animation a first-class mechanic: repainting your OWN
 * pixel costs the flat base price (0.01 USDC/px/frame; the platform currently
 * keeps 100% of every payment). A Creature exploits that by keeping a JOURNAL of
 * what it last painted and only paying for cells whose color actually
 * changes between frames. Cells the sprite vacates (frame shrink or move())
 * are erased to a configurable background color.
 *
 * The journal — last-painted cells, cumulative spend, frame counter, run id —
 * is persisted to a JSON file after every frame, so a restarted Creature
 * resumes without re-paying for pixels already on the canvas, and the budget
 * ceiling survives process restarts.
 */

/** A frame pixel with coordinates RELATIVE to the creature's origin. */
export interface FramePixel {
  x: number;
  y: number;
  /** #rrggbb */
  color: string;
}

/**
 * A frame is either a sparse list of relative pixels, or a 2D pixel map:
 * rows of `#rrggbb` cells where `null`/`undefined`/empty means "not part of
 * the sprite" (left untouched / erased to background when vacated).
 */
export type CreatureFrame = FramePixel[] | (string | null | undefined)[][];

export interface CreatureOptions {
  client: PixelWarClient;
  /** Animation frames, cycled in order. At least one required. */
  frames: CreatureFrame[];
  /** Canvas coordinates of the sprite's top-left anchor. */
  origin: { x: number; y: number };
  /** Milliseconds between frames (default 600000 = 10 min). */
  heartbeatMs?: number;
  /**
   * Hard lifetime spend ceiling in USDC (e.g. 5 = 5 USDC). Checked against
   * the PERSISTED spend journal before every frame; when the next frame's
   * quote would cross it, the creature stops gracefully.
   */
  budgetUsdc: number;
  /** Payment chain (else the server's primary). */
  network?: string;
  /** Color vacated cells are erased to (default #ffffff). */
  backgroundColor?: string;
  /** Where the journal JSON is persisted (default ./creature-journal.json). */
  journalPath?: string;
  /** Optional logger (default console.error). */
  log?: (msg: string) => void;
}

interface CreatureJournal {
  version: 1;
  /** Payer wallet the spend/idempotency keys belong to. */
  wallet: string | null;
  /** Stable id namespacing this creature's idempotency keys. */
  runId: string;
  /** Cumulative gross spend, atomic USDC (string for JSON safety). */
  spent: string;
  /** Frames successfully painted (also the idempotency counter). */
  framesPainted: number;
  /** Last-painted cells: "x,y" -> "#rrggbb". */
  cells: Record<string, string>;
}

export interface CreatureStatus {
  /** Frames successfully painted over the creature's lifetime. */
  frames: number;
  /** Cumulative spend in USDC (human units). */
  spent: number;
  /** Current origin. */
  position: { x: number; y: number };
  /** Whether the frame loop is running. */
  running: boolean;
  /** Remaining budget in USDC. */
  remaining: number;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Normalize one frame into a relative-coordinate pixel list. */
function normalizeFrame(frame: CreatureFrame, index: number): FramePixel[] {
  if (frame.length > 0 && Array.isArray(frame[0])) {
    const rows = frame as (string | null | undefined)[][];
    const out: FramePixel[] = [];
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y]!;
      for (let x = 0; x < row.length; x++) {
        const color = row[x];
        if (color == null || color === "") continue;
        if (!COLOR_RE.test(color)) {
          throw new Error(`frame ${index}: bad color "${color}" at (${x},${y}) — expected #rrggbb`);
        }
        out.push({ x, y, color: color.toLowerCase() });
      }
    }
    return out;
  }
  return (frame as FramePixel[]).map((p) => {
    if (!COLOR_RE.test(p.color)) {
      throw new Error(`frame ${index}: bad color "${p.color}" at (${p.x},${p.y}) — expected #rrggbb`);
    }
    return { x: p.x, y: p.y, color: p.color.toLowerCase() };
  });
}

export class Creature {
  private readonly client: PixelWarClient;
  private readonly frames: FramePixel[][];
  private readonly heartbeatMs: number;
  private readonly budgetAtomic: bigint;
  private readonly network: string | undefined;
  private readonly backgroundColor: string;
  private readonly journalPath: string;
  private readonly log: (msg: string) => void;

  private origin: { x: number; y: number };
  private journal: CreatureJournal;
  private running = false;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(opts: CreatureOptions) {
    if (!opts.frames || opts.frames.length === 0) throw new Error("Creature needs at least one frame");
    if (!(opts.budgetUsdc > 0)) throw new Error("budgetUsdc must be a positive number of USDC");
    this.client = opts.client;
    this.frames = opts.frames.map(normalizeFrame);
    this.origin = { x: opts.origin.x, y: opts.origin.y };
    this.heartbeatMs = opts.heartbeatMs ?? 600_000;
    this.budgetAtomic = BigInt(Math.round(opts.budgetUsdc * 1e6));
    this.network = opts.network;
    this.backgroundColor = (opts.backgroundColor ?? "#ffffff").toLowerCase();
    if (!COLOR_RE.test(this.backgroundColor)) {
      throw new Error(`bad backgroundColor "${opts.backgroundColor}" — expected #rrggbb`);
    }
    this.journalPath = opts.journalPath ?? "creature-journal.json";
    this.log = opts.log ?? ((m) => console.error(m));
    this.journal = this.loadJournal();
  }

  private loadJournal(): CreatureJournal {
    if (existsSync(this.journalPath)) {
      const j = JSON.parse(readFileSync(this.journalPath, "utf8")) as CreatureJournal;
      if (j.version !== 1) throw new Error(`unsupported journal version in ${this.journalPath}`);
      if ((j.wallet ?? null) !== (this.client.address ?? null)) {
        throw new Error(
          `journal ${this.journalPath} belongs to wallet ${j.wallet ?? "(none)"} but the current key is ` +
            `${this.client.address ?? "(none)"} — use a different journalPath or restore the original key`,
        );
      }
      return j;
    }
    return {
      version: 1,
      wallet: this.client.address,
      runId: randomUUID(),
      spent: "0",
      framesPainted: 0,
      cells: {},
    };
  }

  /** Atomic replace: a crash mid-write must never corrupt the spend journal. */
  private saveJournal(): void {
    writeFileSync(`${this.journalPath}.tmp`, JSON.stringify(this.journal));
    renameSync(`${this.journalPath}.tmp`, this.journalPath);
  }

  /** Absolute "x,y" -> color map for one frame at the current origin. */
  private target(frameIdx: number): Map<string, string> {
    const m = new Map<string, string>();
    for (const p of this.frames[frameIdx]!) {
      m.set(`${this.origin.x + p.x},${this.origin.y + p.y}`, p.color);
    }
    return m;
  }

  /**
   * Diff the target frame against the journal: pay ONLY for cells whose
   * color changes, and erase journal cells the sprite no longer covers.
   */
  private diff(target: Map<string, string>): PixelPaint[] {
    const batch: PixelPaint[] = [];
    for (const [k, color] of target) {
      if (this.journal.cells[k] !== color) batch.push(toPixel(k, color));
    }
    for (const k of Object.keys(this.journal.cells)) {
      if (!target.has(k) && this.journal.cells[k] !== this.backgroundColor) {
        batch.push(toPixel(k, this.backgroundColor));
      }
    }
    return batch;
  }

  /** Paint one frame (diffed). Returns false when the budget stops the loop. */
  private async paintFrame(frameIdx: number): Promise<boolean> {
    const target = this.target(frameIdx);
    const batch = this.diff(target);
    if (batch.length === 0) return true; // canvas already matches — free frame

    const spent = BigInt(this.journal.spent);
    if (spent >= this.budgetAtomic) {
      this.log(`creature: budget exhausted (${usdcStr(spent)} USDC spent) — stopping`);
      return false;
    }

    // Owner-aware quote: self-owned cells price at the flat base (1.2.0).
    const quote = await this.client.quote(
      batch,
      this.client.address ? { payer: this.client.address } : undefined,
    );
    const cost = BigInt(quote.total);
    if (spent + cost > this.budgetAtomic) {
      this.log(
        `creature: next frame costs ${quote.totalUsdc} USDC but only ` +
          `${usdcStr(this.budgetAtomic - spent)} USDC of budget remains — stopping gracefully`,
      );
      return false;
    }

    const key = `creature-${this.journal.runId}-${this.journal.framesPainted}`;
    const result = await this.client.paint(batch, {
      maxTotal: cost,
      idempotencyKey: key,
      ...(this.network ? { network: this.network } : {}),
    });

    for (const [k, c] of target) this.journal.cells[k] = c;
    for (const k of Object.keys(this.journal.cells)) {
      if (!target.has(k)) this.journal.cells[k] = this.backgroundColor;
    }
    this.journal.spent = (BigInt(this.journal.spent) + BigInt(result.totalPaid)).toString();
    this.journal.framesPainted++;
    this.saveJournal();
    this.log(
      `creature: frame ${this.journal.framesPainted} (${batch.length}px diff) paid ` +
        `${result.totalPaidUsdc} USDC — total ${usdcStr(BigInt(this.journal.spent))}/${usdcStr(this.budgetAtomic)} USDC`,
    );
    return true;
  }

  /**
   * Start the frame loop: paint the next frame in the cycle, sleep
   * heartbeatMs, repeat. Stops gracefully when the budget is exhausted or
   * stop() is called. The returned promise resolves when the loop ends.
   */
  start(): Promise<void> {
    if (this.running) return this.loop!;
    this.running = true;
    this.loop = (async () => {
      let cursor = this.journal.framesPainted;
      while (this.running) {
        const frameIdx = cursor % this.frames.length;
        try {
          const ok = await this.paintFrame(frameIdx);
          if (!ok) break;
          cursor++;
        } catch (err) {
          this.log(`creature: frame failed (${(err as Error).message}) — retrying next heartbeat`);
        }
        if (!this.running) break;
        await this.sleep(this.heartbeatMs);
      }
      this.running = false;
    })();
    return this.loop;
  }

  /** Stop the frame loop (wakes any pending heartbeat sleep). */
  stop(): void {
    this.running = false;
    this.wake?.();
  }

  /**
   * Shift the creature's origin by (dx, dy). Old cells no longer covered by
   * the sprite are erased to the background color on the next frame (the
   * diff step handles the cleanup — no dark smear left behind).
   */
  move(dx: number, dy: number): void {
    this.origin = { x: this.origin.x + dx, y: this.origin.y + dy };
  }

  status(): CreatureStatus {
    const spent = BigInt(this.journal.spent);
    const remaining = this.budgetAtomic > spent ? this.budgetAtomic - spent : 0n;
    return {
      frames: this.journal.framesPainted,
      spent: Number(spent) / 1e6,
      position: { ...this.origin },
      running: this.running,
      remaining: Number(remaining) / 1e6,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }
}

function toPixel(key: string, color: string): PixelPaint {
  const [x, y] = key.split(",").map(Number) as [number, number];
  return { x, y, color };
}

function usdcStr(atomic: bigint): string {
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${atomic / 1_000_000n}${frac ? `.${frac}` : ""}`;
}
