# Benchmark baseline

Written by `bun run bench -- --write-baseline`. Do not edit by hand; the per-mutant statuses in
`baseline-statuses.json` are the invariant every later run is compared against.

- Date: 2026-10-12T19:17:36.063Z
- Commit: 43efd25
- Machine: 4 CPUs, Intel(R) Xeon(R) Processor @ 2.80GHz, 16 GiB RAM, Linux 6.18.44-fc-v114
- Bun: 1.4.2
- Runs: 5
- Per-run wall time: 27.3s, 28.2s, 29.4s, 31.0s, 31.1s
- Median: 29.4s (min 27.3s, max 31.1s)
- Dry run (median): 1.1s
- Tests in dry run: 2085
- Mutants: 1766

## Status breakdown

| Status | Count |
| --- | ---: |
| Killed | 1604 |
| Survived | 146 |
| Timeout | 16 |
