import { createHash } from 'node:crypto';

export interface Screenshot {
  viewport: 'desktop' | 'mobile';
  data: Buffer;
  sha256: string;
}

export interface Screenshotter {
  capture(url: string, locale: string): Promise<Screenshot[]>;
  close(): Promise<void>;
}

const VIEWPORTS = [
  { name: 'desktop' as const, width: 1440, height: 900, isMobile: false },
  { name: 'mobile' as const, width: 390, height: 844, isMobile: true },
];

/**
 * Headless Chromium screenshots of the preview origin (docs/03 §5 step 16).
 * Template JS is untrusted: every request except the preview origin itself is aborted and
 * DNS for other hosts fails, so a page cannot reach internal services from the worker host.
 * Production should run this inside the isolated executor rather than on a shared worker.
 */
export async function createChromiumScreenshotter(executablePath: string): Promise<Screenshotter> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-dev-shm-usage', '--no-first-run'] });
  return {
    async capture(url, locale) {
      const origin = new URL(url).origin;
      const shots: Screenshot[] = [];
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: vp.isMobile,
          locale: locale === 'en' ? 'en-US' : 'vi-VN',
          javaScriptEnabled: true,
          serviceWorkers: 'block',
          acceptDownloads: false,
        });
        try {
          await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient')));
          await context.routeWebSocket(/.*/, (ws) => ws.close());
          const page = await context.newPage();
          await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
          await page.waitForTimeout(300);
          const data = await page.screenshot({ type: 'png', fullPage: false, timeout: 10_000 });
          shots.push({ viewport: vp.name, data, sha256: createHash('sha256').update(data).digest('hex') });
        } finally {
          await context.close();
        }
      }
      return shots;
    },
    close: () => browser.close(),
  };
}
