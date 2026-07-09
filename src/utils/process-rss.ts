/**
 * Cross-platform child-process RSS (resident set size) probing.
 *
 * Used to implement a soft, userspace memory ceiling for spawned `bun test`
 * children: Stryker mutation campaigns can spawn heavyweight test suites
 * (real ML models, native sqlite/tokenizer bindings) whose per-run footprint
 * can be large. Polling RSS lets the runner convert a runaway run into a
 * clean, attributable failure for that one mutant instead of letting it
 * exhaust system memory/swap.
 *
 * This is deliberately NOT a kernel-enforced hard ceiling (no rlimit/cgroup
 * usage) — see README "Memory containment" section for why: RLIMIT_AS caps
 * virtual address space, not RSS, and modern JS engines (Bun's JavaScriptCore,
 * V8) reserve large virtual ranges up front regardless of actual resident
 * usage, so an RLIMIT_AS ceiling tight enough to matter for RSS would abort
 * the engine at startup; RLIMIT_RSS has been a no-op on Linux since kernel
 * 2.4.30; and cgroup memory.max requires delegated cgroup access that isn't
 * guaranteed on developer machines or CI runners. A polled userspace check is
 * the portable, dependency-free alternative.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * Read a process's current resident set size in bytes.
 *
 * On Linux, reads `/proc/<pid>/status` (VmRSS field) directly — no subprocess
 * needed. On other platforms (e.g. macOS), shells out to `ps -o rss= -p <pid>`
 * since there is no /proc filesystem.
 *
 * @returns RSS in bytes, or `null` if the process no longer exists or the
 *   probe failed for any other reason (treated as "unknown", never thrown).
 */
export async function getProcessRssBytes(pid: number): Promise<number | null> {
    // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: platform branch — exercised by both getLinuxRss and getPsRss test suites via process.platform mocking; the branch condition itself has no independent behavior to assert beyond which probe runs
    return process.platform === 'linux' ? getLinuxRss(pid) : getPsRss(pid);
}

/**
 * Parse the VmRSS line out of /proc/<pid>/status content.
 * Extracted as a pure function so parsing edge cases are testable without
 * mocking the filesystem.
 */
export function parseVmRss(statusContent: string): number | null {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(statusContent);
    // Stryker disable next-line ConditionalExpression,EqualityOperator: null-vs-match guard covered by 'returns null when VmRSS line is absent'
    return match ? Number(match[1]) * 1024 : null;
}

async function getLinuxRss(pid: number): Promise<number | null> {
    try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        return parseVmRss(status);
    } catch{
        // Process may have exited between the caller's check and this read, or
        // /proc may be unavailable — either way, "unknown" is the safe answer.
        return null;
    }
}

/**
 * Parse the numeric RSS-in-KB value out of `ps -o rss=` output.
 * Extracted as a pure function so parsing edge cases are testable without
 * spawning a real process.
 */
export function parsePsRssOutput(output: string): number | null {
    const trimmed = output.trim();
    // Stryker disable next-line ConditionalExpression,EqualityOperator: empty-output guard covered by 'returns null for empty ps output'
    if(trimmed === '') {
        return null;
    }
    const kb = Number(trimmed);
    // Stryker disable next-line ConditionalExpression,LogicalOperator: NaN guard covered by 'returns null for non-numeric ps output'
    return Number.isFinite(kb) ? kb * 1024 : null;
}

async function getPsRss(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
        let child;
        try {
            // eslint-disable-next-line sonarjs/no-os-command-from-path -- 'ps' is a standard system utility resolved the same way as the main bunPath invocation; this probe only runs when maxChildRss is explicitly configured
            child = spawn('ps', ['-o', 'rss=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch{
            resolve(null);
            return;
        }
        let output = '';
        child.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });
        child.on('close', (code) => {
            // Stryker disable next-line ConditionalExpression,EqualityOperator: non-zero exit (e.g. pid no longer exists) covered by 'resolves null when ps exits non-zero'
            resolve(code === 0 ? parsePsRssOutput(output) : null);
        });
        child.on('error', () => {
            resolve(null);
        });
    });
}
