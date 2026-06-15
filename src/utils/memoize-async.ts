/**
 * Memoize a zero-arg async producer for the process lifetime. Caches the
 * promise itself, so concurrent callers share the in-flight call and a
 * failure stays cached too. reset() drops the cache (used by tests).
 */
export interface MemoizedAsync<T> {
  (): Promise<T>
  reset(): void
}

export function memoizeAsync<T>(producer: () => Promise<T>): MemoizedAsync<T> {
  let cached: Promise<T> | null = null
  const fn = (() => {
    if (cached === null) {
      cached = producer()
    }
    return cached
  }) as MemoizedAsync<T>
  fn.reset = () => {
    cached = null
  }
  return fn
}
