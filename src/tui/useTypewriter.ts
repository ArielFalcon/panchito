import { useEffect, useRef, useState } from "react";

const TICK_MS = 16;
const CHARS_PER_TICK = 2;
const MAX_DURATION_MS = 4000;

export function useTypewriter(fullText: string): { displayed: string; isAnimating: boolean } {
  const [revealed, setRevealed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef(0);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!fullText) {
      setRevealed(0);
      return;
    }

    setRevealed(0);
    startRef.current = Date.now();

    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      if (elapsed >= MAX_DURATION_MS) {
        setRevealed(fullText.length);
        return;
      }

      setRevealed((prev) => {
        const next = Math.min(prev + CHARS_PER_TICK, fullText.length);
        if (next >= fullText.length) return next;

        const remaining = fullText.length - next;
        const remainingTime = MAX_DURATION_MS - elapsed;
        const batchSize = Math.max(1, Math.ceil(remaining / (remainingTime / TICK_MS)));
        const delay = Math.max(6, Math.min(TICK_MS, remainingTime / (remaining / Math.max(1, batchSize))));

        timerRef.current = setTimeout(tick, delay);
        return next;
      });
    };

    timerRef.current = setTimeout(tick, 30);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [fullText]);

  return {
    displayed: fullText.slice(0, revealed),
    isAnimating: revealed < fullText.length,
  };
}
