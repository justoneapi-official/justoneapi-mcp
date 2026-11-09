import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bundledCatalog } from "../src/generated/bundledCatalog.js";
import worker from "../src/worker.js";
import { clearWorkerOAuthServicesForTests } from "../src/worker/oauth/services.js";
import {
  OAUTH_ACCESS_TOKEN,
  OAUTH_DELEGATION_TOKEN,
  activeIntrospectionPayload,
  createPrivateJwks,
} from "./oauthFixtures.js";

type ProtocolVersion = "2025-06-18" | "2026-07-28";
type Mode = "off" | "dual";

const lanes = [
  ["off", "2025-06-18"],
  ["dual", "2025-06-18"],
  ["off", "2026-07-28"],
  ["dual", "2026-07-28"],
] as const;
const endpoint = bundledCatalog.catalog.endpoints.find(
  (entry) => !entry.hidden && !entry.deprecated
)!;
const publicCalls = [
  ["list_platforms", {}],
  ["search_endpoints", { query: endpoint.platform, limit: 1 }],
  ["get_endpoint_schema", { endpoint_id: endpoint.endpoint_id }],
] as const;
const protectedCalls = ["call_endpoint", "get_account_balance", "get_usage_summary"];
let privateJwks = "";

beforeAll(async () => {
  privateJwks = (await createPrivateJwks()).raw;
});

afterEach(() => {
  clearWorkerOAuthServicesForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function env(mode: Mode = "dual"): Env {
  return {
    JUSTONEAPI_OAUTH_MODE: mode,
    JUSTONEAPI_OAUTH_WORKER_ACTIVE_KID: "test-key-1",
    JUSTONEAPI_OAUTH_WORKER_PRIVATE_JWKS: privateJwks,
    JUSTONEAPI_MCP_ALLOWED_ORIGINS: "*",
    JUSTONEAPI_MCP_CATALOG: { get: vi.fn(async () => null) } as unknown as KVNamespace,
  } as Env;
}

function rpcRequest(
  method: string,
  params: Record<string, unknown> = {},
  protocolVersion: ProtocolVersion = "2025-06-18",
  authorization?: string
): Request {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
  });
  if (authorization) headers.set("authorization", authorization);
  if (protocolVersion === "2026-07-28") {
    headers.set("mcp-method", method);
    if (method === "tools/call") headers.set("mcp-name", String(params.name));
  }
  return new Request("https://mcp.justoneapi.com/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(method.startsWith("notifications/") ? {} : { id: 1 }),
      method,
      params:
        protocolVersion === "2026-07-28"
          ? {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": protocolVersion,
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            }
          : params,
    }),
  });
}

async function fetchWorker(request: Request, workerEnv = env()): Promise<Response> {
  return await worker.fetch(request, workerEnv, {} as ExecutionContext);
}

async function rpcResult(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text;
  expect(response.status, text).toBe(200);
  expect(json).toBeDefined();
  const message = JSON.parse(json!) as { result: Record<string, unknown>; error?: unknown };
  expect(message.error).toBeUndefined();
  return message.result;
}

