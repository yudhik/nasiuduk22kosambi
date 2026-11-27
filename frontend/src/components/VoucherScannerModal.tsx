import { useEffect, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, X } from 'lucide-react';

interface BarcodeDetectorLike {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

interface VoucherScannerModalProps {
  open: boolean;
  onClose: () => void;
  onDetected: (code: string) => void;
}

/**
 * Lightweight zero-dependency QR & CODE128 Barcode scanner using Android Chrome's native
 * `BarcodeDetector` API over `getUserMedia`, with a still-photo fallback for plain-HTTP LAN.
 */
export function VoucherScannerModal({ open, onClose, onDetected }: VoucherScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [statusMsg, setStatusMsg] = useState('Menyiapkan kamera...');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const detectorSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | null = null;

    const startCamera = async () => {
      setCameraError(null);
      if (!detectorSupported) {
        setCameraError(
          'Browser ini belum mendukung pemindai otomatis (BarcodeDetector). Gunakan Android Chrome atau ketik kode voucher secara manual.'
        );
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError(
          'Kamera live memerlukan HTTPS (atau localhost). Untuk uji di LAN HTTP, gunakan tombol "Ambil Foto" di bawah atau ketik kode secara manual.'
        );
        return;
      }
      try {
        setStatusMsg('Arahkan kamera ke QR / Barcode voucher...');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
        const detector = new window.BarcodeDetector!({
          formats: ['qr_code', 'code_128'],
        });
        const scanLoop = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            if (videoRef.current.readyState >= 2) {
              const results = await detector.detect(videoRef.current);
              const raw = results.find((r) => r.rawValue?.trim())?.rawValue?.trim();
              if (raw) {
                cancelled = true;
                onDetected(raw.toUpperCase());
                onClose();
                return;
              }
            }
          } catch {
            // Ignore transient frame decode errors
          }
          timer = window.setTimeout(() => void scanLoop(), 250);
        };
        timer = window.setTimeout(() => void scanLoop(), 300);
      } catch (err) {
        if (!cancelled) {
          setCameraError(
            err instanceof Error
              ? `Gagal membuka kamera: ${err.message}`
              : 'Gagal membuka kamera. Pastikan izin kamera aktif.'
          );
        }
      }
    };

    void startCamera();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [open, detectorSupported, onDetected, onClose]);

  const handlePhotoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !window.BarcodeDetector) return;
    try {
      setStatusMsg('Memindai foto voucher...');
      const bitmap = await createImageBitmap(file);
      const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
      const results = await detector.detect(bitmap);
      bitmap.close();
      const raw = results.find((r) => r.rawValue?.trim())?.rawValue?.trim();
      if (raw) {
        onDetected(raw.toUpperCase());
        onClose();
      } else {
        setCameraError('Kode QR / Barcode tidak terbaca di foto. Coba lebih dekat atau ketik manual.');
      }
    } catch {
      setCameraError('Gagal memindai foto. Silakan ketik kode voucher secara manual.');
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-brand-amber-soft bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-brand-amber-soft px-4 py-3">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-brand-orange" />
            <h3 className="text-sm font-extrabold text-brand-brown">Scan QR / Barcode Voucher</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-brand-brown/70 hover:bg-brand-cream"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {!cameraError ? (
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-full w-full object-cover"
              />
              <div className="pointer-events-none absolute inset-6 rounded-xl border-2 border-dashed border-brand-orange/90" />
            </div>
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              {cameraError}
            </div>
          )}

          <p className="text-center text-xs font-medium text-brand-brown/75">{statusMsg}</p>

          {detectorSupported && (
            <label className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-brand-amber bg-brand-cream text-xs font-bold text-brand-brown hover:bg-brand-cream-deep">
              <ImageIcon className="h-4 w-4 text-brand-orange" />
              <span>Ambil Foto QR / Barcode</span>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => void handlePhotoCapture(e)}
                className="hidden"
              />
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
