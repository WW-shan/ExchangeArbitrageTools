const TRANSIENT_NETWORK_PATTERN =
  /Client network socket disconnected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|TLS connection|temporary failure/i;

export function isTransientNetworkError(error: unknown): boolean {
  return TRANSIENT_NETWORK_PATTERN.test(error instanceof Error ? error.message : String(error));
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = Math.max(0, options.delayMs ?? 750);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function retryOpenOrderResult<T extends { errors: string[] }>(
  operation: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = Math.max(0, options.delayMs ?? 750);
  let lastResult: T | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await operation();
    lastResult = result;
    if (!result.errors.some(isTransientNetworkError) || attempt === attempts) return result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return lastResult!;
}
