export interface RateLimitConfig {
  requestsPerSecond: number;
  burst: number;
  costPublic: number;
  costPrivate: number;
  weightLimitPerMinute?: number;
  respectRetryAfter: boolean;
}

export type RequestPriority = 'normal' | 'execution';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface Waiter {
  cost: number;
  priority: RequestPriority;
  resolve: () => void;
}

export class TokenBucketRateLimiter {
  readonly #config: RateLimitConfig;
  readonly #clock: Clock;
  #tokens: number;
  #lastRefill: number;
  #blockedUntil = 0;
  readonly #queue: Waiter[] = [];
  #draining = false;

  constructor(config: RateLimitConfig, clock: Clock = systemClock) {
    if (config.requestsPerSecond <= 0 || config.burst <= 0) {
      throw new Error('rate limit values must be positive');
    }
    this.#config = config;
    this.#clock = clock;
    this.#tokens = config.burst;
    this.#lastRefill = clock.now();
  }

  get availableTokens(): number {
    this.refill();
    return this.#tokens;
  }

  private refill(): void {
    const now = this.#clock.now();
    const elapsedSeconds = Math.max(0, now - this.#lastRefill) / 1000;
    this.#tokens = Math.min(
      this.#config.burst,
      this.#tokens + elapsedSeconds * this.#config.requestsPerSecond,
    );
    this.#lastRefill = now;
  }

  async acquire(priority: RequestPriority = 'normal', privateRequest = false): Promise<void> {
    const cost = privateRequest ? this.#config.costPrivate : this.#config.costPublic;
    if (cost <= 0) throw new Error('request cost must be positive');
    if (cost > this.#config.burst) throw new Error('request cost exceeds bucket burst');
    await new Promise<void>((resolve) => {
      const waiter: Waiter = { cost, priority, resolve };
      if (priority === 'execution') this.#queue.unshift(waiter);
      else this.#queue.push(waiter);
      void this.drain();
    });
  }

  respectRetryAfter(retryAfterMs: number): void {
    if (!this.#config.respectRetryAfter) return;
    this.#blockedUntil = Math.max(
      this.#blockedUntil,
      this.#clock.now() + Math.max(0, retryAfterMs),
    );
  }

  private async drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        this.refill();
        const now = this.#clock.now();
        if (now < this.#blockedUntil) {
          await this.#clock.sleep(this.#blockedUntil - now);
          continue;
        }
        const waiter = this.#queue[0]!;
        if (this.#tokens >= waiter.cost) {
          this.#queue.shift();
          this.#tokens -= waiter.cost;
          waiter.resolve();
          continue;
        }
        const missing = waiter.cost - this.#tokens;
        const waitMs = Math.max(1, Math.ceil((missing / this.#config.requestsPerSecond) * 1000));
        await this.#clock.sleep(waitMs);
      }
    } finally {
      this.#draining = false;
      if (this.#queue.length > 0) void this.drain();
    }
  }
}
