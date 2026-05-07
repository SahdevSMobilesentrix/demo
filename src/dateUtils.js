// Date utility — IST wall clock for logging.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Current moment as a Date object adjusted to represent IST wall-clock time. */
export function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}
