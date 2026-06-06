import React, { useCallback, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import Spinner from "ink-spinner";
import SelectInput from "ink-select-input";
import { TestTarget } from "../../types";
import { github, RepoInfo } from "../../integrations/github";
import { buildYaml, writeConfig, configExists, suggestName, OnboardInput } from "../onboard";

interface SelectItem {
  label: string;
  value: string;
}

type Step =
  | "repo" | "validating" | "repo-error"
  | "dev-url" | "dev-version"
  | "qa-target" | "qa-review" | "qa-shadow" | "qa-prefix"
  | "review" | "done" | "write-error";

export function OnboardWizard({
  onDone,
  onCancel,
}: {
  onDone: (appName: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [step, setStep] = useState<Step>("repo");
  const [repoInput, setRepoInput] = useState("");
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [appName, setAppName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [versionUrl, setVersionUrl] = useState("");
  const [target, setTarget] = useState<TestTarget>("e2e");
  const [needsReview, setNeedsReview] = useState(true);
  const [shadow, setShadow] = useState(true);
  const [testPrefix, setTestPrefix] = useState("qa-bot");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = useCallback(() => {
    setStep("repo"); setRepoInput(""); setRepoInfo(null); setAppName("");
    setBaseUrl(""); setVersionUrl(""); setTarget("e2e");
    setNeedsReview(true); setShadow(true); setTestPrefix("qa-bot");
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
      const info = await github.getRepo(trimmed);
      setRepoInfo(info);
      const suggested = suggestName(trimmed);
      setAppName(configExists(suggested) ? `${suggested}-${Date.now().toString(36).slice(-4)}` : suggested);
      setStep("dev-url");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("repo-error");
    } finally {
      setLoading(false);
    }
  }, [repoInput]);

  const commit = useCallback(() => {
    if (!repoInfo) return;
    const input: OnboardInput = {
      name: appName, repo: repoInfo.fullName, baseBranch: repoInfo.defaultBranch,
      baseUrl: baseUrl || `https://github.com/${repoInfo.fullName}`,
      versionUrl: versionUrl || undefined, target, needsReview, shadow,
      testDataPrefix: testPrefix || "qa-bot",
    };
    try {
      writeConfig(input.name, buildYaml(input));
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("write-error");
    }
  }, [appName, repoInfo, baseUrl, versionUrl, target, needsReview, shadow, testPrefix]);

  useInput((char, key) => {
    if (key.escape) {
      if (step === "repo-error" || step === "write-error") { reset(); return; }
      if (step === "done") { onDone(appName); return; }
      onCancel();
      return;
    }

    if (step === "repo") {
      if (key.return && repoInput.trim()) { validateRepo(); return; }
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
      if (key.return && testPrefix.trim()) { setStep("review"); return; }
      if (key.backspace || key.delete) { setTestPrefix((p) => p.slice(0, -1)); return; }
      if (char.length === 1 && char >= " ") { setTestPrefix((p) => p + char); }
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
            ? <Text color="red">✗ {error}</Text>
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
              <Text color="green">✓</Text>
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

  if (step === "review") {
    const displayUrl = baseUrl || `https://github.com/${repoInfo?.fullName ?? ""}`;
    const yaml = repoInfo
      ? buildYaml({
          name: appName, repo: repoInfo.fullName, baseBranch: repoInfo.defaultBranch,
          baseUrl: displayUrl, versionUrl: versionUrl || undefined,
          target, needsReview, shadow, testDataPrefix: testPrefix || "qa-bot",
        })
      : "";
    const items: SelectItem[] = [
      { label: "Yes — write config file", value: "yes" },
      { label: "No — cancel", value: "no" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Review — config/apps/{appName}.yaml</Text>
        <Box marginY={1}>
          {yaml.split("\n").map((line, i) => <Text key={i} dimColor>{`  ${line}`}</Text>)}
        </Box>
        <SelectInput items={items} onSelect={(i) => { i.value === "yes" ? commit() : onCancel(); }} />
      </Box>
    );
  }

  if (step === "done") {
    return (
      <Box flexDirection="column">
        <Text color="green">✓ config/apps/{appName}.yaml created</Text>
        <Box marginTop={1}>
          <Text>Enter → run first QA · Esc → exit</Text>
        </Box>
      </Box>
    );
  }

  if (step === "write-error") {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Failed to write config: {error}</Text>
        <Box marginTop={1}>
          <Text dimColor>Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  return <Text>Loading…</Text>;
}
