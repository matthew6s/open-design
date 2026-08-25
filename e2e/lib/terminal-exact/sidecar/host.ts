import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type * as Standalone from "@open-design/standalone";

import { TerminalExactSidecarHandlers } from "./handlers.js";

const argumentsMap = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key != null && value != null) argumentsMap.set(key, value);
}
const storeRoot = resolve(argumentsMap.get("--store-root") ?? "");
const standalonePath = resolve(argumentsMap.get("--standalone") ?? "");
const port = Number.parseInt(argumentsMap.get("--port") ?? "0", 10);
if (!storeRoot || !standalonePath || !Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("fixture Sidecar arguments are invalid");
}

const standalone = await import(pathToFileURL(standalonePath).href) as typeof Standalone;
const handlers = new TerminalExactSidecarHandlers(storeRoot, standalone, {
  transitionLeaseDurationMs: Number.parseInt(process.env.OD_FIXTURE_TRANSITION_LEASE_MS ?? "30000", 10),
});

function errorPayload(error: unknown): { code: string; message: string } {
  const code = typeof error === "object" && error != null && "code" in error && typeof error.code === "string"
    ? error.code
    : "fixture-sidecar-error";
  return { code, message: error instanceof Error ? error.message : String(error) };
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/request") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  try {
    const message = JSON.parse(body) as Record<string, unknown>;
    if (message.fault === "crash") {
      response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      setImmediate(() => process.exit(73));
      return;
    }
    const result = await handlers.request(message);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: errorPayload(error) }));
  }
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", rejectListen);
    resolveListen();
  });
});
const address = server.address();
if (address == null || typeof address === "string") throw new Error("fixture Sidecar did not bind TCP");
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, endpointUrl: `http://127.0.0.1:${address.port}` })}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
