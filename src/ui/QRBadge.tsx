import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

type Props = {
  /** URL to encode. Defaults to `window.location.href`. */
  url?: string;
  /** Pixels per QR module. 2 = each bit is a 2x2 pixel square; the smallest
   *  size that still scans on most phones. */
  scale?: number;
};

/**
 * Small QR code shown in the app header so the user can re-pair the PWA
 * with the Even Hub WebView (scan from another device) without having
 * to regenerate it from the CLI. Encodes the current page URL by default.
 * Image renders at its native pixel size (modules * scale) — no CSS resize.
 */
export function QRBadge({ url, scale = 2 }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const target = url ?? window.location.href;
    let cancelled = false;
    QRCode.toDataURL(target, {
      margin: 0,
      scale,
      color: { dark: '#ffffff', light: '#00000000' },
    })
      .then((u) => {
        if (!cancelled) setDataUrl(u);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url, scale]);

  if (!dataUrl) return null;
  return (
    <img
      className="qr-badge"
      src={dataUrl}
      alt="QR code to load LifeBot"
      title="Scan in Even Hub app to load LifeBot on G2 glasses"
    />
  );
}
