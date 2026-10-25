/**
 * Minimal local HTTP server for the DLLM Finals backend.
 *
 * Binds to 127.0.0.1 only. Exposes GET /health for liveness checks.
 *
 * This server is deliberately inert: it performs no CDP connection, no LP
 * Agent request, no Fabriq request, and no scan work at startup or on any
 * route. Browser work arrives in a later phase and must be triggered
 * explicitly by a caller.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BackendConfig } from "../config.ts";
import { sanitizeError } from "../errors.ts";

export const SERVICE_NAME = "dllm-backend";

/** Payload returned by GET /health. */
export interface HealthResponse {
  status: "ok";
  service: typeof SERVICE_NAME;
}

export interface BackendServer {
  readonly server: Server;
  /** Resolves with the bound port once listening. */
  readonly listening: Promise<number>;
  /** Close the server and reject any pending connections. */
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * Create the HTTP server. Does not listen yet; callers bind explicitly so
 * tests can choose an ephemeral port.
 */
export function createBackendHttpServer(config: BackendConfig): BackendServer {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Only GET /health exists. Everything else is a 404, and no route touches
    // the browser, a provider, or the filesystem.
    if (req.method === "GET" && req.url?.split("?")[0] === "/health") {
      const payload: HealthResponse = { status: "ok", service: SERVICE_NAME };
      sendJson(res, 200, payload);
      return;
    }
    sendJson(res, 404, { status: "error", error: "Not found" });
  });

  server.on("error", (error: Error) => {
    // Log the sanitized form. A raw error can contain a local filesystem path.
    console.error(`[http] server error: ${sanitizeError(error)}`);
  });

  const listening = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : config.port;
      resolve(port);
    });
  });

  return {
    server,
    listening,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
