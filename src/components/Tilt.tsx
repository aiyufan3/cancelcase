"use client";

import { useRef, type PointerEvent, type ReactNode } from "react";

/**
 * A flat object that leans a few degrees toward the pointer and settles back when it leaves.
 * Mouse only, and not at all when the visitor asked for reduced motion. Purely decorative: it
 * changes nothing about what the content says or does.
 */
export function Tilt({
  children,
  className = "",
  max = 3.2,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lean = (x: number, y: number) => {
    ref.current?.style.setProperty("--tilt-x", `${x.toFixed(2)}deg`);
    ref.current?.style.setProperty("--tilt-y", `${y.toFixed(2)}deg`);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || !ref.current) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const box = ref.current.getBoundingClientRect();
    const dx = (e.clientX - box.left) / box.width - 0.5;
    const dy = (e.clientY - box.top) / box.height - 0.5;
    lean(-dy * max, dx * max);
  };
  return (
    <div
      ref={ref}
      className={`tilt ${className}`}
      onPointerMove={onMove}
      onPointerLeave={() => lean(0, 0)}
    >
      {children}
    </div>
  );
}
