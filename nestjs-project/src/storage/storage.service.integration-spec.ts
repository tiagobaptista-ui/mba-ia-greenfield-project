import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { deleteObjectsByPrefix, putToPresignedUrl } from '../test/storage';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const TEST_PREFIX = 'storage-spec/';
const FIVE_MIB = 5 * 1024 * 1024;

describe('StorageService (integration — real MinIO)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
  });

  afterEach(async () => {
    await deleteObjectsByPrefix(TEST_PREFIX);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const newKey = (): string => `${TEST_PREFIX}${randomUUID()}`;

  it('should assemble an object from 2 parts uploaded to presigned URLs and report its exact size', async () => {
    const key = newKey();
    const part1 = randomBytes(FIVE_MIB);
    const part2 = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const etag1 = await putToPresignedUrl(
      await storage.presignUploadPart(key, uploadId, 1),
      part1,
    );
    const etag2 = await putToPresignedUrl(
      await storage.presignUploadPart(key, uploadId, 2),
      part2,
    );
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etag2 },
      { partNumber: 1, etag: etag1 },
    ]);

    expect(await storage.headObjectSize(key)).toBe(part1.length + part2.length);
  });

  it('should serve a presigned GET with Range as 206 Partial Content', async () => {
    const key = newKey();
    const body = randomBytes(4096);
    await storage.putObject(key, body, 'application/octet-stream');

    const res = await fetch(await storage.presignGetObject(key), {
      headers: { Range: 'bytes=0-99' },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-99/${body.length}`);
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.length).toBe(100);
    expect(received.equals(body.subarray(0, 100))).toBe(true);
  });

  it('should force an attachment download with the given file name', async () => {
    const key = newKey();
    await storage.putObject(key, randomBytes(512), 'video/mp4');

    const res = await fetch(
      await storage.presignGetObject(key, {
        downloadFileName: 'meu-video.mp4',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="meu-video.mp4"',
    );
  });

  it('should invalidate the upload id after aborting a multipart upload', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const partUrl = await storage.presignUploadPart(key, uploadId, 1);

    await storage.abortMultipartUpload(key, uploadId);

    const res = await fetch(partUrl, {
      method: 'PUT',
      body: randomBytes(1024),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('NoSuchUpload');
  });

  it('should delete an object', async () => {
    const key = newKey();
    await storage.putObject(key, randomBytes(128), 'image/jpeg');

    await storage.deleteObject(key);

    await expect(storage.headObjectSize(key)).rejects.toThrow();
  });
});

describe('StorageService — endpoint used for signing', () => {
  it('should sign client URLs for S3_PUBLIC_ENDPOINT and server URLs for S3_ENDPOINT', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue({
        ...storageConfig(),
        endpoint: 'http://minio-internal.test:9000',
        publicEndpoint: 'http://media.public.test:9000',
      })
      .compile();
    const storage = moduleRef.get(StorageService);

    const publicUrl = new URL(await storage.presignGetObject('videos/x'));
    const partUrl = new URL(
      await storage.presignUploadPart('videos/x', 'u', 1),
    );
    const internalUrl = new URL(
      await storage.presignInternalGetObject('videos/x'),
    );

    expect(publicUrl.host).toBe('media.public.test:9000');
    expect(partUrl.host).toBe('media.public.test:9000');
    expect(internalUrl.host).toBe('minio-internal.test:9000');
    await moduleRef.close();
  });
});
