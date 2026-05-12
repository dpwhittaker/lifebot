import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Sticky-bottom autoscroll.
 *
 * When `trigger` changes (e.g. content was appended), scroll the element
 * referenced by `ref` to the bottom — but only if the user is currently at
 * or near the bottom. If they've scrolled up to read older content, leave
 * their view alone. As soon as they scroll back into the bottom band (within
 * `threshold` px), auto-scroll re-engages on the next update.
 *
 * The "at-bottom" check runs from a scroll listener so the user's manual
 * scrolls drive `sticky` directly; the autoscroll runs in a layout effect so
 * it reads the post-mutation `scrollHeight` and beats paint.
 */
export function useStickyScrollBottom(
  ref: RefObject<HTMLElement | null>,
  trigger: unknown,
  threshold = 24,
): void {
  const stickyRef = useRef(true);

  // Track at-bottom state from the user's manual scroll events.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
      stickyRef.current = distance <= threshold;
    };
    // Initial value: if there's no overflow yet, treat as sticky.
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref, threshold]);

  // Autoscroll on content change, but only if sticky.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!stickyRef.current) return;
    el.scrollTop = el.scrollHeight;
    // trigger drives this effect; ref/threshold are referenced inside but
    // their identity is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);
}
