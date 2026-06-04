// Integración con GitHub: abrir un Issue accionable cuando los E2E fallan.
// En verde no se hace nada (sin ruido).

import { requireEnv } from "../util/env";

export const github = {
  async openIssue(
    repo: string,
    title: string,
    body: string,
  ): Promise<{ url: string }> {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) throw new Error(`GitHub error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string };
    return { url: data.html_url };
  },
};
