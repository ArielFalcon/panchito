// Disparador del motor agéntico OpenCode. Sustituye al loop primario↔revisor,
// a los providers y al cliente MCP hechos a mano: ahora la generación, la
// revisión (subagente) y el acceso a codegraph/engram viven DENTRO de OpenCode
// (ver opencode/opencode.json). Aquí solo abrimos una sesión contra
// `opencode serve`, le pasamos el contexto del cambio, y recogemos los .spec.ts
// que el agente escribió en el espejo.
//
// La SDK se inyecta vía OpencodeDeps: la lógica verificable (prompt, parseo del
// veredicto, lectura de specs, orquestación) se testea con stubs; la conexión
// real a `opencode serve` es el borde no cubierto por unitarios (igual que
// Playwright en qa/execute.ts).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Artifact, AgentResult } from "../types";
import { sanitizeText } from "../orchestrator/sanitizer";

export interface OpencodeRunInput {
  repo: string;
  sha: string;
  diff: string;
  mirrorDir: string; // cwd del agente: espejo del repo en el SHA
  specRelDir: string; // dónde escribe el agente, relativo a mirrorDir
  specAbsDir: string; // misma ruta absoluta, para que NOSOTROS leamos los specs
  namespace: string; // prefijo de datos de test (qa-bot-<sha>)
  needsReview: boolean;
}

// Una sesión abierta contra `opencode serve`. prompt() envía el mensaje al
// agente `qa-generator` y devuelve su texto final (incl. el JSON de cierre).
export interface OpencodeSession {
  prompt(text: string): Promise<string>;
}

export interface OpencodeDeps {
  // Abre una sesión para `agent` con `cwd` como directorio de proyecto.
  open(agent: string, cwd: string): Promise<OpencodeSession>;
  // Lee los .spec.ts que el agente escribió en `dir`.
  readSpecs(dir: string): Artifact[];
}

interface FinalVerdict {
  approved: boolean;
  specs: string[];
  note?: string;
}

export async function runOpencode(
  input: OpencodeRunInput,
  deps: OpencodeDeps,
): Promise<AgentResult> {
  const session = await deps.open("qa-generator", input.mirrorDir);
  const finalText = await session.prompt(buildPrompt(input));

  const verdict = parseVerdict(finalText);
  const artifacts = deps.readSpecs(input.specAbsDir);

  // Sin revisión configurada, el veredicto del subagente no aplica: se aprueba.
  const approved = input.needsReview ? verdict.approved : true;

  return {
    output: finalText,
    artifacts,
    reviewed: input.needsReview,
    approved,
    note: approved ? undefined : verdict.note ?? "el revisor no aprobó los E2E",
  };
}

// Ensambla el mensaje dinámico para el agente. La inteligencia de "cómo" vive
// en opencode/agent/qa-generator.md; aquí solo va el contexto del cambio. El
// diff se sanitiza igualmente (defensa en profundidad — barato).
export function buildPrompt(input: OpencodeRunInput): string {
  return [
    `Genera tests E2E para los flujos afectados por el commit ${input.sha} de ${input.repo}.`,
    ``,
    `- Directorio de salida de los specs (relativo a tu cwd): ${input.specRelDir}`,
    `- Prefijo de datos de test: ${input.namespace}`,
    input.needsReview
      ? `- Revisión obligatoria: invoca al subagente qa-reviewer y aplica sus correcciones.`
      : `- Revisión desactivada para este run: no invoques a qa-reviewer.`,
    ``,
    `## Diff del commit`,
    "```diff",
    sanitizeText(input.diff),
    "```",
  ].join("\n");
}

// Extrae el JSON de cierre del agente. Tolerante: busca el ÚLTIMO objeto JSON
// con `approved` (esté o no en un bloque ```json). Si no hay uno válido, se
// asume no aprobado (fail-closed) para no reportar verde por accidente.
export function parseVerdict(text: string): FinalVerdict {
  const candidates = text.match(/\{[\s\S]*?\}/g) ?? [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]!);
      if (typeof parsed.approved === "boolean") {
        return {
          approved: parsed.approved,
          specs: Array.isArray(parsed.specs) ? parsed.specs : [],
          note: typeof parsed.note === "string" ? parsed.note : undefined,
        };
      }
    } catch {
      /* no era JSON parseable; sigue probando candidatos anteriores */
    }
  }
  return { approved: false, specs: [], note: "el agente no emitió veredicto" };
}

// --- Borde de integración: conexión real a `opencode serve` -----------------
// No cubierto por unitarios (igual que el runner Playwright). La SDK se importa
// de forma perezosa para que los tests no requieran el paquete instalado.
// OPENCODE_SERVE_URL apunta al contenedor `opencode` (ver docker-compose).
export async function defaultOpencodeDeps(): Promise<OpencodeDeps> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const client = createOpencodeClient({
    baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://opencode:4096",
  });

  return {
    readSpecs: readSpecsFrom,
    // `directory` (query) posiciona la sesión en el espejo del repo: el agente
    // lee/escribe ahí. El espejo es un volumen compartido con el contenedor
    // `opencode`, así que la ruta es válida en ambos lados.
    open: async (agent, cwd) => {
      const created = await client.session.create({ query: { directory: cwd } });
      const id = created.data?.id;
      if (!id) throw new Error("OpenCode: la sesión no devolvió id");
      return {
        prompt: async (text) => {
          const res = await client.session.prompt({
            path: { id },
            query: { directory: cwd },
            body: { agent, parts: [{ type: "text", text }] },
          });
          return extractText(res.data?.parts);
        },
      };
    },
  };
}

// Concatena el texto de las partes de texto de la respuesta del agente.
function extractText(parts: Array<{ type: string }> | undefined): string {
  return (parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// Lectura por defecto de los specs escritos por el agente.
export function readSpecsFrom(dir: string): Artifact[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // el agente no escribió nada
  }
  return entries
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => ({
      path: f,
      content: readFileSync(join(dir, f), "utf8"),
      kind: "e2e" as const,
    }));
}
