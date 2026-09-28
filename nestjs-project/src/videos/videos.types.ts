import type { VideoMetadata, VideoStatus } from './entities/video.entity';

/** Owner view returned by `GET /videos/:id` (plan § API Contracts). */
export interface VideoDetails {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  original_file_name: string;
  content_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  metadata: VideoMetadata | null;
  has_thumbnail: boolean;
  processing_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SignedPartUrl {
  part_number: number;
  url: string;
}

export interface SignedPartUrls {
  parts: SignedPartUrl[];
  expires_in_seconds: number;
}

export interface UploadedPartInput {
  part_number: number;
  etag: string;
}

/** What the worker extracted from the original (TD-07). */
export interface ProcessedVideoResult {
  duration_seconds: number;
  metadata: VideoMetadata;
  thumbnail_key: string;
}
