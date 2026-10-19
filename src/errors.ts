/** A user-facing error (bad input, missing file, failed validation). */
export class ReviewError extends Error {
  override name = 'ReviewError';
}
