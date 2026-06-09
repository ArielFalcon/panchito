import React, { useCallback, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import Spinner from "ink-spinner";
import SelectInput from "ink-select-input";
import { TestTarget } from "../../types";
import { QaClient, CreateAppRequest, CreateAppResponse, OnboardServiceInput, createClient } from "../client";
import { suggestName } from "../../server/onboard";

interface SelectItem {
  label: string;
  value: string;
}

type Step =
  | "repo" | "validating" | "repo-error"
  | "dev-url" | "dev-version"
  | "qa-target" | "qa-review" | "qa-shadow" | "qa-prefix"
  | "svc-ask" | "svc-repo" | "svc-openapi" | "svc-version"
  | "env-ask" | "env-entry"
  | "review" | "committing" | "done" | "write-error";

export function OnboardWizard({
  client: clientProp,
  onDone,
  onCancel,
}: {
  client?: QaClient;
  onDone: (appName: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  // Standalone CLI entry (`panchito onboard`) renders without a client prop; fall back
  // to a fresh HTTP client. Either way the wizard never reads GITHUB_TOKEN on the host:
  // every side effect routes through the orchestrator (which has the token).
  const [client] = useState<QaClient>(() => clientProp ?? createClient());
  const [step, setStep] = useState<Step>("repo");
  const [repoInput, setRepoInput] = useState("");
  const [repoInfo, setRepoInfo] = useState<CreateAppResponse["repoInfo"] | null>(null);
  const [appName, setAppName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [versionUrl, setVersionUrl] = useState("");
  const [target, setTarget] = useState<TestTarget>("e2e");
  const [needsReview, setNeedsReview] = useState(true);
  const [shadow, setShadow] = useState(true);
  const [testPrefix, setTestPrefix] = useState("qa-bot");
  const [services, setServices] = useState<OnboardServiceInput[]>([]);
  const [svcDraft, setSvcDraft] = useState<OnboardServiceInput>({ repo: "" });
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [envDraft, setEnvDraft] = useState("");
  const [yamlPreview, setYamlPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = useCallback(() => {
    setStep("repo"); setRepoInput(""); setRepoInfo(null); setAppName("");
    setBaseUrl(""); setVersionUrl(""); setTarget("e2e");
    setNeedsReview(true); setShadow(true); setTestPrefix("qa-bot");
    setServices([]); setSvcDraft({ repo: "" });
    setEnvVars({}); setEnvDraft(""); setYamlPreview("");
    setError(null); setLoading(false);
  }, []);

  const validateRepo = useCallback(async () => {
    const trimmed = repoInput.trim();
    if (!trimmed.includes("/")) {
      setError("repo must be in 'org/name' format (e.g. 'facebook/react')");
      setStep("repo-error");
      return;
    }
    setLoading(true);
    setStep("validating");
    try {
      const r = await client.validateRepo(trimmed);
      if (!r.ok || !r.repoInfo) throw new Error(r.errors?.join("; ") ?? "validation failed");
      setRepoInfo(r.repoInfo);
      setAppName(suggestName(trimmed));
      setStep("dev-url");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("repo-error");
    } finally {
      setLoading(false);
    }
  }, [repoInput, client]);

  const buildRequest = useCallback((flags: { dryRun?: boolean }): CreateAppRequest => ({
    repo: repoInfo?.fullName ?? repoInput.trim(),
    name: appName,
    baseUrl: baseUrl || undefined,
    versionUrl: versionUrl || undefined,
    target,
    needsReview,
    shadow,
    testDataPrefix: testPrefix || "qa-bot",
    services: target === "e2e" && services.length ? services : undefined,
    env: Object.keys(envVars).length ? envVars : undefined,
    ...flags,
  }), [repoInfo, repoInput, appName, baseUrl, versionUrl, target, needsReview, shadow, testPrefix, services, envVars]);

  const loadPreview = useCallback(async () => {
    try {
      const r = await client.createApp(buildRequest({ dryRun: true }));
      if (!r.ok) throw new Error(r.errors?.join("; ") ?? "invalid configuration");
      setYamlPreview(r.yaml ?? "");
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("write-error");
    }
  }, [client, buildRequest]);

  const commit = useCallback(async () => {
    setStep("committing");
    try {
      const r = await client.createApp(buildRequest({}));
      if (!r.ok) throw new Error(r.errors?.join("; ") ?? "creation failed");
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("write-error");
    }
  }, [client, buildRequest]);

  useInput((char, key) => {
    if (key.escape) {
      if (step === "repo-error" || step === "write-error") { reset(); return; }
      if (step === "done") { onDone(appName); return; }
      onCancel();
      return;
    }

    if (step === "repo") {
      if (key.return && repoInput.trim()) { void validateRepo(); return; }
      if (key.backspace || key.delete) { setRepoInput((p) => p.slice(0, -1)); return; }
      if (char.length === 1 && char >= " ") { setRepoInput((p) => p + char); }
      return;
    }

    if (step === "dev-url") {
      if (key.return && baseUrl.trim()) { setStep(target === "code" ? "qa-target" : "dev-version"); return; }
      if (key.backspace || key.delete) { setBaseUrl((p) => p.slice(0, -1)); return; }
      if (char.length === 1 && char >= " ") { setBaseUrl((p) => p + char); }
      return;
    }

    if (step === "dev-version") {
      if (key.return) { setStep("qa-target"); return; }
      if (key.backspace || key.delete) { setVersionUrl((p) => p.slice(0, -1)); return; }
      if (char.length === 1 && char >= " ") { setVersionUrl((p) => p + char); }
      return;
    }

    if (step === "qa-prefix") {
      if (key.return && testPrefix.trim()) {
        setStep(target === "e2e" ? "svc-ask" : "env-ask");
        return;
      }
      if (key.backspace || key.delete) { setTestPrefix((p) => p.slice(0, -1)); return; }
      if (char.length === 1 && char >= " ") { setTestPrefix((p) => p + char); }
      return;
    }

    if (step === "svc-repo") {
      if (key.return && svcDraft.repo.trim().includes("/")) { setStep("svc-openapi"); return; }
      if (key.backspace || key.delete) { setSvcDraft((p) => ({ ...p, repo: p.repo.slice(0, -1) })); return; }
      if (char.length === 1 && char >= " ") { setSvcDraft((p) => ({ ...p, repo: p.repo + char })); }
      return;
    }
    if (step === "svc-openapi") {
      if (key.return) { setStep("svc-version"); return; }
      if (key.backspace || key.delete) {
        setSvcDraft((p) => ({ ...p, openapi: (p.openapi ?? "").slice(0, -1) || undefined }));
        return;
      }
      if (char.length === 1 && char >= " ") {
        setSvcDraft((p) => ({ ...p, openapi: (p.openapi ?? "") + char }));
      }
      return;
    }
    if (step === "svc-version") {
      if (key.return) {
        setServices((prev) => [...prev, { ...svcDraft, repo: svcDraft.repo.trim() }]);
        setStep("svc-ask");
        return;
      }
      if (key.backspace || key.delete) {
        setSvcDraft((p) => ({ ...p, versionUrl: (p.versionUrl ?? "").slice(0, -1) || undefined }));
        return;
      }
      if (char.length === 1 && char >= " ") {
        setSvcDraft((p) => ({ ...p, versionUrl: (p.versionUrl ?? "") + char }));
      }
      return;
    }
    if (step === "env-entry") {
      if (key.return) {
        const eq = envDraft.indexOf("=");
        if (eq > 0) {
          const k = envDraft.slice(0, eq).trim();
          const v = envDraft.slice(eq + 1);
          setEnvVars((prev) => ({ ...prev, [k]: v }));
        }
        setEnvDraft("");
        setStep("env-ask");
        return;
      }
      if (key.backspace || key.delete) { setEnvDraft((p) => p.slice(0, -1)); return; }
      if (char.length === 1 && char >= " ") { setEnvDraft((p) => p + char); }
      return;
    }

    if (step === "done" && key.return) {
      onDone(appName);
    }
  });

  if (step === "repo" || step === "validating" || step === "repo-error") {
    return (
      <Box flexDirection="column">
        <Text bold>Enter the GitHub repo (org/name):</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{repoInput || "org/repo"}</Text>
        </Box>
        <Box marginTop={1}>
          {step === "validating"
            ? <Text color="cyan"><Spinner type="dots" /> validating…</Text>
            : step === "repo-error"
            ? <Text color="#c0392b">✗ {error}</Text>
            : <Text dimColor>Enter to validate · Esc to cancel</Text>}
        </Box>
      </Box>
    );
  }

  if (step === "dev-url") {
    const isCode = target === "code";
    return (
      <Box flexDirection="column">
        {repoInfo ? (
          <Box marginBottom={1}>
            <Text>
              <Text color="#3b7a57">✓</Text>
              {` ${repoInfo.fullName} `}
              <Text color={repoInfo.private ? "yellow" : "green"}>
                ({repoInfo.private ? "private" : "public"})
              </Text>
              {` · default branch: ${repoInfo.defaultBranch}`}
            </Text>
          </Box>
        ) : null}
        <Text bold>{isCode ? "Base URL (dummy for code mode):" : "DEV base URL:"}</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{baseUrl || (isCode ? `https://github.com/${repoInput}` : "https://dev.example.com")}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to continue · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (step === "dev-version") {
    return (
      <Box flexDirection="column">
        <Text bold>Version endpoint (optional, Enter to skip):</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{versionUrl || "(skip — no deploy gate)"}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to continue · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (step === "qa-target") {
    const items: SelectItem[] = [
      { label: "e2e  — browser tests against DEV", value: "e2e" },
      { label: "code — source-code tests (no browser)", value: "code" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Test target:</Text>
        <SelectInput items={items} onSelect={(i) => { setTarget(i.value as TestTarget); setStep("qa-review"); }} />
      </Box>
    );
  }

  if (step === "qa-review") {
    const items: SelectItem[] = [
      { label: "Yes — AI reviewer validates generated tests", value: "yes" },
      { label: "No — skip review", value: "no" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Enable AI review?</Text>
        <SelectInput items={items} onSelect={(i) => { setNeedsReview(i.value === "yes"); setStep("qa-shadow"); }} />
      </Box>
    );
  }

  if (step === "qa-shadow") {
    const items: SelectItem[] = [
      { label: "Yes — run silently, no PRs or Issues (recommended)", value: "yes" },
      { label: "No — publish PRs and open Issues", value: "no" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Shadow mode?</Text>
        <SelectInput items={items} onSelect={(i) => { setShadow(i.value === "yes"); setStep("qa-prefix"); }} />
      </Box>
    );
  }

  if (step === "qa-prefix") {
    return (
      <Box flexDirection="column">
        <Text bold>Test data prefix:</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{testPrefix || "qa-bot"}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to continue · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (step === "svc-ask") {
    const items: SelectItem[] = [
      { label: services.length ? `Add another service (${services.length} added)` : "Add a microservice repo (multi-repo app)", value: "add" },
      { label: "Continue — no more services", value: "next" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Microservice repos (optional):</Text>
        {services.map((s) => <Text key={s.repo} dimColor>  ✓ {s.repo}{s.openapi ? ` (openapi: ${s.openapi})` : ""}</Text>)}
        <SelectInput items={items} onSelect={(i) => {
          if (i.value === "add") { setSvcDraft({ repo: "" }); setStep("svc-repo"); }
          else setStep("env-ask");
        }} />
      </Box>
    );
  }

  if (step === "svc-repo") {
    return (
      <Box flexDirection="column">
        <Text bold>Service repo (org/name):</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{svcDraft.repo || "org/service"}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to continue · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (step === "svc-openapi") {
    return (
      <Box flexDirection="column">
        <Text bold>Service OpenAPI glob (optional, Enter to skip):</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{svcDraft.openapi || "(skip)"}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to continue · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (step === "svc-version") {
    return (
      <Box flexDirection="column">
        <Text bold>Service version endpoint (optional, Enter to skip):</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{svcDraft.versionUrl || "(skip)"}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to continue · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (step === "env-ask") {
    const items: SelectItem[] = [
      { label: Object.keys(envVars).length ? `Add another env var (${Object.keys(envVars).length} added)` : "Add an env var (KEY=value)", value: "add" },
      { label: "Continue — review the YAML", value: "next" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Environment variables (optional, server-side):</Text>
        {Object.entries(envVars).map(([k, v]) => (
          <Text key={k} dimColor>  ✓ {k}={"•".repeat(Math.max(4, Math.min(v.length, 12)))}</Text>
        ))}
        <SelectInput items={items} onSelect={(i) => {
          if (i.value === "add") { setEnvDraft(""); setStep("env-entry"); }
          else void loadPreview();
        }} />
      </Box>
    );
  }

  if (step === "env-entry") {
    const eq = envDraft.indexOf("=");
    const masked = eq > 0
      ? `${envDraft.slice(0, eq + 1)}${"•".repeat(Math.max(4, Math.min(envDraft.length - eq - 1, 12)))}`
      : envDraft;
    return (
      <Box flexDirection="column">
        <Text bold>Env var (KEY=value):</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{masked || "KEY=value"}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to add · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (step === "review") {
    const items: SelectItem[] = [
      { label: "Yes — write config file", value: "yes" },
      { label: "No — cancel", value: "no" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Review — config/apps/{appName}.yaml</Text>
        <Box marginY={1} flexDirection="column">
          {yamlPreview.split("\n").map((line, i) => <Text key={i} dimColor>{`  ${line}`}</Text>)}
        </Box>
        <SelectInput items={items} onSelect={(i) => { i.value === "yes" ? void commit() : onCancel(); }} />
      </Box>
    );
  }

  if (step === "committing") {
    return <Text color="cyan"><Spinner type="dots" /> committing…</Text>;
  }

  if (step === "done") {
    return (
      <Box flexDirection="column">
        <Text color="#3b7a57">✓ config/apps/{appName}.yaml created</Text>
        <Box marginTop={1}>
          <Text>Enter → run first QA · Esc → exit</Text>
        </Box>
      </Box>
    );
  }

  if (step === "write-error") {
    return (
      <Box flexDirection="column">
        <Text color="#c0392b">✗ Failed to write config: {error}</Text>
        <Box marginTop={1}>
          <Text dimColor>Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  // loading is consumed by the validating branch above; reference it to satisfy strict unused checks.
  void loading;
  return <Text>Loading…</Text>;
}
