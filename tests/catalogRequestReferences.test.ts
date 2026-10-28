import { describe, expect, it } from "vitest";
import { buildCatalogBundle } from "../src/catalog/build.js";

function document(chinese = false) {
  return {
    paths: {
      "/api/1688/convert-image/v1": {
        post: {
          tags: ["1688"],
          summary: "Image Conversion",
          description: chinese ? "转换图片。" : "Convert an image.",
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Input~1Body~0" },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        "Input/Body~": { $ref: "#/components/schemas/Body" },
        Body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", description: chinese ? "图片链接。" : "Image URL." },
            searchApiEndpoint: {
              $ref: "#/components/schemas/Target",
              description: chinese ? "搜索目标。" : "Search target.",
            },
          },
        },
        Target: { type: "string", enum: ["standard", "cross_border_v2"], default: "standard" },
      },
    },
  };
}

function build(openapi = document(), openapiZh = document(true)) {
  return buildCatalogBundle({
    openapi,
    openapiZh,
    openapiText: JSON.stringify(openapi),
    openapiZhText: JSON.stringify(openapiZh),
    openapiUrl: "https://example.com/openapi.json",
    openapiZhUrl: "https://example.com/openapi-zh.json",
  });
}

describe("request schema references", () => {
  it("resolves chained and escaped local body references with localized property metadata", () => {
    const endpoint = build().catalog.endpoints[0];
    expect(endpoint.content_type).toBe("application/json");
    expect(endpoint.params).toMatchObject([
      {
        name: "url",
        api_name: "url",
        in: "body",
        required: true,
        type: "string",
        description: "图片链接。",
        description_en: "Image URL.",
      },
      {
        name: "search_api_endpoint",
        api_name: "searchApiEndpoint",
        in: "body",
        required: false,
        type: "string",
        enum: ["standard", "cross_border_v2"],
        default: "standard",
        description: "搜索目标。",
        description_en: "Search target.",
      },
    ]);
  });

  it.each([
    "#/components/schemas/Missing",
    "https://example.com/body.json",
    "#/components/schemas/Input~1Body~0",
  ])("rejects missing, external, and cyclic reference %s", (reference) => {
    const spec = document();
    spec.components.schemas["Input/Body~"].$ref = reference;
    expect(() => build(spec)).toThrow(/request-schema reference/);
  });

  it("checks credential values after resolving a body reference", () => {
    const spec = document();
    Object.assign(spec.components.schemas.Body.properties, {
      token: { type: "string", default: "sensitive-test-value" },
    });
    expect(() => build(spec)).toThrow(/credential/i);
  });
});
