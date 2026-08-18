import { setImmediate as setImmediatePromise } from 'node:timers/promises';

const DEFAULT_BATCH_SIZE = 1024;

export interface CooperativeWorkOptions {
    signal?: AbortSignal;
    /** Override only for deterministic tests. */
    batchSize?: number;
}

export type WorkCheckpoint = () => Promise<void> | undefined;

/** Create a cheap checkpoint that periodically yields to timers and terminal input. */
export function createWorkCheckpoint(options: CooperativeWorkOptions = {}): WorkCheckpoint {
    options.signal?.throwIfAborted();

    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
        throw new RangeError('batchSize must be a positive safe integer');
    }

    let remaining = batchSize;
    return () => {
        remaining--;
        if (remaining > 0) return undefined;

        remaining = batchSize;
        options.signal?.throwIfAborted();
        return setImmediatePromise(
            undefined,
            options.signal === undefined ? undefined : { signal: options.signal }
        );
    };
}
