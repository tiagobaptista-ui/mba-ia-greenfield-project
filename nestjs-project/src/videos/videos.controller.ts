import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PartUrlsQueryDto } from './dto/part-urls-query.dto';
import {
  CompletedUploadResponseDto,
  InitiatedUploadResponseDto,
  PartUrlsResponseDto,
  VideoDetailsResponseDto,
} from './dto/video-responses.dto';
import { OWNER_READ_THROTTLE } from './videos.constants';
import { VideosService } from './videos.service';

const errorEnvelope = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel and opens an S3 multipart upload. ' +
      'The client then uploads each part directly to the object storage using presigned URLs — the file never passes through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created with its upload plan',
    type: InitiatedUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR, UNSUPPORTED_VIDEO_FORMAT (mp4, webm, mov, mkv only) or VIDEO_TOO_LARGE (> 10 GiB)',
    schema: errorEnvelope,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiatedUploadResponseDto> {
    return InitiatedUploadResponseDto.fromVideo(
      await this.videosService.initiateUpload(user.sub, dto),
    );
  }

  @Get(':id/upload/part-urls')
  @Throttle(OWNER_READ_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign part upload URLs',
    description:
      'Returns presigned UploadPart URLs (up to 100 per call). The client PUTs each part to its URL and keeps the returned ETag.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR or INVALID_PART_NUMBER',
    schema: errorEnvelope,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ACCESS_DENIED',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE — the video is not a draft',
    schema: errorEnvelope,
  })
  async signPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PartUrlsQueryDto,
  ): Promise<PartUrlsResponseDto> {
    return PartUrlsResponseDto.fromSigned(
      await this.videosService.signPartUrls(user.sub, id, query.part_numbers),
    );
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload, checks the real object size and enqueues the background processing (duration, metadata, thumbnail).',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing enqueued',
    type: CompletedUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR, INVALID_UPLOAD_PARTS or UPLOAD_SIZE_MISMATCH (video marked failed)',
    schema: errorEnvelope,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ACCESS_DENIED',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE — the video is not a draft',
    schema: errorEnvelope,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompletedUploadResponseDto> {
    return CompletedUploadResponseDto.fromVideo(
      await this.videosService.completeUpload(user.sub, id, dto.parts),
    );
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart upload in progress and removes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted, draft removed' })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR',
    schema: errorEnvelope,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ACCESS_DENIED',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE — the video is not a draft',
    schema: errorEnvelope,
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, id);
  }

  @Get(':id')
  @Throttle(OWNER_READ_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get an owned video',
    description:
      'Returns the upload/processing status and the extracted metadata of a video owned by the caller.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    type: VideoDetailsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR',
    schema: errorEnvelope,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ACCESS_DENIED',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  async getOwnedVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoDetailsResponseDto> {
    return VideoDetailsResponseDto.fromDetails(
      await this.videosService.getOwnedVideo(user.sub, id),
    );
  }
}
