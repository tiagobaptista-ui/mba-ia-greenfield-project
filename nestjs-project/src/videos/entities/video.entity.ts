import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/**
 * Technical upload/processing lifecycle only (phase-03-videos/TD-10). Editorial
 * publication/visibility is a separate concern introduced by Phase 04.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/** Normalized ffprobe output persisted in `videos.metadata` (phase-03-videos/TD-07). */
export interface VideoMetadata {
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
}

// Postgres returns bigint as string; 10 GiB fits comfortably in Number.MAX_SAFE_INTEGER.
const bigintToNumber: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
export class Video {
  // Set by the application (randomUUID) before the multipart upload is opened,
  // because the id is part of the storage key (phase-03-videos/TD-03, TD-04).
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_file_name: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  size_bytes: number;

  @Column({ type: 'varchar', length: 255 })
  storage_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'integer' })
  part_size_bytes: number;

  @Column({ type: 'integer' })
  part_count: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
