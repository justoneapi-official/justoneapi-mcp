import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCatalogBundle } from "../src/catalog/build.js";
import { CatalogManager, catalogSemanticSignature } from "../src/catalog/manager.js";
import { CatalogBundle, EndpointParam } from "../src/catalog/types.js";
import { RuntimeContext } from "../src/common/runtime.js";
import { silentLogger } from "../src/common/logger.js";
import { callEndpoint } from "../src/tools/callEndpoint.js";
import { getEndpointSchema } from "../src/tools/getEndpointSchema.js";

const API = "/api/qq-huxuan/cgi-bin/advertiser/mp_publisher/search/v1";
const ENDPOINT = "qq_huxuan.cgi_bin_advertiser_mp_publisher_search_v1";
const CREATOR_TYPES = [
  "SOCIETY",
  "SOCIETY_PUBLIC_INTEREST",
  ...Array.from({ length: 401 }, (_, index) => `CREATOR_SUBCATEGORY_${index}`),
];
const FAN_LEVELS = [
  "UNDER_5K",
  "FROM_5K_TO_10K",
  "FROM_10K_TO_20K",
  "FROM_20K_TO_50K",
  "FROM_50K_TO_100K",
  "FROM_100K_TO_500K",
  "FROM_500K_TO_1M",
  "AT_LEAST_1M",
];

function build(explode: boolean | null = false) {
  const openapi = {
    paths: {
      [API]: {
        get: {
          summary: "Official Account Creator Search",
          description: "Search creators with optional creator categories and follower bands.",
          parameters: [
            {
              name: "creatorTypes",
              in: "query" as const,
              required: false,
              explode: explode ?? undefined,
              description: "Creator category selections.",
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/CreatorType" },
              },
            },
            {
              name: "fansLevels",
              in: "query" as const,
              required: false,
              explode: explode ?? undefined,
              description: "Preset follower bands.",
              schema: { type: "array", items: { $ref: "#/components/schemas/FanLevel" } },
            },
          ],
        },
      },
    },
    components: {
      schemas: {
        CreatorType: { type: "string", enum: CREATOR_TYPES },
        FanLevel: { type: "string", enum: FAN_LEVELS },
      },
    },
  };
  return buildCatalogBundle({
    openapi,
    openapiText: JSON.stringify(openapi),
    openapiUrl: "https://docs.example.com/openapi.json",
    openapiZhUrl: "https://docs.example.com/openapi-zh.json",
  });
}

function runtime(bundle = build()): RuntimeContext {
  const config = {
    baseUrl: "https://api.justoneapi.test",
    openapiUrl: "https://docs.example.com/openapi.json",
    openapiZhUrl: "https://docs.example.com/openapi-zh.json",
    catalogRefreshIntervalMs: 0,
    catalogMemoryTtlMs: 60_000,
    debug: false,
    searchV2Enabled: false,
    timeoutMs: 1_000,
    retry: 0,
  };
  return {
    transport: "stdio",
    config,
    catalogManager: new CatalogManager(
      { load: async () => bundle, save: async () => {} },
      bundle,
      config
    ),
    logger: silentLogger,
    auth: { kind: "api-key", source: "env", token: "synthetic-token" },
  };
}

function withArrayParam(overrides: Partial<EndpointParam> = {}): CatalogBundle {
  const bundle = build();
  bundle.catalog.endpoints[0].params = [
    {
      name: "tag_name",
      api_name: "tagName",
      in: "query",
      required: false,
      type: "array",
      items: { type: "string" },
      style: "form",
      explode: false,
      description: "Tags.",
      description_en: "Tags.",
      ...overrides,
    },
  ];
  return bundle;
}

