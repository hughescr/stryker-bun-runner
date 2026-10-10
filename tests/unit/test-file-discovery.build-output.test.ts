/**
 * Unit tests for findBuildOutputTestFiles: the last path segment is the file
 * itself, never a directory.
 */

import { describe, it, expect } from 'bun:test';
import { findBuildOutputTestFiles } from '../../src/utils/test-file-discovery.js';

describe('findBuildOutputTestFiles (file names versus directory names)', () => {
    it('does not match a file that is itself named exactly dist or build', () => {
        // Only DIRECTORIES conventionally hold compiled output; a file called `dist` or `build`
        // (no extension) is not below such a directory.
        expect(findBuildOutputTestFiles(['dist', 'build', 'Dist', 'src/dist', 'src/BUILD'])).toEqual([]);
    });

    it('still matches a file below a dist directory whose own name is also dist', () => {
        expect(findBuildOutputTestFiles(['dist/dist'])).toEqual(['dist/dist']);
    });
});
