---
name: Catch block lint patterns
description: How to write catch blocks that satisfy all lint rules (sonarjs/no-ignored-exceptions, unicorn, stylistic)
type: feedback
---

Bare `catch {}` (no binding) triggers `@stylistic/keyword-spacing` (unexpected space after catch).
Using `catch (_err) {}` triggers `unicorn/prefer-optional-catch-binding` and `sonarjs/no-ignored-exceptions`.

**Why:** These lint rules combine to make it impossible to silently ignore exceptions without logging.

**How to apply:** Always log the exception (even at debug level) using `catch (error) { this.logger.debug('...', error instanceof Error ? error.message : String(error)); }`. This satisfies all three rules.

Never use bare `catch {}` or `catch (_err) {}` patterns — always consume the error binding.
