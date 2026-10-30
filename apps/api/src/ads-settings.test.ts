import { describe, expect, it } from 'vitest';
import { isAdUrl, normalizeAdsSettings } from './routes/admin-settings.ts';

describe('side-rail ads settings', () => {
  it('accepts only http(s) or root-relative ad URLs', () => {
    expect(isAdUrl('')).toBe(true);
    expect(isAdUrl('https://cdn.example.com/banner.png')).toBe(true);
    expect(isAdUrl('http://example.com/a.jpg')).toBe(true);
    expect(isAdUrl('/banners/left.png')).toBe(true);
    expect(isAdUrl('//evil.example.com/x.png')).toBe(false);
    expect(isAdUrl('javascript:alert(1)')).toBe(false);
    expect(isAdUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isAdUrl('banner.png')).toBe(false);
    expect(isAdUrl('/banners/a b.png')).toBe(false);
  });

  it('normalizes missing or malformed stored values to a disabled, empty config', () => {
    const empty = { enabled: false, left: { image_url: '', link_url: '', alt: '' }, right: { image_url: '', link_url: '', alt: '' } };
    expect(normalizeAdsSettings(null)).toEqual(empty);
    expect(normalizeAdsSettings('junk')).toEqual(empty);
    expect(normalizeAdsSettings({ enabled: 'yes', left: { image_url: 42 } })).toEqual(empty);
  });

  it('keeps a well-formed config and trims values', () => {
    const out = normalizeAdsSettings({
      enabled: true,
      left: { image_url: ' https://cdn.example.com/l.png ', link_url: 'https://example.com', alt: ' Ad ' },
      right: { image_url: '', link_url: '', alt: '' },
    });
    expect(out.enabled).toBe(true);
    expect(out.left).toEqual({ image_url: 'https://cdn.example.com/l.png', link_url: 'https://example.com', alt: 'Ad' });
    expect(out.right.image_url).toBe('');
  });
});
