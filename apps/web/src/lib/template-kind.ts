/** Static vs dynamic templates, told apart by the published version's
 *  runtime adapter: dynamic templates run a server runtime (node-http /
 *  next-standalone) and ship with a per-instance admin (CMS); static
 *  templates are plain HTML/CSS/JS with no runtime and no admin. */
export function isDynamicAdapter(adapter: string | null | undefined): boolean {
  return adapter === 'node-http' || adapter === 'next-standalone';
}
