import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

async function exists(file: string): Promise<boolean> {
    try {
        await access(file);
        return true;
    } catch{
        return false;
    }
}

describe('process runner integration', () => {
    it('loads only the supplied covering test file in a real bun test child', async () => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'stryker-bun-targeted-'));
        try {
            await writeFile(path.join(fixture, 'covering.test.ts'), [
                "import { test, expect } from 'bun:test';",
                "await Bun.write('covering.loaded', 'yes');",
                "test('covering killer', () => expect(process.env.__STRYKER_ACTIVE_MUTANT__).toBe('original'));",
            ].join('\n'));
            await writeFile(path.join(fixture, 'uncovered.test.ts'), [
                "import { test, expect } from 'bun:test';",
                "await Bun.write('uncovered.loaded', 'yes');",
                "test('uncovered', () => expect(true).toBe(true));",
            ].join('\n'));

            const runnerUrl = new URL('../../src/process-runner.ts', import.meta.url).href;
            const script = [
                `const { runBunTests } = await import(${JSON.stringify(runnerUrl)});`,
                `process.chdir(${JSON.stringify(fixture)});`,
                "const result = await runBunTests({ bunPath: process.execPath, timeout: 3000, activeMutant: 'mutant-1', testFiles: ['covering.test.ts'], maxSpawnDepth: 2 });",
                'console.log(JSON.stringify(result));',
            ].join('\n');
            const proc = Bun.spawn([process.execPath, '--eval', script], { cwd: fixture, stdout: 'pipe', stderr: 'pipe' });
            // This subprocess is intentionally Bun-owned; Bun implements the web
            // Response API even though the package's Node compatibility floor predates it.
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- executed only by Bun's integration-test runtime
            const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

            expect(exitCode, stderr).toBe(0);
            const result = JSON.parse(stdout.trim()) as { exitCode: number | null };
            expect(result.exitCode).toBe(1);
            expect(await exists(path.join(fixture, 'covering.loaded'))).toBe(true);
            expect(await exists(path.join(fixture, 'uncovered.loaded'))).toBe(false);
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });
});
