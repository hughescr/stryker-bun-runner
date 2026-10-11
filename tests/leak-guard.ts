/**
 * Fail any test that leaves state behind for the tests after it.
 *
 * Policy: every test cleans up after itself. A spy, a mock implementation, a
 * recorded call on a shared mock, fake timers, a process.env change, a process
 * listener or a module mock is undone after the test that created it (in its
 * own afterEach), or, for file-level fixtures, in the afterAll of the file
 * that created it. No test resets shared state before it runs to protect
 * itself from other tests: that hides the leak instead of fixing it, and the
 * first test of every file is still exposed.
 *
 * Installed by tests/test-preload.ts, so it is active in every `bun test` run,
 * mutant runs included. It works in two scopes:
 *
 * - Test scope. A global beforeEach (which bun runs before any file's
 *   beforeEach) records the state; {@link failOnTestLeaks}, called from the
 *   global afterEach in tests/test-preload.ts (which bun runs after every
 *   file's afterEach), compares the state with it. Whatever the test and its
 *   own beforeEach/afterEach hooks changed and did not undo fails that test,
 *   and bun reports the failure under the test's name.
 * - File scope. State a file sets up in beforeAll is in place before the
 *   global beforeEach, so it is part of every test's starting point and never
 *   counts against a test. It is checked when the file ends instead: a bun
 *   plugin registered below adds a beforeAll at the start and an afterAll at
 *   the end of every *.test.ts file (on the first line and after the last, so
 *   line numbers are unchanged). The beforeAll runs before the file's own and
 *   records the state; the afterAll runs after the file's own (bun runs the
 *   afterAll hooks of one scope in the order they were registered) and fails
 *   the file, naming it, if anything differs. bun's own preload
 *   beforeAll/afterAll would not do: they run once for the whole run, not
 *   once per file.
 *
 * After reporting a leak the guard puts the state back, so a leak fails the
 * one test (or file) that caused it rather than every test after it.
 *
 * What it watches (what bun 1.4.2 lets it see reliably, and cheaply enough to
 * run around every one of thousands of tests):
 *
 * - spyOn() spies not restored, named with the line that created them. bun
 *   keeps no list of live spies, and a test file's `spyOn` is its own binding
 *   of the bun:test export, so the same plugin points each test file's
 *   `import ... from 'bun:test'` at tests/leak-guard-bun-test.ts, which is
 *   bun:test with spyOn (and beforeAll/afterAll, see below) wrapped by this
 *   file; jest.spyOn is wrapped in place. A spy is restored when the
 *   property it replaced holds its original value again (mockRestore(),
 *   jest.restoreAllMocks() or mock.restore()).
 * - Mock state: calls recorded and not cleared, and an implementation
 *   (mockImplementation, mockResolvedValue, a queued ...Once value,
 *   mockReset) not put back, on the shared mocks tests/test-preload.ts
 *   installs as module mocks (mockSpawn, mockKillProcessGroup, mockReadFile
 *   and the rest) and on spies a file keeps across its tests. spyOn() on a
 *   property that already holds one of those mocks returns that same mock,
 *   so a spy on fsPromises.writeFile is checked this way.
 * - Any other override (Object.defineProperty, assignment, a property added
 *   or removed) of the globals tests patch directly: globalThis, process,
 *   console, Date and Bun.
 * - Fake timers left installed (or uninstalled under a file that installed
 *   them).
 * - process.env keys added, changed or removed.
 * - process listeners added or removed for signals, exit and the error
 *   events.
 * - The working directory.
 * - mock.module() calls after the preload. bun cannot undo a module mock
 *   (mock.restore() leaves it in place), so every one leaks: module mocks
 *   belong in tests/test-preload.ts, with a default tests can configure and
 *   reset.
 *
 * Not seen: a plain assignment over a property of a module's exported object
 * or of a builtin (use spyOn, which is seen), a spy created in a helper that
 * imports bun:test itself rather than in a test file, and state inside
 * closures or module variables.
 *
 * Cost: the state is recorded once and then compared in place, without
 * allocating, so a clean test costs a few microseconds and leaves no garbage
 * behind (garbage around every test slows the whole run through the
 * collector). The record is retaken only after a beforeAll or afterAll of a
 * test file has run (the wrapped beforeAll/afterAll note that), since only
 * those hooks run between tests; anything else that changes between two tests
 * is work an earlier test left running, and is reported against the test
 * after it.
 */

