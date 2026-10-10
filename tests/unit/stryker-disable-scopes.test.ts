import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';
import { glob } from 'tinyglobby';
import ts from 'typescript';

/**
 * Guard against `// Stryker disable` / `// Stryker restore` directives that Stryker silently ignores.
 *
 * Stryker only honours a directive comment when it is a LEADING comment of an AST node its
 * instrumenter visits (DirectiveBookkeeper.processStrykerDirectives reads `node.leadingComments`).
 * A directive that is the last thing before a closing brace — e.g. a `// Stryker restore` as the
 * final line of a block, catch clause or function body — is a trailing comment of the previous
 * statement and is never processed. For a restore that means the range disable never ends and
 * keeps ignoring mutants to the end of the file; for a disable it means the directive does
 * nothing. This test walks every src file with the TypeScript AST (no descent into type nodes,
 * imports or decorators, which Stryker skips) and requires every directive to lead some node, and
 * every range disable to be closed by a later range restore covering its mutators.
 */

// The instrumenter's own directive pattern, minus the reason capture this check does not need.
const DIRECTIVE_RE = /^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)/;
const STRYKER_INSTRUMENTED_MARKER = 'stryNS_9fa48';

interface Directive {
    line:     number
    type:     'disable' | 'restore'
    scope:    'next-line' | 'range'
    mutators: string[]
    attached: boolean
}

function commentValue(text: string, range: ts.CommentRange): string {
    const raw = text.slice(range.pos, range.end);
    return range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? raw.slice(2) : raw.slice(2, -2);
}

function hasDeclareModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false);
}

/** Mirrors the instrumenter's shouldSkip(): type-only nodes, `as` expressions, imports and decorators are not entered. */
function isSkippedByStryker(node: ts.Node): boolean {
    return ts.isTypeNode(node)
      || ts.isTypeParameterDeclaration(node)
      || ts.isAsExpression(node)
      || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isEnumDeclaration(node)
      || (ts.isFunctionDeclaration(node) && node.body === undefined)
      || ((ts.isVariableStatement(node) || ts.isModuleDeclaration(node)) && hasDeclareModifier(node))
      || ts.isImportDeclaration(node)
      || ts.isImportEqualsDeclaration(node)
      || ts.isDecorator(node);
}

/** Positions of every comment that leads a node Stryker's traversal would enter. */
function attachedCommentPositions(sourceFile: ts.SourceFile): Set<number> {
    const text = sourceFile.text;
    const attached = new Set<number>();
    const visit = (node: ts.Node): void => {
        for(const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
            attached.add(range.pos);
        }
        if(!isSkippedByStryker(node)) {
            ts.forEachChild(node, visit);
        }
    };
    ts.forEachChild(sourceFile, visit);
    return attached;
}

/** Every comment in the file: each one sits in the trivia before some token (EndOfFileToken included). */
function allComments(sourceFile: ts.SourceFile): ts.CommentRange[] {
    const text = sourceFile.text;
    const byPos = new Map<number, ts.CommentRange>();
    const visit = (node: ts.Node): void => {
        for(const range of [...ts.getLeadingCommentRanges(text, node.pos) ?? [], ...ts.getTrailingCommentRanges(text, node.end) ?? []]) {
            byPos.set(range.pos, range);
        }
        for(const child of node.getChildren(sourceFile)) {
            visit(child);
        }
    };
    visit(sourceFile);
    return [...byPos.values()].toSorted((a, b) => a.pos - b.pos);
}

function collectDirectives(fileName: string, text: string): Directive[] {
    const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const attached = attachedCommentPositions(sourceFile);
    const directives: Directive[] = [];
    for(const range of allComments(sourceFile)) {
        const match = DIRECTIVE_RE.exec(commentValue(text, range));
        if(!match) {
            continue;
        }
        directives.push({
            line:     sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1,
            type:     match[1] as Directive['type'],
            scope:    match[2] === 'next-line' ? 'next-line' : 'range',
            mutators: match[3].split(',').map(name => name.trim().toLowerCase()),
            attached: attached.has(range.pos),
        });
    }
    return directives;
}

/** Problems with the Stryker directives in one file; empty when every directive takes effect as written. */
function findDirectiveProblems(fileName: string, text: string): string[] {
    const directives = collectDirectives(fileName, text);
    const problems: string[] = [];
    for(const [index, directive] of directives.entries()) {
        const label = `${fileName}:${directive.line} Stryker ${directive.type}${directive.scope === 'range' ? '' : ' next-line'} ${directive.mutators.join(',')}`;
        if(!directive.attached) {
            problems.push(directive.type === 'restore'
                ? `${label}: not attached to any statement Stryker visits (trailing comment before a closing brace?) — it is ignored and the matching disable leaks to the end of the file`
                : `${label}: not attached to any statement Stryker visits (trailing comment before a closing brace?) — it is ignored`);
        }
        if(directive.type === 'disable' && directive.scope === 'range') {
            const closing = directives.slice(index + 1).find(later => later.scope === 'range'
              && later.mutators.some(name => name === 'all' || directive.mutators.includes(name)));
            const closes = closing?.type === 'restore'
              && (closing.mutators.includes('all') || directive.mutators.every(name => closing.mutators.includes(name)));
            if(!closes) {
                problems.push(`${label}: no matching range restore before the next overlapping range directive or end of file — the disable runs to the end of the file`);
            }
        }
    }
    return problems;
}

