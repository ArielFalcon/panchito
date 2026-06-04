// Cliente del modelo primario: OpenCode Go (hosteado en US, formato compatible
// con OpenAI). La sanitización previa es defensa en profundidad igualmente.

import { Message } from "../orchestrator/loop";
import { requireEnv } from "../util/env";

export const opencode = {
  async complete({
    model,
    system,
    messages,
  }: {
    model: string;
    system: string;
    messages: Message[];
  }): Promise<string> {
    const res = await fetch(`${requireEnv("OPENCODE_BASE_URL")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${requireEnv("OPENCODE_API_KEY")}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error(`OpenCode error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenCode: respuesta sin choices[0].message.content");
    }
    return content;
  },
};
