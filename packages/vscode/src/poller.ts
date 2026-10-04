// `refresh` asks GitHub and then reads the files; `read` only reads them.
export type PollMode = 'refresh' | 'read';

export interface PollerOptions {
  readonly run: (mode: PollMode) => Promise<void>;
  readonly intervalMs: number;
  readonly focused: boolean;
  // A run that throws is reported here and the poller keeps going.
  readonly onError: (error: unknown) => void;
}

// Runs `run` every interval, and on demand. A tick refreshes while the window
// has focus and only reads while it has not: what the window shows ages, and
// another refresher may have written newer data, whether or not anyone is
// looking, but a request to GitHub for a window out of sight is wasted.
// Single flight: two runs never overlap. A tick that finds one in flight is
// dropped, since the next tick comes soon enough. A refresh asked for while
// one is in flight asks for exactly one more refresh after it, because whatever
// prompted it (a sign-in, a click on Refresh) may be newer than what the
// running one read, and even a read in flight can not stand in for it. A read
// asked for joins the run in flight and queues nothing: a refresh reads the
// files itself at its end, and a read in flight is as new as another would be.
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
  trigger(mode: PollMode = 'refresh'): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#flight) {
      if (mode === 'refresh') this.#again = true;
      return this.#flight;
    }
    // The loop starts on the next microtask, so a run that triggers from
    // inside itself finds the flight already recorded.
    const flight = Promise.resolve().then(() => this.#loop(mode));
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
    if (this.#flight === undefined) void this.trigger(this.#focused ? 'refresh' : 'read');
  }

  // Only a refresh is ever asked for again, so every run after the first is one.
  async #loop(first: PollMode): Promise<void> {
    let mode = first;
    do {
      this.#again = false;
      try {
        await this.#options.run(mode);
      } catch (error) {
        this.#options.onError(error);
      }
      mode = 'refresh';
    } while (this.#again && !this.#disposed);
  }
}
