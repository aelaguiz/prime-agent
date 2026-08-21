import { existsSync } from "node:fs";
import { tryAcquireDaemonLaunchLease } from "../../src/modes/daemon/daemon-launch-lease.js";

const [socketPath, barrierPath, releasePath] = process.argv.slice(2);
if (!socketPath || !barrierPath || !releasePath) throw new Error("missing launch lease fixture arguments");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
process.send?.({ type: "ready" });
while (!existsSync(barrierPath)) await delay(10);
const lease = tryAcquireDaemonLaunchLease(socketPath);
process.send?.({ type: "acquired", leader: lease !== undefined });
if (lease) {
	while (!existsSync(releasePath)) await delay(10);
	lease.release();
}
