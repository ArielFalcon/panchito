// Coordinación primario↔revisor escrita a mano (sin LangGraph). Dos agentes
// SECUENCIALES, un único estado, salidas garantizadas. Al no haber
// concurrencia ni estado global, no puede haber desincronización; el tope de
// iteraciones impide bucles infinitos; la realimentación es solo del delta
// (propuesta + correcciones), no del transcript, para no malgastar tokens.

import { AgentResult } from "../types";
import { sanitizeText } from "./sanitizer";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Verdict {
  approved: boolean;
  corrections: string[];
}

export interface LoopInput {
  systemPrimary: string;
  systemReviewer: string;
  userMessage: string; // ya ensamblado + sanitizado por prompt-builder
  needsReview: boolean;
  maxIterations?: number; // default MAX_ITERATIONS; configurable para tests/tuning
}

// Los dos agentes se inyectan: el loop no conoce proveedores ni red, lo que lo
// hace verificable con stubs en tests unitarios.
export interface LoopDeps {
  primary(a: { system: string; messages: Message[] }): Promise<string>;
  reviewer(a: { system: string; messages: Message[]; temperature?: number }): Promise<Verdict>;
}

export const MAX_ITERATIONS = 2;

export async function runLoop(input: LoopInput, deps: LoopDeps): Promise<AgentResult> {
  const maxIterations = input.maxIterations ?? MAX_ITERATIONS;
  let messages: Message[] = [{ role: "user", content: input.userMessage }];
  let proposal = "";
  let prevCorrections = "";

  for (let iteration = 0; ; iteration++) {
    // --- Primario: genera/corrige los E2E ---
    proposal = await deps.primary({ system: input.systemPrimary, messages });

    if (!input.needsReview) {
      return adapt(proposal, { reviewed: false, approved: true });
    }

    // --- Revisor: juez independiente, determinístico (temp 0), JSON ---
    const verdict = await deps.reviewer({
      system: input.systemReviewer,
      messages: [{ role: "user", content: sanitizeText(proposal) }],
      temperature: 0,
    });

    if (verdict.approved) {
      return adapt(proposal, { reviewed: true, approved: true });
    }

    // --- Cortes de seguridad: el bucle SIEMPRE termina ---
    if (iteration + 1 >= maxIterations) {
      return adapt(proposal, {
        reviewed: true,
        approved: false,
        note: "no convergió en maxIterations",
      });
    }

    const corrections = verdict.corrections.join("\n");
    if (corrections === prevCorrections) {
      return adapt(proposal, {
        reviewed: true,
        approved: false,
        note: "sin progreso entre iteraciones",
      });
    }
    prevCorrections = corrections;

    // Realimenta SOLO el delta (propuesta + correcciones), no el historial.
    messages = [
      { role: "assistant", content: proposal },
      { role: "user", content: sanitizeText(corrections) },
    ];
  }
}

function adapt(
  proposal: string,
  meta: { reviewed: boolean; approved: boolean; note?: string },
): AgentResult {
  return {
    output: proposal,
    artifacts: proposal.trim() ? [{ path: "", content: proposal, kind: "e2e" }] : [],
    reviewed: meta.reviewed,
    approved: meta.approved,
    note: meta.note,
  };
}
