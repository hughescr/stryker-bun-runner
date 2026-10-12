/**
 * Summarise a run profile: where the time of a `stryker run` went, by phase.
 *
 *     bun bench/profile-summary.ts <profile.jsonl>
 *
 * The file is what the runner appends with STRYKER_BUN_PROFILE=<absolute path>
 * set (see src/run-profile.ts): one line per run from every worker, plus one
 * summary line per worker, which this script ignores in favour of the runs
 * themselves (percentiles cannot be merged across workers). It prints:
 *
 * - the wall time covered, the peak number of runs in flight (the workers), and
 *   the dry run's share of the wall time;
 * - each phase's total and its share of all run time, and of the wall time
 *   times the peak number of workers;
 * - per group (dry run; mutant runs by status, by scope, and both), count, mean,
 *   p50, p95 and total milliseconds of every phase, the run's total, and the
 *   numbers of test files handed to bun and of file headers it printed.
 */

/* eslint-disable no-console -- a command-line script: its output is the point */

import { readFile } from 'node:fs/promises';
import { aggregateRuns, PHASES, type GroupStats, type RunRecord, type Stats } from '../src/run-profile.js';

function ms(value: number): string {
    return value.toFixed(1);
}

function pct(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

/** Rows as text columns: the first left-aligned, the rest right-aligned. */
function table(rows: readonly (readonly string[])[]): string {
    const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
    return rows.map(row => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ')).join('\n');
}

/** The most runs in flight at once: the number of workers that were busy together. */
function peakConcurrency(runs: readonly RunRecord[]): number {
    const events = runs.flatMap(run => [[run.startEpochMs, 1], [run.startEpochMs + run.totalMs, -1]] as const)
        // An end and a start at the same instant do not overlap.
        .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current = 0;
    let peak = 0;
    for(const [, delta] of events) {
        current += delta;
        peak = Math.max(peak, current);
    }
    return peak;
}

/** A table row of `stats`, its values shown with `format`; dashes when the group had none. */
function statsRow(label: string, stats: Stats | undefined, format: (value: number) => string = ms): string[] {
    return stats ? [label, String(stats.count), format(stats.mean), format(stats.p50), format(stats.p95), format(stats.sum)] : [label, '0', '-', '-', '-', '-'];
}

function groupTable(name: string, group: GroupStats): string {
    const rows = [['phase (ms)', 'n', 'mean', 'p50', 'p95', 'total']];
    for(const phase of PHASES) {
        if(group.phases[phase]) {
            rows.push(statsRow(phase, group.phases[phase]));
        }
    }
    rows.push(
        statsRow('= run total', group.totalMs),
        statsRow('test files passed', group.files, String),
        statsRow('file headers seen', group.fileHeaders, String)
    );
    return `${name} (${group.runs} run${group.runs === 1 ? '' : 's'})\n${table(rows)}`;
}

function parseRuns(text: string): { runs: RunRecord[], skipped: number } {
    const runs: RunRecord[] = [];
    let skipped = 0;
    for(const line of text.split('\n')) {
        if(line.trim() === '') {
            continue;
        }
        try {
            const parsed = JSON.parse(line) as { type?: unknown };
            if(parsed.type === 'run') {
                runs.push(parsed as RunRecord);
            }
        } catch{
            skipped++;
        }
    }
    return { runs, skipped };
}

/** Print the summary; resolves to the exit code (2: usage, 1: nothing to summarise). */
async function main(): Promise<number> {
    const file = process.argv[2];
    if(!file) {
        console.error('usage: bun bench/profile-summary.ts <profile.jsonl>');
        return 2;
    }
    const { runs, skipped } = parseRuns(await readFile(file, 'utf8'));
    if(skipped > 0) {
        console.error(`profile-summary: skipped ${skipped} line(s) that are not JSON`);
    }
    if(runs.length === 0) {
        console.error(`profile-summary: no run lines in ${file}`);
        return 1;
    }

    const groups = aggregateRuns(runs);
    const start = Math.min(...runs.map(run => run.startEpochMs));
    const wallMs = Math.max(...runs.map(run => run.startEpochMs + run.totalMs)) - start;
    const workers = peakConcurrency(runs);
    const pids = new Set(runs.map(run => run.pid)).size;
    const dryMs = 'dry' in groups ? groups.dry.totalMs.sum : 0;
    const all = groups.all;
    const capacityMs = wallMs * workers;

    console.log(`${file}: ${runs.length} runs from ${pids} worker process(es); wall ${ms(wallMs)} ms (first request to last return); peak ${workers} run(s) in flight`);
    console.log(`busy ${ms(all.totalMs.sum)} ms = ${pct(capacityMs > 0 ? all.totalMs.sum / capacityMs : 0)} of wall x ${workers}; dry run ${ms(dryMs)} ms = ${pct(wallMs > 0 ? dryMs / wallMs : 0)} of wall`);
    console.log('');

    const shareRows = [['phase', 'total ms', 'of run time', `of wall x ${workers}`]];
    for(const phase of PHASES) {
        const stats = all.phases[phase];
        if(stats) {
            shareRows.push([phase, ms(stats.sum), pct(all.phaseShare[phase] ?? 0), pct(capacityMs > 0 ? stats.sum / capacityMs : 0)]);
        }
    }
    console.log('Share of time per phase, all runs');
    console.log(table(shareRows));

    for(const [name, group] of Object.entries(groups)) {
        if(name !== 'all') {
            console.log('');
            console.log(groupTable(name, group));
        }
    }
    return 0;
}

const exitCode = await main();
process.exitCode = exitCode;