function mockDispatch() {
  const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
    Response.json({ code: 0, data: { list: [] } })
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("OpenAPI query-array request contracts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves all 403 category and 8 fan item enums through catalog and tool schema", async () => {
    const bundle = build();
    const params = bundle.catalog.endpoints[0].params;
    expect(params[0]).toMatchObject({
      name: "creator_types",
      api_name: "creatorTypes",
      required: false,
      type: "array",
      items: { type: "string", enum: CREATOR_TYPES },
      style: "form",
      explode: false,
    });
    expect(params[1].items?.enum).toEqual(FAN_LEVELS);
    expect(params[0].items?.enum).toHaveLength(403);
    expect(params[1].items?.enum).toHaveLength(8);
    expect(params[0].enum).toBeUndefined();
    const schema = await getEndpointSchema({ endpoint_id: ENDPOINT }, runtime(bundle));
    expect(schema.params[0].items).toEqual(params[0].items);
    expect(schema.params[1]).toMatchObject({
      items: { type: "string", enum: FAN_LEVELS },
      style: "form",
      explode: false,
    });
  });

  it("sends the selected filter arrays as one CSV value each with camelCase API names", async () => {
    const fetch = mockDispatch();
    const result = await callEndpoint(
      {
        endpoint_id: ENDPOINT,
        params: {
          creator_types: ["SOCIETY", "SOCIETY_PUBLIC_INTEREST"],
          fans_levels: ["FROM_500K_TO_1M", "AT_LEAST_1M"],
        },
      },
      runtime()
    );
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.getAll("creatorTypes")).toEqual(["SOCIETY,SOCIETY_PUBLIC_INTEREST"]);
    expect(url.searchParams.getAll("fansLevels")).toEqual(["FROM_500K_TO_1M,AT_LEAST_1M"]);
    expect(url.searchParams.has("creator_types")).toBe(false);
    expect(url.searchParams.get("fansLevels")).not.toContain("[");
  });

  it("keeps CSV input compatibility while validating every selected preset", async () => {
    const fetch = mockDispatch();
    await callEndpoint(
      { endpoint_id: ENDPOINT, params: { fansLevels: "UNDER_5K,AT_LEAST_1M" } },
      runtime()
    );
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("fansLevels")).toBe(
      "UNDER_5K,AT_LEAST_1M"
    );
  });

  it.each([
    { value: ["UNKNOWN"] },
    { value: ["UNDER_5K", "30000-80000"] },
    { value: [""] },
    { value: [null] },
    { value: [{}] },
    { value: 1 },
  ])("rejects invalid fan selections before an upstream dispatch: %j", async ({ value }) => {
    const fetch = mockDispatch();
    await expect(
      callEndpoint({ endpoint_id: ENDPOINT, params: { fans_levels: value } }, runtime())
    ).rejects.toMatchObject({ payload: { code: "VALIDATION_ERROR" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("omits optional empty selections", async () => {
    const fetch = mockDispatch();
    await callEndpoint(
      { endpoint_id: ENDPOINT, params: { creator_types: [], fans_levels: [] } },
      runtime()
    );
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.has("creatorTypes")).toBe(false);
    expect(url.searchParams.has("fansLevels")).toBe(false);
  });

  it("preserves the key for a required empty array rather than silently omitting it", async () => {
    const fetch = mockDispatch();
    await callEndpoint(
      { endpoint_id: ENDPOINT, params: { tag_name: [] } },
      runtime(withArrayParam({ required: true }))
    );
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.has("tagName")).toBe(true);
    expect(url.searchParams.get("tagName")).toBe("");
  });

  it("URL-encodes CSV contents without introducing extra parameters", async () => {
    const fetch = mockDispatch();
    await callEndpoint(
      { endpoint_id: ENDPOINT, params: { tag_name: ["中文&x=1", "A+B / test"] } },
      runtime(withArrayParam())
    );
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get("tagName")).toBe("中文&x=1,A+B / test");
    expect(url.searchParams.has("x")).toBe(false);
    expect(url.search).toContain("%26x%3D1%2CA%2BB");
  });

  it.each([true, undefined])("uses repeated keys for form explode=%j", async (explode) => {
    const fetch = mockDispatch();
    await callEndpoint(
      { endpoint_id: ENDPOINT, params: { tag_name: ["one", "two words"] } },
      runtime(withArrayParam({ explode }))
    );
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.getAll("tagName")).toEqual(["one", "two words"]);
  });

  it("records the OpenAPI defaults when style and explode are omitted", () => {
    const bundle = build(null);
    expect(bundle.catalog.endpoints[0].params[0]).toMatchObject({ style: "form", explode: true });
  });

  it("includes array serialization and item enums in the catalog semantic signature", () => {
    const endpoint = withArrayParam().catalog.endpoints[0];
    const signature = catalogSemanticSignature(endpoint);
    for (const change of [
      { explode: true },
      { style: "pipeDelimited" },
      { items: { type: "string", enum: ["one", "two"] } },
    ]) {
      expect(
        catalogSemanticSignature({
          ...endpoint,
          params: [{ ...endpoint.params[0], ...change }],
        })
      ).not.toBe(signature);
    }
  });

  it("rejects unsupported query-array styles before dispatch", async () => {
    const fetch = mockDispatch();
    await expect(
      callEndpoint(
        { endpoint_id: ENDPOINT, params: { tag_name: ["one"] } },
        runtime(withArrayParam({ style: "deepObject" }))
      )
    ).rejects.toMatchObject({ payload: { code: "VALIDATION_ERROR" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["spaceDelimited", " "],
    ["pipeDelimited", "|"],
  ])("honors query array style=%s", async (style, delimiter) => {
    const fetch = mockDispatch();
    await callEndpoint(
      { endpoint_id: ENDPOINT, params: { tag_name: ["one", "two"] } },
      runtime(withArrayParam({ style }))
    );
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("tagName")).toBe(
      `one${delimiter}two`
    );
  });

  it("keeps old catalog array encoding until serialization metadata has refreshed", async () => {
    const fetch = mockDispatch();
    await callEndpoint(
      { endpoint_id: ENDPOINT, params: { tag_name: ["one", "two"] } },
      runtime(withArrayParam({ items: undefined, style: undefined, explode: undefined }))
    );
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("tagName")).toBe(
      '["one","two"]'
    );
  });

  it.each(["application/json", "application/x-www-form-urlencoded"])(
    "keeps body arrays in their original %s representation",
    async (contentType) => {
      const fetch = mockDispatch();
      const bundle = withArrayParam({ in: "body", style: undefined, explode: undefined });
      const endpoint = bundle.catalog.endpoints[0];
      endpoint.method = "POST";
      endpoint.content_type = contentType;
      const values = ["one", "two words"];
      await callEndpoint({ endpoint_id: ENDPOINT, params: { tag_name: values } }, runtime(bundle));
      const [requestUrl, init] = fetch.mock.calls[0];
      expect(new URL(String(requestUrl)).searchParams.has("tagName")).toBe(false);
      if (contentType === "application/json") {
        expect(JSON.parse(String(init?.body))).toEqual({ tagName: values });
      } else {
        expect((init?.body as URLSearchParams).get("tagName")).toBe(JSON.stringify(values));
      }
    }
  );

  it.each(["application/json", "application/x-www-form-urlencoded"])(
    "keeps query arrays separate from body arrays for POST %s",
    async (contentType) => {
      const fetch = mockDispatch();
      const bundle = withArrayParam();
      const endpoint = bundle.catalog.endpoints[0];
      endpoint.method = "POST";
      endpoint.content_type = contentType;
      endpoint.params.push({
        ...endpoint.params[0],
        name: "body_values",
        api_name: "bodyValues",
        in: "body",
        style: undefined,
        explode: undefined,
      });
      await callEndpoint(
        {
          endpoint_id: ENDPOINT,
          params: { tag_name: ["one", "two"], body_values: ["three", "four"] },
        },
        runtime(bundle)
      );
      const [requestUrl, init] = fetch.mock.calls[0];
      const url = new URL(String(requestUrl));
      expect(url.searchParams.getAll("tagName")).toEqual(["one,two"]);
      expect(url.searchParams.has("bodyValues")).toBe(false);
      if (contentType === "application/json") {
        expect(JSON.parse(String(init?.body))).toEqual({ bodyValues: ["three", "four"] });
      } else {
        expect((init?.body as URLSearchParams).get("tagName")).toBeNull();
        expect((init?.body as URLSearchParams).get("bodyValues")).toBe('["three","four"]');
      }
    }
  );
});
