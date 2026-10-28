/**
 * Free-text need → category classifier for the homepage template finder.
 * Pure functions (no I/O) so they are unit-testable without a server.
 *
 * Matching is deliberately conservative: keywords are matched whole-word on
 * diacritic-stripped text (so "ban quan ao" matches "bán quần áo"), scores
 * count matched keyword phrases per category, and a tie or zero score
 * returns null so the finder falls back to plain keyword search instead of
 * guessing wrong. An explicit purpose button always wins over inference.
 */
export const FINDER_CATEGORIES = ['landing', 'business', 'food', 'realestate', 'store', 'beauty', 'blog', 'portfolio'] as const;
export type FinderCategory = (typeof FINDER_CATEGORIES)[number];

export function normalizeNeed(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const KEYWORDS: Record<FinderCategory, string[]> = {
  blog: ['tin tuc', 'blog', 'bao', 'bai viet', 'tin', 'tap chi'],
  store: ['ban', 'shop', 'cua hang', 'san pham', 'thoi trang', 'my pham', 'quan ao', 'giay', 'tui', 'dong ho', 'do choi', 'sach', 'gia dung', 'thuc pham', 'me va be', 'the thao', 'dien thoai', 'phu kien'],
  food: ['nha hang', 'quan an', 'cafe', 'ca phe', 'pho', 'com', 'tra sua', 'lau', 'nuong', 'banh mi', 'hai san', 'chay', 'nuoc ep', 'an vat', 'quan'],
  beauty: ['spa', 'salon', 'toc', 'nail', 'mi', 'da', 'trang diem', 'co dau', 'barber', 'phun xam', 'tham my', 'duong sinh', 'waxing'],
  realestate: ['bat dong san', 'nha dat', 'nha', 'can ho', 'chung cu', 'biet thu', 'nha pho', 'dat nen', 'van phong cho thue', 'mat bang', 'moi gioi', 'thue nha'],
  business: ['ke toan', 'thue', 'luat', 'van chuyen', 'giao hang', 'xay dung', 'dao tao', 've sinh', 'bao ve', 'du hoc', 'phong kham', 'sua chua', 'thiet ke'],
  portfolio: ['portfolio', 'nhiep anh', 'freelancer', 'kien truc', 'noi that', 'makeup', 'dau bep', 'giao vien', 'ca si', 'kol', 'anh cuoi', 'illustrator', 'copywriter'],
  landing: ['landing', 'quang cao', 'ra mat', 'su kien', 'khoa hoc', 'webinar', 'ebook', 'dung thu', 'giam gia', 'tuyen dung', 'tu van', 'thanh vien', 'ung dung', 'saas'],
};

export function classifyIntent(text: string): FinderCategory | null {
  const normalized = ` ${normalizeNeed(text)} `;
  let best: FinderCategory | null = null;
  let bestScore = 0;
  let tied = false;
  for (const category of FINDER_CATEGORIES) {
    let score = 0;
    for (const kw of KEYWORDS[category]) if (normalized.includes(` ${kw} `)) score++;
    if (score > bestScore) {
      best = category;
      bestScore = score;
      tied = false;
    } else if (score > 0 && score === bestScore) {
      tied = true;
    }
  }
  return tied || bestScore === 0 ? null : best;
}
