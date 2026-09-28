// Injection tokens for the two S3 clients (phase-03-videos/TD-03):
// - INTERNAL talks to the storage over the Compose network (S3_ENDPOINT).
// - PUBLIC is only used to sign URLs handed to clients (S3_PUBLIC_ENDPOINT),
//   because SigV4 binds the signature to the host the client will call.
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

export const STORAGE_KEY_PREFIXES = {
  VIDEOS: 'videos/',
  THUMBNAILS: 'thumbnails/',
} as const;

export function videoOriginalKey(videoId: string): string {
  return `${STORAGE_KEY_PREFIXES.VIDEOS}${videoId}/original`;
}

export function videoThumbnailKey(videoId: string): string {
  return `${STORAGE_KEY_PREFIXES.THUMBNAILS}${videoId}.jpg`;
}
