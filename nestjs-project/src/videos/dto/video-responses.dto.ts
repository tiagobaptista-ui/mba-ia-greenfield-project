import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus, type Video } from '../entities/video.entity';
import type { SignedPartUrls, VideoDetails } from '../videos.types';

const VIDEO_ID_EXAMPLE = '5b0c8a4e-6f7d-4a53-9b1e-2f4f0d6a9c11';
const SLUG_EXAMPLE = 'aZ3kP9xQ2mB';

/** 201 of `POST /videos` — the upload plan the client follows (plan § API Contracts). */
export class InitiatedUploadResponseDto {
  @ApiProperty({ format: 'uuid', example: VIDEO_ID_EXAMPLE })
  id: string;

  @ApiProperty({
    description: 'Unique URL identifier (11-char base62)',
    example: SLUG_EXAMPLE,
  })
  slug: string;

  @ApiProperty({ example: 'minha-viagem' })
  title: string;

  @ApiProperty({
    enum: VideoStatus,
    enumName: 'VideoStatus',
    example: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @ApiProperty({
    description: 'Every part but the last has exactly this size',
    example: 67108864,
  })
  part_size_bytes: number;

  @ApiProperty({ example: 3 })
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
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    format: 'uri',
    description:
      'Presigned UploadPart URL — PUT the part bytes and keep the ETag',
  })
  url: string;
}

/** 200 of `GET /videos/:id/upload/part-urls`. */
export class PartUrlsResponseDto {
  @ApiProperty({ type: [SignedPartUrlDto] })
  parts: SignedPartUrlDto[];

  @ApiProperty({ example: 3600 })
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
  @ApiProperty({ format: 'uuid', example: VIDEO_ID_EXAMPLE })
  id: string;

  @ApiProperty({ example: SLUG_EXAMPLE })
  slug: string;

  @ApiProperty({ example: 'minha-viagem' })
  title: string;

  @ApiProperty({
    enum: VideoStatus,
    enumName: 'VideoStatus',
    example: VideoStatus.PROCESSING,
  })
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

/** Extracted by ffprobe in the worker (phase-03-videos/TD-07). */
export class VideoMetadataDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  container: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 29.97 })
  fps: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Bits per second',
    example: 4500000,
  })
  bitrate: number | null;
}

/** 200 of `GET /videos/:id` — owner view. */
export class VideoDetailsResponseDto {
  @ApiProperty({ format: 'uuid', example: VIDEO_ID_EXAMPLE })
  id: string;

  @ApiProperty({ example: SLUG_EXAMPLE })
  slug: string;

  @ApiProperty({ example: 'minha-viagem' })
  title: string;

  @ApiProperty({
    enum: VideoStatus,
    enumName: 'VideoStatus',
    example: VideoStatus.READY,
  })
  status: VideoStatus;

  @ApiProperty({ example: 'minha-viagem.mp4' })
  original_file_name: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ example: 137282022 })
  size_bytes: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Set by the worker once the video is ready',
    example: 60,
  })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    description: 'Whether GET /videos/:slug/thumbnail can serve an image',
  })
  has_thumbnail: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Failure reason when status is failed',
    example: null,
  })
  processing_error: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;

  @ApiProperty({ format: 'date-time' })
  updated_at: Date;

  static fromDetails(details: VideoDetails): VideoDetailsResponseDto {
    return { ...details };
  }
}
