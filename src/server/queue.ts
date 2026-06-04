// Sequential job queue. Processes one run at a time so two close-together pushes
// do not launch concurrent QA against DEV and clobber each other's data (which
// would break determinism and cause cross-contamination). A failing job does not
// stop the following ones.

export class JobQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onError: (e: unknown) => void = () => {}) {}

  enqueue(job: () => Promise<void>): void {
    this.pending++;
    this.tail = this.tail
      .then(() => job())
      .catch((e) => this.onError(e))
      .finally(() => {
        this.pending--;
      });
  }

  get size(): number {
    return this.pending;
  }

  // Resolves once everything enqueued so far has finished.
  async drain(): Promise<void> {
    await this.tail;
  }
}
