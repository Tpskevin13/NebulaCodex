import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, createAltScreen } from "../src/ui/screen.ts";

test("alt screen is entered once and left once, in order", () => {
  const writes: string[] = [];
  const screen = createAltScreen((text) => writes.push(`async:${text}`), (text) => writes.push(`sync:${text}`));
  screen.leave(); // sin haber entrado no hace nada
  assert.deepEqual(writes, []);
  screen.enter();
  screen.enter();
  assert.equal(screen.active, true);
  screen.leave();
  screen.leave();
  assert.equal(screen.active, false);
  assert.deepEqual(writes, [`async:${ENTER_ALT_SCREEN}`, `sync:${LEAVE_ALT_SCREEN}`]);
});

test("leaving the alt screen never throws, even if the terminal is gone", () => {
  const screen = createAltScreen(() => {}, () => {
    throw new Error("EPIPE");
  });
  screen.enter();
  assert.doesNotThrow(() => screen.leave());
  assert.equal(screen.active, false);
});

test("the sequences switch the buffer on and off and restore the cursor", () => {
  assert.ok(ENTER_ALT_SCREEN.includes("\u001B[?1049h"));
  assert.ok(LEAVE_ALT_SCREEN.includes("\u001B[?1049l"));
  assert.ok(LEAVE_ALT_SCREEN.includes("\u001B[?25h"));
});