const repoRoot = path.resolve(import.meta.dir, '../..');
const globbed = await glob('src/**/*.ts', { cwd: repoRoot });
const srcFiles = globbed.toSorted((a, b) => a.localeCompare(b));
const srcTexts = await Promise.all(srcFiles.map(async file => readFile(path.join(repoRoot, file), 'utf8')));
const instrumented = srcTexts.some(text => text.includes(STRYKER_INSTRUMENTED_MARKER));

describe('Stryker directive scopes', () => {
    // Inside a Stryker sandbox the src files are the instrumented copies, whose comment layout no
    // longer matches the sources; the check is about the committed sources, so it runs outside only.
    it.skipIf(instrumented)('every Stryker directive in src takes effect, and every range disable is restored', () => {
        expect(srcFiles.length).toBeGreaterThan(0);
        const problems = srcFiles.flatMap((file, i) => findDirectiveProblems(file, srcTexts[i]));
        expect(problems).toEqual([]);
    });

    describe('findDirectiveProblems', () => {
        it('accepts a range restore that leads the next statement', () => {
            const code = [
                'function f(xs: string[]): string {',
                '    // Stryker disable StringLiteral: reason',
                '    const s = xs.join(", ");',
                '    // Stryker restore StringLiteral',
                '    return s;',
                '}',
            ].join('\n');
            expect(findDirectiveProblems('a.ts', code)).toEqual([]);
        });

        it('accepts a restore that leads the next class member, and a disable leading a catch clause', () => {
            const code = [
                'class C {',
                '    m(): void {',
                '        try {',
                '            g();',
                '        }',
                '        // Stryker disable all: reason',
                '        catch (error) {',
                '            h(error);',
                '        }',
                '    }',
                '    // Stryker restore all',
                '    /** doc */',
                '    n(): void {}',
                '}',
            ].join('\n');
            expect(findDirectiveProblems('a.ts', code)).toEqual([]);
        });

        it('flags a range restore that is the last line of a block (the leak this guards against)', () => {
            const code = [
                'function f(xs: string[]): void {',
                '    if(xs.length > 0) {',
                '        // Stryker disable StringLiteral,EqualityOperator: reason',
                '        warn("%s", xs.length > 5 ? ", …" : "");',
                '        // Stryker restore StringLiteral,EqualityOperator',
                '    }',
                '}',
            ].join('\n');
            expect(findDirectiveProblems('a.ts', code)).toEqual([
                expect.stringMatching(/^a\.ts:5 Stryker restore stringliteral,equalityoperator: not attached .* leaks to the end of the file$/),
            ]);
        });

        it('flags a range restore that is the last line of a catch clause and of a function body', () => {
            const code = [
                'function f(): void {',
                '    try {',
                '        g();',
                '    }',
                '    // Stryker disable all: reason',
                '    catch (error) {',
                '        h(error);',
                '    }',
                '    // Stryker restore all',
                '}',
                'function k(): void {',
                '    // Stryker disable BlockStatement: reason',
                '    if(a) {',
                '        b();',
                '    }',
                '    // Stryker restore BlockStatement',
                '}',
            ].join('\n');
            expect(findDirectiveProblems('a.ts', code)).toEqual([
                expect.stringMatching(/^a\.ts:9 Stryker restore all: not attached/),
                expect.stringMatching(/^a\.ts:16 Stryker restore blockstatement: not attached/),
            ]);
        });

        it('flags a disable (range or next-line) placed before a closing brace, where it does nothing', () => {
            const code = [
                'function f(): void {',
                '    if(a) {',
                '        b();',
                '        // Stryker disable next-line BlockStatement: reason',
                '    } else {',
                '        c();',
                '        // Stryker disable ConditionalExpression: reason',
                '    }',
                '    // Stryker restore ConditionalExpression',
                '    d();',
                '}',
            ].join('\n');
            expect(findDirectiveProblems('a.ts', code)).toEqual([
                expect.stringMatching(/^a\.ts:4 Stryker disable next-line blockstatement: not attached .* it is ignored$/),
                expect.stringMatching(/^a\.ts:7 Stryker disable conditionalexpression: not attached .* it is ignored$/),
            ]);
        });

        it('flags a range disable with no matching restore, or one closed by a restore of other mutators', () => {
            const unclosed = [
                '// Stryker disable StringLiteral: reason',
                'const a = "x";',
            ].join('\n');
            expect(findDirectiveProblems('a.ts', unclosed)).toEqual([
                expect.stringMatching(/^a\.ts:1 Stryker disable stringliteral: no matching range restore/),
            ]);
            const partial = [
                '// Stryker disable StringLiteral,EqualityOperator: reason',
                'const a = "x" === b;',
                '// Stryker restore StringLiteral',
                'const c = 1;',
            ].join('\n');
            expect(findDirectiveProblems('a.ts', partial)).toEqual([
                expect.stringMatching(/^a\.ts:1 Stryker disable stringliteral,equalityoperator: no matching range restore/),
            ]);
        });

        it('ignores directives inside type declarations as Stryker does, and reads block comments', () => {
            const code = [
                'interface I {',
                '    // Stryker disable next-line all: reason',
                '    a: string',
                '}',
                '/* Stryker disable next-line StringLiteral: reason */',
                'const x = "y";',
            ].join('\n');
            expect(findDirectiveProblems('a.ts', code)).toEqual([
                expect.stringMatching(/^a\.ts:2 Stryker disable next-line all: not attached/),
            ]);
        });
    });
});
