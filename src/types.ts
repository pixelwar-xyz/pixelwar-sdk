export interface PixelPaint {
  x: number;
  y: number;
  /** #RRGGBB */
  color: string;
}

export interface CanvasMeta {
  width: number;
  height: number;
  basePrice: string;
  basePriceUsdc: string;
  priceRule: string;
  network: string;
  paymentMode: "mock" | "x402";
  asset: string;
}

export interface PixelInfo {
  x: number;
  y: number;
  color: string;
  owner: string | null;
  price: string;
  priceUsdc: string;
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
  accepts: PaymentRequirements[];
  quote: { total: string; totalUsdc: string; pixelCount: number };
}

export interface PaintResult {
  painted: number;
  totalPaid: string;
  totalPaidUsdc: string;
  txHash: string | null;
  paymentId: string;
  pixels: { x: number; y: number; color: string; pricePaid: string }[];
}

export interface Stats {
  paintedPixels: number;
  totalPaints: number;
  totalSpent: string;
  totalSpentUsdc: string;
  uniquePainters: number;
  mostExpensivePixel: { x: number; y: number; price: string; priceUsdc: string } | null;
  lastCommitment: { day: string; canvasHash: string; txHash: string | null } | null;
}

export interface Leaderboard {
  bySpent: { wallet: string; spent: string; spentUsdc: string; paints: number }[];
  byOwned: { wallet: string; pixelsOwned: number }[];
}

export interface ActivityEvent {
  x: number;
  y: number;
  color: string;
  painter: string;
  pricePaid: string;
  pricePaidUsdc: string;
  at: string;
}

export interface LivePaintEvent {
  type: "paint";
  /** Color of the batch's first pixel (feed icon). */
  color: string;
  painter: string;
  pixelCount: number;
  totalPaid: string;
  totalPaidUsdc: string;
  txHash: string | null;
  at: string;
  pixels: { x: number; y: number }[];
}

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
