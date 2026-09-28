import { VideoStatus, type Video } from '../entities/video.entity';
import type { SignedPartUrls, VideoDetails } from '../videos.types';

/** 201 of `POST /videos` — the upload plan the client follows (plan § API Contracts). */
export class InitiatedUploadResponseDto {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  part_size_bytes: number;
  part_count: number;

  static fromVideo(video: Video): InitiatedUploadResponseDto {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      part_size_bytes: video.part_size_bytes,
      part_count: video.part_count,
    };
  }
}

export class SignedPartUrlDto {
  part_number: number;
  url: string;
}

/** 200 of `GET /videos/:id/upload/part-urls`. */
export class PartUrlsResponseDto {
  parts: SignedPartUrlDto[];
  expires_in_seconds: number;

  static fromSigned(signed: SignedPartUrls): PartUrlsResponseDto {
    return {
      parts: signed.parts,
      expires_in_seconds: signed.expires_in_seconds,
    };
  }
}

/** 202 of `POST /videos/:id/upload/complete`. */
export class CompletedUploadResponseDto {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;

  static fromVideo(video: Video): CompletedUploadResponseDto {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
    };
  }
}

export class VideoMetadataDto {
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
}

/** 200 of `GET /videos/:id` — owner view. */
export class VideoDetailsResponseDto {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  original_file_name: string;
  content_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  metadata: VideoMetadataDto | null;
  has_thumbnail: boolean;
  processing_error: string | null;
  created_at: Date;
  updated_at: Date;

  static fromDetails(details: VideoDetails): VideoDetailsResponseDto {
    return { ...details };
  }
}
