// Núcleo del sistema. Agnóstico al disparador y al proyecto. Toda petición
// entra por aquí. La inteligencia de "qué hacer" vive en los prompts
// (config/), no en este código. Las dependencias externas (proveedores, MCP)
// se inyectan para mantener el núcleo verificable.

import { AgentContext, AgentResult } from "../types";
import { sanitize } from "./sanitizer";
import { buildPrompt, buildUserMessage } from "./prompt-builder";
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
  // 1. Sanitizar el contexto de entrada. El resto de fracciones se sanitizan
  //    en el ensamblaje del mensaje (prompt-builder).
  const clean = sanitize(ctx);

  // 2. Blast radius: solo el subgrafo afectado por el diff.
  const codeContext =
    clean.diff && clean.repo ? await deps.getImpactRadius(clean.repo, clean.diff) : null;

  // 3. Memoria episódica relevante.
  const memory = await deps.getMemory(clean.repo);

  // 4. Loop de agentes a mano. El núcleo no sabe cuántos agentes hay.
  const needsReview = (clean.metadata?.needsReview as boolean | undefined) ?? true;
  return runLoop(
    {
      systemPrimary: buildPrompt("primary-agent", clean),
      systemReviewer: buildPrompt("reviewer-agent", clean),
      userMessage: buildUserMessage(clean, codeContext, memory),
      needsReview,
    },
    deps.loopDeps,
  );
}
