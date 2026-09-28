import { generateVideoSlug, VIDEO_SLUG_LENGTH } from './slug.util';

describe('generateVideoSlug', () => {
  it('should return 11 base62 characters', () => {
    const slug = generateVideoSlug();

    expect(slug).toHaveLength(VIDEO_SLUG_LENGTH);
    expect(slug).toMatch(/^[0-9A-Za-z]{11}$/);
  });

  it('should produce distinct slugs across many calls', () => {
    const slugs = new Set(
      Array.from({ length: 5000 }, () => generateVideoSlug()),
    );

    expect(slugs.size).toBe(5000);
  });
});
