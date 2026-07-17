import { randomUUID } from "node:crypto";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  DoNotRepayError,
  InsufficientBalanceError,
  PaymentRejectedError,
  PriceChangedError,
  SpendLimitError,
  type ActivityEvent,
  type CanvasMeta,
  type HistoryOptions,
  type HistoryPage,
  type Leaderboard,
  type LivePaintEvent,
  type PaintResult,
  type PaymentRequired,
  type PaymentRequirements,
  type PixelHistoryEvent,
  type PixelInfo,
  type PixelPaint,
  type PlatformEvent,
  type Quote,
  type Stats,
  type WalletCareer,
  type WalletPayout,
} from "./types.js";

const CHAIN_IDS: Record<string, number> = {
  "base-sepolia": 84532,
  base: 8453,
  "arbitrum-sepolia": 421614,
  arbitrum: 42161,
  "polygon-amoy": 80002,
  polygon: 137,
};

/** Deterministic payer used for mock-mode payments when no key is configured. */
const MOCK_FALLBACK_PAYER = "0xA9E0770001111111111111111111111111111111";

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
  /**
   * Re-sign and retry this many times on a clean `settlement_failed`
   * rejection (transient facilitator failure — the server guarantees no
   * funds moved and frees the batch). Default 2. Never applies to
   * `do_not_repay` outcomes, which are never retried.
   */
  maxSettleRetries?: number;
  /**
   * JSON-RPC endpoint for the soft pre-sign USDC balance check. Defaults to
   * a public RPC for the chain being paid on; the check is skipped when the
   * RPC is unreachable. NOTE: this single override applies to EVERY chain —
   * when paying on a non-default `network`, point it at THAT chain's RPC (a
   * wrong-chain RPC makes the check silently skip).
   */
  rpcUrl?: string;
}

/** Public RPCs used for the soft balance pre-check (overridable via rpcUrl). */
const DEFAULT_RPC: Record<string, string> = {
  "base-sepolia": "https://sepolia.base.org",
  base: "https://mainnet.base.org",
  "arbitrum-sepolia": "https://sepolia-rollup.arbitrum.io/rpc",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  // publicnode endpoints: the official rpc-amoy.polygon.technology and
  // polygon-rpc.com were both dead/keyless when probed (2026-07-17).
  "polygon-amoy": "https://polygon-amoy-bor-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
};

export class PixelWarClient {
  readonly baseUrl: string;
  private account: PrivateKeyAccount | null;
  private mock: boolean | null;
  private maxRepriceRetries: number;
  private maxSettleRetries: number;
  private rpcUrl: string | undefined;
  private metaCache: CanvasMeta | null = null;

  constructor(opts: PixelWarClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.pixelwar.xyz").replace(/\/$/, "");
    this.account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null;
    this.mock = opts.mock ?? null;
    this.maxRepriceRetries = opts.maxRepriceRetries ?? 0;
    this.maxSettleRetries = opts.maxSettleRetries ?? 2;
    this.rpcUrl = opts.rpcUrl;
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

  /** Paint history of one pixel (its war record), most recent first. */
  pixelHistory(x: number, y: number): Promise<{ events: PixelHistoryEvent[] }> {
    return this.get(`/v1/pixels/${x}/${y}/history`);
  }

  /**
   * The append-only platform event log, cursor-paginated and replayable from
   * genesis (`GET /v1/history`). Pass `page.nextCursor` back as `after` until
   * it is null.
   *
   * Backward-compatible overload: `history(x, y)` with two numbers still
   * returns the single-pixel paint history (same as `pixelHistory`).
   */
  history(opts?: HistoryOptions): Promise<HistoryPage>;
  /** @deprecated use `pixelHistory(x, y)` */
  history(x: number, y: number): Promise<{ events: PixelHistoryEvent[] }>;
  history(
    optsOrX?: HistoryOptions | number,
    y?: number,
  ): Promise<HistoryPage> | Promise<{ events: PixelHistoryEvent[] }> {
    if (typeof optsOrX === "number" && typeof y === "number") {
      return this.pixelHistory(optsOrX, y);
    }
    const opts = (optsOrX as HistoryOptions | undefined) ?? {};
    const q = new URLSearchParams();
    if (opts.after !== undefined) q.set("after", String(opts.after));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.type) q.set("type", opts.type);
    if (opts.wallet) q.set("wallet", opts.wallet);
    const qs = q.toString();
    return this.get<HistoryPage>(`/v1/history${qs ? `?${qs}` : ""}`);
  }

