import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Return one physical filesystem identity even when the final path does not
 * exist yet. Missing suffixes are appended to the nearest existing realpath.
 */
export function normalizePhysicalFilesystemPath(path: string, baseDir?: string): string {
	let existingAncestor = baseDir ? resolve(baseDir, path) : resolve(path);
	const missingSuffix: string[] = [];
	while (true) {
		try {
			const physicalAncestor = realpathSync.native(existingAncestor);
			const canonical = join(physicalAncestor, ...missingSuffix);
			return process.platform === "win32" ? canonical.toLowerCase() : canonical;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			let ancestorEntryExists = false;
			try {
				// ENOENT from realpath can also mean that an existing symlink is
				// broken. That is unresolved authority evidence, not a missing suffix.
				lstatSync(existingAncestor);
				ancestorEntryExists = true;
			} catch (lstatError) {
				if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") throw lstatError;
			}
			if (ancestorEntryExists) throw error;
			const parent = dirname(existingAncestor);
			if (parent === existingAncestor) throw error;
			missingSuffix.unshift(basename(existingAncestor));
			existingAncestor = parent;
		}
	}
}

/** Return the platform authority identity for a daemon socket or named pipe. */
export function normalizeSocketPath(socketPath: string, baseDir?: string): string {
	if (process.platform === "win32") {
		// Named pipes are not filesystem paths. Preserve the existing Windows
		// policy rather than trying to realpath their namespace.
		return socketPath.toLowerCase();
	}
	return normalizePhysicalFilesystemPath(socketPath, baseDir);
}
