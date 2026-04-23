---
name: Numeric separators style rule
description: unicorn/numeric-separators-style with minimumDigits 5 — <5 digits must NOT have underscores
type: feedback
---

The `unicorn/numeric-separators-style` rule is configured with `minimumDigits: 5`. This means:
- Numbers with **fewer than 5 digits** must NOT have separators: `5000` is correct, `5_000` is WRONG
- Numbers with **5 or more digits** MUST have separators: `10_000` is correct, `10000` is WRONG

**Why:** Counter-intuitive — the setting means "only add separators when the number has at least 5 digits."

**How to apply:** When seeing this rule fire, count the digits. If 4 or fewer, remove the underscore. If 5 or more, add the underscore every 3 digits from the right.
