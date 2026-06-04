// Núcleo del sistema. Agnóstico al disparador y al proyecto. Toda petición
// entra por aquí. La inteligencia de "qué hacer" vive en los prompts
// (config/), no en este código. Las dependencias externas (proveedores, MCP)
// se inyectan para mantener el núcleo verificable.

import { AgentContext, AgentResult } from "../types";
import { sanitize, stripIgnoredFiles } from "./sanitizer";
import { buildSystemPrompt, buildUserMessage } from "./prompt-builder";
import { loadAiIgnore } from "./config-loader";
import { runLoop, LoopDeps } from "./loop";
import { buildCodegraph, buildEngram } from "../integrations/factory";
import { opencode } from "../providers/opencode";
import { gemini } from "../providers/gemini";

export interface RunDeps {
  loopDeps: LoopDeps;
  getImpactRadius(repo: string, diff: string): Promise<string | null>;
  getMemory(repo?: string): Promise<string | null>;
}

const defaultDeps: RunDeps = {
  loopDeps: {
    primary: ({ system, messages }) =>
      opencode.complete({ model: process.env.OPENCODE_MODEL ?? "", system, messages }),
    reviewer: ({ system, messages, temperature }) =>
      gemini.completeJson({ system, messages, temperature }),
  },
  getImpactRadius: (repo, diff) => buildCodegraph().getImpactRadius(repo, diff),
  getMemory: (repo) => buildEngram().getContext(repo),
};

export async function runAgent(
  ctx: AgentContext,
  deps: RunDeps = defaultDeps,
): Promise<AgentResult> {
  // 1. Sanitizar: redactar secretos/PII y descartar los ficheros vetados por
  //    .aiignore (su contenido NUNCA llega al LLM ni al MCP). El resto de
  //    fracciones se sanitizan al ensamblar el mensaje (prompt-builder).
  const redacted = sanitize(ctx);
  const clean: AgentContext = redacted.diff
    ? { ...redacted, diff: stripIgnoredFiles(redacted.diff, loadAiIgnore()) }
    : redacted;

  // 2. Blast radius: solo el subgrafo afectado por el diff.
  const codeContext =
    clean.diff && clean.repo ? await deps.getImpactRadius(clean.repo, clean.diff) : null;

  // 3. Memoria episódica relevante.
  const memory = await deps.getMemory(clean.repo);

  // 4. Loop de agentes a mano. El núcleo no sabe cuántos agentes hay.
  const needsReview = (clean.metadata?.needsReview as boolean | undefined) ?? true;
  return runLoop(
    {
      systemPrimary: buildSystemPrompt("primary-agent"),
      systemReviewer: buildSystemPrompt("reviewer-agent"),
      userMessage: buildUserMessage(clean, codeContext, memory),
      needsReview,
    },
    deps.loopDeps,
  );
}