import path from 'node:path';
import { afterAll, beforeAll, beforeEach, jest, mock, spyOn } from 'bun:test';

type MockLike = ((...args: unknown[]) => unknown) & {
    _isMockFunction:       true
    mock:                  { invocationCallOrder: number[] }
    getMockImplementation: () => unknown
    mockClear:             () => void
    mockReset:             () => void
    mockImplementation:    (fn: unknown) => void
    mockRestore?:          () => void
};

/** A watched global: its own properties are compared one by one. */
interface Watched {
    label:     string
    target:    object
    /** Keys that were accessor properties when the guard loaded. */
    accessors: Set<string>
}

/** An accessor property's getter and setter, compared by identity. */
class Accessor {
    constructor(readonly get: unknown, readonly set: unknown) {}
}

/** Stands in for a property that could not be read. */
const UNREADABLE = Symbol('unreadable');

/** A watched global's own properties at one moment: names and, in the same order, values. */
interface PropsState {
    entry:  Watched
    names:  string[]
    values: unknown[]
}

interface MockState {
    fn:        MockLike
    label:     string
    /**
     * The invocation order number of its latest recorded call (0 for none).
     * bun numbers every mock call from one counter that only grows, so a call
     * still recorded later with a higher number was made after the record,
     * and clearing older calls is never mistaken for new ones.
     */
    lastOrder: number
    impl:      unknown
}

/** A spy made through the wrapped spyOn. */
interface SpyRecord {
    target:   object
    key:      PropertyKey
    original: unknown
    spy:      MockLike
    site:     string
}

/** The recorded state that later state is compared with. */
export interface Snapshot {
    props:       PropsState[]
    mocks:       MockState[]
    spies:       number
    env:         Record<string, string | undefined>
    envCount:    number
    fakeTimers:  boolean
    listeners:   (readonly unknown[])[]
    cwd:         string
    moduleMocks: number
}

export interface Leak {
    /** One line naming what leaked. */
    description: string
    /** Puts this one piece of state back to the record. */
    undo:        () => void
}

/** The repository root (this file sits in tests/). */
const PROJECT_ROOT = path.resolve(import.meta.dir, '..') + path.sep;
const THIS_FILE = import.meta.path;
/** bun:test with spyOn, beforeAll and afterAll wrapped by this file. */
const BUN_TEST_SHIM = path.join(import.meta.dir, 'leak-guard-bun-test.ts');

/** The process events whose listeners outlive a test if it forgets them. */
const PROCESS_EVENTS = [
    'exit', 'beforeExit', 'uncaughtException', 'unhandledRejection', 'warning',
    'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2', 'SIGCHLD', 'SIGPIPE',
] as const;

// Captured before any test can spy on them.
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with process bound below
const nativeCwd = process.cwd;
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with process bound below
const nativeChdir = process.chdir;
const nativeListeners = process.listeners.bind(process);
const nativeListenerCount = process.listenerCount.bind(process);
const nativeOn = process.on.bind(process);
const nativeRemoveListener = process.removeListener.bind(process);
const getCwd = (): string => nativeCwd.call(process);

function isMock(value: unknown): value is MockLike {
    return typeof value === 'function' && (value as Partial<MockLike>)._isMockFunction === true;
}

/** The first stack frame outside the guard: who called. */
function callerSite(): string {
    // eslint-disable-next-line unicorn/error-message -- never thrown; only its stack is read
    const frames = (new Error().stack ?? '').split('\n').slice(1);
    return frames.find(frame => !frame.includes(THIS_FILE) && !frame.includes(BUN_TEST_SHIM))?.trim() ?? '(unknown site)';
}

