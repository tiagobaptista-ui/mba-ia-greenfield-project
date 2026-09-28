import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

interface EnvValidationResult {
  error?: ValidationError;
  value: {
    SWAGGER_ENABLED?: string;
    S3_ENDPOINT?: string;
    S3_BUCKET?: string;
    S3_PRESIGN_EXPIRES_SECONDS?: number;
    UPLOAD_PART_SIZE_BYTES?: number;
    REDIS_HOST?: string;
    REDIS_PORT?: number;
    QUEUE_PREFIX?: string;
  };
}

const validate = (
  env: Record<string, string>,
  base: Record<string, string> = requiredEnv,
): EnvValidationResult =>
  envValidationSchema.validate(
    { ...base, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue keys', () => {
  it('should reject a missing S3_ACCESS_KEY, citing the key', () => {
    const withoutAccessKey = { ...requiredEnv } as Record<string, string>;
    delete withoutAccessKey.S3_ACCESS_KEY;

    const { error } = validate({}, withoutAccessKey);

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY');
  });

  it('should reject a missing S3_SECRET_KEY, citing the key', () => {
    const withoutSecretKey = { ...requiredEnv } as Record<string, string>;
    delete withoutSecretKey.S3_SECRET_KEY;

    const { error } = validate({}, withoutSecretKey);

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should apply defaults for the optional storage and queue keys', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_BUCKET).toBe('streamtube-media');
    expect(value.S3_PRESIGN_EXPIRES_SECONDS).toBe(3600);
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(64 * 1024 * 1024);
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_PREFIX).toBe('streamtube');
  });

  it('should reject UPLOAD_PART_SIZE_BYTES below the 5 MiB S3 multipart minimum', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: String(1024 * 1024) });

    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });
});
