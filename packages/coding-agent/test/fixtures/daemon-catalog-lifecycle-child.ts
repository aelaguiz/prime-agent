import type { ChildProcess } from "node:child_process";
import { installProcessLifecycle, markProcessLifecycleCompleted } from "../../src/core/process-lifecycle.js";
import {
	DaemonCatalogClient,
	isDaemonCatalogProcess,
	runDaemonCatalogProcess,
} from "../../src/modes/daemon/daemon-catalog-process.js";

function requireCatalogChild(client: DaemonCatalogClient): ChildProcess {
	const child = (client as unknown as { child?: ChildProcess }).child;
	if (!child) throw new Error("Catalog client did not retain its child process");
	return child;
}

function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => rejectExit(new Error("Timed out waiting for catalog child exit")), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

if (isDaemonCatalogProcess()) {
	installProcessLifecycle({ role: "daemon-catalog" });
	await runDaemonCatalogProcess();
} else {
	installProcessLifecycle({ role: "daemon-catalog-test-parent" });
	const client = new DaemonCatalogClient(() => undefined, "/tmp/catalog-lifecycle-test.sock");
	await client.start();
	const firstChild = requireCatalogChild(client);
	const firstExit = waitForExit(firstChild);
	firstChild.kill("SIGKILL");
	await firstExit;

	await client.start();
	const replacementChild = requireCatalogChild(client);
	const replacementExit = waitForExit(replacementChild);
	await client.stop();
	await replacementExit;
	markProcessLifecycleCompleted({ result: "catalog-recovered" });
}
