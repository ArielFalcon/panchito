import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { OnboardWizard } from "./OnboardWizard";

test("renders the repo input step initially", () => {
  const { lastFrame, unmount } = render(
    <OnboardWizard onDone={() => {}} onCancel={() => {}} />,
  );
  const f = lastFrame() ?? "";
  assert.match(f, /Enter the GitHub repo/);
  assert.match(f, /org\/repo/);
  unmount();
});

test("renders without crashing", () => {
  const { unmount } = render(
    <OnboardWizard onDone={() => {}} onCancel={() => {}} />,
  );
  unmount();
});