  /** Daily bulk dump of the event log (`GET /v1/export/{day}.ndjson`), parsed. */
  async exportDay(day: string): Promise<PlatformEvent[]> {
    const res = await fetch(`${this.baseUrl}/v1/export/${day}.ndjson`);
    if (!res.ok) throw new Error(`export ${day}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as PlatformEvent);
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

  // --- wallets / careers ------------------------------------------------------

  /** Public career of any wallet: territory, spend, conquest spoils. */
  wallet(address: string): Promise<WalletCareer> {
    return this.get(`/v1/wallets/${address.toLowerCase()}`);
  }

  /** Recent on-chain payouts (conquest spoils and refunds) to a wallet. */
  walletPayouts(address: string): Promise<{ payouts: WalletPayout[] }> {
    return this.get(`/v1/wallets/${address.toLowerCase()}/payouts`);
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
   *
   * `maxTotal` (atomic USDC) is a hard spend ceiling: the client never signs
   * a challenge above it, including reprice retries where prices may have
   * doubled since your quote. Always pass it when the amount matters.
   *
   * The Idempotency-Key is stable for the whole call (including reprice
   * retries), so a response lost to the network can be retried by calling
   * paint() again with the same key via `idempotencyKey` — the server
   * replays the original result instead of charging twice.
   */
  async paint(
    pixels: PixelPaint[],
    opts: { maxTotal?: bigint | string; idempotencyKey?: string; network?: string } = {},
  ): Promise<PaintResult> {
    let ceiling: bigint | null = null;
    if (opts.maxTotal !== undefined) {
      try {
        ceiling = BigInt(opts.maxTotal);
      } catch {
        throw new Error(
          `maxTotal must be ATOMIC USDC (integer, e.g. quote.total = "10000"); got "${opts.maxTotal}" — a decimal like quote.totalUsdc will not work`,
        );
      }
    }
    const idempotencyKey = opts.idempotencyKey ?? randomUUID();

    // Recovery path: with an explicitly supplied key, first check whether the
    // server already executed this paint (a previous response may have been
    // lost). This never builds a payment, so it works even when prices have
    // since doubled past the spend ceiling. Works in mock mode too — the
    // server keys records by the payer we'd pay as.
    if (opts.idempotencyKey) {
      const payerForReplay = this.account?.address ?? (this.mock ? MOCK_FALLBACK_PAYER : null);
      if (payerForReplay) {
        const replayed = await this.fetchReplay(opts.idempotencyKey, payerForReplay);
        if (replayed) return replayed;
      }
    }

    let attempt = 0;
    let settleAttempt = 0;
    for (;;) {
      const challenge = await this.paintChallenge(pixels);
      // Pick the requested chain from the 402's accepts list, else the first
      // (server lists them in priority order, primary first).
      const req = opts.network
        ? challenge.accepts.find((a) => a.network === opts.network)
        : challenge.accepts[0];
      if (!req) {
        const offered = challenge.accepts.map((a) => a.network).join(", ");
        throw new Error(
          opts.network
            ? `network "${opts.network}" not offered by the server (accepts: ${offered})`
            : "server returned no payment requirements",
        );
      }

      const required = BigInt(req.maxAmountRequired);
      if (ceiling !== null && required > ceiling) {
        throw new SpendLimitError(required, ceiling);
      }

      const mock = await this.isMock();
      if (!mock) await this.assertBalance(req);
      const header = mock ? this.buildMockPayment(req) : await this.signPayment(req);

      try {
        return await this.paintWithPayment(pixels, header, idempotencyKey);
      } catch (err) {
        if (err instanceof PriceChangedError && attempt < this.maxRepriceRetries) {
          attempt++;
          continue;
        }
        // A clean settlement failure is the server's explicit "no funds
        // moved, batch unlocked, safe to sign again" — the pending payment
        // row is deleted and the idempotency gate freed, so retrying under
        // the SAME key with a fresh signature cannot double-charge (and the
        // key still replays any earlier success). do_not_repay outcomes
        // raise DoNotRepayError and are never retried.
        if (
          err instanceof PaymentRejectedError &&
          err.response.error === "settlement_failed" &&
          settleAttempt < this.maxSettleRetries
        ) {
          settleAttempt++;
          await new Promise((r) => setTimeout(r, 1500 * 2 ** (settleAttempt - 1)));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Soft pre-sign check that the wallet's USDC covers the challenge amount —
   * turns "balance too low" into a clear local error BEFORE anything is
   * signed, instead of a settlement failure after the payment round-trip.
   * Soft: any RPC problem skips the check (settlement stays the source of
   * truth).
   */
  private async assertBalance(req: PaymentRequirements): Promise<void> {
    if (!this.account) return;
    const rpc = this.rpcUrl ?? DEFAULT_RPC[req.network];
    if (!rpc) return;
    let balance: bigint;
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Bounded: a hung public RPC must not stall the challenge→sign window
        // (the parked quote and authorization validity are both time-limited).
        signal: AbortSignal.timeout(3_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            {
              to: req.asset,
              // balanceOf(address) selector + the wallet address, ABI-padded.
              data: `0x70a08231${this.account.address.slice(2).toLowerCase().padStart(64, "0")}`,
            },
            "latest",
          ],
        }),
      });
      const body = (await res.json()) as { result?: unknown };
      if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) return;
      balance = BigInt(body.result);
    } catch {
      return;
    }
    const required = BigInt(req.maxAmountRequired);
    if (balance < required) {
      throw new InsufficientBalanceError(balance, required, req.asset);
    }
  }

  /**
   * Look up the stored result of a previous paint by its Idempotency-Key
   * (`GET /v1/paints/replay`). Returns null when the server has no stored
   * result (yet). Never constructs or signs a payment — this is the ONLY
   * safe recovery call after a DoNotRepayError.
   *
   * Throws when no wallet is configured in real-payment mode: results are
   * keyed by (key, payer), so answering null there would be a false
   * "never landed" that invites a double-pay.
   */
  async paintReplay(idempotencyKey: string): Promise<PaintResult | null> {
    const payer = this.account?.address ?? ((await this.isMock()) ? MOCK_FALLBACK_PAYER : null);
    if (!payer) {
      throw new Error(
        "cannot look up a replay without a wallet: results are keyed by (key, payer) — configure the SAME privateKey that made the payment",
      );
    }
    return this.fetchReplay(idempotencyKey, payer);
  }

  /** Look up the stored result of a previous paint by Idempotency-Key. */
  private async fetchReplay(key: string, payer: string): Promise<PaintResult | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/paints/replay?key=${encodeURIComponent(key)}&payer=${payer}`,
      );
      if (res.status === 200) return (await res.json()) as PaintResult;
    } catch { /* endpoint unavailable — fall through to the normal flow */ }
    return null;
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
    idempotencyKey: string,
  ): Promise<PaintResult> {
    const res = await fetch(`${this.baseUrl}/v1/paint`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment": paymentHeader,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ pixels }),
    });
    // Never let a non-JSON error body (LB error page) mask the real status —
    // especially after the payment header has been submitted.
    let body: PaintResult & PaymentRequired & { message?: string; code?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error(
        `paint response unreadable (HTTP ${res.status}) — payment outcome uncertain, retry with the same idempotencyKey ("${idempotencyKey}")`,
      );
    }
    if (res.status === 402) {
      if (
        body.code === "quote_expired" ||
        (typeof body.error === "string" && body.error.startsWith("quote expired"))
      ) {
        throw new PriceChangedError(body);
      }
      throw new PaymentRejectedError(body);
    }
    if (!res.ok) {
      if (body.error === "idempotency_conflict") {
        throw new Error(
          `idempotency key "${idempotencyKey}" was already used with a DIFFERENT batch — reuse a key only for retries of the exact same pixels`,
        );
      }
      // The one code that must never be swallowed: funds may already have
      // moved, so callers need to distinguish "safe to re-sign" from this.
      if (body.code === "do_not_repay") {
        throw new DoNotRepayError(
          body.message ?? body.error ?? `paint failed: ${res.status}`,
          body.error,
        );
      }
      throw new Error(body.message ?? body.error ?? `paint failed: ${res.status}`);
    }
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
    const from = this.account?.address ?? MOCK_FALLBACK_PAYER;
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
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
    /** Connection-level failure (refused, dropped). Fires before onClose. */
    onError?: (message: string) => void;
  }): Promise<() => void> {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/v1/live";
    const WebSocketImpl =
      typeof WebSocket !== "undefined" ? WebSocket : (await import("ws")).default;
    const ws = new WebSocketImpl(wsUrl) as WebSocket;
    ws.binaryType = "arraybuffer";
    let closed = false;
    const notifyClose = () => {
      if (closed) return;
      closed = true;
      handlers.onClose?.();
    };
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
    // Without an error handler, the ws package (Node <22 fallback) raises an
    // unhandled 'error' event and crashes the process on ECONNREFUSED.
    ws.onerror = (evt: Event & { message?: string; error?: Error }) => {
      handlers.onError?.(evt.message ?? evt.error?.message ?? "websocket error");
      notifyClose();
    };
    ws.onclose = () => notifyClose();
    return () => ws.close();
  }
}
