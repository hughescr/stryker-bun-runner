/**
 * Unit tests for discoverTestFiles
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { discoverTestFiles } from '../../src/utils/test-file-discovery.js';
import * as fs from 'node:fs';
import { join as pathJoin } from 'node:path';

describe('discoverTestFiles (symlink handling)', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(pathJoin(process.env.TMPDIR ?? '/tmp', 'stryker-symlink-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('discovers test files inside a symlinked directory', async () => {
        // Create a real directory with a test file
        const realDir = pathJoin(tmpDir, 'real-sub');
        fs.mkdirSync(realDir);
        fs.writeFileSync(pathJoin(realDir, 'foo.test.ts'), '');

        // Create a symlink pointing to that directory
        const linkDir = pathJoin(tmpDir, 'link-sub');
        fs.symlinkSync(realDir, linkDir);

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        expect(result!.some(f => f.includes('foo.test.ts'))).toBe(true);
    });

    it('discovers a symlinked test file directly', async () => {
        // Create a real test file in a subdirectory
        const realFile = pathJoin(tmpDir, 'real.test.ts');
        fs.writeFileSync(realFile, '');

        // Create a symlink to the file in the same dir under a different name
        const subDir = pathJoin(tmpDir, 'sub');
        fs.mkdirSync(subDir);
        const linkedFile = pathJoin(subDir, 'linked.test.ts');
        fs.symlinkSync(realFile, linkedFile);

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        // Both the real file and the symlinked file should be discovered
        expect(result!.some(f => f.includes('real.test.ts'))).toBe(true);
        expect(result!.some(f => f.includes('linked.test.ts'))).toBe(true);
    });

    it('terminates without hanging when a symlink creates a self-referential loop', async () => {
        // Create a directory that symlinks back to the root (loop)
        const loopLink = pathJoin(tmpDir, 'loop');
        fs.symlinkSync(tmpDir, loopLink);

        // Add a real test file so discovery returns something
        fs.writeFileSync(pathJoin(tmpDir, 'real.test.ts'), '');

        // Should resolve without hanging (loop is detected via realpath tracking)
        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        expect(result!.some(f => f.includes('real.test.ts'))).toBe(true);
    });

    it('silently skips a broken symlink and still discovers real test files', async () => {
        // Create a broken symlink (points to a non-existent target)
        const broken = pathJoin(tmpDir, 'broken-link.test.ts');
        fs.symlinkSync(pathJoin(tmpDir, 'does-not-exist.test.ts'), broken);

        // Also create a real test file
        fs.writeFileSync(pathJoin(tmpDir, 'real.test.ts'), '');

        const mockLogger = {
            debug: mock(),
            warn:  mock(),
        };

        const result = await discoverTestFiles(tmpDir, mockLogger);
        expect(result).toBeDefined();
        expect(result!.some(f => f.includes('real.test.ts'))).toBe(true);
        // The broken symlink must not cause an unhandled rejection
        // A debug warning should have been logged for the broken symlink
        // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining('broken symlink'),
            expect.stringContaining('broken-link.test.ts')
        );
    });

    it('does not descend into a symlinked directory that resolves to node_modules', async () => {
        // Simulate: vendor → node_modules/some-package/tests (realistic scenario)
        const nodeModules = pathJoin(tmpDir, 'node_modules', 'some-package', 'tests');
        fs.mkdirSync(nodeModules, { recursive: true });
        fs.writeFileSync(pathJoin(nodeModules, 'pkg.test.ts'), '');

        const vendor = pathJoin(tmpDir, 'vendor');
        fs.symlinkSync(nodeModules, vendor);

        const mockLogger = {
            debug: mock(),
            warn:  mock(),
        };

        const result = await discoverTestFiles(tmpDir, mockLogger);
        // The symlinked vendor directory resolves into node_modules — must not be descended.
        const discovered = result ?? [];
        expect(discovered.some(f => f.includes('pkg.test.ts'))).toBe(false);
        // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing method for mock verification
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.stringContaining('excluded path'),
            expect.any(String),
            expect.stringContaining('node_modules')
        );
    });

    it('does not descend into a symlinked directory that resolves inside .git', async () => {
        // Simulate: cache → .git/objects
        const gitObjects = pathJoin(tmpDir, '.git', 'objects');
        fs.mkdirSync(gitObjects, { recursive: true });
        fs.writeFileSync(pathJoin(gitObjects, 'obj.test.ts'), '');

        const cache = pathJoin(tmpDir, 'cache');
        fs.symlinkSync(gitObjects, cache);

        const result = await discoverTestFiles(tmpDir);
        const discovered = result ?? [];
        expect(discovered.some(f => f.includes('obj.test.ts'))).toBe(false);
    });

    it('does descend into a symlinked directory that resolves to a legitimate test directory', async () => {
        // Regression guard: a symlink to a real test directory MUST be followed.
        const realTests = pathJoin(tmpDir, 'real-tests');
        fs.mkdirSync(realTests);
        fs.writeFileSync(pathJoin(realTests, 'legit.test.ts'), '');

        const linkTests = pathJoin(tmpDir, 'linked-tests');
        fs.symlinkSync(realTests, linkTests);

        const result = await discoverTestFiles(tmpDir);
        expect(result).toBeDefined();
        // Both the original and the symlinked directory should yield the test file.
        expect(result!.some(f => f.includes('legit.test.ts'))).toBe(true);
    });
});
