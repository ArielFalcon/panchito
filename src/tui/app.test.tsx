import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { Launcher } from "./app";

test("Launcher offers context mode from the interactive run flow", async () => {
  const { lastFrame, stdin, unmount } = render(
    <Launcher
      apps={["demo"]}
      initialApp="demo"
      onLaunch={() => {}}
      onOnboard={() => {}}
    />,
  );
  stdin.write("\r"); // choose e2e target and advance to mode selection
  await new Promise((resolve) => setTimeout(resolve, 20));
  const f = lastFrame() ?? "";
  assert.match(f, /context/);
  assert.match(f, /architecture map/);
  unmount();
});
