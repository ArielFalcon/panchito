import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { Dashboard } from "./Dashboard";
import { RunRecord } from "../../types";

const rec = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  app: "portfolio",
  sha: "abcdef1234567",
  target: "e2e",
  mode: "diff",
  status: "running",
  step: "execute",
  cases: [],
  logs: [],
  at: "t",
  ...over,
});

test("renders the header and short sha", () => {
  const { lastFrame, unmount } = render(
    <Dashboard
      record={rec({
        step: "execute",
        passed: 1,
        failed: 1,
        cases: [
          { name: "login", status: "pass" },
          { name: "checkout", status: "fail" },
        ],
      })}
    />,
  );
  const f = lastFrame() ?? "";
  assert.match(f, /portfolio/);
  assert.match(f, /abcdef1/); // short sha
  unmount();
});

test("renders the verdict banner when the run is done", () => {
  const { lastFrame, unmount } = render(
    <Dashboard
      record={rec({
        status: "done",
        step: "done",
        verdict: "pass",
        passed: 2,
        failed: 0,
        cases: [
          { name: "a", status: "pass" },
          { name: "b", status: "pass" },
        ],
      })}
    />,
  );
  assert.match(lastFrame() ?? "", /verdict: pass/);
  unmount();
});

test("shows the pipeline step labels", () => {
  const { lastFrame, unmount } = render(<Dashboard record={rec({ step: "generate" })} />);
  const f = lastFrame() ?? "";
  assert.match(f, /classify/);
  assert.match(f, /generate/);
  assert.match(f, /validate/);
  assert.match(f, /execute/);
  unmount();
});

test("shows the running spinner while there is no verdict", () => {
  const { lastFrame, unmount } = render(<Dashboard record={rec({ verdict: undefined, step: "execute" })} />);
  assert.match(lastFrame() ?? "", /running/);
  unmount();
});

test("shows the code-mode binary result line for a code target", () => {
  const { lastFrame, unmount } = render(
    <Dashboard record={rec({ target: "code", step: "done", verdict: "pass", cases: [] })} />,
  );
  assert.match(lastFrame() ?? "", /code tests: all passed/);
  unmount();
});
