// Sequential job queue. Processes one run at a time so two close-together pushes
// do not launch concurrent QA against DEV and clobber each other's data (which
// would break determinism and cause cross-contamination). A failing job does not
// stop the following ones.
//
// Jobs receive an AbortSignal — the queue cancels the currently-running job by
// aborting its signal when cancel() is called.

export class JobQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private currentController: AbortController | null = null;

  constructor(private readonly onError: (e: unknown) => void = () => {}) {}

  enqueue(job: (signal: AbortSignal) => Promise<void>): void {
    this.pending++;
    this.tail = this.tail
      .then(() => {
        this.currentController = new AbortController();
        return job(this.currentController.signal);
      })
      .catch((e) => this.onError(e))
      .finally(() => {
        this.currentController = null;
        this.pending--;
      });
  }

  cancel(): boolean {
    if (this.currentController) {
      this.currentController.abort();
      return true;
    }
    return false;
  }

  get size(): number {
    return this.pending;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
