import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  file_name: string;

  /** Declared size in bytes; values above 10 GiB are rejected with VIDEO_TOO_LARGE. */
  @IsInt()
  @Min(1)
  size_bytes: number;

  /** One of video/mp4, video/webm, video/quicktime, video/x-matroska. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  content_type: string;

  /** Defaults to the file name without extension. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title?: string;
}
