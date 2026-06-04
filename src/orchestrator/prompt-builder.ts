// Ensambla los prompts. El system viene de config/prompts (especificidad del
// equipo); el user-message reúne tarea + diff + contexto de código + memoria.
// CLAVE: cada fracción se sanitiza aquí — es el punto donde "ninguna ruta al
// LLM evita el sanitizer" se hace cumplir para el contenido dinámico.

import { AgentContext } from "../types";
import { loadSystemPrompt } from "./config-loader";
import { sanitizeText } from "./sanitizer";

export function buildPrompt(role: string, _ctx: AgentContext): string {
  return loadSystemPrompt(role);
}

export function buildUserMessage(
  ctx: AgentContext,
  codeContext: string | null,
  memory: string | null,
): string {
  const parts: string[] = [];
  parts.push(`## Tarea\n${sanitizeText(ctx.task ?? "")}`);
  if (ctx.repo) {
    parts.push(`## Repo\n${ctx.repo}${ctx.sha ? ` @ ${ctx.sha}` : ""}`);
  }
  if (ctx.diff) {
    parts.push(`## Diff (sanitizado)\n${sanitizeText(ctx.diff)}`);
  }
  if (codeContext) {
    parts.push(`## Contexto de código — blast radius (sanitizado)\n${sanitizeText(codeContext)}`);
  }
  if (memory) {
    parts.push(`## Memoria relevante (sanitizada)\n${sanitizeText(memory)}`);
  }
  return parts.join("\n\n");
}