// ---------------------------------------------------------------------------
// The globals, and the shared mocks

function watch(label: string, target: object): Watched {
    const accessors = new Set<string>();
    for(const key of Object.getOwnPropertyNames(target)) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if(descriptor !== undefined && !('value' in descriptor)) {
            accessors.add(key);
        }
    }
    return { label, target, accessors };
}

const watched: Watched[] = [
    watch('globalThis', globalThis),
    watch('process', process),
    watch('console', console),
    watch('Date', Date),
    watch('Bun', Bun),
];

const sharedMocks: [string, MockLike][] = [];

/**
 * Called by tests/test-preload.ts with the module mocks it installs, so their
 * calls and implementations are checked around every test.
 */
export function registerSharedMocks(mocks: Record<string, unknown>): void {
    for(const [name, fn] of Object.entries(mocks)) {
        if(isMock(fn)) {
            sharedMocks.push([`${name} (tests/test-preload.ts)`, fn]);
        }
    }
}

// ---------------------------------------------------------------------------
// spyOn, beforeAll and afterAll, as test files see them

const spies: SpyRecord[] = [];

function readKey(target: object, key: PropertyKey): unknown {
    try {
        return (target as Record<PropertyKey, unknown>)[key];
    } catch{
        return UNREADABLE;
    }
}

/** spyOn, recording the spy so a spy left in place is caught. */
export const guardedSpyOn = ((target: object, key: PropertyKey, ...rest: unknown[]) => {
    const original = readKey(target, key);
    const spy = (spyOn as (...args: unknown[]) => MockLike)(target, key, ...rest);
    // spyOn over a mock returns that mock: its state is checked as a mock instead.
    if(spy !== original) {
        spies.push({ target, key, original, spy, site: callerSite() });
    }
    return spy;
}) as typeof spyOn;

jest.spyOn = guardedSpyOn;

/** Set when a test file's beforeAll or afterAll runs: the record must be retaken. */
let fixturesChanged = false;

function noteFixtureHook<T extends (...args: never[]) => unknown>(fn: T): T {
    const wrapped = function(this: unknown, ...args: Parameters<T>): ReturnType<T> {
        fixturesChanged = true;
        return fn.apply(this, args) as ReturnType<T>;
    };
    // bun passes a done callback only to a hook that declares a parameter for it.
    Object.defineProperty(wrapped, 'length', { value: fn.length });
    return wrapped as unknown as T;
}

/** beforeAll, noting that fixtures may have changed between tests. */
export const guardedBeforeAll = ((fn: (...args: never[]) => unknown, ...rest: unknown[]) =>
    (beforeAll as (...args: unknown[]) => void)(noteFixtureHook(fn), ...rest)) as typeof beforeAll;

/** afterAll, noting that fixtures may have changed between tests. */
export const guardedAfterAll = ((fn: (...args: never[]) => unknown, ...rest: unknown[]) =>
    (afterAll as (...args: unknown[]) => void)(noteFixtureHook(fn), ...rest)) as typeof afterAll;

// ---------------------------------------------------------------------------
// mock.module tracking

interface ModuleMockCall {
    id:   string
    site: string
}

const moduleMockCalls: ModuleMockCall[] = [];
/** How many of them a failure has already reported (they cannot be undone, so they stay). */
let moduleMocksReported = 0;
/** Off until the first test file loads: the preload's own module mocks are the sanctioned ones. */
let moduleMocksArmed = false;

const nativeModuleMock = mock.module.bind(mock);
mock.module = (id: string, factory: () => unknown): void | Promise<void> => {
    if(moduleMocksArmed) {
        moduleMockCalls.push({ id, site: callerSite() });
    }
    return nativeModuleMock(id, factory);
};

// ---------------------------------------------------------------------------
// Recording

