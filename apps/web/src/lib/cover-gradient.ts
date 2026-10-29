/** Deterministic decorative gradient per template (no fake screenshot): the colour
 *  comes from the slug, so the same template always gets the same cover.
 *  Kept in a plain module (not in the client TemplateCard) so server
 *  components such as the template detail page can call it too. */
const COVER_GRADIENTS = [
  'linear-gradient(135deg, #1d4ed8, #7c3aed)',
  'linear-gradient(135deg, #0891b2, #1d4ed8)',
  'linear-gradient(135deg, #db2777, #7c3aed)',
  'linear-gradient(135deg, #059669, #0891b2)',
  'linear-gradient(135deg, #ea580c, #db2777)',
  'linear-gradient(135deg, #6d28d9, #0891b2)',
];

export function coverGradient(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return COVER_GRADIENTS[hash % COVER_GRADIENTS.length]!;
}
