import assert from "node:assert/strict";
import { test } from "node:test";
import { handleCliArgs } from "../src/cli.ts";

test("--version and -v print the version and exit cleanly", () => {
  for (const flag of ["--version", "-v"]) {
    const result = handleCliArgs([flag], "1.2.3");
    assert.deepEqual(result, { output: "NebulaCodex 1.2.3", exitCode: 0 });
  }
});

test("--help and -h describe usage and where configuration lives", () => {
  for (const flag of ["--help", "-h"]) {
    const result = handleCliArgs([flag], "1.2.3");
    assert.ok(result);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /NebulaCodex 1\.2\.3/);
    assert.match(result.output, /--version/);
    assert.match(result.output, /\/providers/);
  }
});

test("without flags the app starts normally", () => {
  assert.equal(handleCliArgs([], "1.2.3"), null);
  assert.equal(handleCliArgs(["alguna-carpeta"], "1.2.3"), null);
});
