import { useEffect, useRef, type MutableRefObject, type ReactNode } from 'react';

/**
 * Hält den jeweils aktuellen Callback in einem Ref, damit der Öffnen-
 * Effekt nur von `open` abhängt und nicht bei jedem Parent-Render (neue
 * Inline-Callback-Identität) neu läuft und den Fokus zurückschleppen
 * würde. Der Caller liest `ref.current` zur Aufrufzeit -> immer aktuell.
 */
function useLatestCallback<T extends (...args: never[]) => void>(
  cb: T,
): MutableRefObject<T> {
  const ref = useRef(cb);
  useEffect(() => {
    ref.current = cb;
  }, [cb]);
  return ref;
}

/**
 * ConfirmDialog – Wiederverwendbares Bestätigungs-Dialog (Modal):
 * Schützt destruktive Aktionen (z. B. "Attacke löschen") vor versehentlichem
 * Antippen.
 *
 * iOS-Safari-Beachten:
 *  - Buttons mit min-h-11 (44 px) -> sichere Touch-Targets.
 *  - Zentriertes Modal statt Browser-`window.confirm()`: Safari zeigt
 *    native Confirm-Dialogs in PWA-Standalone-Modus teils nicht an oder
 *    blockiert die Interaktion – ein eigenes Modal ist zuverlässiger.
 *  - Fokus-Management: Beim Öffnen bekommt der (sichere) Cancel-Button
 *    den Fokus, beim Schließen wird der vorherige Fokus wiederhergestellt.
 */

export interface ConfirmDialogProps {
  /** true, solange das Dialog sichtbar ist. */
  open: boolean;

  /** Kopfzeile des Dialogs, z. B. "Attacke löschen?". */
  title: string;

  /** Beschreibungstext (kann formatierte Daten enthalten). */
  message: ReactNode;

  /** Beschriftung des Bestätigungs-Buttons. Default "Löschen". */
  confirmLabel?: string;

  /** Beschriftung des Abbruch-Buttons. Default "Abbrechen". */
  cancelLabel?: string;

  /** true, während die Bestätigung asynchron abläuft (Button gesperrt). */
  isPending?: boolean;

  /** Wird auf Tippen auf Bestätigen oder Enter auf dem Confirm-Button aufgerufen. */
  onConfirm: () => void;

  /** Wird auf Tippen auf Abbrechen, Escape oder Klick auf den Hintergrund aufgerufen. */
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Löschen',
  cancelLabel = 'Abbrechen',
  isPending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const latestOnCancel = useLatestCallback(onCancel);
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;

  // Fokus-Management + Escape-Handler + Scroll-Lock, nur wenn geöffnet.
  useEffect(() => {
    if (!open) return;

    // Element merken, das vorher Fokus hatte (z. B. der "Löschen"-Button),
    // damit wir nach dem Schließen dorthin zurückkehren können.
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Sichere Default-Auswahl: Fokus auf "Abbrechen" – versehentliches
    // Enter drückt also nie die destruktive Aktion.
    cancelButtonRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !isPendingRef.current) {
        e.preventDefault();
        latestOnCancel.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    // Hintergrund-Scroll sperren, solange das Modal offen ist.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prevOverflow;
      restoreFocusRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        // Nur Klicks direkt auf die Abdeckung schließen, nicht Klicks,
        // die in der Karte begonnen haben.
        if (e.target === e.currentTarget && !isPending) {
          onCancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
      >
        <h2
          id="confirm-dialog-title"
          className="text-base font-semibold text-gray-900"
        >
          {title}
        </h2>
        <div
          id="confirm-dialog-message"
          className="mt-2 text-sm leading-relaxed text-gray-600"
        >
          {message}
        </div>

        <div className="mt-5 flex gap-3">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="min-h-11 flex-1 rounded-xl border border-gray-300 bg-white
                       text-base font-semibold text-gray-700
                       transition-colors hover:bg-gray-50
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400
                       disabled:cursor-not-allowed disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="flex min-h-11 flex-1 items-center justify-center gap-2
                       rounded-xl bg-rose-600 text-base font-semibold text-white
                       shadow-sm transition-colors hover:bg-rose-700
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400
                       focus-visible:ring-offset-2
                       disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending && (
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              />
            )}
            {isPending ? 'Läuft …' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
