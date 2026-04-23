---
name: Avoid microtask yields on fake-timer test hot paths
description: async functions always yield to microtask queue — avoid async calls inside dryRun hot path where fake timers are active
type: feedback
---

`async` functions always yield at least once to the microtask queue when awaited, even on cache hit. This disrupts fake-timer test choreography (tests that carefully sequence `jest.advanceTimersByTime()` + `await Promise.resolve()`).

**Pattern that caused hang:** Added `const testFiles = await this.getOrDiscoverTestFiles()` inside `dryRun()`. Even on cache hit (immediate return), `await asyncFn()` yields once. This broke fake-timer tests that relied on exact async ordering.

**Fix pattern:** For synchronous cache hits inside fake-timer-sensitive paths, use a sync helper that returns the value directly (not via Promise), and only fall back to `await asyncFn()` on cache miss:
```typescript
const cached = this.syncCacheHit(cwd);  // returns T | null
const value = cached === null ? await this.asyncDiscover() : cached;
```

**How to apply:** Any time you add an `await` inside `dryRun()` or other methods exercised by fake-timer tests, verify the async function is bypassed synchronously on the hot path.
