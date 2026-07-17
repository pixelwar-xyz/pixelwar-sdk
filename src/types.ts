export interface PixelPaint {
  x: number;
  y: number;
  /** #RRGGBB */
  color: string;
}

/** Versioned economy ruleset (changes announced ≥14 days ahead, never retroactive). */
export interface Ruleset {
  version: string;
  announcedAt: string;
  effectiveFrom: string;
  /** Price multiplier per overpaint, e.g. "1.5". */
  growth: string;
  /** Percent of every overpaint payment sent on-chain to the dispossessed owner, e.g. "80". */
  ownerSharePct: string;
  /** Idle days before a pixel's price starts decaying. */
  decayGraceDays: number;
  /** Days per halving once decay has started. */
  decayHalfLifeDays: number;
}

export interface CanvasMeta {
  width: number;
  height: number;
  basePrice: string;
  basePriceUsdc: string;
  priceRule: string;
  ruleset: Ruleset;
  network: string;
  paymentMode: "mock" | "x402";
  asset: string;
}

export interface PixelInfo {
  x: number;
  y: number;
  color: string;
  owner: string | null;
  /** CURRENT price to paint this pixel — decay already applied, atomic USDC. */
  price: string;
  priceUsdc: string;
  /** What the current owner paid (their stake), atomic USDC; null if virgin. */
  lastPaid: string | null;
  paintCount: number;
  lastPaintedAt: string | null;
}

export interface Quote {
  pixels: { x: number; y: number; price: string; priceUsdc: string }[];
  total: string;
  totalUsdc: string;
  network: string;
  asset: string;
}

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string; requestHash: string };
}

export interface PaymentRequired {
  x402Version: number;
  error: string;
  /** Machine-readable rejection code, e.g. "quote_expired". */
  code?: string;
  accepts: PaymentRequirements[];
  quote: { total: string; totalUsdc: string; pixelCount: number };
}

export interface PaintedPixel {
  x: number;
  y: number;
  color: string;
  /** Actually charged (decayed) price, atomic USDC. */
  pricePaid: string;
  previousOwner: string | null;
  /** 80% of pricePaid, paid on-chain to previousOwner (conquest spoils); "0" for virgin pixels. */
  spoils: string;
  /** Undecayed price of the NEXT overpaint. */
  nextPrice: string;
}

export interface PaintResult {
  painted: number;
  /** Sum of the recomputed (decayed) per-pixel prices actually charged, atomic USDC. */
  totalPaid: string;
  totalPaidUsdc: string;
  /** Amount settled over x402 (the signed authorization), atomic USDC. */
  settledAmount: string;
  /** settledAmount − totalPaid; when > 0 (decay between quote and payment) it is sent back on-chain. */
  refund: string;
  txHash: string | null;
  paymentId: string;
  pixels: PaintedPixel[];
}

export interface Stats {
  paintedPixels: number;
  totalPaints: number;
  totalSpent: string;
  totalSpentUsdc: string;
  /** Total conquest spoils paid to dispossessed owners. */
  totalSpoils: string;
  totalSpoilsUsdc: string;
  uniquePainters: number;
  mostExpensivePixel: { x: number; y: number; price: string; priceUsdc: string } | null;
  lastCommitment: {
    day: string;
    canvasHash: string;
    logMerkleRoot: string | null;
    txHash: string | null;
  } | null;
}

export interface Leaderboard {
  bySpent: { wallet: string; spent: string; spentUsdc: string; paints: number }[];
  byOwned: { wallet: string; pixelsOwned: number }[];
  bySpoils: { wallet: string; spoils: string; spoilsUsdc: string }[];
  /** Pixels taken from another wallet. */
  byConquests: { wallet: string; conquests: number }[];
}

/** One row of GET /v1/events/recent. */
export interface ActivityEvent {
  x: number;
  y: number;
  color: string;
  painter: string;
  pricePaid: string;
  pricePaidUsdc: string;
  spoils: string;
  spoilsUsdc: string;
  previousOwner: string | null;
  /** Groups pixels of one paid batch. */
  paymentId: string;
  at: string;
}

/** One row of GET /v1/pixels/{x}/{y}/history. */
export interface PixelHistoryEvent {
  color: string;
  painter: string;
  pricePaid: string;
  pricePaidUsdc: string;
  spoils: string;
  previousOwner: string | null;
  at: string;
}

