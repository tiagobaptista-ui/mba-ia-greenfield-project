import type { VideoMetadata } from '../videos/entities/video.entity';

export interface ProbeResult {
  duration_seconds: number;
  metadata: VideoMetadata;
}

/** Subset of `ffprobe -print_format json -show_format -show_streams` that the service reads. */
export interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    duration?: string;
  }[];
}
