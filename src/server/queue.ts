// Cola de jobs SECUENCIAL. Procesa un run a la vez: evita que dos pushes
// cercanos lancen QA concurrente contra DEV y se pisen los datos (recordar:
// determinismo y sin polución cruzada). Un job que falla no detiene los
// siguientes.

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

  // Resuelve cuando todo lo encolado HASTA AHORA ha terminado.
  async drain(): Promise<void> {
    await this.tail;
  }
}
