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
const MOCK_SVM_PAYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PB5jyz1";

/**
 * A payment entry normalized across x402 v1 (friendly network ids, X-PAYMENT)
 * and v2 (CAIP-2 ids, PAYMENT-SIGNATURE). `network` is the friendly id when
 * the chain is known to CHAIN_IDS (keeps balance checks and messages
 * readable), the raw CAIP-2 id otherwise.
 */
interface SelectedPayment {
  version: 1 | 2;
  vm: "evm" | "svm";
  headerName: "x-payment" | "payment-signature";
  network: string;
  chainId: number | undefined;
  amount: string;
  /** EVM: USDC contract. SVM: SPL mint. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** EVM: {name, version, requestHash}. SVM: {feePayer, memo}. */
  extra: Record<string, string | undefined>;
  /** v2 only: the original accepted entry + resource, echoed in the envelope. */
  v2?: { accepted: unknown; resource?: unknown };
}

/** CAIP-2 ids of Solana networks this SDK build knows, → friendly id. */
const SVM_CAIP2: Record<string, string> = {
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "solana-devnet",
};
const SVM_RPC: Record<string, string> = {
  "solana-devnet": "https://api.devnet.solana.com",
};

export interface PixelWarClientOptions {
  /** API base URL, e.g. https://api.pixelwar.xyz */
  baseUrl?: string;
  /** Hex private key for signing x402 payments on EVM chains (funded with USDC). */
  privateKey?: `0x${string}`;
  /** base58 secret key for paying on Solana networks (funded with SPL USDC + a little SOL). */
  solanaPrivateKey?: string;
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
  private solanaSecret: string | undefined;
  private mock: boolean | null;
  private maxRepriceRetries: number;
  private maxSettleRetries: number;
  private rpcUrl: string | undefined;
  private metaCache: CanvasMeta | null = null;

  constructor(opts: PixelWarClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.pixelwar.xyz").replace(/\/$/, "");
    this.account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null;
    this.solanaSecret = opts.solanaPrivateKey;
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
      // Recover under whichever wallet we'd pay as. Prefer the EVM account;
      // fall back to the Solana pubkey when only a Solana key is configured
      // (so a solana-only client can still recover a lost result).
      const payerForReplay =
        this.account?.address ??
        (this.solanaSecret ? (await this.solanaKeypair()).publicKey.toBase58() : null) ??
        (this.mock ? MOCK_FALLBACK_PAYER : null);
      if (payerForReplay) {
        const replayed = await this.fetchReplay(opts.idempotencyKey, payerForReplay);
        if (replayed) return replayed;
      }
    }

