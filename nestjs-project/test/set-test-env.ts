// Loaded by Jest before `dotenv/config` (which never overrides already-set variables).
// - QUEUE_PREFIX isolates test jobs from the `video-worker` container, which consumes the
//   default prefix (phase-03-videos/TD-12).
// - S3_PUBLIC_ENDPOINT must be reachable from inside the nestjs-api container, where the
//   tests run and follow presigned URLs (phase-03-videos/TD-03).
process.env.QUEUE_PREFIX = 'streamtube-test';
process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
