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

test("generate phase: renders the live panel (focus card + todo checklist + files + commands)", () => {
  const { lastFrame, unmount } = render(
    <Dashboard
      record={rec({
        step: "generate",
        cases: [],
        activity: [
          { kind: "todo", text: "map repo structure", status: "completed", ts: "t1" },
          { kind: "todo", text: "generate checkout specs", status: "in_progress", ts: "t2" },
          { kind: "file", text: "checkout.spec.ts", ts: "t3" },
          { kind: "command", text: "npx playwright test --list", ts: "t4" },
        ],
      })}
    />,
  );
  const f = lastFrame() ?? "";
  assert.match(f, /generate checkout specs/); // focus card + checklist
  assert.match(f, /map repo structure/);      // completed todo
  assert.match(f, /checkout\.spec\.ts/);       // wrote line
  assert.match(f, /npx playwright test/);      // ran line
  unmount();
});

test("execute phase: renders the running-test focus card from in-progress activity", () => {
  const { lastFrame, unmount } = render(
    <Dashboard
      record={rec({
        step: "execute",
        verdict: undefined,
        passed: 1,
        failed: 0,
        cases: [{ name: "home › hero", status: "pass" }],
        activity: [
          { kind: "todo", text: "home › hero", status: "completed", ts: "t1" },
          { kind: "todo", text: "cart › updates total", status: "in_progress", ts: "t2" },
        ],
      })}
    />,
  );
  const f = lastFrame() ?? "";
  assert.match(f, /running/);              // focus card label
  assert.match(f, /cart › updates total/); // the test running right now
  unmount();
});
