// Sequential job queue. One run at a time so two close-together pushes do not
// launch concurrent QA against DEV. A failing job does not stop the following ones.
// cancel() aborts the currently-running job; pass a runId to abort only when it
// matches (so a stale cancel cannot abort an unrelated successor).

export class JobQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private currentController: AbortController | null = null;
  private currentRunId: string | null = null;

  constructor(private readonly onError: (e: unknown) => void = () => {}) {}

  enqueue(job: (signal: AbortSignal) => Promise<void>, runId?: string): void {
    this.pending++;
    this.tail = this.tail
      .then(() => {
        this.currentController = new AbortController();
        this.currentRunId = runId ?? null;
        return job(this.currentController.signal);
      })
      .catch((e) => this.onError(e))
      .finally(() => {
        this.currentController = null;
        this.currentRunId = null;
        this.pending--;
      });
  }

  cancel(runId?: string): boolean {
    if (!this.currentController) return false;
    if (runId !== undefined && this.currentRunId !== runId) return false;
    this.currentController.abort();
    return true;
  }

  get size(): number {
    return this.pending;
  }

  get current(): string | null {
    return this.currentRunId;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
