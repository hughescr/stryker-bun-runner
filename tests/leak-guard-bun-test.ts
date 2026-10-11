/**
 * bun:test as test files see it: tests/leak-guard.ts points every test file's
 * `import ... from 'bun:test'` here. Everything is bun:test's own, except
 * spyOn, which records each spy so one left in place fails its test, and
 * beforeAll/afterAll, which note that a file's fixtures may have changed
 * between two tests. See tests/leak-guard.ts.
 */

export * from 'bun:test';
export { guardedAfterAll as afterAll, guardedBeforeAll as beforeAll, guardedSpyOn as spyOn } from './leak-guard.js';
