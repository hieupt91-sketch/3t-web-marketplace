import { describe, expect, it } from 'vitest';
import { safeRequestPath } from './server.ts';

describe('safeRequestPath', () => {
  it.each([
    ['/', ''],
    ['/details.html?x=1', 'details.html'],
    ['/a/b/', 'a/b/'],
    ['/a/./b.css', 'a/b.css'],
  ])('maps %s', (input, expected) => expect(safeRequestPath(input)).toBe(expected));

  it.each(['/../etc/passwd', '/%2e%2e/secret', '/a/%2e%2e/%2e%2e/x', '/a\\b', '/%00', '/.env', '/x/.git/config', '/%E0%A4%A'])(
    'rejects %s',
    (input) => expect(safeRequestPath(input)).toBeNull(),
  );
});
