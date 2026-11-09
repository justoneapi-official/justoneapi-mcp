import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  checkRegistry, validateCandidate, validateCommit, versionURL,
} from "./registry-release.mjs";

const entry = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));
const response = (status, body) => new Response(JSON.stringify(body), { status });
const clone = () => structuredClone(entry);
const record = server => ({ server, _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } } });

test("a reviewed entry is addressed by exact namespace and version", () => {
  assert.equal(versionURL(entry), "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.justoneapi-official%2Fjustoneapi/versions/2.0.1");
});

test("unreviewed destinations, packages, headers and versions cannot be submitted", () => {
  for (const mutate of [
    e => { e.remotes[0].url = "https://example.com/mcp"; },
    e => { e.remotes[0].headers = [{ name: "Authorization", value: "not-a-real-secret" }]; },
    e => { e.packages = []; },
    e => { e.version = "2.0.2"; },
    e => { e.name = "io.github.someone/other"; },
    e => { e.icons[0].src = "https://example.com/icon.png"; },
    e => { e.icons[0].mimeType = "image/svg+xml"; },
    e => { e.icons[0].sizes = ["96x96"]; },
    e => { e.icons.push({ src: "https://example.com/extra.png" }); },
  ]) {
    const changed = clone(); mutate(changed);
    assert.throws(() => validateCandidate(changed));
  }
});

test("the main ref and exact reviewed commit are both required", () => {
  const sha = "a".repeat(40);
  validateCommit({ ref: "refs/heads/main", sha, reviewedCommit: sha });
  for (const bad of [
    { ref: "refs/heads/test", sha, reviewedCommit: sha },
    { ref: "refs/heads/main", sha, reviewedCommit: "b".repeat(40) },
    { ref: "refs/heads/main", sha, reviewedCommit: "$(not-a-command)" },
    { ref: "refs/heads/main", sha, reviewedCommit: sha.slice(0, 7) },
  ]) assert.throws(() => validateCommit(bad));
});

test("only an explicit 404 is absent; the read is anonymous and follows no redirects", async () => {
  const result = await checkRegistry(entry, async (url, options) => {
    assert.equal(url, versionURL(entry));
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.deepEqual(options.headers, { Accept: "application/json" });
    return response(404, {});
  });
  assert.equal(result.state, "absent");
});

test("a matching existing version is recognized without another publication", async () => {
  const server = clone();
  server.repository.id = "assigned-repository-id";
  const result = await checkRegistry(entry, async () => response(200, record(server)));
  assert.equal(result.state, "match");
});

test("different published content is a conflict", async () => {
  const server = clone(); server.description = "Different content";
  assert.equal((await checkRegistry(entry, async () => response(200, record(server)))).state, "conflict");
});

test("unreviewed remote headers or packages are not hidden by projection", async () => {
  for (const server of [
    { ...clone(), packages: [{ identifier: "some-package" }] },
    { ...clone(), remotes: [{ ...entry.remotes[0], headers: [{ name: "X-Key", value: "fake" }] }] },
    { ...clone(), icons: [{ ...entry.icons[0], src: "https://example.com/icon.png" }] },
  ]) assert.equal((await checkRegistry(entry, async () => response(200, record(server)))).state, "conflict");
});

test("deprecated or deleted entries cannot pass as an active release", async () => {
  for (const status of ["deprecated", "deleted"]) {
    const body = record(clone());
    body._meta["io.modelcontextprotocol.registry/official"].status = status;
    assert.equal((await checkRegistry(entry, async () => response(200, body))).state, "conflict");
  }
});

test("unknown lifecycle metadata is not a verified publication", async () => {
  assert.equal((await checkRegistry(entry, async () => response(200, { server: clone() }))).state, "unknown");
});

test("a changed schema annotation is not silently accepted", async () => {
  const server = clone(); server.$schema = "https://example.com/schema.json";
  assert.equal((await checkRegistry(entry, async () => response(200, record(server)))).state, "conflict");
});

for (const status of [301, 401, 403, 429, 500]) {
  test(`HTTP ${status} remains unknown and cannot authorize publication`, async () => {
    assert.equal((await checkRegistry(entry, async () => response(status, {}))).state, "unknown");
  });
}

test("network failure does not become absent", async () => {
  assert.equal((await checkRegistry(entry, async () => { throw new Error("private diagnostic"); })).state, "unknown");
});

test("malformed, oversized and unexpected responses remain unknown", async () => {
  for (const r of [new Response("not JSON"), new Response(" ".repeat(1_000_001)), response(200, {})]) {
    assert.equal((await checkRegistry(entry, async () => r)).state, "unknown");
  }
});

test("a body-read failure remains unknown without leaking its contents", async () => {
  const result = await checkRegistry(entry, async () => ({ status: 200, text() { throw new Error("private diagnostic"); } }));
  assert.deepEqual(Object.keys(result).sort(), ["httpStatus", "name", "state", "version"]);
  assert.equal(result.state, "unknown");
});
