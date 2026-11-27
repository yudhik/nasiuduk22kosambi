import { useEffect, useId, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, X } from 'lucide-react';
import type { Html5Qrcode } from 'html5-qrcode';

interface VoucherScannerModalProps {
  open: boolean;
  onClose: () => void;
  onDetected: (code: string) => void;
}

/**
 * Cross-browser QR & CODE128 Barcode scanner (lazy-loaded `html5-qrcode`)
 * with live camera on HTTPS/localhost and native photo-capture fallback for plain-HTTP LAN.
 */
export function VoucherScannerModal({ open, onClose, onDetected }: VoucherScannerModalProps) {
  const rawId = useId();
  const readerId = `voucher-qr-reader-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const runningRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  const onCloseRef = useRef(onClose);
  onDetectedRef.current = onDetected;
  onCloseRef.current = onClose;

  const [statusMsg, setStatusMsg] = useState('Menyiapkan kamera...');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [decodingPhoto, setDecodingPhoto] = useState(false);

  const stopScannerSafely = async () => {
    const inst = scannerRef.current;
    if (!inst) return;
    if (runningRef.current) {
      runningRef.current = false;
      try {
        await inst.stop();
      } catch {
        // ignore stop errors when camera was never started
      }
    }
    try {
      inst.clear();
    } catch {
      // ignore clear errors
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const startCamera = async () => {
      setCameraError(null);
      setStatusMsg('Menyiapkan kamera...');

      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError(
          'Kamera live memerlukan HTTPS (atau localhost). Di jaringan LAN HTTP, tekan tombol "Ambil Foto QR / Barcode" di bawah untuk membuka kamera HP.'
        );
        setStatusMsg('Gunakan tombol Ambil Foto di bawah atau ketik kode manual.');
        return;
      }

      try {
        const { Html5Qrcode: Html5QrcodeCtor, Html5QrcodeSupportedFormats } = await import(
          'html5-qrcode'
        );
        if (cancelled) return;

        const scanner = new Html5QrcodeCtor(readerId, {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
          ],
          verbose: false,
        });
        scannerRef.current = scanner;

        const config = {
          fps: 10,
          qrbox: { width: 220, height: 180 },
          aspectRatio: 4 / 3,
        };

        const handleSuccess = (decodedText: string) => {
          const clean = decodedText.trim();
          if (!clean || cancelled) return;
          cancelled = true;
          void stopScannerSafely().finally(() => {
            onDetectedRef.current(clean.toUpperCase());
            onCloseRef.current();
          });
        };

        // Prefer rear camera on mobile; fallback to any available webcam on desktop
        try {
          await scanner.start({ facingMode: 'environment' }, config, handleSuccess, () => {});
        } catch {
          if (cancelled) return;
          const cameras = await Html5QrcodeCtor.getCameras();
          if (cancelled) return;
          if (!cameras.length) {
            throw new Error('Tidak ada kamera yang terdeteksi pada perangkat ini.');
          }
          await scanner.start(cameras[0].id, config, handleSuccess, () => {});
        }

        if (cancelled) {
          runningRef.current = true;
          await stopScannerSafely();
          return;
        }
        runningRef.current = true;
        setStatusMsg('Arahkan kamera ke QR / Barcode voucher...');
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setCameraError(
            msg.includes('Permission') || msg.includes('NotAllowed')
              ? 'Izin kamera ditolak. Izinkan akses kamera di browser atau gunakan "Ambil Foto QR / Barcode" di bawah.'
              : `Gagal membuka kamera: ${msg}`
          );
          setStatusMsg('Coba tombol Ambil Foto di bawah atau ketik kode manual.');
        }
      }
    };

    void startCamera();

    return () => {
      cancelled = true;
      void stopScannerSafely();
      scannerRef.current = null;
    };
  }, [open, readerId]);

  const handlePhotoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      setDecodingPhoto(true);
      setStatusMsg('Memindai foto voucher...');
      await stopScannerSafely();

      const { Html5Qrcode: Html5QrcodeCtor, Html5QrcodeSupportedFormats } = await import(
        'html5-qrcode'
      );
      const photoScanner = new Html5QrcodeCtor(readerId, {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.CODE_128,
        ],
        verbose: false,
      });
      scannerRef.current = photoScanner;
      const decodedText = await photoScanner.scanFile(file, false);
      const clean = decodedText.trim();
      if (clean) {
        onDetectedRef.current(clean.toUpperCase());
        onCloseRef.current();
      } else {
        setCameraError(
          'Kode QR / Barcode tidak terbaca di foto. Coba lebih dekat & terang, atau ketik manual.'
        );
      }
    } catch {
      setCameraError(
        'Kode QR / Barcode tidak terbaca di foto. Pastikan fokus & cahaya cukup, atau ketik manual.'
      );
      setStatusMsg('Silakan coba lagi atau ketik kode manual.');
    } finally {
      setDecodingPhoto(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
      onClick={() => onCloseRef.current()}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-brand-amber-soft bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-brand-amber-soft px-4 py-3">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-brand-orange" />
            <h3 className="text-sm font-extrabold text-brand-brown">Scan QR / Barcode Voucher</h3>
          </div>
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-brand-brown/70 hover:bg-brand-cream"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          {/* Container always mounted so html5-qrcode can attach for live video OR scanFile */}
          <div
            id={readerId}
            className={`w-full overflow-hidden rounded-xl bg-black ${
              cameraError ? 'hidden' : 'min-h-[220px]'
            }`}
          />

          {cameraError && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              {cameraError}
            </div>
          )}

          <p className="text-center text-xs font-medium text-brand-brown/75">{statusMsg}</p>

          <label
            className={`flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-brand-amber bg-brand-cream text-xs font-bold text-brand-brown hover:bg-brand-cream-deep ${
              decodingPhoto ? 'pointer-events-none opacity-60' : ''
            }`}
          >
            <ImageIcon className="h-4 w-4 text-brand-orange" />
            <span>{decodingPhoto ? 'Memindai Foto...' : 'Ambil Foto QR / Barcode'}</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              disabled={decodingPhoto}
              onChange={(e) => void handlePhotoCapture(e)}
              className="hidden"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
