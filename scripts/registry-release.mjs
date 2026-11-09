import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const registryOrigin = "https://registry.modelcontextprotocol.io";
export const reviewedName = "io.github.justoneapi-official/justoneapi";
export const reviewedVersion = "2.0.1";

const fields = [
  "$schema", "name", "title", "description", "version", "repository", "websiteUrl", "icons", "remotes",
];

// This is a deliberately bounded reviewed registry release, not a general publisher.
// The official JSON schema is independently checked during release preparation.
export function validateCandidate(entry) {
  assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), "Invalid registry entry");
  assert.deepEqual(Object.keys(entry).sort(), [...fields].sort(), "Unreviewed entry fields");
  assert.equal(entry.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.equal(entry.name, reviewedName, "Unreviewed registry namespace");
  assert.equal(entry.version, reviewedVersion, "Unreviewed registry version");
  assert.equal(entry.title, "JustOneAPI", "Unreviewed registry title");
  assert.equal(entry.description, "Discover social and commerce APIs without login; authenticate for API calls and account data.");
  assert.equal(entry.websiteUrl, "https://justoneapi.com/en");
  assert.deepEqual(entry.icons, [{
    src: "https://justoneapi.com/logo/justoneapi-brand.png", mimeType: "image/png", sizes: ["256x256"],
  }]);
  assert.deepEqual(entry.repository, {
    url: "https://github.com/justoneapi-official/justoneapi-mcp", source: "github",
  });
  assert.deepEqual(entry.remotes, [{ type: "streamable-http", url: "https://mcp.justoneapi.com/mcp" }]);
  return entry;
}

export function validateCommit({ ref, sha, reviewedCommit }) {
  assert.equal(ref, "refs/heads/main", "Registry release requires main");
  assert.match(reviewedCommit || "", /^[0-9a-f]{40}$/, "A complete reviewed commit is required");
  assert.equal(sha, reviewedCommit, "The selected main commit differs from the reviewed commit");
}

export function versionURL(entry) {
  validateCandidate(entry);
  return `${registryOrigin}/v0.1/servers/${encodeURIComponent(entry.name)}/versions/${encodeURIComponent(entry.version)}`;
}

function publicResult(state, httpStatus) {
  return { state, name: reviewedName, version: reviewedVersion, ...(httpStatus ? { httpStatus } : {}) };
}

function matchesReviewedEntry(server, entry) {
  if (!server || typeof server !== "object" || Array.isArray(server)) return false;
  // Ignore the registry's optional schema annotation and assigned GitHub repo ID.
  // No unreviewed packages, headers, templates, publisher metadata, or icon changes pass.
  const copy = structuredClone(server);
  if (copy.$schema !== undefined && copy.$schema !== entry.$schema) return false;
  if (copy.$schema !== undefined) delete copy.$schema;
  if (copy.repository?.id !== undefined) delete copy.repository.id;
  const expected = structuredClone(entry);
  delete expected.$schema;
  try {
    assert.deepEqual(copy, expected);
    return true;
  } catch {
    return false;
  }
}

export async function checkRegistry(entry, fetchImpl = fetch) {
  const url = versionURL(entry);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return publicResult("unknown");
  }
  if (response.status === 404) return publicResult("absent", 404);
  if (response.status !== 200) return publicResult("unknown", response.status);
  let body;
  try {
    const text = await response.text();
    if (text.length > 1_000_000) return publicResult("unknown", 200);
    body = JSON.parse(text);
  } catch {
    return publicResult("unknown", 200);
  }
  if (!body?.server || typeof body.server !== "object" || Array.isArray(body.server)) {
    return publicResult("unknown", 200);
  }
  const status = body._meta?.["io.modelcontextprotocol.registry/official"]?.status;
  if (typeof status !== "string") return publicResult("unknown", 200);
  if (status !== "active") return publicResult("conflict", 200);
  return publicResult(matchesReviewedEntry(body.server, entry) ? "match" : "conflict", 200);
}

async function report(result, githubOutput = false) {
  // Emit only fixed identity and states, never response bodies or credentials.
  console.log(JSON.stringify(result));
  if (githubOutput && process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `state=${result.state}\n`);
  }
}

async function main() {
  const command = process.argv[2];
  const entry = validateCandidate(JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8")));
  if (command === "validate") {
    validateCommit({
      ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, reviewedCommit: process.env.REVIEWED_COMMIT,
    });
    await report(publicResult("validated"));
    return;
  }
  if (command === "check" || command === "verify") {
    // Only post-publication verification polls. A preflight never retries a write.
    const attempts = command === "verify" ? 4 : 1;
    let result;
    for (let attempt = 0; attempt < attempts; attempt++) {
      result = await checkRegistry(entry);
      if (result.state === "match" || result.state === "conflict") break;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 3000));
    }
    await report(result, process.argv.includes("--github-output"));
    if (command === "verify" ? result.state !== "match" : !["absent", "match"].includes(result.state)) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("Unknown registry release command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Registry release validation failed; no response body or credentials were logged.");
    process.exitCode = 1;
  });
}
