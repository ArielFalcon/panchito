import React, { useCallback, useEffect, useState } from "react";
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
  | "review" | "committing" | "done" | "write-error"
  | "loading-config" | "config-error" | "edit-menu";

interface RepoItem {
  fullName: string;
  private: boolean;
  description: string | null;
}

// Steps where TextInput is rendered — leftArrow is for cursor movement in these steps,
// not back navigation. Use Escape to go back.
const TEXT_INPUT_STEPS = new Set<Step>([
  "browse-owner", "repo", "repo-error",
  "dev-url", "dev-version", "qa-prefix",
  "svc-repo", "svc-openapi", "svc-version",
  "env-entry",
]);

const STEPS_BACK: Partial<Record<Step, Step>> = {
  "browse-owner": "repo-source",
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
  "env-ask": "svc-ask",   // code-mode override handled in goBack
  "env-entry": "env-ask",
  "review": "env-ask",
  "config-error": "loading-config",
  "edit-menu": "loading-config",
};

export function OnboardWizard({
  client: clientProp,
  onDone,
  onCancel,
  editMode,
  initialAppName,
}: {
  client?: QaClient;
  onDone: (appName: string) => void;
  onCancel: () => void;
  editMode?: boolean;
  initialAppName?: string;
}): React.ReactElement {
  const [client] = useState<QaClient>(() => clientProp ?? createClient());
  const [step, setStep] = useState<Step>(editMode ? "loading-config" : "repo-source");
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
  const [yamlPreview, setYamlPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isEditMode] = useState<boolean>(editMode ?? false);
  const [editAppName, setEditAppName] = useState<string>(initialAppName ?? "");

  // ── repo browser state ──────────────────────────────────────────────────
  const [browseOwner, setBrowseOwner] = useState("");
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [repoPage, setRepoPage] = useState(1);
  const [repoHasMore, setRepoHasMore] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [repoFilterActive, setRepoFilterActive] = useState(false);

  useEffect(() => {
    if (!isEditMode || !editAppName) return;
    setLoading(true);
    client.getApp(editAppName)
      .then((app) => {
        setRepoInput(app.repo);
        setAppName(app.name);
        setBaseUrl(app.baseUrl);
        setVersionUrl(app.versionUrl);
        setTarget(app.code ? "code" : "e2e");
        setNeedsReview(app.needsReview);
        setShadow(app.shadow);
        setTestPrefix(app.testDataPrefix);
        setServices(app.services.map((s) => ({ repo: s.repo, openapi: s.openapi, versionUrl: s.versionUrl })));
        setStep("edit-menu");
        setError(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setStep("config-error");
      })
      .finally(() => setLoading(false));
  }, [isEditMode, editAppName, client]);

  const reset = useCallback(() => {
    if (isEditMode) {
      setStep("loading-config");
      setError(null);
      setLoading(false);
      return;
    }
    setStep("repo-source"); setRepoInput(""); setRepoInfo(null); setAppName("");
    setBaseUrl(""); setVersionUrl(""); setTarget("e2e");
    setNeedsReview(true); setShadow(true); setTestPrefix("qa-bot");
    setServices([]); setSvcDraft({ repo: "" });
    setEnvVars({}); setYamlPreview("");
    setError(null); setLoading(false);
    setBrowseOwner(""); setRepos([]); setRepoPage(1); setRepoHasMore(false);
    setRepoFilter(""); setRepoFilterActive(false);
  }, [isEditMode]);

  const goBack = useCallback(() => {
    // Code mode: svc-ask was skipped, so env-ask goes back to qa-prefix
    if (step === "env-ask" && target !== "e2e") {
      setStep("qa-prefix"); setError(null); return;
    }
    const prev = STEPS_BACK[step];
    if (prev) { setStep(prev); setError(null); }
  }, [step, target]);

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

  const fetchRepos = useCallback(async (owner: string, page: number) => {
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
  }, [client]);

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
      const req = buildRequest({ dryRun: true });
      const r = isEditMode
        ? await client.updateApp(appName, req)
        : await client.createApp(req);
      if (!r.ok) throw new Error(r.errors?.join("; ") ?? "invalid configuration");
      setYamlPreview(r.yaml ?? "");
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("write-error");
    }
  }, [client, buildRequest, isEditMode, appName]);

  const commit = useCallback(async () => {
    setStep("committing");
    try {
      const req = buildRequest({});
      const r = isEditMode
        ? await client.updateApp(appName, req)
        : await client.createApp(req);
      if (!r.ok) throw new Error(r.errors?.join("; ") ?? (isEditMode ? "update failed" : "creation failed"));
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("write-error");
    }
  }, [client, buildRequest, isEditMode, appName]);

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
      if (step === "write-error") { reset(); return; }
      if (step === "done") { onDone(appName); return; }
      if (isEditMode && (step === "edit-menu" || step === "config-error")) { onCancel(); return; }
      if (isEditMode && step !== "loading-config" && step !== "review" && step !== "committing") { setStep("edit-menu"); return; }
      // For any step with a back target, Escape goes back instead of cancelling
      if (STEPS_BACK[step]) { goBack(); return; }
      onCancel();
      return;
    }

    // Left arrow: back navigation only for non-text-input steps
    // (TextInput uses leftArrow for cursor movement)
    if (key.leftArrow && !TEXT_INPUT_STEPS.has(step) && step !== "repo-source" && step !== "browse-list" && step !== "loading-config" && step !== "edit-menu") {
      if (isEditMode && step !== "config-error" && step !== "review" && step !== "committing" && step !== "done" && step !== "write-error") {
        setStep("edit-menu"); return;
      }
      goBack(); return;
    }

    // ── browse list ─────────────────────────────────────────────────────
    if (step === "browse-list") {
      if (key.rightArrow && repoHasMore && !loading) { void fetchRepos(browseOwner, repoPage + 1); return; }
      if (key.leftArrow && repoPage > 1 && !loading) { void fetchRepos(browseOwner, repoPage - 1); return; }
      if (char === "/") { setRepoFilterActive((p) => !p); if (repoFilterActive) setRepoFilter(""); return; }
      if (repoFilterActive) {
        if (key.return) { setRepoFilterActive(false); return; }
        if (key.backspace || key.delete) { setRepoFilter((p) => p.slice(0, -1)); return; }
        if (char.length === 1 && char >= " ") { setRepoFilter((p) => p + char); }
        return;
      }
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
    && step !== "committing" && step !== "done" && step !== "write-error"
    && step !== "loading-config" && step !== "config-error" && step !== "edit-menu";

  const showBack = STEPS_BACK[step] !== undefined && !TEXT_INPUT_STEPS.has(step) && step !== "edit-menu";
  const backHint = showBack ? "  ·  ← back" : "";

  // ── repo source ───────────────────────────────────────────────────────
  if (step === "repo-source") {
    const items: SelectItem[] = [
      { label: "Browse my repos (pick from a list)", value: "browse" },
      { label: "Enter repo manually (org/name)", value: "manual" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>How would you like to select the repo?</Text>
        <SelectInput items={items} onSelect={(i) => { if (i.value === "browse") { setRepoFilter(""); setRepoFilterActive(false); setStep("browse-owner"); } else { setStep("repo"); } }} />
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
          placeholder="@me (your repos)"
          onSubmit={(v) => {
            const owner = v.trim() || "@me";
            setBrowseOwner(owner);
            setRepoPage(1);
            void fetchRepos(owner, 1).then(() => { setRepoFilter(""); setRepoFilterActive(false); setStep("browse-list"); });
          }}
        />
        <Box marginTop={1}>
          <Text dimColor>Enter to search  ·  empty Enter = your repos  ·  Esc to go back</Text>
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
        <Text bold>{`Repos for ${browseOwner === "@me" ? "your account" : browseOwner}`}{repoFilterActive ? `  (filter: ${repoFilter || "_"})` : ""}  page {repoPage}</Text>
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

  // ── manual repo entry ─────────────────────────────────────────────────
  if (step === "repo") {
    return (
      <Box flexDirection="column">
        <Text bold>Enter the GitHub repo (org/name):</Text>
        <TextInput
          defaultValue={isEditMode ? undefined : (repoInput || undefined)}
          placeholder={isEditMode ? (repoInput || "org/repo") : "org/repo"}
          onChange={isEditMode ? undefined : setRepoInput}
          onSubmit={(v) => { const r = v.trim() || repoInput; if (r) { setRepoInput(r); void validateRepo(r); } }}
        />
        <Box marginTop={1}><Text dimColor>Enter to validate  ·  Esc to go back</Text></Box>
      </Box>
    );
  }

  // ── validating ────────────────────────────────────────────────────────
  if (step === "validating") {
    return (
      <Box flexDirection="column">
        <Text bold>Enter the GitHub repo (org/name):</Text>
        <Box marginTop={1}><Text color="cyan"><Spinner type="dots" /> validating {repoInput}…</Text></Box>
      </Box>
    );
  }

  // ── repo error ────────────────────────────────────────────────────────
  if (step === "repo-error") {
    return (
      <Box flexDirection="column">
        <Text bold>Enter the GitHub repo (org/name):</Text>
        <TextInput
          defaultValue={repoInput}
          placeholder="org/repo"
          onChange={setRepoInput}
          onSubmit={(v) => { if (v.trim()) { setRepoInput(v); void validateRepo(v); } }}
        />
        <Box marginTop={1} flexDirection="column">
          <Text color="#c0392b">✗ {error}</Text>
          <Text dimColor>Enter to retry  ·  Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  // ── dev-url ───────────────────────────────────────────────────────────
  if (step === "dev-url") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        {repoInfo ? (
          <Box marginBottom={1}>
            <Text><Text color="#3b7a57">✓</Text>{` ${repoInfo.fullName} `}<Text color={repoInfo.private ? "yellow" : "green"}>({repoInfo.private ? "private" : "public"})</Text>{` · default branch: ${repoInfo.defaultBranch}`}</Text>
          </Box>
        ) : null}
        <Text bold>DEV base URL <Text dimColor>(optional — Enter to skip)</Text></Text>
        {/* edit mode: start empty so typing replaces rather than appends; placeholder shows current value */}
        <TextInput
          defaultValue={isEditMode ? undefined : (baseUrl || undefined)}
          placeholder={isEditMode ? (baseUrl || "https://dev.myapp.com") : "https://dev.myapp.com"}
          onChange={isEditMode ? undefined : setBaseUrl}
          onSubmit={(v) => { if (v.trim()) setBaseUrl(v.trim()); setStep(isEditMode ? "edit-menu" : "dev-version"); }}
        />
        <Box marginTop={1}><Text dimColor>Enter to continue  ·  Esc to go back</Text></Box>
      </Box>
    );
  }

  // ── dev-version ───────────────────────────────────────────────────────
  if (step === "dev-version") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Version endpoint <Text dimColor>(optional — Enter to skip)</Text></Text>
        <TextInput
          defaultValue={isEditMode ? undefined : (versionUrl || undefined)}
          placeholder={isEditMode ? (versionUrl || "https://dev.myapp.com/version") : "https://dev.myapp.com/version"}
          onChange={isEditMode ? undefined : setVersionUrl}
          onSubmit={(v) => { if (v.trim()) setVersionUrl(v.trim()); setStep(isEditMode ? "edit-menu" : "qa-target"); }}
        />
        <Box marginTop={1}><Text dimColor>Enter to continue  ·  Esc to go back</Text></Box>
      </Box>
    );
  }

  // ── qa-target ─────────────────────────────────────────────────────────
  if (step === "qa-target") {
    const items: SelectItem[] = [
      { label: "e2e  — browser tests against DEV", value: "e2e" },
      { label: "code — source-code tests (no browser)", value: "code" },
    ];
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Test target:</Text>
        <SelectInput items={items} onSelect={(i) => { setTarget(i.value as TestTarget); setStep(isEditMode ? "edit-menu" : "qa-review"); }} />
        <Box marginTop={1}><Text dimColor>{showBack ? "← back  ·  " : ""}Esc to cancel</Text></Box>
      </Box>
    );
  }

  // ── qa-review ─────────────────────────────────────────────────────────
  if (step === "qa-review") {
    const items: SelectItem[] = [
      { label: "Yes — AI reviewer validates generated tests", value: "yes" },
      { label: "No — skip review", value: "no" },
    ];
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Enable AI review?</Text>
        <SelectInput items={items} onSelect={(i) => { setNeedsReview(i.value === "yes"); setStep(isEditMode ? "edit-menu" : "qa-shadow"); }} />
        <Box marginTop={1}><Text dimColor>{showBack ? "← back  ·  " : ""}Esc to cancel</Text></Box>
      </Box>
    );
  }

  // ── qa-shadow ─────────────────────────────────────────────────────────
  if (step === "qa-shadow") {
    const items: SelectItem[] = [
      { label: "Yes — run silently, no PRs or Issues (recommended)", value: "yes" },
      { label: "No — publish PRs and open Issues", value: "no" },
    ];
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Shadow mode?</Text>
        <SelectInput items={items} onSelect={(i) => { setShadow(i.value === "yes"); setStep(isEditMode ? "edit-menu" : "qa-prefix"); }} />
        <Box marginTop={1}><Text dimColor>{showBack ? "← back  ·  " : ""}Esc to cancel</Text></Box>
      </Box>
    );
  }

  // ── qa-prefix ─────────────────────────────────────────────────────────
  if (step === "qa-prefix") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Test data prefix <Text dimColor>(Enter to keep current or set new)</Text></Text>
        <TextInput
          defaultValue={isEditMode ? undefined : (testPrefix || undefined)}
          placeholder={testPrefix || "qa-bot"}
          onChange={isEditMode ? undefined : setTestPrefix}
          onSubmit={(v) => {
            const name = v.trim() || testPrefix || "qa-bot";
            setTestPrefix(name);
            setStep(isEditMode ? "edit-menu" : target === "e2e" ? "svc-ask" : "env-ask");
          }}
        />
        <Box marginTop={1}><Text dimColor>Enter to continue  ·  Esc to go back</Text></Box>
      </Box>
    );
  }

  // ── svc-ask ───────────────────────────────────────────────────────────
  if (step === "svc-ask") {
    const items: SelectItem[] = [
      { label: services.length ? `Add another service (${services.length} added)` : "Add a microservice repo (multi-repo app)", value: "add" },
      { label: isEditMode ? "Back to menu" : "Continue — no more services", value: "next" },
    ];
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Microservice repos <Text dimColor>(optional)</Text></Text>
        {services.map((s) => <Text key={s.repo} dimColor>  ✓ {s.repo}{s.openapi ? ` (openapi: ${s.openapi})` : ""}</Text>)}
        <SelectInput items={items} onSelect={(i) => {
          if (i.value === "add") { setSvcDraft({ repo: "" }); setStep("svc-repo"); }
          else setStep(isEditMode ? "edit-menu" : "env-ask");
        }} />
        <Box marginTop={1}><Text dimColor>Esc to cancel{backHint}</Text></Box>
      </Box>
    );
  }

  // ── svc-repo ──────────────────────────────────────────────────────────
  if (step === "svc-repo") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Service repo (org/name):</Text>
        <TextInput
          defaultValue={svcDraft.repo}
          placeholder="org/service-name"
          onChange={(v) => setSvcDraft((p) => ({ ...p, repo: v }))}
          onSubmit={(v) => {
            if (!v.trim().includes("/")) {
              setError("repo must be in 'org/name' format (e.g. 'org/my-service')");
              return;
            }
            setError(null);
            setSvcDraft((p) => ({ ...p, repo: v.trim() }));
            setStep("svc-openapi");
          }}
        />
        {error ? <Box marginTop={1}><Text color="#c0392b">✗ {error}</Text></Box> : null}
        <Box marginTop={1}><Text dimColor>Enter to continue  ·  Esc to go back</Text></Box>
      </Box>
    );
  }

  // ── svc-openapi ───────────────────────────────────────────────────────
  if (step === "svc-openapi") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Service OpenAPI glob <Text dimColor>(optional — Enter to skip)</Text></Text>
        <TextInput
          defaultValue={svcDraft.openapi ?? ""}
          placeholder="api/**/*.yaml"
          onChange={(v) => setSvcDraft((p) => ({ ...p, openapi: v || undefined }))}
          onSubmit={(v) => {
            setSvcDraft((p) => ({ ...p, openapi: v.trim() || undefined }));
            setStep("svc-version");
          }}
        />
        <Box marginTop={1}><Text dimColor>Enter to continue  ·  Esc to go back</Text></Box>
      </Box>
    );
  }

  // ── svc-version ───────────────────────────────────────────────────────
  if (step === "svc-version") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Service version endpoint <Text dimColor>(optional — Enter to skip)</Text></Text>
        <TextInput
          defaultValue={svcDraft.versionUrl ?? ""}
          placeholder="https://service/version"
          onChange={(v) => setSvcDraft((p) => ({ ...p, versionUrl: v || undefined }))}
          onSubmit={(v) => {
            const versionUrl = v.trim() || undefined;
            setServices((prev) => [...prev, { repo: svcDraft.repo.trim(), openapi: svcDraft.openapi, versionUrl }]);
            setSvcDraft({ repo: "" });
            setStep("svc-ask");
          }}
        />
        <Box marginTop={1}><Text dimColor>Enter to continue  ·  Esc to go back</Text></Box>
      </Box>
    );
  }

  // ── env-ask ───────────────────────────────────────────────────────────
  if (step === "env-ask") {
    const items: SelectItem[] = [
      { label: Object.keys(envVars).length ? `Add another env var (${Object.keys(envVars).length} added)` : "Add an env var (KEY=value)", value: "add" },
      { label: isEditMode ? "Back to menu" : "Continue — review the YAML", value: "next" },
    ];
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Environment variables <Text dimColor>(optional, server-side)</Text></Text>
        {Object.entries(envVars).map(([k, v]) => (
          <Text key={k} dimColor>  ✓ {k}={"•".repeat(Math.max(4, Math.min(v.length, 12)))}</Text>
        ))}
        <SelectInput items={items} onSelect={(i) => {
          if (i.value === "add") { setStep("env-entry"); }
          else if (isEditMode) { setStep("edit-menu"); }
          else void loadPreview();
        }} />
        <Box marginTop={1}><Text dimColor>Esc to cancel{backHint}</Text></Box>
      </Box>
    );
  }

  // ── env-entry ─────────────────────────────────────────────────────────
  if (step === "env-entry") {
    return (
      <Box flexDirection="column">
        {showSummary ? renderSummaryBar() : null}
        <Text bold>Env var <Text dimColor>(KEY=value)</Text></Text>
        <TextInput
          placeholder="GITHUB_TOKEN=ghp_xxx"
          onSubmit={(v) => {
            const eq = v.indexOf("=");
            if (eq > 0) {
              const k = v.slice(0, eq).trim();
              const val = v.slice(eq + 1);
              setEnvVars((prev) => ({ ...prev, [k]: val }));
            }
            setStep(isEditMode ? "edit-menu" : "env-ask");
          }}
        />
        <Box marginTop={1}><Text dimColor>Enter to add  ·  Esc to go back</Text></Box>
      </Box>
    );
  }

  // ── review ────────────────────────────────────────────────────────────
  if (step === "review") {
    const items: SelectItem[] = [
      { label: isEditMode ? "Yes — save changes" : "Yes — write config file", value: "yes" },
      { label: "No — cancel", value: "no" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>{isEditMode ? `Review changes — config/apps/${appName}.yaml` : `Review — config/apps/${appName}.yaml`}</Text>
        <Box marginY={1} flexDirection="column">
          {yamlPreview.split("\n").map((line, i) => <Text key={i} dimColor>{`  ${line}`}</Text>)}
        </Box>
        <SelectInput items={items} onSelect={(i) => { i.value === "yes" ? void commit() : onCancel(); }} />
        <Box marginTop={1}><Text dimColor>{showBack ? "← back  ·  " : ""}Esc to cancel</Text></Box>
      </Box>
    );
  }

  if (step === "committing") {
    return <Text color="cyan"><Spinner type="dots" /> {isEditMode ? "saving…" : "committing…"}</Text>;
  }

  if (step === "done") {
    return (
      <Box flexDirection="column">
        <Text color="#3b7a57">✓ config/apps/{appName}.yaml {isEditMode ? "updated" : "created"}</Text>
        <Box marginTop={1}><Text>Enter → {isEditMode ? "done" : "run first QA"}  ·  Esc → exit</Text></Box>
      </Box>
    );
  }

  if (step === "write-error") {
    return (
      <Box flexDirection="column">
        <Text color="#c0392b">✗ Failed to {isEditMode ? "save" : "write"} config: {error}</Text>
        <Box marginTop={1}><Text dimColor>Esc to go back</Text></Box>
      </Box>
    );
  }

  if (step === "loading-config") {
    return (
      <Box flexDirection="column">
        <Text color="cyan"><Spinner type="dots" /> loading config for {editAppName}…</Text>
      </Box>
    );
  }

  if (step === "config-error") {
    return (
      <Box flexDirection="column">
        <Text color="#c0392b">✗ Failed to load config: {error}</Text>
        <Box marginTop={1}><Text dimColor>Esc to cancel</Text></Box>
      </Box>
    );
  }

  if (step === "edit-menu") {
    const items: SelectItem[] = [
      { label: `Repo: ${repoInput || repoInfo?.fullName || "(none)"}`, value: "repo" },
      { label: `Base URL: ${baseUrl || "(none)"}`, value: "baseUrl" },
      { label: `Version URL: ${versionUrl || "(none)"}`, value: "versionUrl" },
      { label: `Target: ${target}`, value: "target" },
      { label: `AI Review: ${needsReview ? "yes" : "no"}`, value: "needsReview" },
      { label: `Shadow: ${shadow ? "yes" : "no"}`, value: "shadow" },
      { label: `Test Prefix: ${testPrefix || "qa-bot"}`, value: "testPrefix" },
      { label: `Services: ${services.length}`, value: "services" },
      { label: `Env Vars: ${Object.keys(envVars).length}`, value: "env" },
      { label: "Review & Save", value: "review" },
      { label: "Cancel", value: "cancel" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Edit config/apps/{appName}.yaml</Text>
        <Box marginTop={1}>
          <SelectInput items={items} onSelect={(i) => {
            switch (i.value) {
              case "repo": setStep("repo"); break;
              // Do NOT clear field values — existing values remain for editing
              case "baseUrl": setStep("dev-url"); break;
              case "versionUrl": setStep("dev-version"); break;
              case "target": setStep("qa-target"); break;
              case "needsReview": setStep("qa-review"); break;
              case "shadow": setStep("qa-shadow"); break;
              case "testPrefix": setStep("qa-prefix"); break;
              case "services": setStep("svc-ask"); break;
              case "env": setStep("env-ask"); break;
              case "review": void loadPreview(); break;
              case "cancel": onCancel(); break;
            }
          }} />
        </Box>
        <Box marginTop={1}><Text dimColor>Esc to cancel</Text></Box>
      </Box>
    );
  }

  void loading;
  return <Text>Loading…</Text>;
}
