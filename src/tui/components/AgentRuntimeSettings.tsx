import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { TextInput } from "@inkjs/ui";
import {
  AgentConfigUpdate,
  AgentMode,
  AgentModelInfo,
  AgentProvider,
  PublicAgentConfig,
  QaApiError,
  QaClient,
} from "../client";

type Role = "primary" | "reviewer" | "chat";
type Step = "menu" | "role" | "key" | "confirm-downgrade";

interface SelectItem {
  label: string;
  value: string;
}

const PROVIDERS: AgentProvider[] = ["opencode", "codex"];
const ROLES: Role[] = ["primary", "reviewer", "chat"];
const ROLE_LABEL: Record<Role, string> = {
  primary: "Primary",
  reviewer: "Reviewer",
  chat: "Chat",
};

export function AgentRuntimeSettings({ client, onBack }: { client: QaClient; onBack: () => void }): React.ReactElement {
  const [config, setConfig] = useState<PublicAgentConfig | null>(null);
  const [draft, setDraft] = useState<PublicAgentConfig | null>(null);
  const [models, setModels] = useState<Record<AgentProvider, AgentModelInfo[]>>({ opencode: [], codex: [] });
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("menu");
  const [editingRole, setEditingRole] = useState<Role>("primary");
  const [editingKey, setEditingKey] = useState<AgentProvider>("opencode");
  const [apiKeys, setApiKeys] = useState<Partial<Record<AgentProvider, string>>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await client.getAgentConfig();
      const [openModels, codexModels] = await Promise.allSettled([
        client.listAgentModels("opencode"),
        client.listAgentModels("codex"),
      ]);
      setConfig(cfg);
      setDraft(cloneConfig(cfg));
      setModels({
        opencode: openModels.status === "fulfilled" ? openModels.value.models : modelsFromConfig(cfg, "opencode"),
        codex: codexModels.status === "fulfilled" ? codexModels.value.models : modelsFromConfig(cfg, "codex"),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useInput(
    useCallback((_, key) => {
      if (!key.escape) return;
      if (step === "menu") { onBack(); return; }
      setStep("menu");
    }, [onBack, step]),
  );

  const dirty = useMemo(() => {
    if (!config || !draft) return false;
    return JSON.stringify(configSnapshot(config)) !== JSON.stringify(configSnapshot(draft)) || Object.keys(apiKeys).length > 0;
  }, [apiKeys, config, draft]);

  const apply = useCallback(async (confirmSingleDowngrade = false) => {
    if (!draft) return;
    if (draft.mode === "dual" && oneVisibleProvider(draft) && !confirmSingleDowngrade) {
      setStep("confirm-downgrade");
      return;
    }
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const input: AgentConfigUpdate = {
        mode: draft.mode,
        singleProvider: draft.singleProvider,
        assignments: draft.assignments,
        ...(Object.keys(apiKeys).length > 0 ? { apiKeys } : {}),
        ...(confirmSingleDowngrade ? { confirmSingleDowngrade: true } : {}),
      };
      const result = await client.updateAgentConfig(input);
      setConfig(result.config);
      setDraft(cloneConfig(result.config));
      setApiKeys({});
      setStep("menu");
      setNotice(result.downgraded
        ? `Converted to single/${result.config.singleProvider}; restarted ${result.restarted.join(", ") || "none"}`
        : `Saved; restarted ${result.restarted.join(", ") || "none"}`);
    } catch (e) {
      setError(e instanceof QaApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }, [apiKeys, client, draft]);

  if (loading) {
    return <RuntimeFrame><Text color="cyan"><Spinner type="dots" />{" loading runtime…"}</Text></RuntimeFrame>;
  }

  if (!draft) {
    return (
      <RuntimeFrame>
        <Text color="#c0392b">{error ?? "runtime config unavailable"}</Text>
        <Box marginTop={1}><Text dimColor>Esc → back</Text></Box>
      </RuntimeFrame>
    );
  }

  if (applying) {
    return (
      <RuntimeFrame>
        <Text color="cyan"><Spinner type="dots" />{" applying runtime config…"}</Text>
        <Box marginTop={1}><Text dimColor>Waiting for provider health.</Text></Box>
      </RuntimeFrame>
    );
  }

  if (step === "key") {
    return (
      <RuntimeFrame>
        <Text bold>{`${providerLabel(editingKey)} API key`}</Text>
        <TextInput
          placeholder={draft.keys[editingKey] ? "configured; Enter to keep" : "paste key"}
          onSubmit={(value) => {
            const v = value.trim();
            if (v) setApiKeys((prev) => ({ ...prev, [editingKey]: v }));
            setStep("menu");
          }}
        />
        <Box marginTop={1}><Text dimColor>Enter → stage key  ·  Esc → back</Text></Box>
      </RuntimeFrame>
    );
  }

  if (step === "role") {
    const items = roleModelItems(draft, editingRole, models);
    return (
      <RuntimeFrame>
        <Text bold>{`${ROLE_LABEL[editingRole]} model`}</Text>
        <SelectInput
          items={items}
          onSelect={(item) => {
            const [provider, model] = item.value.split("::") as [AgentProvider, string];
            setDraft((prev) => prev ? setRole(prev, editingRole, provider, model) : prev);
            setStep("menu");
          }}
        />
        <Box marginTop={1}><Text dimColor>Esc → back</Text></Box>
      </RuntimeFrame>
    );
  }

  if (step === "confirm-downgrade") {
    const provider = uniqueProvider(draft) ?? draft.singleProvider;
    return (
      <RuntimeFrame>
        <Text color="#c2891b">Dual uses only {providerLabel(provider)} roles.</Text>
        <SelectInput
          items={[
            { label: `Convert to single/${provider}`, value: "yes" },
            { label: "Keep editing", value: "no" },
          ]}
          onSelect={(item) => item.value === "yes" ? void apply(true) : setStep("menu")}
        />
        <Box marginTop={1}><Text dimColor>Esc → back</Text></Box>
      </RuntimeFrame>
    );
  }

  const items = menuItems(draft, dirty);
  return (
    <RuntimeFrame>
      <StatusBlock config={draft} apiKeys={apiKeys} />
      {error ? <Box marginTop={1}><Text color="#c0392b">{error}</Text></Box> : null}
      {notice ? <Box marginTop={1}><Text color="#2f8f46">{notice}</Text></Box> : null}
      {draft.validation.errors.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {draft.validation.errors.map((e) => <Text key={e} color="#c2891b">{`! ${e}`}</Text>)}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "mode") { setDraft(toggleMode(draft, models)); return; }
            if (item.value === "provider") { setDraft(switchSingleProvider(draft, models)); return; }
            if (item.value.startsWith("role:")) { setEditingRole(item.value.slice("role:".length) as Role); setStep("role"); return; }
            if (item.value.startsWith("key:")) { setEditingKey(item.value.slice("key:".length) as AgentProvider); setStep("key"); return; }
            if (item.value.startsWith("restart:")) { void restart(client, item.value.slice("restart:".length) as AgentProvider, setNotice, setError, reload); return; }
            if (item.value === "apply") { void apply(false); return; }
            if (item.value === "reset") { setDraft(cloneConfig(config ?? draft)); setApiKeys({}); return; }
            if (item.value === "back") onBack();
          }}
        />
      </Box>
      <Box marginTop={1}><Text dimColor>Esc → back</Text></Box>
    </RuntimeFrame>
  );
}

function RuntimeFrame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">╭────────────────────────────────────────────╮</Text>
      <Text bold color="cyan">│  <Text color="#c24e2c">Agent Runtime</Text>{"                              │"}</Text>
      <Text bold color="cyan">╰────────────────────────────────────────────╯</Text>
      <Box marginTop={1} flexDirection="column">{children}</Box>
    </Box>
  );
}

