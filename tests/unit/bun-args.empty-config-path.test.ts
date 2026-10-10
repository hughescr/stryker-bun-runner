/**
 * An empty string is not a usable value for the separate-token forms of
 * `--config`/`-c`: consuming it would hand the sanitizer an empty path, which
 * resolves to the current directory. It must stay in the args so
 * findUnsupportedBunArgs rejects the flag as having no usable path.
 */

import { describe, it, expect } from 'bun:test';
import { assertSupportedBunArgs, findUnsupportedBunArgs, splitBunConfigArg } from '../../src/utils/bun-args.js';

describe.each(['--config', '-c'])('%s followed by an empty-string token', (flag) => {
    it('does not consume the empty token as the config path', () => {
        expect(splitBunConfigArg([flag, ''])).toEqual({ args: [flag, ''], configPath: undefined });
    });

    it('rejects the flag as having no usable path', () => {
        expect(findUnsupportedBunArgs([flag, '']).map(f => f.arg)).toEqual([flag]);
        expect(() => assertSupportedBunArgs([flag, ''])).toThrow(`bun.bunArgs contains "${flag}"`);
    });

    it('still consumes a real path in the same position', () => {
        expect(splitBunConfigArg([flag, 'bunfig.ci.toml'])).toEqual({ args: [], configPath: 'bunfig.ci.toml' });
    });
});
