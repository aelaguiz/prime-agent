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

export async function runMcpServe(options: McpServeOptions): Promise<void> {
	const bridge = new DaemonBridge({ ...(options.daemonSocket ? { daemonSocket: options.daemonSocket } : {}) });
	try {
		await bridge.start();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`mcp-serve cannot reach the Prime Agent daemon at ${bridge.socketPath}: ${message}`);
	}
	const context: McpServeToolContext = { bridge, host: hostname() };
	try {
		if (options.stdio) {
			await serveStdio(context);
			return;
		}
		await serveHttp(options, context);
	} finally {
		bridge.close();
	}
}

async function serveStdio(context: McpServeToolContext): Promise<void> {
	const server = createMcpServer(context);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// stdout is the protocol channel in stdio mode; every log line goes to stderr.
	process.stderr.write(`mcp-serve ready on stdio (daemon: ${context.bridge.socketPath})\n`);
	await waitForShutdownSignal();
	await server.close();
}

async function serveHttp(options: McpServeOptions, context: McpServeToolContext): Promise<void> {
	const httpServer = createServer((request, response) => {
		void handleHttpRequest(request, response, context);
	});
	await listen(httpServer, options.port, options.bind);
	const daemonVersion = context.bridge.hello?.appVersion ?? "unknown";
	console.log(
		`mcp-serve listening on http://${options.bind}:${options.port}${MCP_PATH} ` +
			`(daemon: ${context.bridge.socketPath}, ${daemonVersion})`,
	);
	await waitForShutdownSignal();
	httpServer.closeAllConnections();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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
		void transport.close();
		void server.close();
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
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BYTES) {
				reject(new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("error", reject);
		request.on("end", () => {
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

function waitForShutdownSignal(): Promise<void> {
	return new Promise((resolve) => {
		const onSignal = () => {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			resolve();
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	});
}

function jsonRpcError(code: number, message: string): Record<string, unknown> {
	return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
	response.writeHead(statusCode, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}
