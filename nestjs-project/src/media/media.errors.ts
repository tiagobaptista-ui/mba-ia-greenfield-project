/**
 * The input is not a readable video (no video stream, unreadable container). Not an HTTP
 * error: the worker turns it into a terminal `failed` status without retries
 * (phase-03-videos/TD-13).
 */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}
