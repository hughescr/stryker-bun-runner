/**
 * Preload script generator
 * Generates the preload script for coverage collection
 */

import { mkdir, unlink, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PreloadOptions {
    /**
   * Directory to write the preload script to
   */
    tempDir: string

    /**
   * Path where coverage data will be written
   */
    coverageFile: string
}

/**
 * Generate the coverage preload script
 *
 * The preload script is copied from the templates directory to a temp location
 * so it can be used with Bun's --preload flag.
 *
 * @returns Path to the generated preload script
 */
export async function generatePreloadScript(options: PreloadOptions): Promise<string> {
    const preloadPath = join(options.tempDir, 'stryker-coverage-preload.ts');

    // Ensure temp directory exists (mkdir with recursive is idempotent)
    await mkdir(options.tempDir, { recursive: true });

    // Get the path to the template file
    // Note: When bundled, all code lives in dist/index.js, so __dirname is dist/
    // The templates folder is copied to dist/templates/ during build
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const templatePath = join(__dirname, 'templates/coverage-preload.ts');

    // Read the template
    const template = await readFile(templatePath, 'utf-8');

    // Calculate the absolute path to preload-logic.js
    // When bundled, __dirname is dist/, so preload-logic.js is at dist/coverage/preload-logic.js
    const preloadLogicPath = join(__dirname, 'coverage/preload-logic.js');

    // Replace the placeholder with the absolute path
    const content = template.replace('__PRELOAD_LOGIC_PATH__', preloadLogicPath);

    // Write the template to the temp location
    await writeFile(preloadPath, content, 'utf-8');

    return preloadPath;
}

/**
 * Clean up generated preload script
 */
export async function cleanupPreloadScript(preloadPath: string): Promise<void> {
    try {
        await unlink(preloadPath);
    } catch{
    // Ignore errors - file may not exist or may have already been deleted
    }
}