/** The value to compare for one property: the value itself, or the accessor pair. */
function readProperty(entry: Watched, key: string): unknown {
    try {
        if(!entry.accessors.has(key)) {
            return (entry.target as Record<string, unknown>)[key];
        }
        const descriptor = Object.getOwnPropertyDescriptor(entry.target, key);
        if(descriptor === undefined) {
            return UNREADABLE;
        }
        return 'value' in descriptor ? descriptor.value : accessorOf(descriptor);
    } catch{
        return UNREADABLE;
    }
}

function accessorOf(descriptor: PropertyDescriptor): Accessor {
    // Only compared by identity, never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- see above
    return new Accessor(descriptor.get, descriptor.set);
}

function recordProps(entry: Watched): PropsState {
    const names = Object.getOwnPropertyNames(entry.target);
    return { entry, names, values: names.map(key => readProperty(entry, key)) };
}

function mockState(fn: MockLike, label: string): MockState {
    return { fn, label, lastOrder: fn.mock.invocationCallOrder.at(-1) ?? 0, impl: fn.getMockImplementation() };
}

/** A readable name for the object a spy was made on. */
function describeTarget(target: object): string {
    for(const { label, target: candidate } of watched) {
        if(target === candidate) {
            return label;
        }
    }
    // eslint-disable-next-line unicorn/prefer-module -- bun's module registry, ESM included; only read for a message
    for(const [file, entry] of Object.entries(require.cache)) {
        if(entry?.exports === target) {
            return `the exports of ${path.relative(PROJECT_ROOT, file)}`;
        }
    }
    const ctor: unknown = (target as { constructor?: unknown }).constructor;
    if(typeof ctor === 'function' && (ctor as { prototype?: unknown }).prototype === target) {
        return `${ctor.name}.prototype`;
    }
    return typeof ctor === 'function' && ctor.name !== '' ? `a ${ctor.name}` : 'an object';
}

function spyLabel({ target, key, site }: SpyRecord): string {
    return `spyOn(${describeTarget(target)}, ${JSON.stringify(String(key))}) ${site}`;
}

/** Record everything the guard watches. */
export function takeSnapshot(): Snapshot {
    const mocks = sharedMocks.map(([label, fn]) => mockState(fn, label));
    // Spies a file keeps across its tests: their calls and implementation are per-test state too.
    for(const record of spies) {
        if(readKey(record.target, record.key) === record.spy) {
            mocks.push(mockState(record.spy, spyLabel(record)));
        }
    }
    const env = { ...process.env };
    return {
        props:       watched.map(entry => recordProps(entry)),
        mocks,
        spies:       spies.length,
        env,
        envCount:    Object.keys(env).length,
        fakeTimers:  jest.isFakeTimers(),
        listeners:   PROCESS_EVENTS.map(event => nativeListeners(event)),
        cwd:         getCwd(),
        moduleMocks: moduleMockCalls.length,
    };
}

// ---------------------------------------------------------------------------
// Comparison with the live state

function isAccessor(value: unknown): value is Accessor {
    return value instanceof Accessor;
}

function sameValue(a: unknown, b: unknown): boolean {
    if(isAccessor(a) && isAccessor(b)) {
        return a.get === b.get && a.set === b.set;
    }
    return Object.is(a, b);
}

