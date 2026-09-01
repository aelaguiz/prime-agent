import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	initializeOrphanProcessJournal,
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
} from "../src/core/orphan-process-journal.js";

/** Installs one explicit durable authority and returns an exact environment restore. */
export function installTestOrphanProcessJournal(directory: string): () => void {
	const previousPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	const previousGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
	const authority = initializeOrphanProcessJournal(join(directory, `orphans-${randomUUID()}.jsonl`));
	process.env[ORPHAN_PROCESS_JOURNAL_ENV] = authority.path;
	process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
	return () => {
		if (previousPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previousPath;
		if (previousGeneration === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		else process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = previousGeneration;
	};
}
