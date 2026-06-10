import React, { useCallback, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import Spinner from "ink-spinner";
import SelectInput from "ink-select-input";
import { TextInput } from "@inkjs/ui";
import { TestTarget } from "../../types";
import { QaClient, CreateAppRequest, CreateAppResponse, OnboardServiceInput, createClient } from "../client";
import { suggestName } from "../../server/onboard";

interface SelectItem { label: string; value: string }

type Step =
  | "repo-source" | "browse-owner" | "browse-list"
  | "repo" | "validating" | "repo-error"
  | "dev-url" | "dev-version"
  | "qa-target" | "qa-review" | "qa-shadow" | "qa-prefix"
  | "svc-ask" | "svc-repo" | "svc-openapi" | "svc-version"
  | "env-ask" | "env-entry"
  | "review" | "committing" | "done" | "write-error";

interface RepoItem {
  fullName: string;
  private: boolean;
  description: string | null;
}

const STEPS_BACK: Partial<Record<Step, Step>> = {
  "browse-list": "browse-owner",
  "repo": "repo-source",
  "repo-error": "repo",
  "dev-url": "repo",
  "dev-version": "dev-url",
  "qa-target": "dev-version",
  "qa-review": "qa-target",
  "qa-shadow": "qa-review",
  "qa-prefix": "qa-shadow",
  "svc-ask": "qa-prefix",
  "svc-repo": "svc-ask",
  "svc-openapi": "svc-repo",
  "svc-version": "svc-openapi",
  "env-ask": "svc-ask",
  "env-entry": "env-ask",
  "review": "env-ask",
};

export function OnboardWizard({
  client: clientProp,
  onDone,
  onCancel,
}: {
  client?: QaClient;
  onDone: (appName: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [client] = useState<QaClient>(() => clientProp ?? createClient());
  const [step, setStep] = useState<Step>("repo-source");
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

  // ── repo browser state ──────────────────────────────────────────────────
  const [browseOwner, setBrowseOwner] = useState("");
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [repoPage, setRepoPage] = useState(1);
  const [repoHasMore, setRepoHasMore] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [repoFilterActive, setRepoFilterActive] = useState(false);

  const reset = useCallback(() => {
    setStep("repo-source"); setRepoInput(""); setRepoInfo(null); setAppName("");
    setBaseUrl(""); setVersionUrl(""); setTarget("e2e");
    setNeedsReview(true); setShadow(true); setTestPrefix("qa-bot");
    setServices([]); setSvcDraft({ repo: "" });
    setEnvVars({}); setEnvDraft(""); setYamlPreview("");
    setError(null); setLoading(false);
    setBrowseOwner(""); setRepos([]); setRepoPage(1); setRepoHasMore(false);
    setRepoFilter(""); setRepoFilterActive(false);
  }, []);

  const goBack = useCallback(() => {
    const prev = STEPS_BACK[step];
    if (prev) { setStep(prev); setError(null); }
  }, [step]);

  const validateRepo = useCallback(async (repo: string) => {
    const trimmed = repo.trim();
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
  }, [client]);

  const selectRepo = useCallback((fullName: string) => {
    setRepoInput(fullName);
    void validateRepo(fullName);
  }, [validateRepo]);

  const fetchRepos = useCallback(async (page: number) => {
    const owner = browseOwner.trim();
    if (!owner) return;
    setLoading(true);
    try {
      const r = await client.listRepos(owner, page);
      setRepos(r.repos);
      setRepoHasMore(r.hasMore);
      setRepoPage(page);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [browseOwner, client]);

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

  // ── config summary line ─────────────────────────────────────────────────
  const summaryParts: string[] = [];
  if (repoInput || repoInfo) summaryParts.push(`repo: ${repoInfo?.fullName ?? repoInput}`);
  if (appName) summaryParts.push(`name: ${appName}`);
  if (baseUrl) summaryParts.push(`url: ${baseUrl}`);
  summaryParts.push(target);
  summaryParts.push(`review: ${needsReview ? "yes" : "no"}`);
  summaryParts.push(`shadow: ${shadow ? "yes" : "no"}`);
  if (services.length) summaryParts.push(`${services.length} svc`);
  if (Object.keys(envVars).length) summaryParts.push(`${Object.keys(envVars).length} env`);
  const summary = summaryParts.join("  |  ");

  // ── input handler ───────────────────────────────────────────────────────
  useInput((char, key) => {
    if (key.escape) {
      if (step === "browse-list" && repoFilterActive) { setRepoFilterActive(false); return; }
      if (step === "repo-error" || step === "write-error") { reset(); return; }
      if (step === "done") { onDone(appName); return; }
      onCancel();
      return;
    }

    if (key.leftArrow && step !== "repo-source" && step !== "browse-owner" && step !== "browse-list") {
      goBack();
      return;
    }

    // ── repo source ─────────────────────────────────────────────────────
    if (step === "repo-source") {
      if (key.return) { /* handled by SelectInput */ return; }
      return;
    }

    // ── browse list ─────────────────────────────────────────────────────
    if (step === "browse-list") {
      if (key.rightArrow && repoHasMore && !loading) { void fetchRepos(repoPage + 1); return; }
      if (key.leftArrow && repoPage > 1 && !loading) { void fetchRepos(repoPage - 1); return; }
      if (char === "/") { setRepoFilterActive((p) => !p); if (repoFilterActive) setRepoFilter(""); return; }
      if (repoFilterActive) {
        if (key.return) { setRepoFilterActive(false); return; }
        if (key.backspace || key.delete) { setRepoFilter((p) => p.slice(0, -1)); return; }
        if (char.length === 1 && char >= " ") { setRepoFilter((p) => p + char); }
        return;
      }
      if (key.return) { /* handled by SelectInput */ return; }
      return;
    }

    // ── text input steps ────────────────────────────────────────────────
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
      if (key.return && testPrefix.trim()) { setStep(target === "e2e" ? "svc-ask" : "env-ask"); return; }
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
      if (key.backspace || key.delete) { setSvcDraft((p) => ({ ...p, openapi: (p.openapi ?? "").slice(0, -1) || undefined })); return; }
      if (char.length === 1 && char >= " ") { setSvcDraft((p) => ({ ...p, openapi: (p.openapi ?? "") + char })); }
      return;
    }
    if (step === "svc-version") {
      if (key.return) { setServices((prev) => [...prev, { ...svcDraft, repo: svcDraft.repo.trim() }]); setStep("svc-ask"); return; }
      if (key.backspace || key.delete) { setSvcDraft((p) => ({ ...p, versionUrl: (p.versionUrl ?? "").slice(0, -1) || undefined })); return; }
      if (char.length === 1 && char >= " ") { setSvcDraft((p) => ({ ...p, versionUrl: (p.versionUrl ?? "") + char })); }
      return;
    }
    if (step === "env-entry") {
      if (key.return) {
        const eq = envDraft.indexOf("=");
        if (eq > 0) { const k = envDraft.slice(0, eq).trim(); const v = envDraft.slice(eq + 1); setEnvVars((prev) => ({ ...prev, [k]: v })); }
        setEnvDraft("");
        setStep("env-ask");
        return;
      }
      if (key.backspace || key.delete) { setEnvDraft((p) => p.slice(0, -1)); return; }
      if (char.length === 1 && char >= " ") { setEnvDraft((p) => p + char); }
      return;
    }
    if (step === "done" && key.return) { onDone(appName); }
  });

  // ── render ─────────────────────────────────────────────────────────────

  const renderSummaryBar = () => (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{"─".repeat(60)}</Text>
      <Text dimColor>{summary}</Text>
      <Text dimColor>{"─".repeat(60)}</Text>
    </Box>
  );

  const showSummary = step !== "repo-source" && step !== "browse-owner" && step !== "browse-list"
    && step !== "repo" && step !== "validating" && step !== "repo-error"
    && step !== "committing" && step !== "done" && step !== "write-error";

  const showBack = STEPS_BACK[step] !== undefined;

  // ── repo source ───────────────────────────────────────────────────────
  if (step === "repo-source") {
    const items: SelectItem[] = [
      { label: "Browse my repos (pick from a list)", value: "browse" },
      { label: "Enter repo manually (org/name)", value: "manual" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>How would you like to select the repo?</Text>
        <SelectInput items={items} onSelect={(i) => { i.value === "browse" ? setStep("browse-owner") : setStep("repo"); }} />
        <Box marginTop={1}><Text dimColor>Esc to cancel</Text></Box>
      </Box>
    );
  }

  // ── browse owner ──────────────────────────────────────────────────────
  if (step === "browse-owner") {
    return (
      <Box flexDirection="column">
        <Text bold>Enter GitHub username or organization:</Text>
        <TextInput
          placeholder="username"
          onSubmit={(v) => { if (v.trim()) { setBrowseOwner(v); setRepoPage(1); void fetchRepos(1).then(() => setStep("browse-list")); } }}
        />
        <Box marginTop={1}>
          <Text dimColor>Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── browse list ───────────────────────────────────────────────────────
  if (step === "browse-list") {
    const filtered = repoFilter ? repos.filter((r) => r.fullName.toLowerCase().includes(repoFilter.toLowerCase())) : repos;
    const items: SelectItem[] = filtered.map((r) => ({
      label: `${r.fullName}${r.private ? " 🔒" : ""}${r.description ? ` — ${r.description.slice(0, 40)}` : ""}`,
      value: r.fullName,
    }));
    if (items.length === 0 && !loading) {
      items.push({ label: "(no repos match — adjust filter or go back)", value: "" });
    }
    return (
      <Box flexDirection="column">
        <Text bold>{`Repos for ${browseOwner}`}{repoFilterActive ? `  (filter: ${repoFilter || "_"})` : ""}  page {repoPage}</Text>
        {repoFilterActive ? (
          <Box marginTop={1}><Text dimColor>filter: {repoFilter || "_"}  Enter to apply  ·  Esc to close filter</Text></Box>
        ) : (
          <Box marginTop={1}><Text dimColor>/ filter  ·  → next page  ·  {repoPage > 1 ? "← prev page  ·  " : ""}Esc to go back</Text></Box>
        )}
        {loading ? (
          <Box marginTop={1}><Text color="cyan"><Spinner type="dots" /> loading…</Text></Box>
        ) : error ? (
          <Box marginTop={1} flexDirection="column">
            <Text color="#c0392b">✗ {error}</Text>
            <Text dimColor>You can still enter the repo manually — Esc to go back</Text>
          </Box>
        ) : (
          <Box marginTop={1}><SelectInput items={items} onSelect={(i) => { if (i.value) selectRepo(i.value); }} /></Box>
        )}
      </Box>
    );
  }

  // ── manual repo / validating / repo-error ─────────────────────────────
  if (step === "repo" || step === "validating" || step === "repo-error") {
    const showBackHint = STEPS_BACK[step] !== undefined;
    return (
      <Box flexDirection="column">
        <Text bold>Enter the GitHub repo (org/name):</Text>
        {step === "repo" ? (
          <TextInput
            placeholder="org/repo"
            onSubmit={(v) => { if (v.trim()) { setRepoInput(v); void validateRepo(v); } }}
          />
        ) : null}
        <Box marginTop={1}>
          {step === "validating"
            ? <Text color="cyan"><Spinner type="dots" /> validating…</Text>
            : step === "repo-error"
            ? (
              <Box flexDirection="column">
                <Text color="#c0392b">✗ {error}</Text>
                <Box marginTop={1}><Text dimColor>Enter to retry  ·  Esc to go back</Text></Box>
              </Box>
            )
            : step === "repo" ? null : null}
          {step === "repo" ? (
            <Box marginTop={1}>
              <Text dimColor>Esc to cancel{showBackHint ? "  ← back" : ""}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    );
  }

  // ── env-ask ───────────────────────────────────────────────────────────
  if (step === "env-ask") {
    const items: SelectItem[] = [
      { label: Object.keys(envVars).length ? `Add another env var (${Object.keys(envVars).length} added)` : "Add an env var (KEY=value)", value: "add" },
      { label: "Continue — review the YAML", value: "next" },
    ];
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Environment variables (optional, server-side):</Text>
        {Object.entries(envVars).map(([k, v]) => (
          <Text key={k} dimColor>  ✓ {k}={"•".repeat(Math.max(4, Math.min(v.length, 12)))}</Text>
        ))}
        <SelectInput items={items} onSelect={(i) => {
          if (i.value === "add") { setEnvDraft(""); setStep("env-entry"); }
          else void loadPreview();
        }} />
        <Box marginTop={1}><Text dimColor>Esc to cancel{showBack ? "  ← back" : ""}</Text></Box>
      </Box>
    );
  }

  // ── env-entry ─────────────────────────────────────────────────────────
  if (step === "env-entry") {
    const eq = envDraft.indexOf("=");
    const masked = eq > 0
      ? `${envDraft.slice(0, eq + 1)}${"•".repeat(Math.max(4, Math.min(envDraft.length - eq - 1, 12)))}`
      : envDraft;
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Env var (KEY=value):</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{masked || "KEY=value"}</Text>
        </Box>
        <Box marginTop={1}><Text dimColor>Enter to add{showBack ? "  ← back" : ""}  ·  Esc to cancel</Text></Box>
      </Box>
    );
  }

  // ── svc-ask ───────────────────────────────────────────────────────────
  if (step === "svc-ask") {
    const items: SelectItem[] = [
      { label: services.length ? `Add another service (${services.length} added)` : "Add a microservice repo (multi-repo app)", value: "add" },
      { label: "Continue — no more services", value: "next" },
    ];
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Microservice repos (optional):</Text>
        {services.map((s) => <Text key={s.repo} dimColor>  ✓ {s.repo}{s.openapi ? ` (openapi: ${s.openapi})` : ""}</Text>)}
        <SelectInput items={items} onSelect={(i) => {
          if (i.value === "add") { setSvcDraft({ repo: "" }); setStep("svc-repo"); }
          else setStep("env-ask");
        }} />
        <Box marginTop={1}><Text dimColor>Esc to cancel{showBack ? "  ← back" : ""}</Text></Box>
      </Box>
    );
  }

  // ── simple steps (dev-url, dev-version, qa-target, qa-review, qa-shadow, qa-prefix, svc-*, review, committing, done, write-error) ──

  if (step === "dev-url") {
    const isCode = target === "code";
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        {repoInfo ? (
          <Box marginBottom={1}>
            <Text><Text color="#3b7a57">✓</Text>{` ${repoInfo.fullName} `}<Text color={repoInfo.private ? "yellow" : "green"}>({repoInfo.private ? "private" : "public"})</Text>{` · default branch: ${repoInfo.defaultBranch}`}</Text>
          </Box>
        ) : null}
        <Text bold>{isCode ? "Base URL (dummy for code mode):" : "DEV base URL:"}</Text>
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text>{baseUrl || (isCode ? `https://github.com/${repoInput}` : "https://dev.example.com")}</Text>
        </Box>
        <Box marginTop={1}><Text dimColor>Enter to continue{showBack ? "  ← back" : ""}  ·  Esc to cancel</Text></Box>
      </Box>
    );
  }

  if (step === "dev-version") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Version endpoint (optional, Enter to skip):</Text>
        <Box marginTop={1}><Text dimColor>{"> "}</Text><Text>{versionUrl || "(skip — no deploy gate)"}</Text></Box>
        <Box marginTop={1}><Text dimColor>Enter to continue{showBack ? "  ← back" : ""}  ·  Esc to cancel</Text></Box>
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
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Test target:</Text>
        <SelectInput items={items} onSelect={(i) => { setTarget(i.value as TestTarget); setStep("qa-review"); }} />
        <Box marginTop={1}><Text dimColor>{showBack ? "← back  ·  " : ""}Esc to cancel</Text></Box>
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
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Enable AI review?</Text>
        <SelectInput items={items} onSelect={(i) => { setNeedsReview(i.value === "yes"); setStep("qa-shadow"); }} />
        <Box marginTop={1}><Text dimColor>{showBack ? "← back  ·  " : ""}Esc to cancel</Text></Box>
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
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Shadow mode?</Text>
        <SelectInput items={items} onSelect={(i) => { setShadow(i.value === "yes"); setStep("qa-prefix"); }} />
        <Box marginTop={1}><Text dimColor>{showBack ? "← back  ·  " : ""}Esc to cancel</Text></Box>
      </Box>
    );
  }

  if (step === "qa-prefix") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Test data prefix:</Text>
        <Box marginTop={1}><Text dimColor>{"> "}</Text><Text>{testPrefix || "qa-bot"}</Text></Box>
        <Box marginTop={1}><Text dimColor>Enter to continue{showBack ? "  ← back" : ""}  ·  Esc to cancel</Text></Box>
      </Box>
    );
  }

  if (step === "svc-repo") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Service repo (org/name):</Text>
        <Box marginTop={1}><Text dimColor>{"> "}</Text><Text>{svcDraft.repo || "org/service"}</Text></Box>
        <Box marginTop={1}><Text dimColor>Enter to continue{showBack ? "  ← back" : ""}  ·  Esc to cancel</Text></Box>
      </Box>
    );
  }

  if (step === "svc-openapi") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Service OpenAPI glob (optional, Enter to skip):</Text>
        <Box marginTop={1}><Text dimColor>{"> "}</Text><Text>{svcDraft.openapi || "(skip)"}</Text></Box>
        <Box marginTop={1}><Text dimColor>Enter to continue{showBack ? "  ← back" : ""}  ·  Esc to cancel</Text></Box>
      </Box>
    );
  }

  if (step === "svc-version") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Service version endpoint (optional, Enter to skip):</Text>
        <Box marginTop={1}><Text dimColor>{"> "}</Text><Text>{svcDraft.versionUrl || "(skip)"}</Text></Box>
        <Box marginTop={1}><Text dimColor>Enter to continue{showBack ? "  ← back" : ""}  ·  Esc to cancel</Text></Box>
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
        <Box marginTop={1}><Text dimColor>{showBack ? "← back  ·  " : ""}Esc to cancel</Text></Box>
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
        <Box marginTop={1}><Text>Enter → run first QA  ·  Esc → exit</Text></Box>
      </Box>
    );
  }

  if (step === "write-error") {
    return (
      <Box flexDirection="column">
        <Text color="#c0392b">✗ Failed to write config: {error}</Text>
        <Box marginTop={1}><Text dimColor>Esc to go back</Text></Box>
      </Box>
    );
  }

  void loading;
  return <Text>Loading…</Text>;
}
