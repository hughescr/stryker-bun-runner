/**
 * Keeps per-mutant warnings from flooding the log.
 *
 * A warning the runner emits for a mutant run can repeat for thousands of mutants
 * (one broken registry, one misconfigured preload, ...). The first occurrence of
 * each kind is logged at warn with full detail, exactly as a lone warning would be;
 * every later occurrence of that kind goes to debug with the same detail; and
 * {@link flush} adds one summary warn per kind that affected more than one mutant.
 */

import type { Logger } from '@stryker-mutator/api/logging';

/** How many affected mutant ids a summary line names. */
const MAX_LISTED_MUTANT_IDS = 5;

export class MutantWarnAggregator {
    /** The distinct mutant ids affected per kind, in first-seen order. */
    private readonly affected = new Map<string, Set<string>>();

    constructor(private readonly logger: Logger) {}

    /**
     * Log a per-mutant warning of the given kind: at warn the first time the kind occurs,
     * at debug afterwards. `format` and `args` are passed to the logger unchanged.
     */
    public warn(kind: string, mutantId: string, format: string, ...args: unknown[]): void {
        const ids = this.affected.get(kind);
        if(ids === undefined) {
            this.affected.set(kind, new Set([mutantId]));
            this.logger.warn(format, ...args);
        } else {
            ids.add(mutantId);
            this.logger.debug(format, ...args);
        }
    }

    /** Emit one summary warn per kind that affected more than one mutant, then forget everything. */
    public flush(): void {
        for(const [kind, ids] of this.affected) {
            if(ids.size > 1) {
                this.logger.warn(
                    '%s: %d mutants affected (first: %s%s); see debug log for details',
                    kind,
                    ids.size,
                    [...ids].slice(0, MAX_LISTED_MUTANT_IDS).join(', '),
                    ids.size > MAX_LISTED_MUTANT_IDS ? ', …' : ''
                );
            }
        }
        this.affected.clear();
    }
}
