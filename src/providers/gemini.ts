// Cliente del modelo revisor: Gemini 2.5 Flash (plan pago, excluye datos de
// entrenamiento). Modelo DISTINTO al primario para garantizar independencia
// del juicio. Fuerza salida JSON con el esquema { approved, corrections }.

import { Message, Verdict } from "../orchestrator/loop";
import { requireEnv } from "../util/env";

export const gemini = {
  async completeJson({
    system,
    messages,
    temperature = 0,
  }: {
    system: string;
    messages: Message[];
    temperature?: number;
  }): Promise<Verdict> {
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${requireEnv("GEMINI_API_KEY")}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature, response_mime_type: "application/json" },
      }),
    });
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text);
    return {
      approved: Boolean(parsed.approved),
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
    };
  },
};