export interface LivePaintPixel {
  x: number;
  y: number;
  color: string;
  priceUsdc: string;
  pricePaid: string;
  spoils: string;
  spoilsUsdc: string;
  previousOwner: string | null;
  nextPrice: string;
}

export interface LivePaintEvent {
  type: "paint";
  paymentId: string;
  /** Color of the batch's first pixel (feed icon). */
  color: string;
  painter: string;
  pixelCount: number;
  totalPaid: string;
  totalPaidUsdc: string;
  txHash: string | null;
  at: string;
  pixels: LivePaintPixel[];
}

// --- wallets / careers ---------------------------------------------------------

/** Public career of a wallet (GET /v1/wallets/{address}). */
export interface WalletCareer {
  address: string;
  /** Territory currently held. */
  pixelsOwned: number;
  paints: number;
  totalSpent: string;
  totalSpentUsdc: string;
  /** Lifetime conquest spoils owed to this wallet. */
  totalSpoils: string;
  totalSpoilsUsdc: string;
  /** Spoils queued but not yet transferred on-chain, atomic USDC. */
  spoilsPending: string;
  /** Off-path funding-graph label; labeled, never blocked. */
  clusterLabel: string | null;
}

/** One on-chain payout receipt (GET /v1/wallets/{address}/payouts). */
export interface WalletPayout {
  id: string;
  kind: "spoils" | "refund";
  amount: string;
  amountUsdc: string;
  status: "pending" | "sending" | "sent" | "failed";
  txHash: string | null;
  createdAt: string;
  sentAt: string | null;
}


// --- platform event log ----------------------------------------------------------

/** One row of the append-only platform event log (GET /v1/history). */
export interface PlatformEvent {
  id: string;
  ts: string;
  type: string;
  wallet: string | null;
  payload: unknown;
}

export interface HistoryPage {
  events: PlatformEvent[];
  /** Pass as `after` to fetch the next page; null when you are caught up. */
  nextCursor: string | null;
}

export interface HistoryOptions {
  /** Return events with id strictly greater than this cursor. */
  after?: string | number | bigint;
  /** 1-1000, default 100. */
  limit?: number;
  /** Filter by event type, e.g. "paint". */
  type?: string;
  /** Filter by attributed wallet. */
  wallet?: string;
}

// --- errors ------------------------------------------------------------------------

export class PriceChangedError extends Error {
  constructor(public readonly freshQuote: PaymentRequired) {
    super(
      `pixel prices changed since quote: new total ${freshQuote?.quote?.totalUsdc ?? "?"} USDC`,
    );
    this.name = "PriceChangedError";
  }
}

export class SpendLimitError extends Error {
  constructor(
    public readonly required: bigint,
    public readonly limit: bigint,
  ) {
    super(
      `payment of ${required} atomic USDC exceeds the configured limit of ${limit} — refusing to sign`,
    );
    this.name = "SpendLimitError";
  }
}

export class PaymentRejectedError extends Error {
  constructor(public readonly response: PaymentRequired) {
    super(`payment rejected: ${response.error}`);
    this.name = "PaymentRejectedError";
  }
}

/**
 * Raised BEFORE signing when the wallet's USDC balance can't cover the
 * challenge amount (soft pre-check against a public RPC). Nothing was signed
 * or sent — top up the wallet or split the batch below the balance.
 */
export class InsufficientBalanceError extends Error {
  constructor(
    public readonly balance: bigint,
    public readonly required: bigint,
    /** USDC contract the balance was checked against. */
    public readonly asset: string,
  ) {
    super(
      `wallet holds ${balance} atomic USDC but this batch needs ${required} — top up or split the batch (nothing was signed)`,
    );
    this.name = "InsufficientBalanceError";
  }
}

/**
 * The server reported a machine-readable `code: "do_not_repay"` after the
 * payment header was submitted (settlement_outcome_unknown or
 * paint_apply_failed): funds may already have moved and the payment is held
 * for reconciliation. NEVER sign a new payment for this batch — poll the
 * stored result via `PixelWarClient.paintReplay(idempotencyKey)` instead.
 */
export class DoNotRepayError extends Error {
  /** Machine-readable code from the error body, always "do_not_repay". */
  readonly code = "do_not_repay" as const;
  constructor(
    message: string,
    /** The server's error identifier, e.g. "settlement_outcome_unknown" or "paint_apply_failed". */
    public readonly serverError?: string,
  ) {
    super(message);
    this.name = "DoNotRepayError";
  }
}
