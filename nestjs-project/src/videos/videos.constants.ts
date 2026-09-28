// phase-03-videos/TD-13 — declared allowlist (ffprobe in the worker stays the authority).
export const ACCEPTED_VIDEO_FORMATS: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
export const MAX_UPLOAD_PARTS = 10_000; // S3 multipart hard limit
export const MAX_PART_URLS_PER_REQUEST = 100;
export const SLUG_MAX_RETRIES = 5;
export const SLUG_COLUMN = 'slug';
export const DEFAULT_VIDEO_TITLE = 'Untitled video';
export const PROCESSING_ERROR_MAX_LENGTH = 500;
