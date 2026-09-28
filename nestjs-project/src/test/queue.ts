import type { Queue } from 'bullmq';

/** Removes every job (any state) of a queue in the test prefix — keeps suites independent. */
export async function obliterateQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}
