/**
 * Tutorial videos for the help center (guide-plan.md, Option B).
 *
 * This file is the single place that lists the videos shown on
 * `/{locale}/help/videos`. To publish a video: upload it to the webmaket
 * YouTube channel (metadata in ~/workspace/video/youtube-meta.md), then fill
 * in its `youtubeId` below — that is the only change needed; the page renders
 * the youtube-nocookie embed for entries with an id and a graceful
 * "video đang được cập nhật" placeholder for entries whose id is still empty,
 * so the page is safe to deploy before the ids land.
 *
 * Titles and descriptions live in the i18n locale files (both vi and en)
 * under the `titleKey` / `descriptionKey` keys, so the page stays fully
 * translated like the rest of the help center.
 */
export interface GuideVideo {
  /** Stable slug, also used for the card anchor (`#video-<slug>`). */
  slug: string;
  /** Playlist order (Phần 1 → 7 in "Hướng dẫn sử dụng webmaket"). */
  part: number;
  /** YouTube video id; empty until the video is uploaded. */
  youtubeId: string;
  titleKey: string;
  descriptionKey: string;
}

export const GUIDE_VIDEOS: GuideVideo[] = [
  {
    slug: 'tim-mau-va-xem-demo',
    part: 1,
    youtubeId: 'g51_7vB02Mc',
    titleKey: 'ui.help.video.1.title',
    descriptionKey: 'ui.help.video.1.description',
  },
  {
    slug: 'tao-tai-khoan',
    part: 2,
    youtubeId: 'maocvvSvR4I',
    titleKey: 'ui.help.video.2.title',
    descriptionKey: 'ui.help.video.2.description',
  },
  {
    slug: 'chon-goi-va-cau-hinh',
    part: 3,
    youtubeId: '2XFuuoNjVp8',
    titleKey: 'ui.help.video.3.title',
    descriptionKey: 'ui.help.video.3.description',
  },
  {
    slug: 'thanh-toan-vietqr',
    part: 4,
    youtubeId: '6ycZ1IRbGo4',
    titleKey: 'ui.help.video.4.title',
    descriptionKey: 'ui.help.video.4.description',
  },
  {
    slug: 'nhan-web-va-thiet-lap-quan-tri',
    part: 5,
    youtubeId: '9xeXIyZXgYM',
    titleKey: 'ui.help.video.5.title',
    descriptionKey: 'ui.help.video.5.description',
  },
  {
    slug: 'tu-trien-khai',
    part: 6,
    youtubeId: '9frS9OTUo7A',
    titleKey: 'ui.help.video.6.title',
    descriptionKey: 'ui.help.video.6.description',
  },
  {
    slug: 'cai-dat-google-sheet',
    part: 7,
    youtubeId: 'RuaOMAEkbhQ',
    titleKey: 'ui.help.video.7.title',
    descriptionKey: 'ui.help.video.7.description',
  },
];

/** Embed URL for a video id (privacy-enhanced mode, no tracking cookies). */
export function youtubeEmbedUrl(youtubeId: string): string {
  return `https://www.youtube-nocookie.com/embed/${youtubeId}`;
}
