import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VERSION } from "../../config.js";
import { DaemonBridge } from "./daemon-bridge.js";
import { type McpServeToolContext, registerMcpServeTools } from "./tools.js";

export interface McpServeOptions {
	port: number;
	bind: string;
	stdio: boolean;
	daemonSocket?: string;
}

export const MCP_SERVE_DEFAULT_PORT = 7717;
export const MCP_SERVE_DEFAULT_BIND = "0.0.0.0";

const MCP_PATH = "/mcp";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_DRAIN_BYTES = 16 * 1024 * 1024;

export interface RunningMcpServe {
	readonly port: number;
	readonly socketPath: string;
	readonly daemonVersion: string;
	/** True when the daemon runs an older build than this process. */
	readonly staleDaemon: boolean;
	close(): Promise<void>;
}

export async function runMcpServe(options: McpServeOptions): Promise<void> {
	if (options.stdio) {
		const context = await createToolContext(options.daemonSocket);
		try {
			await serveStdio(context);
		} finally {
			context.bridge.close();
		}
		return;
	}
	const server = await startMcpServe(options);
	const skew = server.staleDaemon ? `, older than this build ${VERSION}` : "";
	console.log(
		`mcp-serve listening on http://${options.bind}:${server.port}${MCP_PATH} ` +
			`(daemon: ${server.socketPath}, ${server.daemonVersion}${skew})`,
	);
	await waitForShutdown();
	await server.close();
}

/**
 * Start the HTTP server and return a handle. Signal handling stays in
 * `runMcpServe` so an embedding caller (a test) owns the lifecycle itself.
 * Port 0 binds an ephemeral port; the handle reports the real one.
 */
export async function startMcpServe(options: {
	port: number;
	bind: string;
	daemonSocket?: string;
}): Promise<RunningMcpServe> {
	const context = await createToolContext(options.daemonSocket);
	const httpServer = createServer((request, response) => {
		handleHttpRequest(request, response, context).catch((error: unknown) => {
			console.error(`mcp-serve request handler failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
	try {
		await listen(httpServer, options.port, options.bind);
	} catch (error) {
		context.bridge.close();
		throw error;
	}
	const address = httpServer.address();
	return {
		port: typeof address === "object" && address !== null ? address.port : options.port,
		socketPath: context.bridge.socketPath,
		daemonVersion: context.bridge.hello?.appVersion ?? "unknown",
		staleDaemon: context.bridge.isStaleDaemon,
		close: async () => {
			httpServer.closeAllConnections();
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
			context.bridge.close();
		},
	};
}

async function createToolContext(daemonSocket: string | undefined): Promise<McpServeToolContext> {
	const bridge = new DaemonBridge({ ...(daemonSocket ? { daemonSocket } : {}) });
	try {
		await bridge.start();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`mcp-serve cannot reach the Prime Agent daemon at ${bridge.socketPath}: ${message}`);
	}
	return { bridge, host: hostname() };
}

async function serveStdio(context: McpServeToolContext): Promise<void> {
	const server = createMcpServer(context);
	const transport = new StdioServerTransport();
	const clientClosed = new Promise<void>((resolve) => {
		server.server.onclose = () => resolve();
	});
	await server.connect(transport);
	// stdout is the protocol channel in stdio mode; every log line goes to stderr.
	process.stderr.write(`mcp-serve ready on stdio (daemon: ${context.bridge.socketPath})\n`);
	await waitForShutdown(clientClosed);
	await server.close();
}

async function handleHttpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	context: McpServeToolContext,
): Promise<void> {
	const path = (request.url ?? "").split("?")[0];
	if (path !== MCP_PATH) {
		writeJson(response, 404, jsonRpcError(-32601, `Unknown path: ${path}`));
		return;
	}
	if (request.method !== "POST") {
		// Stateless Streamable HTTP has no standalone SSE stream and no session to delete.
		writeJson(response, 405, jsonRpcError(-32601, `Method not allowed: ${request.method ?? "unknown"}`));
		return;
	}

	let body: unknown;
	try {
		body = await readJsonBody(request);
	} catch (error) {
		writeJson(response, 400, jsonRpcError(-32700, error instanceof Error ? error.message : String(error)));
		return;
	}

	const server = createMcpServer(context);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	response.on("close", () => {
		transport.close().catch(() => undefined);
		server.close().catch(() => undefined);
	});
	try {
		await server.connect(transport);
		await transport.handleRequest(request, response, body);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`mcp-serve request failed: ${message}`);
		if (!response.headersSent) {
			writeJson(response, 500, jsonRpcError(-32603, message));
		}
	}
}

function createMcpServer(context: McpServeToolContext): McpServer {
	const server = new McpServer(
		{ name: "prime-agent", version: VERSION },
		{
			instructions:
				`Remote control for the Prime Agent sessions running on ${context.host}. ` +
				"Call status first: it lists every session with a derived state and the evidence behind it.",
		},
	);
	registerMcpServeTools(server, context);
	return server;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let oversize = false;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BYTES) {
				// Keep draining (discarding) an oversized body instead of destroying the
				// socket, so the caller can finish its upload and read the 400 rather than
				// seeing a dropped connection. Give up on a caller that ignores the limit.
				chunks.length = 0;
				oversize = true;
				if (size > MAX_REQUEST_DRAIN_BYTES) {
					request.destroy();
					reject(new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`));
				}
				return;
			}
			chunks.push(chunk);
		});
		request.on("error", reject);
		request.on("end", () => {
			if (oversize) {
				reject(new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`));
				return;
			}
			if (size === 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

function listen(server: Server, port: number, bind: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(port, bind, () => {
			server.off("error", onError);
			resolve();
		});
	});
}

/** Resolves on SIGINT/SIGTERM, or on `closed` when the transport goes away first. */
async function waitForShutdown(closed?: Promise<void>): Promise<void> {
	let onSignal: (() => void) | undefined;
	const signalled = new Promise<void>((resolve) => {
		onSignal = resolve;
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
	try {
		await (closed ? Promise.race([signalled, closed]) : signalled);
	} finally {
		if (onSignal) {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
		}
	}
}

function jsonRpcError(code: number, message: string): Record<string, unknown> {
	return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
	response.writeHead(statusCode, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}
