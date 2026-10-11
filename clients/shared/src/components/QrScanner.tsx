import { useEffect, useRef, useState } from 'react';

/**
 * Full-screen QR scanner for importing configs.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY getUserMedia AND NOT A BARCODE PLUGIN
 *
 * The obvious choice is @capacitor-mlkit/barcode-scanning, and for most apps it would be
 * right. It is wrong for this one: ML Kit's scanner is a Google Play Services module, either
 * bundled (tens of MB) or downloaded on first use. This app's users are on networks where
 * Play Services is frequently unreachable and on devices where it is sometimes absent
 * entirely - so the feature would fail exactly where the app is meant to work, and fail with
 * a Google error message the user cannot act on.
 *
 * The WebView already has a camera and Capacitor already brokers the permission:
 * BridgeWebChromeClient.onPermissionRequest maps a VIDEO_CAPTURE request onto the Android
 * CAMERA runtime permission and launches the system prompt. So this needs no native plugin,
 * no Gradle change, and no Play Services - only the manifest declaration.
 *
 * Swapping to ML Kit later means replacing this one component; nothing else knows how the
 * scan happened.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * How often to decode a frame.
 *
 * Not every frame: decoding is a full-image scan on the JS thread, and at 30fps it would
 * compete with the video preview it is reading from. ~8/s is faster than a human can hold a
 * phone steady and leaves the UI responsive.
 */
const DECODE_INTERVAL_MS = 120;

type Status = 'starting' | 'scanning' | 'denied' | 'unavailable';

export function QrScanner({
  open,
  onResult,
  onClose,
}: {
  open: boolean;
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<Status>('starting');

  /**
   * The success callback, held in a ref so it is NOT an effect dependency.
   *
   * THIS IS THE FIX FOR THE CAMERA FLICKER, and the reason is worth keeping.
   *
   * The lifecycle effect used to list `onResult` in its deps. The prop is an inline arrow in
   * ServersView, so it gets a new identity on every render of that component - and ServersView
   * subscribes to the core status stream, which ticks once a second while connected. So once a
   * second: dep changed -> cleanup -> tracks stopped -> effect re-ran -> getUserMedia again.
   * The camera opened and closed in a loop, which is exactly what it looked like.
   *
   * A ref updated on every render gives the effect the latest callback without ever changing
   * the effect's identity. The effect now depends on `open` alone, which is the only thing
   * that should start or stop a camera.
   */
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });

  useEffect(() => {
    if (!open) return;

    setStatus('starting');

    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    // Offscreen: the preview the user sees is the <video>; this is only a surface to read
    // pixels from, so it never enters the DOM.
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    /**
     * Release the camera.
     *
     * THE MOST IMPORTANT FUNCTION HERE. A MediaStream whose tracks are not stopped keeps the
     * sensor powered and the privacy indicator lit after the sheet is gone - a camera left on
     * behind a closed dialog, in a privacy tool. It must run on every exit path: success,
     * cancel, error, unmount.
     */
    const release = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (stream !== null) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    // Loaded once, before the decode loop starts - see the dynamic import below for why.
    let decode: typeof import('jsqr').default | null = null;

    const tick = () => {
      if (decode === null) return;
      const video = videoRef.current;
      if (!video || context === null || video.readyState !== video.HAVE_ENOUGH_DATA) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      if (canvas.width === 0 || canvas.height === 0) return;

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);

      // dontInvert: a QR is dark-on-light by definition, and letting jsQR also try the
      // inverted interpretation doubles the work of every frame for no real-world gain.
      const found = decode(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      if (found === null || found.data.length === 0) return;

      // Release BEFORE handing the result up: the callback closes the sheet, and a camera
      // still running while the next screen renders is exactly the leak above.
      release();
      stopped = true;
      onResultRef.current(found.data);
    };

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable');
        return;
      }
      try {
        // On demand: the decoder is dead weight in the main bundle for every session that
        // never opens the scanner, and it is wanted before the camera rather than after so
        // the first frames are not dropped while it downloads.
        decode = (await import('jsqr')).default;

        // Capacitor's WebChromeClient turns this into the Android CAMERA permission prompt if
        // it has not been granted yet.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (stopped || !videoRef.current) {
          // The sheet closed while the permission dialog was up.
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setStatus('scanning');
        timer = setInterval(tick, DECODE_INTERVAL_MS);
      } catch (e) {
        // NotAllowedError is a denial; everything else (no camera, in use, insecure origin)
        // is something the user cannot fix from here, so it gets the softer message.
        const denied = e instanceof DOMException && e.name === 'NotAllowedError';
        setStatus(denied ? 'denied' : 'unavailable');
      }
    })();

    return () => {
      stopped = true;
      release();
    };
    // `open` ONLY. Adding anything else here re-opens the camera on unrelated renders - see
    // onResultRef above for what that looked like on device.
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-[60] flex flex-col bg-black"
      role="dialog"
      aria-modal="true"
      aria-label="Scan a QR code"
    >
      <div
        className="shrink-0 flex items-center justify-between px-5 pb-3"
        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
      >
        <span className="text-sm font-bold text-white">Scan QR code</span>
        <button
          onClick={onClose}
          aria-label="Close scanner"
          className="w-8 h-8 rounded-lg bg-brand-surface border border-brand-border text-brand-muted hover:text-white"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
        />

        {status === 'scanning' && (
          // Framing guide. Purely visual - jsQR reads the whole frame, not this box - but
          // people aim at a target, and a centred code decodes faster than a corner one.
          <div className="relative w-64 h-64 rounded-3xl border-2 border-brand-orange/80 shadow-glow-orange" />
        )}

        {status !== 'scanning' && (
          <div className="relative px-8 text-center space-y-2">
            <p className="text-sm font-semibold text-white">
              {status === 'starting' && 'Starting camera…'}
              {status === 'denied' && 'Camera permission denied'}
              {status === 'unavailable' && 'No camera available'}
            </p>
            {status === 'denied' && (
              <p className="text-[11px] text-brand-muted leading-relaxed">
                Allow camera access in Android Settings → Apps → Nexus → Permissions, then try
                again.
              </p>
            )}
          </div>
        )}
      </div>

      <p
        className="shrink-0 px-8 py-4 text-center text-[11px] text-brand-muted"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        Point the camera at a config QR code.
      </p>
    </div>
  );
}