function describeValue(value: unknown): string {
    if(isMock(value)) {
        return 'a mock function';
    }
    if(isAccessor(value)) {
        return 'an accessor';
    }
    if(typeof value === 'function') {
        return `function ${value.name || '(anonymous)'}`;
    }
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Put one global's property back to its recorded value (UNREADABLE: it did not exist). */
function undoProperty(target: object, key: string, was: unknown): void {
    if(was === UNREADABLE) {
        Reflect.deleteProperty(target, key);
        return;
    }
    Object.defineProperty(target, key, isAccessor(was)
        ? { get: was.get as () => unknown, set: was.set as (v: unknown) => void, configurable: true, enumerable: true }
        : { value: was, writable: true, configurable: true, enumerable: true });
}

/** Whether any property of this global differs from the record; allocates nothing but the name list. */
function propsChanged({ entry, names, values }: PropsState): boolean {
    if(Object.getOwnPropertyNames(entry.target).length !== names.length) {
        return true;
    }
    // An indexed loop: for-of over entries() would allocate a pair per property, around every test.
    // eslint-disable-next-line unicorn/no-for-loop -- see above
    for(let i = 0; i < names.length; i++) {
        if(!sameValue(values[i], readProperty(entry, names[i]))) {
            return true;
        }
    }
    return false;
}

function propsLeaks(state: PropsState, leaks: Leak[]): void {
    const { entry: { label, target }, names, values } = state;
    const now = recordProps(state.entry);
    const later = new Map(now.names.map((name, i) => [name, now.values[i]]));
    for(const [i, key] of names.entries()) {
        const was = values[i];
        if(!later.has(key)) {
            leaks.push({ description: `${label}.${key} was removed and not put back`, undo: () => undoProperty(target, key, was) });
            continue;
        }
        const value = later.get(key);
        later.delete(key);
        // A tracked spy is reported as one, with the line that made it.
        if(!sameValue(was, value) && !spies.some(record => record.spy === value)) {
            leaks.push({ description: `${label}.${key} was replaced by ${describeValue(value)} and not restored`, undo: () => undoProperty(target, key, was) });
        }
    }
    for(const key of later.keys()) {
        leaks.push({ description: `${label}.${key} was added and not removed`, undo: () => undoProperty(target, key, UNREADABLE) });
    }
}

function spyLeaks(from: number, leaks: Leak[]): void {
    for(let i = from; i < spies.length; i++) {
        const record = spies[i];
        if(readKey(record.target, record.key) !== record.original) {
            leaks.push({
                description: `${spyLabel(record)} was not restored (mockRestore() it after the test)`,
                undo:        () => {
                    record.spy.mockRestore?.();
                    if(readKey(record.target, record.key) !== record.original) {
                        (record.target as Record<PropertyKey, unknown>)[record.key] = record.original;
                    }
                },
            });
        }
    }
}

function mockLeaks({ fn, label, lastOrder, impl }: MockState, leaks: Leak[]): void {
    const orders = fn.mock.invocationCallOrder;
    const implChanged = fn.getMockImplementation() !== impl;
    if(!implChanged && (orders.length === 0 || orders.at(-1)! <= lastOrder)) {
        return;
    }
    const problems: string[] = [];
    const newCalls = orders.filter(order => order > lastOrder).length;
    if(newCalls > 0) {
        problems.push(`${newCalls} recorded call(s) not cleared (mockClear() it after the test)`);
    }
    if(implChanged) {
        problems.push('its implementation was changed and not put back');
    }
    leaks.push({
        description: `mock ${label}: ${problems.join('; ')}`,
        undo:        () => {
            if(!implChanged) {
                fn.mockClear();
                return;
            }
            fn.mockReset();
            if(impl !== undefined) {
                fn.mockImplementation(impl);
            }
        },
    });
}

function envChanged(since: Snapshot): boolean {
    const keys = Object.keys(process.env);
    if(keys.length !== since.envCount) {
        return true;
    }
    for(const key of keys) {
        if(process.env[key] !== since.env[key]) {
            return true;
        }
    }
    return false;
}

function envLeaks(since: Snapshot, leaks: Leak[]): void {
    const now = { ...process.env };
    for(const key of new Set([...Object.keys(since.env), ...Object.keys(now)])) {
        const was = since.env[key];
        const value = now[key];
        if(was === value) {
            continue;
        }
        let change = 'was changed';
        if(was === undefined) {
            change = 'was added';
        } else if(value === undefined) {
            change = 'was removed';
        }
        leaks.push({
            description: `process.env.${key} ${change} and not restored`,
            undo:        () => {
                if(was === undefined) {
                    Reflect.deleteProperty(process.env, key);
                } else {
                    process.env[key] = was;
                }
            },
        });
    }
}

/** Items of `a` not matched one-for-one in `b`. */
function minus(a: readonly unknown[], b: readonly unknown[]): unknown[] {
    const rest = [...b];
    return a.filter((item) => {
        const index = rest.indexOf(item);
        if(index === -1) {
            return true;
        }
        rest.splice(index, 1);
        return false;
    });
}

function listenerLeaks(event: string, was: readonly unknown[], leaks: Leak[]): void {
    const now = nativeListeners(event);
    const added = minus(now, was);
    const removed = minus(was, now);
    if(added.length > 0) {
        leaks.push({
            description: `${added.length} process '${event}' listener(s) added and not removed`,
            undo:        () => {
                for(const listener of added) {
                    nativeRemoveListener(event, listener as () => void);
                }
            },
        });
    }
    if(removed.length > 0) {
        leaks.push({
            description: `${removed.length} process '${event}' listener(s) removed and not put back`,
            undo:        () => {
                for(const listener of removed) {
                    nativeOn(event, listener as () => void);
                }
            },
        });
    }
}

/**
 * Everything that differs now from the record `since`, each with a way to put
 * it back. Reads the live state in place: when nothing differs it allocates
 * next to nothing.
 */
export function findLeaks(since: Snapshot): Leak[] {
    const leaks: Leak[] = [];
    spyLeaks(since.spies, leaks);
    for(const state of since.mocks) {
        mockLeaks(state, leaks);
    }
    for(const state of since.props) {
        if(propsChanged(state)) {
            propsLeaks(state, leaks);
        }
    }
    if(envChanged(since)) {
        envLeaks(since, leaks);
    }
    // An indexed loop, as in propsChanged: nothing allocated around a clean test.
    // eslint-disable-next-line unicorn/no-for-loop -- see above
    for(let index = 0; index < PROCESS_EVENTS.length; index++) {
        const event = PROCESS_EVENTS[index];
        const was = since.listeners[index];
        // A listener swapped for another one in the same count is not seen.
        if(nativeListenerCount(event) !== was.length) {
            listenerLeaks(event, was, leaks);
        }
    }
    const fakeTimers = jest.isFakeTimers();
    if(since.fakeTimers !== fakeTimers) {
        leaks.push(fakeTimers
            ? { description: 'fake timers are still installed (call jest.useRealTimers() after the test)', undo: () => jest.useRealTimers() }
            : { description: 'fake timers were uninstalled under the file that installed them', undo: () => jest.useFakeTimers() });
    }
    const cwd = getCwd();
    if(since.cwd !== cwd) {
        leaks.push({
            description: `the working directory changed from ${since.cwd} to ${cwd}`,
            undo:        () => nativeChdir.call(process, since.cwd),
        });
    }
    for(let i = Math.max(since.moduleMocks, moduleMocksReported); i < moduleMockCalls.length; i++) {
        const { id, site } = moduleMockCalls[i];
        leaks.push({
            description: `mock.module('${id}') ${site}: bun cannot undo a module mock, so it outlives this test; mock modules only in tests/test-preload.ts`,
            undo:        () => undefined,
        });
    }
    return leaks;
}

/** Undo every leak, the last first; a leak that cannot be undone is noted in the message. */
function undoAll(leaks: Leak[]): string[] {
    const failed: string[] = [];
    for(const leak of leaks.toReversed()) {
        try {
            leak.undo();
        } catch (error) {
            failed.push(`  - could not undo "${leak.description}": ${(error as Error).message}`);
        }
    }
    return failed;
}

/** The error that reports `leaks`, after putting the state back. */
export function leakError(scope: string, leaks: Leak[]): Error {
    const failed = undoAll(leaks);
    moduleMocksReported = moduleMockCalls.length;
    return new Error([
        `${scope} left state behind that leaks into the tests after it (${leaks.length} leak${leaks.length === 1 ? '' : 's'}):`,
        ...leaks.map(leak => `  - ${leak.description}`),
        ...failed,
        'Undo everything a test sets up in its own afterEach (or, for a file\'s beforeAll, in that file\'s afterAll); do not reset state before a test.',
        'A change the test did not make itself is work an earlier test left running. See tests/leak-guard.ts.',
    ].join('\n'));
}

// ---------------------------------------------------------------------------
// Hooks

/** The latest record, reused while no fixture hook has run since. */
let current: Snapshot | undefined;
let testBaseline: Snapshot | undefined;

beforeEach(() => {
    if(current === undefined || fixturesChanged) {
        current = takeSnapshot();
        fixturesChanged = false;
    }
    testBaseline = current;
});

/**
 * Throws the test-scope leak report, if any; called from the global afterEach
 * in tests/test-preload.ts.
 */
export function failOnTestLeaks(): void {
    const before = testBaseline;
    testBaseline = undefined;
    if(before === undefined) {
        return;
    }
    const leaks = findLeaks(before);
    if(leaks.length > 0) {
        // Put the state back (as far as it goes), then report.
        const error = leakError('This test', leaks);
        // Anything that could not be undone becomes the next test's starting point.
        current = undefined;
        spies.length = before.spies;
        throw error;
    }
    // The test's own spies are all restored: stop tracking them.
    spies.length = before.spies;
}

const FILE_START = '__leakGuardFileStart';
const FILE_END = '__leakGuardFileEnd';

/** Each test file's starting record, taken before its own beforeAll. */
const fileBaselines = new Map<string, Snapshot>();

/** Runs as the first statement of every test file: record the state before the file's own beforeAll. */
function fileStart(file: string): void {
    moduleMocksArmed = true;
    // Module mocks and spies made while the file loads (before the hook below) belong to the file too.
    const moduleMocks = moduleMockCalls.length;
    const fileSpies = spies.length;
    beforeAll(() => {
        current = takeSnapshot();
        fileBaselines.set(file, { ...current, moduleMocks, spies: fileSpies });
    });
}

/** Runs as the last statement of every test file: compare after the file's own afterAll. */
function fileEnd(file: string): void {
    afterAll(() => {
        const baseline = fileBaselines.get(file);
        fileBaselines.delete(file);
        current = undefined;
        if(baseline === undefined) {
            return;
        }
        const leaks = findLeaks(baseline);
        const error = leaks.length > 0
            ? leakError(`Test file ${path.relative(PROJECT_ROOT, file)} (its beforeAll/afterAll or top level)`, leaks)
            : undefined;
        spies.length = Math.min(spies.length, baseline.spies);
        if(error !== undefined) {
            throw error;
        }
    });
}

Object.assign(globalThis, { [FILE_START]: fileStart, [FILE_END]: fileEnd });

function loaderFor(file: string): 'ts' | 'tsx' | 'js' | 'jsx' {
    const typescript = /\.[cm]?tsx?$/.test(file);
    if(file.endsWith('x')) {
        return typescript ? 'tsx' : 'jsx';
    }
    return typescript ? 'ts' : 'js';
}

/** `import ... from 'bun:test'` at the start of a line: a real import, not one quoted inside a fixture. */
const BUN_TEST_IMPORT = /^(import\s[^;]*?from\s*)(['"])bun:test\2/gm;

Bun.plugin({
    name: 'leak-guard',
    setup(build) {
        build.onLoad({ filter: /\.test\.[cm]?[jt]sx?$/ }, async ({ path: file }) => {
            const source = await Bun.file(file).text();
            const loader = loaderFor(file);
            const call = (name: string): string => `globalThis.${name}(${JSON.stringify(file)});`;
            const guarded = source.replaceAll(BUN_TEST_IMPORT, (_match, head: string) => `${head}${JSON.stringify(BUN_TEST_SHIM)}`);
            // On the first line and after the last, so every original line keeps its number.
            return { contents: `${call(FILE_START)}${guarded}\n${call(FILE_END)}\n`, loader };
        });
    },
});
