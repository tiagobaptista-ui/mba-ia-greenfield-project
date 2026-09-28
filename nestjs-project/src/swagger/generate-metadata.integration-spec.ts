import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePluginMetadata, METADATA_FILENAME } from './generate-metadata';

describe('generatePluginMetadata (integration — real TypeScript program)', () => {
  let outputDir: string;

  beforeAll(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'swagger-metadata-'));
    generatePluginMetadata(outputDir);
  }, 60_000);

  afterAll(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('keeps the committed src/metadata.ts in sync with the DTOs (run `npm run openapi:metadata`)', () => {
    const fresh = readFileSync(join(outputDir, METADATA_FILENAME), 'utf-8');
    const committed = readFileSync(
      join(__dirname, '..', METADATA_FILENAME),
      'utf-8',
    );

    expect(committed).toBe(fresh);
  });

  it('emits CommonJS-loadable references only', () => {
    const fresh = readFileSync(join(outputDir, METADATA_FILENAME), 'utf-8');

    expect(fresh).not.toMatch(/\bimport\(/);
    expect(fresh).not.toMatch(/\]\.Object\b/);
    expect(fresh).toContain('require("./videos/dto/create-video.dto")');
  });
});