describe("public Worker catalog and protected account/API boundary", () => {
  it.each(["GET", "DELETE", "PUT"])(
    "returns 405 for an unsupported %s without an OAuth challenge",
    async (method) => {
      const upstream = vi.fn();
      vi.stubGlobal("fetch", upstream);
      const response = await fetchWorker(new Request("https://mcp.justoneapi.com/mcp", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.has("www-authenticate")).toBe(false);
      expect(response.headers.get("allow")).toContain("POST");
      expect(upstream).not.toHaveBeenCalled();
    }
  );

  it("connects a real Streamable HTTP client anonymously without authentication errors", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const workerEnv = env();
    const clientError = vi.fn();
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.justoneapi.com/mcp"), {
      fetch: async (input, init) => await fetchWorker(new Request(input, init), workerEnv),
    });
    const client = new LegacyClient({ name: "anonymous-catalog-client", version: "1.0.0" });
    client.onerror = clientError;
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(6);
      const result = await client.callTool({ name: "list_platforms", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(clientError).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
    }
  });

  it.each(lanes)("supports anonymous discovery in %s mode with %s", async (mode, protocol) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const workerEnv = env(mode);
    // Discovery must not depend on the Authorization Server or its signing secrets.
    delete workerEnv.JUSTONEAPI_OAUTH_WORKER_PRIVATE_JWKS;
    delete workerEnv.JUSTONEAPI_OAUTH_WORKER_ACTIVE_KID;

    if (protocol === "2025-06-18") {
      const initialized = await rpcResult(
        await fetchWorker(
          rpcRequest("initialize", {
            protocolVersion: protocol,
            capabilities: {},
            clientInfo: { name: "anonymous-catalog-test", version: "1.0.0" },
          }),
          workerEnv
        )
      );
      expect(initialized).toHaveProperty("serverInfo");
      const notified = await fetchWorker(rpcRequest("notifications/initialized"), workerEnv);
      expect(notified.status).toBe(202);
      await rpcResult(await fetchWorker(rpcRequest("ping", {}, protocol), workerEnv));
    } else {
      const discovered = await rpcResult(
        await fetchWorker(rpcRequest("server/discover", {}, protocol), workerEnv)
      );
      expect(discovered).toMatchObject({
        supportedVersions: expect.arrayContaining(["2026-07-28"]),
        capabilities: { tools: expect.any(Object) },
      });
    }
    const listed = await rpcResult(
      await fetchWorker(rpcRequest("tools/list", {}, protocol), workerEnv)
    );
    expect(listed.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "search_endpoints",
          securitySchemes: [{ type: "noauth" }],
        }),
        expect.objectContaining({ name: "call_endpoint" }),
      ])
    );
    expect(JSON.stringify(listed)).not.toContain("refresh_catalog");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(lanes)(
    "serves all three anonymous catalog tools in %s mode with %s",
    async (mode, protocol) => {
      const upstream = vi.fn();
      vi.stubGlobal("fetch", upstream);
      const workerEnv = env(mode);
      for (const [name, args] of publicCalls) {
        const result = await rpcResult(
          await fetchWorker(
            rpcRequest("tools/call", { name, arguments: args }, protocol),
            workerEnv
          )
        );
        expect(result.isError).not.toBe(true);
        if (name === "list_platforms") {
          expect(result.structuredContent).toMatchObject({
            success: true,
            platforms: expect.any(Array),
          });
        } else if (name === "search_endpoints") {
          expect(result.structuredContent).toMatchObject({ results: expect.any(Array) });
        } else {
          expect(result.structuredContent).toMatchObject({
            success: true,
            endpoint_id: endpoint.endpoint_id,
          });
        }
      }
      // No API dispatch, account read, introspection, token exchange, or catalog refresh.
      expect(upstream).not.toHaveBeenCalled();
    }
  );

  it.each(lanes)(
    "rejects all anonymous API/account calls before dispatch in %s mode with %s",
    async (mode, protocol) => {
      const upstream = vi.fn();
      vi.stubGlobal("fetch", upstream);
      for (const name of protectedCalls) {
        const response = await fetchWorker(
          rpcRequest(
            "tools/call",
            { name, arguments: { endpoint_id: endpoint.endpoint_id, params: {} } },
            protocol
          ),
          env(mode)
        );
        expect(response.status).toBe(401);
        expect(response.headers.has("www-authenticate")).toBe(mode === "dual");
        if (mode === "dual") {
          expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
        }
      }
      expect(upstream).not.toHaveBeenCalled();
    }
  );

  it("lets an authenticated OAuth user read the public catalog without the legacy catalog scope", async () => {
    const upstream = vi.fn(async (input: URL | RequestInfo) => {
      expect(String(input)).toContain("/oauth2/introspect");
      return Response.json(activeIntrospectionPayload("mcp:account:read"));
    });
    vi.stubGlobal("fetch", upstream);
    for (const [name, args] of publicCalls) {
      const result = await rpcResult(
        await fetchWorker(
          rpcRequest(
            "tools/call",
            { name, arguments: args },
            "2026-07-28",
            `Bearer ${OAUTH_ACCESS_TOKEN}`
          )
        )
      );
      expect(result.isError).not.toBe(true);
    }
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each(["tools/list", "list_platforms", ...protectedCalls])(
    "rejects an expired/revoked OAuth token for %s without anonymous fallback",
    async (name) => {
      const upstream = vi.fn(async () => Response.json({ active: false }));
      vi.stubGlobal("fetch", upstream);
      const response = await fetchWorker(
        name === "tools/list"
          ? rpcRequest(name, {}, "2025-06-18", `Bearer ${OAUTH_ACCESS_TOKEN}`)
          : rpcRequest(
              "tools/call",
              { name, arguments: {} },
              "2025-06-18",
              `Bearer ${OAUTH_ACCESS_TOKEN}`
            )
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(upstream).toHaveBeenCalledOnce();
    }
  );

  it.each(["legacy", "oauth"] as const)(
    "keeps all three protected tools working with valid %s credentials using mocked upstreams",
    async (kind) => {
      const callable = bundledCatalog.catalog.endpoints.find(
        (entry) =>
          !entry.hidden &&
          !entry.deprecated &&
          entry.method === "GET" &&
          entry.params.every((param) => !param.required)
      )!;
      const legacyToken = "L".repeat(16);
      const dispatches: string[] = [];
      const exchanges: string[] = [];
      const upstream = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.href === "https://auth.justoneapi.com/oauth2/introspect") {
          return Response.json(activeIntrospectionPayload("mcp:api:call mcp:account:read"));
        }
        if (url.href === "https://auth.justoneapi.com/oauth2/token") {
          const scope = new URLSearchParams(String(init?.body)).get("scope");
          exchanges.push(scope!);
          return Response.json({
            access_token: OAUTH_DELEGATION_TOKEN,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 120,
            scope,
          });
        }
        expect(url.origin).toBe("https://api.justoneapi.com");
        if (kind === "oauth") {
          expect(url.searchParams.has("token")).toBe(false);
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${OAUTH_DELEGATION_TOKEN}`
          );
        } else {
          expect(url.searchParams.get("token")).toBe(legacyToken);
        }
        dispatches.push(url.pathname);
        return Response.json({ code: 0, data: { mocked: true } });
      });
      vi.stubGlobal("fetch", upstream);
      for (const name of protectedCalls) {
        const result = await rpcResult(
          await fetchWorker(
            rpcRequest(
              "tools/call",
              {
                name,
                arguments:
                  name === "call_endpoint" ? { endpoint_id: callable.endpoint_id, params: {} } : {},
              },
              "2026-07-28",
              `Bearer ${kind === "oauth" ? OAUTH_ACCESS_TOKEN : legacyToken}`
            )
          )
        );
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ success: true, data: { mocked: true } });
      }
      expect(dispatches).toEqual([callable.path, "/user/get-balance", "/user/get-usage-summary"]);
      expect(exchanges).toEqual(
        kind === "oauth" ? ["mcp:api:call", "mcp:account:read", "mcp:account:read"] : []
      );
    }
  );

  it.each(protectedCalls)("retains the OAuth scope gate for %s", async (name) => {
    const upstream = vi.fn(async () => Response.json(activeIntrospectionPayload()));
    vi.stubGlobal("fetch", upstream);
    const response = await fetchWorker(
      rpcRequest(
        "tools/call",
        { name, arguments: {} },
        "2026-07-28",
        `Bearer ${OAUTH_ACCESS_TOKEN}`
      )
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      name === "call_endpoint" ? "mcp:api:call" : "mcp:account:read"
    );
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each(["refresh_catalog", "unknown_tool"])("does not expose %s anonymously", async (name) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await fetchWorker(rpcRequest("tools/call", { name, arguments: {} }));
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["mcp-method", "tools/list"],
    ["mcp-name", "list_platforms"],
  ])("rejects spoofed %s routing headers for a protected body", async (header, value) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const request = rpcRequest(
      "tools/call",
      { name: "call_endpoint", arguments: {} },
      "2026-07-28"
    );
    request.headers.set(header, value);
    expect((await fetchWorker(request)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a protected routing header on a public body", async () => {
    const request = rpcRequest(
      "tools/call",
      { name: "list_platforms", arguments: {} },
      "2026-07-28"
    );
    request.headers.set("mcp-name", "call_endpoint");
    expect((await fetchWorker(request)).status).toBe(400);
  });

  it("rejects JSON-RPC batches containing both public and protected calls", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await fetchWorker(
      new Request("https://mcp.justoneapi.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "call_endpoint", arguments: {} },
          },
        ]),
      })
    );
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});
