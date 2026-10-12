# Benchmark results

One row per `bun run bench -- --record "<label>"`. Delta is the median wall time versus the median in `baseline.json`.

| date | sha | label | runs | median | min–max | delta vs baseline | status_diff |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| 2026-10-12 18:48 | e305c85 | baseline (e305c85) | 5 | 28.5s | 28.1–29.5s | n/a | NO_BASELINE; RUNS DISAGREE |
| 2026-10-12 19:17 | 43efd25 | baseline | 5 | 29.4s | 27.3–31.1s | n/a | NO_BASELINE |
| 2026-10-12 19:21 | e3e2fa9 | killer-order 9912287 | 5 | 25.9s | 24.3–26.9s | -12.0% (-3.5s) | OK |
| 2026-10-12 20:03 | 27309b5 vs 288921a | killer-order dd4d1b8 vs 288921a (compare ref=288921a) | 6 | 28.0s | 26.2–29.7s | -9.3% (-2.88s) vs ref, wins 6/6, p=0.031 | OK; 1 CONTAMINATED |
| 2026-10-12 20:33 | 74079ad vs e8cd563 | lifeline da1c44d vs e8cd563 (compare ref=e8cd563) | 6 | 19.3s | 18.8–20.0s | -22.2% (-5.45s) vs ref, wins 6/6, p=0.031 | OK; swaps K→T:1; 1 CONTAMINATED |
| 2026-10-12 21:41 | deaa391 vs 33e8e18 | tip deaa391 vs original 33e8e18 (compare ref=33e8e18) | 6 | 17.3s | 16.9–18.6s | -37.9% (-10.74s) vs ref, wins 6/6, p=0.031 | OK |
