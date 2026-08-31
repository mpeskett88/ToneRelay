import type { ReactNode } from "react";
import type { BlockCategory } from "./catalog";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden className="cat-icon">
      {children}
    </svg>
  );
}

const stroke = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function CategoryIcon({ category }: { category: BlockCategory }) {
  switch (category) {
    case "input":
      return (
        <Svg>
          <path d="M4 12h10M14 12l-3-3M14 12l-3 3" {...stroke} />
          <rect x="16" y="7" width="5" height="10" rx="1" {...stroke} />
        </Svg>
      );
    case "output":
      return (
        <Svg>
          <rect x="3" y="7" width="5" height="10" rx="1" {...stroke} />
          <path d="M8 12h10M15 9l3 3-3 3" {...stroke} />
        </Svg>
      );
    case "wah":
      return (
        <Svg>
          <path d="M5 16c2-8 12-8 14 0" {...stroke} />
          <circle cx="12" cy="9" r="2" {...stroke} />
        </Svg>
      );
    case "volume":
      return (
        <Svg>
          <rect x="5" y="4" width="14" height="16" rx="2" {...stroke} />
          <path d="M12 8v8M9 12h6" {...stroke} />
        </Svg>
      );
    case "drive":
      return (
        <Svg>
          <path d="M4 16c3-9 13-9 16 0" {...stroke} />
          <path d="M7 16h10" {...stroke} />
        </Svg>
      );
    case "amp":
      return (
        <Svg>
          <rect x="4" y="5" width="16" height="14" rx="1.5" {...stroke} />
          <circle cx="12" cy="12" r="3.5" {...stroke} />
        </Svg>
      );
    case "cab":
      return (
        <Svg>
          <rect x="5" y="4" width="14" height="16" rx="1" {...stroke} />
          <circle cx="12" cy="9" r="2.2" {...stroke} />
          <circle cx="12" cy="15" r="2.2" {...stroke} />
        </Svg>
      );
    case "ir":
      return (
        <Svg>
          <path d="M4 12h3l2-5 3 10 2-5h6" {...stroke} />
        </Svg>
      );
    case "modulation":
      return (
        <Svg>
          <path d="M3 12c2-6 4 6 6 0s4 6 6 0 4 6 6 0" {...stroke} />
        </Svg>
      );
    case "delay":
      return (
        <Svg>
          <circle cx="8" cy="12" r="3" {...stroke} />
          <circle cx="16" cy="12" r="3" {...stroke} opacity={0.55} />
        </Svg>
      );
    case "reverb":
      return (
        <Svg>
          <path d="M5 18V8l7-4 7 4v10" {...stroke} />
          <path d="M5 11h14" {...stroke} />
        </Svg>
      );
    case "compression":
      return (
        <Svg>
          <path d="M6 6v12M18 6v12M9 9h6M9 15h6" {...stroke} />
        </Svg>
      );
    case "eq":
      return (
        <Svg>
          <path d="M7 18V8M12 18V5M17 18v-7" {...stroke} />
        </Svg>
      );
    case "filter":
      return (
        <Svg>
          <path d="M4 6h16l-6 7v6l-4-2v-4z" {...stroke} />
        </Svg>
      );
    case "split":
      return (
        <Svg>
          <path d="M4 12h8M12 12l7-5M12 12l7 5" {...stroke} />
        </Svg>
      );
    case "merge":
      return (
        <Svg>
          <path d="M20 12h-8M12 12 5 7M12 12 5 17" {...stroke} />
        </Svg>
      );
    default:
      return (
        <Svg>
          <rect x="6" y="6" width="12" height="12" rx="2" {...stroke} />
        </Svg>
      );
  }
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden className="trash-icon">
      <path d="M5 8h14M9 4h6M8 8v11a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8" {...stroke} />
      <path d="M10 11v5M14 11v5" {...stroke} />
    </svg>
  );
}

export function GraphIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden className="graph-icon">
      <path d="M4 18h16M4 6v12" {...stroke} />
      <path d="M6 14c2-6 4-2 6-6s4 2 6-4" {...stroke} />
    </svg>
  );
}
