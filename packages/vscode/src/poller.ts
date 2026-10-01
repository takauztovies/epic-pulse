export interface PollerOptions {
  readonly run: () => Promise<void>;
  readonly intervalMs: number;
  readonly focused: boolean;
  // A run that throws is reported here and the poller keeps going.
  readonly onError: (error: unknown) => void;
}

// Runs `run` every interval while the window has focus, and on demand.
// Single flight: two runs never overlap. A tick that finds one in flight is
// dropped, since the next tick comes soon enough. A trigger that finds one in
// flight asks for exactly one more run after it, because whatever prompted it
// (a sign-in, a click on Refresh) may be newer than what the running one read.
export class Poller {
  readonly #options: PollerOptions;
  #flight: Promise<void> | undefined;
  #again = false;
  #focused: boolean;
  #disposed = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: PollerOptions) {
    this.#options = options;
    this.#focused = options.focused;
    this.setIntervalMs(options.intervalMs);
  }

  // Resolves once the run it started or joined, and any run it asked for, is done.
  trigger(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#flight) {
      this.#again = true;
      return this.#flight;
    }
    // The loop starts on the next microtask, so a run that triggers from
    // inside itself finds the flight already recorded.
    const flight = Promise.resolve().then(() => this.#loop());
    this.#flight = flight.finally(() => {
      this.#flight = undefined;
    });
    return this.#flight;
  }

  // Coming back to the window refreshes at once instead of at the next tick.
  setFocused(focused: boolean): void {
    const regained = focused && !this.#focused;
    this.#focused = focused;
    if (regained) void this.trigger();
  }

  setIntervalMs(intervalMs: number): void {
    clearInterval(this.#timer);
    this.#timer = this.#disposed ? undefined : setInterval(() => this.#tick(), intervalMs);
  }

  // Stops the timer and any further run. Resolves when the run in flight, if
  // any, has finished, so a refresh releases its lock before the host exits.
  dispose(): Promise<void> {
    this.#disposed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    return this.#flight ?? Promise.resolve();
  }

  #tick(): void {
    if (this.#focused && this.#flight === undefined) void this.trigger();
  }

  async #loop(): Promise<void> {
    do {
      this.#again = false;
      try {
        await this.#options.run();
      } catch (error) {
        this.#options.onError(error);
      }
    } while (this.#again && !this.#disposed);
  }
}
