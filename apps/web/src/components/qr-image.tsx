'use client';

import { useEffect, useState } from 'react';

/**
 * Renders any QR payload (VietQR string, a gateway pay URL, MoMo's native
 * payload) as a QR image, generated locally in the browser — no external
 * QR service is involved. Renders nothing until the image is ready, so a
 * failed render degrades to the surrounding text instructions.
 */
export function QrImage({ payload, size = 264 }: { payload: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void import('qrcode')
      .then((QR) => QR.toDataURL(payload, { width: size, margin: 1, errorCorrectionLevel: 'M' }))
      .then((url) => { if (live) setSrc(url); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [payload, size]);
  if (!src) return null;
  return <img src={src} alt="QR" width={size} height={size} style={{ maxWidth: '100%', height: 'auto' }} />;
}
