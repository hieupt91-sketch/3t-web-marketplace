/**
 * Server-rendered JSON-LD block (schema.org). Data comes from lib/seo builders fed with real
 * page data only. `<` is escaped so a title can never break out of the script element.
 */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
