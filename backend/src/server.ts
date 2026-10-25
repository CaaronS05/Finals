/**
 * Backend entrypoint.
 *
 * Loads and validates configuration, starts the local HTTP server, and stops.
 * No CDP connection is opened here. Browser work is opt-in and belongs to a
 * later phase.
 */

import { loadConfig } from "./config.ts";
import { createBackendHttpServer } from "./http/index.ts";
import { sanitizeError } from "./errors.ts";
import { ConfigError } from "./errors.ts";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Fail fast with a sanitized message. A malformed port or host is a
    // configuration mistake, not a runtime condition to paper over.
    const detail = error instanceof ConfigError ? ` (${error.field ?? "unknown field"})` : "";
    console.error(`[config] startup rejected${detail}: ${sanitizeError(error)}`);
    process.exitCode = 1;
    return;
  }

  const app = createBackendHttpServer(config);
  app.listening.then(
    (port) => {
      console.log(`[http] ${SERVICE_LABEL} listening on http://${config.host}:${port}`);
      console.log("[http] GET /health is the only route. CDP connections are opt-in and lazy.");
    },
    (error: unknown) => {
      console.error(`[http] failed to bind http://${config.host}:${config.port}: ${sanitizeError(error)}`);
      process.exitCode = 1;
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(`[http] shutdown error: ${sanitizeError(error)}`);
          process.exit(1);
        },
      );
    });
  }
}

const SERVICE_LABEL = "dllm-backend";

main();
