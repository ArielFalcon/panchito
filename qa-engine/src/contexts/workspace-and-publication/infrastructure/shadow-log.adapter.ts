// src/contexts/workspace-and-publication/infrastructure/shadow-log.adapter.ts
// Shadow-mode swap boundary: implements ShadowPublicationPort by replacing every side effect with a
// log line. At composition time (Plan 6) the DI container selects this adapter when qa.shadow=true;
// the real adapters (VcsWriteAdapter, GitHubPrAdapter, GitHubIssueAdapter, MirrorGcAdapter) are
// selected otherwise. No network / git / GitHub API calls are made — purely observational.
import type { ShadowPublicationPort } from "../application/ports/index.ts";

export class ShadowLogAdapter implements ShadowPublicationPort {
  constructor(private readonly log: (msg: string) => void = console.log) {}

  async openPr(repo: string, branch: string, title: string, body: string): Promise<void> {
    this.log(`[shadow] openPr skipped — would open PR on ${repo} branch=${branch} title="${title}" body-length=${body.length}`);
  }

  async openIssue(repo: string, title: string, body: string): Promise<void> {
    this.log(`[shadow] openIssue skipped — would open Issue on ${repo} title="${title}" body-length=${body.length}`);
  }

  async commit(dir: string, message: string, files: readonly string[]): Promise<void> {
    this.log(`[shadow] commit skipped — would commit ${files.length} file(s) in ${dir} message="${message}"`);
  }

  async push(dir: string, branch: string): Promise<void> {
    this.log(`[shadow] push skipped — would push ${branch} from ${dir}`);
  }

  async prune(mirrorDir: string): Promise<void> {
    this.log(`[shadow] prune skipped — would prune mirror at ${mirrorDir}`);
  }
}