function StatusBlock({ config, apiKeys }: { config: PublicAgentConfig; apiKeys: Partial<Record<AgentProvider, string>> }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{`Mode: ${config.mode}${config.mode === "single" ? `/${config.singleProvider}` : ""}`}</Text>
      {PROVIDERS.map((provider) => {
        const h = config.health?.[provider];
        const staged = apiKeys[provider] ? " staged" : "";
        return <Text key={provider} dimColor>{`${providerLabel(provider).padEnd(8)} key=${config.keys[provider] ? "yes" : "no"}${staged} health=${h?.status ?? "unknown"}${h?.error ? ` (${h.error})` : ""}`}</Text>;
      })}
      <Box marginTop={1} flexDirection="column">
        {ROLES.map((role) => {
          const a = config.assignments[role];
          return <Text key={role}>{`${ROLE_LABEL[role].padEnd(8)} ${a.provider} · ${a.model}`}</Text>;
        })}
      </Box>
    </Box>
  );
}

function menuItems(config: PublicAgentConfig, dirty: boolean): SelectItem[] {
  return [
    { label: `Mode: ${config.mode === "single" ? "single" : "dual"}`, value: "mode" },
    ...(config.mode === "single" ? [{ label: `Provider: ${providerLabel(config.singleProvider)}`, value: "provider" }] : []),
    ...ROLES.map((role) => ({ label: `${ROLE_LABEL[role]}: ${config.assignments[role].provider} · ${config.assignments[role].model}`, value: `role:${role}` })),
    { label: "Set OpenCode API key", value: "key:opencode" },
    { label: "Set Codex API key", value: "key:codex" },
    { label: "Restart OpenCode", value: "restart:opencode" },
    { label: "Restart Codex", value: "restart:codex" },
    { label: dirty ? "Apply changes" : "Apply changes (nothing staged)", value: "apply" },
    { label: "Reset draft", value: "reset" },
    { label: "Back", value: "back" },
  ];
}

