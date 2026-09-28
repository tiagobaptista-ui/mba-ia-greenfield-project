import { randomBytes } from 'node:crypto';

const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const VIDEO_SLUG_LENGTH = 11;

// 248 is the largest multiple of 62 below 256: bytes >= 248 are rejected so every
// character is uniformly distributed (no modulo bias).
const UNBIASED_BYTE_LIMIT = 248;

/**
 * Short, non-enumerable public identifier for the video URL (phase-03-videos/TD-08):
 * 11 base62 characters (~65 bits) from `node:crypto`. Uniqueness is guaranteed by the
 * `videos.slug` unique index plus retry on collision.
 */
export function generateVideoSlug(): string {
  let slug = '';
  while (slug.length < VIDEO_SLUG_LENGTH) {
    for (const byte of randomBytes(VIDEO_SLUG_LENGTH * 2)) {
      if (byte < UNBIASED_BYTE_LIMIT) {
        slug += BASE62_ALPHABET[byte % BASE62_ALPHABET.length];
        if (slug.length === VIDEO_SLUG_LENGTH) break;
      }
    }
  }
  return slug;
}
