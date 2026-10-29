import { translate } from '@3t/i18n';
import { fetchPublic } from '@/lib/api-server';
import { fetchHelpIndex } from '@/lib/content-server';
import { SITE_NAME, siteBaseUrl } from '@/lib/seo';

/**
 * /llms.txt — a factual map of the store for AI assistants, following the llmstxt.org layout
 * (H1, summary blockquote, link sections, Optional last). Everything here is generated from
 * live store data and existing site copy: category names come from the i18n catalog, help
 * entries from the published help index, and no prices or claims are stated — prices live in
 * the catalog and on each template's page, where they are maintained.
 */
const CATEGORY_LABELS: Record<string, string> = {
  food: translate('vi', 'ui.category.food'),
  beauty: translate('vi', 'ui.category.beauty'),
  realestate: translate('vi', 'ui.category.realestate'),
  business: translate('vi', 'ui.category.business'),
  store: translate('vi', 'ui.category.store'),
  landing: translate('vi', 'ui.category.landing'),
  portfolio: translate('vi', 'ui.category.portfolio'),
  blog: translate('vi', 'ui.category.blog'),
  website: translate('vi', 'ui.category.website'),
};

export async function GET(): Promise<Response> {
  const base = siteBaseUrl();
  const lines: string[] = [
    `# ${SITE_NAME}`,
    '',
    `> ${translate('vi', 'ui.meta.description')}`,
    '',
    'Mỗi mẫu có trang chi tiết với bản demo trực tiếp; người mua chọn tải bộ cài tự host hoặc dùng hosting của nền tảng. Giá của từng mẫu được niêm yết tại trang danh mục và trang chi tiết của mẫu đó.',
    '',
    '## Danh mục mẫu',
    '',
    `- [${translate('vi', 'ui.catalog.title')}](${base}/vi/templates)`,
  ];

  const categories = await fetchPublic<{ code: string }[]>('/categories', 'vi');
  if (categories.ok) {
    for (const category of categories.data) {
      const label = CATEGORY_LABELS[category.code];
      if (label) lines.push(`- [${label}](${base}/vi/templates?category=${category.code})`);
    }
  }

  lines.push('', '## Trang chính', '');
  lines.push(`- [${translate('vi', 'ui.home.meta_title')}](${base}/vi)`);
  lines.push(`- [${translate('vi', 'ui.home.how_it_works')}](${base}/vi/how-it-works)`);
  lines.push(`- [${translate('vi', 'ui.footer.partners')}](${base}/vi/partners)`);
  lines.push(`- [${translate('vi', 'ui.help.title')}](${base}/vi/help)`);
  lines.push(`- [${translate('vi', 'ui.contact.title')}](${base}/vi/contact)`);

  const help = await fetchHelpIndex('vi');
  if (help.ok && help.data.length > 0) {
    lines.push('', `## ${translate('vi', 'ui.help.title')}`, '');
    for (const article of help.data) {
      lines.push(`- [${article.title}](${base}/vi/help/${article.slug})`);
    }
  }

  lines.push('', '## Optional', '');
  lines.push(`- [English catalog](${base}/en/templates)`);
  lines.push(`- [${translate('vi', 'ui.footer.terms')}](${base}/vi/policies/terms)`);
  lines.push(`- [${translate('vi', 'ui.footer.privacy')}](${base}/vi/policies/privacy)`);
  lines.push('');

  return new Response(lines.join('\n'), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
