/**
 * Await durable startup registration using change notifications, never completion polling.
 * Registration is read immediately after subscribing, so already-complete startup is observed.
 * @param readReady Read the durable worker's identity, PID and callback-ready marker.
 * @param subscribe Install a disposable notification source before the first read.
 * @param signal Optional caller cancellation.
 * @param timeoutMs Finite startup deadline, in milliseconds.
 * @returns Resolves only after durable registration; rejects on uncertainty or cancellation.
 */
export const waitForRegistration = (
  readReady: () => Promise<boolean>,
  subscribe: (changed: () => void) => { close: () => void },
  signal: AbortSignal | undefined,
  timeoutMs = 30_000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      reject(new Error("Invalid startup registration deadline"));
      return;
    }
    let closed = false;
    let reading = false;
    let dirty = false;
    let subscription: { close: () => void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | undefined) => {
      if (closed) return;
      closed = true;
      subscription?.close();
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = () =>
      finish(new Error("Worker startup registration aborted; inspect before retrying"));
    const check = async () => {
      if (closed) return;
      if (reading) {
        dirty = true;
        return;
      }
      reading = true;
      try {
        if (await readReady()) finish(undefined);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      } finally {
        reading = false;
        if (dirty && !closed) {
          dirty = false;
          void check();
        }
      }
    };
    try {
      subscription = subscribe(() => {
        void check();
      });
      timer = setTimeout(
        () => finish(new Error("Worker startup registration timed out; inspect before retrying")),
        timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else void check();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