    let attempt = 0;
    let settleAttempt = 0;
    for (;;) {
      const challenge = await this.paintChallenge(pixels);
      const req = this.selectPayment(challenge, opts.network);

      const required = BigInt(req.amount);
      if (ceiling !== null && required > ceiling) {
        throw new SpendLimitError(required, ceiling);
      }

      const mock = await this.isMock();
      if (!mock) await this.assertBalance(req);
      const header = mock ? await this.buildMockPayment(req) : await this.signPayment(req);

      try {
        return await this.paintWithPayment(pixels, header, idempotencyKey, req.headerName);
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
  private async assertBalance(req: SelectedPayment): Promise<void> {
    // SVM balance pre-check is skipped (soft): settlement remains the source
    // of truth, and the SPL balance lookup would add another dependency path.
    if (req.vm === "svm") return;
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
    const required = BigInt(req.amount);
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

  /**
   * Pick the payment entry for `wanted` (friendly id like "arbitrum-sepolia",
   * or a CAIP-2 id) across BOTH protocol generations offered by the 402:
   * v1 entries are preferred where available (battle-tested path); a chain
   * offered only in the v2 header (e.g. arbitrum-sepolia) is paid via v2.
   * Everything downstream consumes the normalized SelectedPayment.
   */
  private selectPayment(challenge: PaymentRequired, wanted?: string): SelectedPayment {
    const fromV1 = (a: PaymentRequirements): SelectedPayment => ({
      version: 1,
      vm: "evm",
      headerName: "x-payment",
      network: a.network,
      chainId: CHAIN_IDS[a.network],
      amount: a.maxAmountRequired,
      asset: a.asset,
      payTo: a.payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds,
      extra: a.extra,
    });
    const fromV2 = (a: NonNullable<PaymentRequired["v2"]>["accepts"][number]): SelectedPayment => {
      if (!a || typeof a.network !== "string" || typeof a.amount !== "string" ||
          typeof a.asset !== "string" || typeof a.payTo !== "string") {
        throw new Error("malformed v2 payment entry (missing network/amount/asset/payTo) — refusing to sign");
      }
      // Solana (SVM) v2 entry: base58 mint/payTo, extra {feePayer, memo}.
      const svmFriendly = SVM_CAIP2[a.network];
      if (svmFriendly) {
        const extra = (a.extra ?? {}) as { feePayer?: string; memo?: string };
        if (typeof extra.feePayer !== "string" || typeof extra.memo !== "string") {
          throw new Error(`Solana entry for ${a.network} lacks feePayer/memo in extra — refusing to sign`);
        }
        return {
          version: 2,
          vm: "svm",
          headerName: "payment-signature",
          network: svmFriendly,
          chainId: undefined,
          amount: a.amount,
          asset: a.asset,
          payTo: a.payTo,
          maxTimeoutSeconds: a.maxTimeoutSeconds,
          extra: extra as SelectedPayment["extra"],
          v2: { accepted: a, resource: challenge.v2?.resource },
        };
      }
      const m = /^eip155:(\d+)$/.exec(a.network);
      if (!m) throw new Error(`network "${a.network}" is not a supported chain — this SDK version cannot pay on it`);
      const chainId = Number(m[1]);
      if (!Number.isSafeInteger(chainId) || chainId <= 0) {
        throw new Error(`network "${a.network}" has an out-of-range chain id — refusing to sign`);
      }
      const friendly = Object.entries(CHAIN_IDS).find(([, id]) => id === chainId)?.[0];
      // Allowlist gate (parity with v1): only sign chains this SDK build
      // recognizes. Without this, a malicious/misconfigured/MITM server could
      // name an unlisted chain (e.g. eip155:1 with real mainnet USDC + an
      // attacker payTo) and we'd sign a real authorization on it — with the
      // balance pre-check silently skipped (no DEFAULT_RPC entry).
      if (!friendly) {
        throw new Error(
          `network "${a.network}" is not in this SDK's known chains — refusing to sign. Upgrade the SDK if this chain is legitimately supported.`,
        );
      }
      const extra = (a.extra ?? {}) as { name?: string; version?: string; requestHash?: string };
      if (typeof extra.name !== "string" || typeof extra.version !== "string") {
        throw new Error(`v2 entry for ${a.network} lacks the EIP-712 domain in extra — refusing to sign`);
      }
      return {
        version: 2,
        vm: "evm",
        headerName: "payment-signature",
        network: friendly,
        chainId,
        amount: a.amount,
        asset: a.asset,
        payTo: a.payTo,
        maxTimeoutSeconds: a.maxTimeoutSeconds,
        extra: extra as SelectedPayment["extra"],
        v2: { accepted: a, resource: challenge.v2?.resource },
      };
    };

    const v2accepts = Array.isArray(challenge.v2?.accepts) ? challenge.v2!.accepts : [];
    if (wanted) {
      // Normalize `wanted` to BOTH a friendly id and a CAIP-2 id so a
      // CAIP-2 --network still prefers the v1 (battle-tested) entry when the
      // chain is offered in both generations.
      const wantedCaip2 = wanted.includes(":")
        ? wanted
        : CHAIN_IDS[wanted] !== undefined
          ? `eip155:${CHAIN_IDS[wanted]}`
          : null;
      const caipMatch = /^eip155:(\d+)$/.exec(wantedCaip2 ?? "");
      const wantedFriendly = wanted.includes(":")
        ? (caipMatch ? Object.entries(CHAIN_IDS).find(([, id]) => id === Number(caipMatch[1]))?.[0] : undefined)
        : wanted;
      const v1 = challenge.accepts.find((a) => a.network === wantedFriendly);
      if (v1) return fromV1(v1);
      // Solana: match by friendly id ("solana-devnet") or its CAIP-2 id.
      const wantedSvmCaip2 = wanted.includes(":")
        ? wanted
        : Object.entries(SVM_CAIP2).find(([, friendly]) => friendly === wanted)?.[0];
      const v2 = v2accepts.find((a) => a.network === wantedCaip2 || a.network === wantedSvmCaip2);
      if (v2) return fromV2(v2);
      const offered = [
        ...challenge.accepts.map((a) => a.network),
        ...v2accepts.map((a) => `${a.network} (v2)`),
      ].join(", ");
      throw new Error(`network "${wanted}" not offered by the server (accepts: ${offered})`);
    }
    if (challenge.accepts[0]) return fromV1(challenge.accepts[0]);
    if (v2accepts[0]) return fromV2(v2accepts[0]);
    throw new Error("server returned no payment requirements");
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
    const challenge = (await res.json()) as PaymentRequired;
    // The v2 signal rides a header on the SAME 402; it may offer chains the
    // v1 body can't (v2-only facilitators, e.g. arbitrum-sepolia).
    const v2Header = res.headers.get("payment-required");
    if (v2Header) {
      try {
        challenge.v2 = JSON.parse(Buffer.from(v2Header, "base64").toString("utf8"));
      } catch {
        /* malformed header — v1 body remains authoritative */
      }
    }
    return challenge;
  }

  private async paintWithPayment(
    pixels: PixelPaint[],
    paymentHeader: string,
    idempotencyKey: string,
    headerName: "x-payment" | "payment-signature" = "x-payment",
  ): Promise<PaintResult> {
    const res = await fetch(`${this.baseUrl}/v1/paint`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [headerName]: paymentHeader,
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

  /** Lazily derive the Solana keypair from solanaPrivateKey (base58). */
  private async solanaKeypair() {
    if (!this.solanaSecret) {
      throw new Error("no solanaPrivateKey configured — required to pay on Solana (or use mock mode)");
    }
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    return Keypair.fromSecretKey(bs58.decode(this.solanaSecret));
  }

  /** The address we'd pay as on `req`'s VM (for replay lookup / mock payer). */
  private async payerFor(req: SelectedPayment): Promise<string | null> {
    if (req.vm === "svm") {
      if (this.solanaSecret) return (await this.solanaKeypair()).publicKey.toBase58();
      return this.mock ? MOCK_SVM_PAYER : null;
    }
    return this.account?.address ?? (this.mock ? MOCK_FALLBACK_PAYER : null);
  }

  /**
   * Build + partially-sign a Solana `exact` payment transaction per the x402
   * SVM scheme: [CU limit, CU price, SPL TransferChecked (payer ATA → payTo
   * ATA), Memo=extra.memo]. Fee-payer is the facilitator (extra.feePayer); it
   * co-signs at settle. We sign only as the transfer authority.
   */
  private async signSvmPayment(req: SelectedPayment): Promise<string> {
    const web3 = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    const payer = await this.solanaKeypair();
    const feePayer = new web3.PublicKey(req.extra.feePayer!);
    const mint = new web3.PublicKey(req.asset);
    const payTo = new web3.PublicKey(req.payTo);
    const payerAta = await spl.getAssociatedTokenAddress(mint, payer.publicKey);
    const payToAta = await spl.getAssociatedTokenAddress(mint, payTo);
    const rpc = this.rpcUrl ?? SVM_RPC[req.network] ?? "https://api.devnet.solana.com";
    const connection = new web3.Connection(rpc, "confirmed");
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const ixs = [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      spl.createTransferCheckedInstruction(payerAta, mint, payToAta, payer.publicKey, BigInt(req.amount), 6),
      new web3.TransactionInstruction({
        keys: [],
        programId: new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        data: Buffer.from(req.extra.memo!, "utf8"),
      }),
    ];
    const msg = new web3.TransactionMessage({
      payerKey: feePayer,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new web3.VersionedTransaction(msg);
    tx.sign([payer]); // partial: only the transfer authority; facilitator co-signs at settle
    const transaction = Buffer.from(tx.serialize()).toString("base64");
    return this.encodeSvmHeader(transaction, req);
  }

  private async signPayment(req: SelectedPayment): Promise<string> {
    if (req.vm === "svm") return this.signSvmPayment(req);
    if (!this.account) {
      throw new Error(
        "no privateKey configured — required for real x402 payments (or use mock mode)",
      );
    }
    const chainId = req.chainId;
    if (!chainId) throw new Error(`unknown network: ${req.network}`);

    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;
    const authorization = {
      from: this.account.address,
      to: req.payTo as `0x${string}`,
      value: BigInt(req.amount),
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
    }, req);
  }

  private async buildMockPayment(req: SelectedPayment): Promise<string> {
    if (req.vm === "svm") {
      // Mock SVM: a decodable stub {mock,payer,amount,memo} the mock provider
      // reads (no real chain). Payer = the solana pubkey if configured, else a
      // fixed mock pubkey.
      const payer = this.solanaSecret
        ? (await this.solanaKeypair()).publicKey.toBase58()
        : MOCK_SVM_PAYER;
      const transaction = Buffer.from(
        JSON.stringify({ mock: true, payer, amount: req.amount, memo: req.extra.memo }),
      ).toString("base64");
      return this.encodeSvmHeader(transaction, req);
    }
    const from = this.account?.address ?? MOCK_FALLBACK_PAYER;
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
    return this.encodeHeader("0xmock", {
      from,
      to: req.payTo,
      value: req.amount,
      validAfter: String(now - 60),
      validBefore: String(now + 120),
      nonce,
    }, req);
  }

  /** v2 SVM envelope: payload is {transaction}, accepted echoed verbatim. */
  private encodeSvmHeader(transaction: string, req: SelectedPayment): string {
    return Buffer.from(
      JSON.stringify({
        x402Version: 2,
        ...(req.v2?.resource ? { resource: req.v2.resource } : {}),
        accepted: req.v2?.accepted,
        payload: { transaction },
      }),
    ).toString("base64");
  }

  private encodeHeader(
    signature: string,
    authorization: Record<string, string>,
    req: SelectedPayment,
  ): string {
    const envelope =
      req.version === 2
        ? {
            x402Version: 2,
            ...(req.v2?.resource ? { resource: req.v2.resource } : {}),
            // Echo the server's own accepted entry verbatim per spec.
            accepted: req.v2?.accepted,
            payload: { signature, authorization },
          }
        : {
            x402Version: 1,
            scheme: "exact",
            network: req.network,
            payload: { signature, authorization },
          };
    return Buffer.from(JSON.stringify(envelope)).toString("base64");
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
