import assert from "node:assert/strict";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runTool } from "../src/core/tools.ts";

let directory = "";
let originalLookup = dns.lookup;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebulacodex-safety-"));
  originalLookup = dns.lookup;
  // Los tests usan dominios ficticios con fetch simulado; la comprobación SSRF real necesita DNS.
  (dns as any).lookup = async () => [{ address: "93.184.216.34", family: 4 }];
});

afterEach(() => {
  (dns as any).lookup = originalLookup;
  fs.rmSync(directory, { recursive: true, force: true });
});

test("fetch_url blocks cloud metadata endpoints before any request is made", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("should not happen");
  };
  try {
    assert.match(
      await runTool("fetch_url", { url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" }),
      /metadatos internos/,
    );
    assert.match(
      await runTool("fetch_url", { url: "http://metadata.google.internal/computeMetadata/v1/" }),
      /metadatos internos/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch_url blocks loopback, private ranges and redirects into them", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
  };
  try {
    const blocked = [
      "http://127.0.0.1/",
      "http://localhost/",
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
    ];
    for (const url of blocked) {
      assert.match(await runTool("fetch_url", { url }), /metadatos internos/);
    }
    assert.equal(calls, 0, "ninguna dirección bloqueada debe llegar a fetch");

    assert.match(await runTool("fetch_url", { url: "https://example.invalid/redirect" }), /metadatos internos/);
    assert.equal(calls, 1, "la redirección se valida antes de seguirla");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch_url rejects binary content and oversized bodies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("data", {
    headers: { "content-type": "image/png" },
  });
  try {
    assert.match(await runTool("fetch_url", { url: "https://example.invalid/image" }), /no es texto/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => new Response("small", {
    headers: { "content-type": "text/plain", "content-length": String(5 * 1024 * 1024 + 1) },
  });
  try {
    assert.match(await runTool("fetch_url", { url: "https://example.invalid/big" }), /más de 5 MiB/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch_url stops a chunked response that crosses the 5 MiB limit", async () => {
  const originalFetch = globalThis.fetch;
  const chunk = new Uint8Array(1024 * 1024);
  chunk.fill(65);
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
  }), { headers: { "content-type": "text/plain" } });
  try {
    assert.match(await runTool("fetch_url", { url: "https://example.invalid/stream" }), /más de 5 MiB/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch_url decodes numeric HTML entities without double-decoding ampersands", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<html><body><p>&#128512; &#x1F600; &amp;#39; &nbsp; fin</p></body></html>",
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
  try {
    assert.equal(await runTool("fetch_url", { url: "https://example.invalid/entities" }), "😀 😀 &#39; fin");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read_file rejects files above its memory limit before reading them", async () => {
  const file = path.join(directory, "huge.txt");
  fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.match(await runTool("read_file", { path: file }), /supera el límite de lectura de 4 MiB/);
});

test("writing over a file larger than the undo limit reports that it cannot be undone", async () => {
  const file = path.join(directory, "large.txt");
  fs.writeFileSync(file, "a".repeat(2 * 1024 * 1024 + 1));
  const result = await runTool("write_file", { path: file, content: "replaced" });
  assert.match(result, /sin deshacer.*2 MiB/);
  assert.equal(fs.readFileSync(file, "utf8"), "replaced");
});
