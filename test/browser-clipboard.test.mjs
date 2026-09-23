import assert from "node:assert/strict";
import test from "node:test";

import { copyTextToClipboard } from "../lib/browser-clipboard.mjs";

test("request IDs use the modern clipboard API when it is available", async () => {
  const writes = [];
  const copied = await copyTextToClipboard("request-42", {
    clipboard: {
      async writeText(value) {
        writes.push(value);
      },
    },
    documentObject: null,
  });

  assert.equal(copied, true);
  assert.deepEqual(writes, ["request-42"]);
});

test("request ID copy falls back for direct-LAN HTTP pages", async () => {
  const events = [];
  const textArea = {
    style: {},
    setAttribute(name, value) { events.push(["attribute", name, value]); },
    focus() { events.push(["focus"]); },
    select() { events.push(["select"]); },
    setSelectionRange(start, end) { events.push(["range", start, end]); },
    remove() { events.push(["remove"]); },
  };
  const documentObject = {
    activeElement: { focus() { events.push(["restore-focus"]); } },
    body: { appendChild(node) { events.push(["append", node.value]); } },
    createElement(name) {
      events.push(["create", name]);
      return textArea;
    },
    execCommand(command) {
      events.push(["command", command]);
      return true;
    },
  };

  const copied = await copyTextToClipboard("request-73", {
    clipboard: {
      async writeText() {
        throw new DOMException("Not allowed", "NotAllowedError");
      },
    },
    documentObject,
  });

  assert.equal(copied, true);
  assert.deepEqual(events.find(([name]) => name === "append"), ["append", "request-73"]);
  assert.deepEqual(events.find(([name]) => name === "range"), ["range", 0, 10]);
  assert.deepEqual(events.find(([name]) => name === "command"), ["command", "copy"]);
  assert.ok(events.some(([name]) => name === "remove"));
  assert.ok(events.some(([name]) => name === "restore-focus"));
});

test("empty clipboard values fail closed", async () => {
  assert.equal(await copyTextToClipboard("", {
    clipboard: { writeText: async () => assert.fail("must not write") },
    documentObject: null,
  }), false);
});
