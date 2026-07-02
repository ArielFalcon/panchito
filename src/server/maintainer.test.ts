import assert from "node:assert/strict";
import test from "node:test";

import { getIncidents, recordIncident } from "./maintainer";

test("recordIncident defaults to pending", () => {
  const incident = recordIncident({
    source: "health-check",
    severity: "warn",
    summary: "default incident status",
  });

  assert.equal(incident.status, "pending");
  assert.equal(getIncidents().at(-1)?.status, "pending");
});

test("recordIncident honors explicit dismissed status for observational events", () => {
  const incident = recordIncident({
    source: "health-check",
    severity: "warn",
    summary: "observational incident status",
    status: "dismissed",
  });

  assert.equal(incident.status, "dismissed");
  assert.equal(getIncidents().at(-1)?.status, "dismissed");
});