function roleModelItems(config: PublicAgentConfig, role: Role, models: Record<AgentProvider, AgentModelInfo[]>): SelectItem[] {
  const providers = config.mode === "single" ? [config.singleProvider] : PROVIDERS;
  return providers.flatMap((provider) => modelList(models, provider, config.assignments[role].model).map((m) => ({
    label: config.mode === "single" ? m.id : `${provider} · ${m.id}`,
    value: `${provider}::${m.id}`,
  })));
}

function modelList(models: Record<AgentProvider, AgentModelInfo[]>, provider: AgentProvider, currentModel: string): AgentModelInfo[] {
  const list = models[provider].length > 0 ? models[provider] : [{ id: currentModel }];
  return list.some((m) => m.id === currentModel) ? list : [{ id: currentModel }, ...list];
}

function toggleMode(config: PublicAgentConfig, models: Record<AgentProvider, AgentModelInfo[]>): PublicAgentConfig {
  if (config.mode === "dual") {
    return asSingle(config, config.singleProvider, models);
  }
  const reviewerProvider = opposite(config.singleProvider);
  return {
    ...cloneConfig(config),
    mode: "dual",
    assignments: {
      ...config.assignments,
      reviewer: { provider: reviewerProvider, model: firstModel(models, reviewerProvider, config.assignments.reviewer.model) },
    },
  };
}

function switchSingleProvider(config: PublicAgentConfig, models: Record<AgentProvider, AgentModelInfo[]>): PublicAgentConfig {
  return asSingle(config, opposite(config.singleProvider), models);
}

function asSingle(config: PublicAgentConfig, provider: AgentProvider, models: Record<AgentProvider, AgentModelInfo[]>): PublicAgentConfig {
  return {
    ...cloneConfig(config),
    mode: "single",
    singleProvider: provider,
    assignments: {
      primary: { provider, model: firstModel(models, provider, config.assignments.primary.model) },
      reviewer: { provider, model: firstModel(models, provider, config.assignments.reviewer.model) },
      chat: { provider, model: firstModel(models, provider, config.assignments.chat.model) },
    },
  };
}

function setRole(config: PublicAgentConfig, role: Role, provider: AgentProvider, model: string): PublicAgentConfig {
  return {
    ...cloneConfig(config),
    assignments: {
      ...config.assignments,
      [role]: { provider, model },
    },
  };
}

function firstModel(models: Record<AgentProvider, AgentModelInfo[]>, provider: AgentProvider, fallback: string): string {
  return models[provider][0]?.id ?? fallback;
}

function oneVisibleProvider(config: PublicAgentConfig): boolean {
  return new Set(ROLES.map((role) => config.assignments[role].provider)).size === 1;
}

function uniqueProvider(config: PublicAgentConfig): AgentProvider | undefined {
  const providers = [...new Set(ROLES.map((role) => config.assignments[role].provider))] as AgentProvider[];
  return providers.length === 1 ? providers[0] : undefined;
}

function configSnapshot(config: PublicAgentConfig): unknown {
  return {
    mode: config.mode,
    singleProvider: config.singleProvider,
    assignments: config.assignments,
  };
}

function cloneConfig(config: PublicAgentConfig): PublicAgentConfig {
  return JSON.parse(JSON.stringify(config)) as PublicAgentConfig;
}

function modelsFromConfig(config: PublicAgentConfig, provider: AgentProvider): AgentModelInfo[] {
  const ids = new Set<string>();
  for (const role of ROLES) {
    const a = config.assignments[role];
    if (a.provider === provider) ids.add(a.model);
  }
  return [...ids].map((id) => ({ id, provider }));
}

function providerLabel(provider: AgentProvider): string {
  return provider === "opencode" ? "OpenCode" : "Codex";
}

function opposite(provider: AgentProvider): AgentProvider {
  return provider === "opencode" ? "codex" : "opencode";
}

async function restart(
  client: QaClient,
  provider: AgentProvider,
  setNotice: (v: string | null) => void,
  setError: (v: string | null) => void,
  reload: () => Promise<void>,
): Promise<void> {
  setNotice(null);
  setError(null);
  try {
    const result = await client.restartAgentProvider(provider);
    setNotice(`${providerLabel(provider)} restart: ${result.health?.status ?? "unknown"}`);
    await reload();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}
