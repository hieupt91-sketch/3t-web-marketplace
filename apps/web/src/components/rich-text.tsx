import type { ReactNode } from 'react';

/**
 * Render a restricted markdown subset as React nodes. HTML is never interpreted (React escapes
 * all text), so stored content cannot inject scripts (docs/05 RichText: sanitized, no arbitrary script).
 * Supported: # / ## / ### headings, - bullet lists, blank-line paragraphs, **bold**, [text](url).
 */
/**
 * Site-internal hrefs only: a single leading `/` NOT followed by `/` or `\`.
 * `//evil.com`, `///evil.com` and `/\evil.com` are protocol-relative URLs that
 * browsers resolve to another host, so they must be classified (and rel'd) as
 * external — a bare startsWith('/') would let them masquerade as internal and
 * skip the external-link rel (audit UI-LOW-01). Pure + exported for testing.
 */
export function isInternalHref(href: string): boolean {
  return href.startsWith('/') && href[1] !== '/' && href[1] !== '\\';
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Tokenise bold and links; everything else is plain (escaped) text.
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${i}`}>{match[1]}</strong>);
    } else {
      const href = match[3] ?? '';
      // Only http(s) and site-relative links (protocol-relative included, as
      // external); no javascript:/data: URLs.
      const safe = /^https?:\/\//.test(href) || href.startsWith('/');
      nodes.push(safe ? <a key={`${keyPrefix}-l${i}`} href={href} rel={isInternalHref(href) ? undefined : 'noopener noreferrer nofollow'}>{match[2]}</a> : match[2]);
    }
    last = pattern.lastIndex;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function RichText({ body }: { body: string }) {
  const blocks: ReactNode[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(<p key={`p${blocks.length}`}>{renderInline(paragraph.join(' '), `p${blocks.length}`)}</p>);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      const items = list;
      blocks.push(<ul key={`u${blocks.length}`}>{items.map((item, idx) => <li key={idx}>{renderInline(item, `u${blocks.length}-${idx}`)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      const Tag = (['h2', 'h3', 'h4'] as const)[level - 1]!;
      blocks.push(<Tag key={`h${blocks.length}`}>{renderInline(heading[2]!, `h${blocks.length}`)}</Tag>);
    } else if (bullet) {
      flushParagraph();
      list.push(bullet[1]!);
    } else if (line === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return <div className="stack">{blocks}</div>;
}
