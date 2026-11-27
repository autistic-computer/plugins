// Newline-delimited JSON-RPC for MCP over stdio, serving both protocol eras
// from one process: `server/discover` with per-request `_meta` (2026-07-28)
// and the `initialize` handshake (2025-11-25 and earlier).
//
// Claude Code probes `server/discover` first and falls back to `initialize`
// on any error. It only advertises the Tasks extension on the modern path,
// and the Skills extension is declared in the discover result, so answering
// `server/discover` is what unlocks both.

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const TASKS_EXT = "io.modelcontextprotocol/tasks";
export const SKILLS_EXT = "io.modelcontextprotocol/skills";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const META_SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  missingCapability: -32021,
  unsupportedVersion: -32022
};

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * @param {object} options
 * @param {{name: string, version: string}} options.serverInfo
 * @param {string} options.instructions
 * @param {{modern: object, legacy: object}} options.capabilities
 * @param {Record<string, (params: object, ctx: object) => unknown>} options.methods
 * @param {(line: string) => void} options.write
 * @param {(direction: "in" | "out", message: unknown) => void} [options.trace]
 */
export function createRpcServer({ serverInfo, instructions, capabilities, methods, write, trace = () => {} }) {
  const inflight = new Map();
  const openSubscriptions = new Set();

  function send(message) {
    trace("out", message);
    write(`${JSON.stringify(message)}\n`);
  }

  function notify(method, params) {
    send({ jsonrpc: "2.0", method, params });
  }

  const builtins = {
    "server/discover": () => ({
      supportedVersions: [MODERN_VERSION],
      capabilities: capabilities.modern,
      instructions,
      ttlMs: 3_600_000,
      cacheScope: "public"
    }),

    initialize: (params) => ({
      protocolVersion: LEGACY_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : LEGACY_VERSIONS[0],
      capabilities: capabilities.legacy,
      serverInfo,
      instructions
    }),

    ping: () => ({}),

    // Nothing here ever changes its tool or resource list, so a subscription is
    // acknowledged and then held open until the client cancels or we shut down.
    "subscriptions/listen": (_params, ctx) => {
      notify("notifications/subscriptions/acknowledged", { _meta: { [META_SUBSCRIPTION]: ctx.id } });
      return new Promise((resolve) => {
        const close = () => {
          openSubscriptions.delete(close);
          resolve({ _meta: { [META_SUBSCRIPTION]: ctx.id } });
        };
        openSubscriptions.add(close);
        ctx.signal.addEventListener("abort", close, { once: true });
      });
    }
  };

  function context(request) {
    const meta = request.params?._meta ?? {};
    const modern = typeof meta[META_VERSION] === "string";
    const clientCaps = modern ? meta[META_CLIENT_CAPS] ?? {} : {};
    const controller = new AbortController();
    const progressToken = meta.progressToken;
    let ticks = 0;
    return {
      id: request.id,
      meta,
      modern,
      controller,
      signal: controller.signal,
      supportsTasks: Boolean(clientCaps.extensions?.[TASKS_EXT]),
      // Progress resets the client's idle timer on long blocking calls. It is a
      // no-op unless the caller opted in with a progress token.
      progress(message) {
        if (progressToken === undefined || controller.signal.aborted) {
          return;
        }
        ticks += 1;
        notify("notifications/progress", { progressToken, progress: ticks, message });
      }
    };
  }

  function envelope(result) {
    const body = result && typeof result === "object" ? result : {};
    return {
      resultType: "complete",
      ...body,
      _meta: { [META_SERVER_INFO]: serverInfo, ...body._meta }
    };
  }

  async function handleRequest(request) {
    const ctx = context(request);
    try {
      if (ctx.modern && ctx.meta[META_VERSION] !== MODERN_VERSION) {
        throw new RpcError(ERR.unsupportedVersion, "Unsupported protocol version", {
          supported: [MODERN_VERSION, ...LEGACY_VERSIONS],
          requested: ctx.meta[META_VERSION]
        });
      }
      const handler = builtins[request.method] ?? methods[request.method];
      if (!handler) {
        throw new RpcError(ERR.methodNotFound, `Method not found: ${request.method}`);
      }
      inflight.set(request.id, ctx.controller);
      const result = await handler(request.params ?? {}, ctx);
      send({ jsonrpc: "2.0", id: request.id, result: envelope(result) });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : ERR.internal;
      const payload = { code, message: error instanceof Error ? error.message : String(error) };
      if (error instanceof RpcError && error.data !== undefined) {
        payload.data = error.data;
      }
      send({ jsonrpc: "2.0", id: request.id, error: payload });
    } finally {
      inflight.delete(request.id);
    }
  }

  function handleNotification(notification) {
    if (notification.method === "notifications/cancelled") {
      inflight.get(notification.params?.requestId)?.abort();
    }
  }

  async function handleLine(line) {
    const text = line.trim();
    if (!text) {
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "Parse error" } });
      return;
    }
    trace("in", message);
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR.invalidRequest, message: "Invalid request" } });
      return;
    }
    if (typeof message.method !== "string") {
      // A response. This server never sends requests, so there is nothing to match.
      return;
    }
    if (message.id === undefined || message.id === null) {
      handleNotification(message);
      return;
    }
    await handleRequest(message);
  }

  function close() {
    for (const closeSubscription of [...openSubscriptions]) {
      closeSubscription();
    }
    for (const controller of inflight.values()) {
      controller.abort();
    }
  }

  return { handleLine, notify, close };
}
