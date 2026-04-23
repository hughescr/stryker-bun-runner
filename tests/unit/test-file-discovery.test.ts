/**
 * Unit tests for discoverTestFiles
 */

import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { discoverTestFiles } from '../../src/utils/test-file-discovery.js';

describe('discoverTestFiles (symlink handling)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'stryker-symlink-test-'));
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('discovers test files inside a symlinked directory', async () => {
        // Create a real directory with a test file
        const realDir = path.join(tmpDir, 'real-sub');
        await mkdir(realDir);
        await writeFile(path.join(realDir, 'foo.test.ts'), '');

        // Create a symlink pointing to that directory
        const linkDir = path.join(tmpDir, 'link-sub');
        await symlink(realDir, linkDir);

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        expect(result!.some(f => f.includes('foo.test.ts'))).toBe(true);
    });

    it('discovers a symlinked test file directly', async () => {
        // Create a real test file in a subdirectory
        const realFile = path.join(tmpDir, 'real.test.ts');
        await writeFile(realFile, '');

        // Create a symlink to the file in the same dir under a different name
        const subDir = path.join(tmpDir, 'sub');
        await mkdir(subDir);
        const linkedFile = path.join(subDir, 'linked.test.ts');
        await symlink(realFile, linkedFile);

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        // Both the real file and the symlinked file should be discovered
        expect(result!.some(f => f.includes('real.test.ts'))).toBe(true);
        expect(result!.some(f => f.includes('linked.test.ts'))).toBe(true);
    });

    it('terminates without hanging when a symlink creates a self-referential loop', async () => {
        // Create a directory that symlinks back to the root (loop)
        const loopLink = path.join(tmpDir, 'loop');
        await symlink(tmpDir, loopLink);

        // Add a real test file so discovery returns something
        await writeFile(path.join(tmpDir, 'real.test.ts'), '');

        // Should resolve without hanging (loop is detected via realpath tracking)
        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        expect(result!.some(f => f.includes('real.test.ts'))).toBe(true);
    });

    it('silently skips a broken symlink and still discovers real test files', async () => {
        // Create a broken symlink (points to a non-existent target)
        const broken = path.join(tmpDir, 'broken-link.test.ts');
        await symlink(path.join(tmpDir, 'does-not-exist.test.ts'), broken);

        // Also create a real test file
        await writeFile(path.join(tmpDir, 'real.test.ts'), '');

        const mockLogger = {
            debug: mock(),
            warn:  mock(),
        };

        const result = await discoverTestFiles(tmpDir, mockLogger);
        expect(result).toBeDefined();
        expect(result!.some(f => f.includes('real.test.ts'))).toBe(true);
        // The broken symlink must not cause an unhandled rejection
        // A debug warning should have been logged for the broken symlink

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining('broken symlink'),
            expect.stringContaining('broken-link.test.ts')
        );
    });

    it('does not descend into a symlinked directory that resolves to node_modules', async () => {
        // Simulate: vendor → node_modules/some-package/tests (realistic scenario)
        const nodeModules = path.join(tmpDir, 'node_modules', 'some-package', 'tests');
        await mkdir(nodeModules, { recursive: true });
        await writeFile(path.join(nodeModules, 'pkg.test.ts'), '');

        const vendor = path.join(tmpDir, 'vendor');
        await symlink(nodeModules, vendor);

        const mockLogger = {
            debug: mock(),
            warn:  mock(),
        };

        const result = await discoverTestFiles(tmpDir, mockLogger);
        // The symlinked vendor directory resolves into node_modules — must not be descended.
        const discovered = result ?? [];
        expect(discovered.some(f => f.includes('pkg.test.ts'))).toBe(false);

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining('excluded path'),
            expect.any(String),
            expect.stringContaining('node_modules')
        );
    });

    it('does not descend into a symlinked directory that resolves inside .git', async () => {
        // Simulate: cache → .git/objects
        const gitObjects = path.join(tmpDir, '.git', 'objects');
        await mkdir(gitObjects, { recursive: true });
        await writeFile(path.join(gitObjects, 'obj.test.ts'), '');

        const cache = path.join(tmpDir, 'cache');
        await symlink(gitObjects, cache);

        const result = await discoverTestFiles(tmpDir);
        const discovered = result ?? [];
        expect(discovered.some(f => f.includes('obj.test.ts'))).toBe(false);
    });

    it('does descend into a symlinked directory that resolves to a legitimate test directory', async () => {
        // Regression guard: a symlink to a real test directory MUST be followed.
        const realTests = path.join(tmpDir, 'real-tests');
        await mkdir(realTests);
        await writeFile(path.join(realTests, 'legit.test.ts'), '');

        const linkTests = path.join(tmpDir, 'linked-tests');
        await symlink(realTests, linkTests);

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        // Both the original and the symlinked directory should yield the test file.
        expect(result!.some(f => f.includes('legit.test.ts'))).toBe(true);
    });

    // ── handleSymlinkDir: only-via-symlink discovery (kills mutants 1514/1519) ──
    it('discovers test files reachable ONLY through a symlinked directory pointing outside the walk root', async () => {
        // The file must not exist anywhere directly inside tmpDir — it is only reachable
        // through the symlink.  This ensures handleSymlinkDir's ctx.walk() call (L72) is
        // the ONLY path that adds the file.
        // Kills ConditionalExpression 1514 (hasExcludedAncestor → true) and
        // BlockStatement 1519 (removing ctx.walk body): both prevent the file from being found.
        const externalDir = await mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'stryker-ext-target-'));
        try {
            // File ONLY reachable via symlink (not directly inside tmpDir)
            await writeFile(path.join(externalDir, 'only-via-symlink.test.ts'), '');

            // The symlink itself lives inside tmpDir under a non-excluded name
            const linkToExternal = path.join(tmpDir, 'external-tests');
            await symlink(externalDir, linkToExternal);

            const result = await discoverTestFiles(tmpDir);
            expect(result).toBeDefined();
            // Must be found via the symlink (only path to the file)
            expect(result!.some(f => f.includes('only-via-symlink.test.ts'))).toBe(true);
        } finally {
            await rm(externalDir, { recursive: true, force: true });
        }
    });

    // ── handleSymlinkDir: excluded entry name (mutant 1508/1509) ────────────
    it('skips a symlinked directory whose entry name is an excluded dir (e.g. node_modules)', async () => {
        // A symlink named "node_modules" inside a tmp dir should be skipped because
        // the ENTRY NAME matches the excludedDirs set — regardless of where it points.
        // The test file must only be reachable through the symlink (not via any other path).
        const externalDir = await mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'stryker-nm-target-'));
        try {
            await writeFile(path.join(externalDir, 'hidden.test.ts'), '');

            // Symlink named "node_modules" — the name itself triggers the exclusion
            const nmLink = path.join(tmpDir, 'node_modules');
            await symlink(externalDir, nmLink);

            // Also add a real test file in tmpDir root so result isn't undefined
            await writeFile(path.join(tmpDir, 'real.test.ts'), '');

            const result = await discoverTestFiles(tmpDir);
            // hidden.test.ts is ONLY reachable via the "node_modules" symlink — must NOT appear
            expect(result).toBeDefined();
            expect(result!.some(f => f.includes('hidden.test.ts'))).toBe(false);
            expect(result!.some(f => f.includes('real.test.ts'))).toBe(true);
        } finally {
            await rm(externalDir, { recursive: true, force: true });
        }
    });

    it('skips a symlink named ".stryker-tmp"', async () => {
        const externalDir = await mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'stryker-excl-target-'));
        try {
            await writeFile(path.join(externalDir, 'secret.test.ts'), '');

            const strykerLink = path.join(tmpDir, '.stryker-tmp');
            await symlink(externalDir, strykerLink);

            // Real test file so result isn't undefined
            await writeFile(path.join(tmpDir, 'legit.test.ts'), '');

            const result = await discoverTestFiles(tmpDir);
            expect(result).toBeDefined();
            expect(result!.some(f => f.includes('secret.test.ts'))).toBe(false);
            expect(result!.some(f => f.includes('legit.test.ts'))).toBe(true);
        } finally {
            await rm(externalDir, { recursive: true, force: true });
        }
    });

    // ── handleSymlinkFile: non-test-extension symlinked file (mutant 1523/1524) ──
    it('does not include a symlinked file with a non-test extension', async () => {
        const realFile = path.join(tmpDir, 'util.ts');
        await writeFile(realFile, '');

        // Symlink to a non-test file in a sub-dir (it is a symbolic link file)
        const subDir = path.join(tmpDir, 'sub');
        await mkdir(subDir);
        const linkFile = path.join(subDir, 'util-link.ts');
        await symlink(realFile, linkFile);

        // Also add a real test file so discoverTestFiles doesn't return undefined
        await writeFile(path.join(tmpDir, 'real.test.ts'), '');

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        // The symlinked non-test file should NOT be included
        expect(result!.every(f => !f.includes('util-link.ts'))).toBe(true);
    });

    // ── handleSymlinkFile: excluded ancestor (mutant 1525) ───────────────────
    it('does not include a symlinked test file whose target is inside node_modules', async () => {
        // A symlink to a test file whose real path passes through node_modules
        const nmDir = path.join(tmpDir, 'node_modules', 'pkg');
        await mkdir(nmDir, { recursive: true });
        const realTestFile = path.join(nmDir, 'hidden.test.ts');
        await writeFile(realTestFile, '');

        // Symlink named like a test file in the root — but pointing into node_modules
        const linkedTestFile = path.join(tmpDir, 'linked.test.ts');
        await symlink(realTestFile, linkedTestFile);

        // Add a real test file so discovery doesn't short-circuit to undefined
        await writeFile(path.join(tmpDir, 'legit.test.ts'), '');

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        // The symlinked file resolves into node_modules — must not be included
        expect(result!.every(f => !f.includes('linked.test.ts'))).toBe(true);
        // The real test file IS included
        expect(result!.some(f => f.includes('legit.test.ts'))).toBe(true);
    });

    // ── handleSymlink: stat returns file branch (mutant 1540) ────────────────
    it('discovers a symlinked test file without treating it as a directory', async () => {
        // When stat.isFile() is true for a symlink, it should be handled as a file,
        // not a directory. The result must include exactly one test file entry.
        const realFile = path.join(tmpDir, 'real.test.ts');
        await writeFile(realFile, '');

        const subDir = path.join(tmpDir, 'sub');
        await mkdir(subDir);
        const linkedFile = path.join(subDir, 'linked.test.ts');
        await symlink(realFile, linkedFile);

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        // Both real and linked are found (they point to the same content but different paths)
        expect(result!.some(f => f.includes('real.test.ts'))).toBe(true);
        expect(result!.some(f => f.includes('linked.test.ts'))).toBe(true);
        // Should NOT have duplicate entries
        const realCount = result!.filter(f => f.includes('real.test.ts')).length;
        expect(realCount).toBe(1);
    });

    // ── processEntry: regular file without test extension (mutant 1551/1554/1556) ─
    it('ignores regular files without a test extension', async () => {
        // Kills ConditionalExpression mutants at line 134: entry.isFile() && testFileRe.test(entry.name)
        // If entry.isFile() is always true, non-test files would be erroneously included.
        await writeFile(path.join(tmpDir, 'README.md'), '');
        await writeFile(path.join(tmpDir, 'util.ts'), '');
        await writeFile(path.join(tmpDir, 'valid.test.ts'), '');

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        expect(result!.every(f => f.endsWith('.test.ts') || f.endsWith('.spec.ts'))).toBe(true);
        expect(result!.some(f => f.includes('README.md'))).toBe(false);
        expect(result!.some(f => f.includes('util.ts'))).toBe(false);
        expect(result!.some(f => f.includes('valid.test.ts'))).toBe(true);
    });

    it('includes only test files matching the test file regex (entry.isFile && testFileRe.test)', async () => {
        // Kills LogicalOperator mutant 1556: entry.isFile() || testFileRe.test(...) → both sides must be true
        await writeFile(path.join(tmpDir, 'a.test.ts'), '');
        await writeFile(path.join(tmpDir, 'b.spec.js'), '');
        await writeFile(path.join(tmpDir, 'c.ts'), '');        // no test extension
        await writeFile(path.join(tmpDir, 'd.js'), '');        // no test extension

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        expect(result!.length).toBe(2);
        expect(result!.some(f => f.includes('a.test.ts'))).toBe(true);
        expect(result!.some(f => f.includes('b.spec.js'))).toBe(true);
    });

    // ── results array initialised to [] (mutant 1559) ────────────────────────
    it('starts with an empty result set and returns only discovered test files', async () => {
        // Kills ArrayDeclaration mutant 1559: [] → ["Stryker was here"]
        // If results starts non-empty, discovery would return an extra bogus entry.
        await writeFile(path.join(tmpDir, 'one.test.ts'), '');

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        expect(result!.length).toBe(1);
        expect(result![0]).toMatch(/one\.test\.ts$/);
    });

    // ── visitedRealPaths guards against symlink loops (mutant 1569/1570) ─────
    it('returns only real test files and not duplicate paths when loop symlink present', async () => {
        // Kills ConditionalExpression 1569/BlockStatement 1570 — the visited-path
        // guard is what terminates the loop.  Without it, walk() would recurse forever.
        // The test fixture has a loop symlink so any hang signals the guard is broken.
        const loopLink = path.join(tmpDir, 'loop');
        await symlink(tmpDir, loopLink);
        await writeFile(path.join(tmpDir, 'real.test.ts'), '');

        // If visitedRealPaths guard doesn't work, this hangs. A 5-second timeout
        // is sufficient — in practice the loop terminates in <10 ms.
        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        // Only one unique path to real.test.ts (not duplicated through loop)
        const testEntries = result!.filter(f => f.includes('real.test.ts'));
        expect(testEntries.length).toBe(1);
    });

    // ── entries.sort() ensures deterministic walk order (mutant 1575) ────────
    it('returns files in deterministic sorted order regardless of fs readdir ordering', async () => {
        // Kills MethodExpression mutant 1575: entries.sort(...) removed
        // Create files with names that would give different results without sorting
        await writeFile(path.join(tmpDir, 'z.test.ts'), '');
        await writeFile(path.join(tmpDir, 'a.test.ts'), '');
        await writeFile(path.join(tmpDir, 'm.test.ts'), '');

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        const sorted = result!.toSorted((a, b) => a.localeCompare(b));
        expect(result).toEqual(sorted);
    });

    // ── empty results → undefined (mutant 1579/1581) ─────────────────────────
    it('returns undefined when no test files are found in the directory', async () => {
        // Kills ConditionalExpression 1579 and BlockStatement 1581
        // Write only a non-test file
        await writeFile(path.join(tmpDir, 'README.md'), '');

        const result = await discoverTestFiles(tmpDir);
        // No test files → must return undefined, not an empty array
        expect(result).toBeUndefined();
    });

    // ── results.sort() ensures stable top-level sort (mutant 1584) ───────────
    it('returns results in ascending lexicographic order across subdirectories', async () => {
        // Kills MethodExpression mutant 1584: results.sort() removed
        const subA = path.join(tmpDir, 'a-sub');
        const subZ = path.join(tmpDir, 'z-sub');
        await mkdir(subA);
        await mkdir(subZ);
        await writeFile(path.join(subZ, 'z.test.ts'), '');
        await writeFile(path.join(subA, 'a.test.ts'), '');

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        expect(result!.length).toBe(2);
        // 'a-sub/a.test.ts' < 'z-sub/z.test.ts' alphabetically
        expect(result![0]).toMatch(/a\.test\.ts$/);
        expect(result![1]).toMatch(/z\.test\.ts$/);
    });
});
