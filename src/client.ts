import { randomUUID } from "node:crypto";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  PaymentRejectedError,
  PriceChangedError,
  type ActivityEvent,
  type CanvasMeta,
  type Leaderboard,
  type LivePaintEvent,
  type PaintResult,
  type PaymentRequired,
  type PaymentRequirements,
  type PixelInfo,
  type PixelPaint,
  type Quote,
  type Stats,
} from "./types.js";

const CHAIN_IDS: Record<string, number> = {
  "base-sepolia": 84532,
  base: 8453,
};

export interface PixelWarClientOptions {
  /** API base URL, e.g. https://api.pixelwar.xyz */
  baseUrl?: string;
  /** Hex private key for signing x402 payments (funded with USDC on Base). */
  privateKey?: `0x${string}`;
  /**
   * Force mock payments (no key needed). Defaults to auto-detect from the
   * server's payment mode.
   */
  mock?: boolean;
  /** Re-quote and retry this many times when a price changes mid-flight. */
  maxRepriceRetries?: number;
}

export class PixelWarClient {
  readonly baseUrl: string;
  private account: PrivateKeyAccount | null;
  private mock: boolean | null;
  private maxRepriceRetries: number;
  private metaCache: CanvasMeta | null = null;

  constructor(opts: PixelWarClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.pixelwar.xyz").replace(/\/$/, "");
    this.account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null;
    this.mock = opts.mock ?? null;
    this.maxRepriceRetries = opts.maxRepriceRetries ?? 0;
  }

  /** The wallet address used for payments. */
  get address(): string | null {
    return this.account?.address ?? null;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  // --- free reads ------------------------------------------------------------

  async meta(): Promise<CanvasMeta> {
    this.metaCache ??= await this.get<CanvasMeta>("/v1/canvas/meta");
    return this.metaCache;
  }

  pixel(x: number, y: number): Promise<PixelInfo> {
    return this.get(`/v1/pixels/${x}/${y}`);
  }

  history(x: number, y: number) {
    return this.get<{ events: unknown[] }>(`/v1/pixels/${x}/${y}/history`);
  }

  stats(): Promise<Stats> {
    return this.get("/v1/stats");
  }

  leaderboard(): Promise<Leaderboard> {
    return this.get("/v1/leaderboard");
  }

  recentEvents(): Promise<{ events: ActivityEvent[] }> {
    return this.get("/v1/events/recent");
  }

  /** Full canvas snapshot as PNG bytes. */
  async canvasPng(): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/v1/canvas.png`);
    if (!res.ok) throw new Error(`canvas.png: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  quote(pixels: PixelPaint[]): Promise<Quote> {
    return this.post("/v1/quote", { pixels });
  }

  // --- the paid action ---------------------------------------------------------

  /**
   * Paint pixels through the full x402 flow:
   * request → 402 challenge → sign payment → retry with X-PAYMENT.
   * Retries on price changes up to maxRepriceRetries times.
   */
  async paint(pixels: PixelPaint[]): Promise<PaintResult> {
    let attempt = 0;
    for (;;) {
      const challenge = await this.paintChallenge(pixels);
      const req = challenge.accepts[0];
      if (!req) throw new Error("server returned no payment requirements");

      const header = (await this.isMock())
        ? this.buildMockPayment(req)
        : await this.signPayment(req);

      try {
        return await this.paintWithPayment(pixels, header);
      } catch (err) {
        if (err instanceof PriceChangedError && attempt < this.maxRepriceRetries) {
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  private async paintChallenge(pixels: PixelPaint[]): Promise<PaymentRequired> {
    const res = await fetch(`${this.baseUrl}/v1/paint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pixels }),
    });
    if (res.status !== 402) {
      throw new Error(`expected 402 challenge, got ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as PaymentRequired;
  }

  private async paintWithPayment(
    pixels: PixelPaint[],
    paymentHeader: string,
  ): Promise<PaintResult> {
    const res = await fetch(`${this.baseUrl}/v1/paint`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment": paymentHeader,
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ pixels }),
    });
    const body = (await res.json()) as PaintResult & PaymentRequired & { message?: string };
    if (res.status === 402) {
      if (body.error?.startsWith("quote expired")) throw new PriceChangedError(body);
      throw new PaymentRejectedError(body);
    }
    if (!res.ok) throw new Error(body.message ?? `paint failed: ${res.status}`);
    return body;
  }

  // --- x402 signing --------------------------------------------------------------

  private async isMock(): Promise<boolean> {
    if (this.mock !== null) return this.mock;
    const meta = await this.meta();
    this.mock = meta.paymentMode === "mock";
    return this.mock;
  }

  private async signPayment(req: PaymentRequirements): Promise<string> {
    if (!this.account) {
      throw new Error(
        "no privateKey configured — required for real x402 payments (or use mock mode)",
      );
    }
    const chainId = CHAIN_IDS[req.network];
    if (!chainId) throw new Error(`unknown network: ${req.network}`);

    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;
    const authorization = {
      from: this.account.address,
      to: req.payTo as `0x${string}`,
      value: BigInt(req.maxAmountRequired),
      validAfter: BigInt(now - 60),
      validBefore: BigInt(now + (req.maxTimeoutSeconds || 120)),
      nonce,
    };

    const signature = await this.account.signTypedData({
      domain: {
        name: req.extra.name,
        version: req.extra.version,
        chainId,
        verifyingContract: req.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: authorization,
    });

    return this.encodeHeader(signature, {
      ...authorization,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
    }, req.network);
  }

  private buildMockPayment(req: PaymentRequirements): string {
    const from = this.account?.address ?? "0xA9E0770001111111111111111111111111111111";
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`;
    return this.encodeHeader("0xmock", {
      from,
      to: req.payTo,
      value: req.maxAmountRequired,
      validAfter: String(now - 60),
      validBefore: String(now + 120),
      nonce,
    }, req.network);
  }

  private encodeHeader(
    signature: string,
    authorization: Record<string, string>,
    network: string,
  ): string {
    return Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        network,
        payload: { signature, authorization },
      }),
    ).toString("base64");
  }

  // --- live feed -------------------------------------------------------------------

  /**
   * Subscribe to the live paint feed. Returns an unsubscribe function.
   * Works in Node (ws package) and browsers (native WebSocket).
   */
  async live(handlers: {
    onPaint?: (event: LivePaintEvent) => void;
    onDelta?: (bytes: Uint8Array) => void;
    onClose?: () => void;
  }): Promise<() => void> {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/v1/live";
    const WebSocketImpl =
      typeof WebSocket !== "undefined" ? WebSocket : (await import("ws")).default;
    const ws = new WebSocketImpl(wsUrl) as WebSocket;
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        handlers.onDelta?.(new Uint8Array(e.data));
      } else {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.type === "paint") handlers.onPaint?.(msg);
        } catch { /* ignore */ }
      }
    };
    ws.onclose = () => handlers.onClose?.();
    return () => ws.close();
  }
}
