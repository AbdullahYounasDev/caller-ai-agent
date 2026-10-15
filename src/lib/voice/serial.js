/**
 * Run async work ONE AT A TIME, in arrival order — a mutex without the ceremony.
 *
 * Used to serialise use of a shared native model (one recognizer, one voice) across
 * concurrent calls, and to keep each call's turns strictly in order. A failure in one
 * task never poisons the queue: the next task still runs.
 *
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
