# Benchmark results

One row per `bun run bench -- --record "<label>"`. Delta is the median wall time versus the median in `baseline.json`.

| date | sha | label | runs | median | min–max | delta vs baseline | status_diff |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| 2026-10-12 18:48 | e305c85 | baseline (e305c85) | 5 | 28.5s | 28.1–29.5s | n/a | NO_BASELINE; RUNS DISAGREE |
| 2026-10-12 19:17 | 43efd25 | baseline | 5 | 29.4s | 27.3–31.1s | n/a | NO_BASELINE |
