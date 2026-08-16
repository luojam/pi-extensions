import type { Dir } from 'node:fs';
import { opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface DiscoveredSessionFile {
    /** Canonical absolute path. */
    path: string;
    /** Whether the file is physically beneath a directory named `subagents`. */
    isSubagentFile: boolean;
}

export interface SessionDiscoveryOptions {
    signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
}

function isWithin(parent: string, candidate: string): boolean {
    const child = relative(parent, candidate);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function isSubagentPath(path: string): boolean {
    return path.split(sep).includes('subagents');
}

/**
 * Resolve existing roots and remove duplicates and roots already covered by another root.
 * Missing or non-directory roots are silently ignored.
 */
export async function canonicalizeSessionRoots(
    roots: readonly string[],
    options: SessionDiscoveryOptions = {}
): Promise<string[]> {
    const canonical = new Set<string>();

    for (const root of roots) {
        throwIfAborted(options.signal);
        try {
            const path = await realpath(resolve(root));
            if ((await stat(path)).isDirectory()) canonical.add(path);
        } catch (error) {
            throwIfAborted(options.signal);
            // A missing or inaccessible root is an empty source.
            if (error instanceof Error) continue;
        }
    }

    const sorted = [...canonical].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return sorted.filter(
        (candidate, index) => !sorted.slice(0, index).some((root) => isWithin(root, candidate))
    );
}

/** Recursively discover regular JSONL files without following symlink directories or files. */
export async function discoverSessionFiles(
    roots: readonly string[],
    options: SessionDiscoveryOptions = {}
): Promise<DiscoveredSessionFile[]> {
    const canonicalRoots = await canonicalizeSessionRoots(roots, options);
    const paths = new Map<string, DiscoveredSessionFile>();
    const physicalFiles = new Set<string>();

    for (const root of canonicalRoots) {
        const pending = [root];
        while (pending.length > 0) {
            throwIfAborted(options.signal);
            const directory = pending.pop();
            if (directory === undefined) break;

            let handle: Dir | undefined;
            try {
                handle = await opendir(directory);
                for await (const entry of handle) {
                    throwIfAborted(options.signal);
                    const path = resolve(directory, entry.name);
                    if (entry.isDirectory()) {
                        pending.push(path);
                        continue;
                    }
                    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

                    try {
                        const canonicalPath = await realpath(path);
                        const metadata = await stat(canonicalPath);
                        if (!metadata.isFile()) continue;
                        const identity = `${metadata.dev}:${metadata.ino}`;
                        if (physicalFiles.has(identity)) continue;
                        physicalFiles.add(identity);
                        paths.set(canonicalPath, {
                            path: canonicalPath,
                            isSubagentFile: isSubagentPath(canonicalPath),
                        });
                    } catch {
                        throwIfAborted(options.signal);
                        // Files can disappear or become unreadable during discovery.
                    }
                }
            } catch {
                throwIfAborted(options.signal);
                // An unreadable individual directory does not invalidate other roots.
            } finally {
                await handle?.close().catch(() => undefined);
            }
        }
    }

    return [...paths.values()].sort((a, b) => a.path.localeCompare(b.path));
}
