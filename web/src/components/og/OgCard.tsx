/**
 * The 1200×630 social card (#55), rendered by `next/og` (Satori): flexbox only,
 * inline styles only, no CSS variables — Satori resolves none of them — so the
 * colours are the dark theme's literal values, picked to match the tokens.
 *
 * What a card may say is decided by its caller, not here. A published hand's
 * card shows the deal and nothing after it (spoilers closed, as the page's
 * meta description already is); a poll's card shows the question and never a
 * card from the hand.
 */

import { railIconDataUri } from "../../lib/brand/markSvg";
import type { Dict } from "../../lib/i18n/types";

const SUIT: Record<string, { glyph: string; color: string }> = {
  s: { glyph: "♠", color: "#18202b" },
  c: { glyph: "♣", color: "#1b6e3c" },
  h: { glyph: "♥", color: "#c62828" },
  d: { glyph: "♦", color: "#1565c0" },
};

function Card({ code }: { code: string }) {
  const rank = code.slice(0, -1).replace("T", "10");
  const suit = SUIT[code.slice(-1).toLowerCase()] ?? { glyph: "?", color: "#18202b" };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: 120,
        height: 168,
        borderRadius: 14,
        background: "#f6f8fb",
        color: suit.color,
        fontSize: 64,
        fontWeight: 700,
        lineHeight: 1,
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
      }}
    >
      <span>{rank}</span>
      <span style={{ fontSize: 52 }}>{suit.glyph}</span>
    </div>
  );
}

export function OgCard({
  eyebrow,
  title,
  facts,
  cards = [],
  badge,
  t: en,
}: {
  eyebrow: string;
  title: string;
  facts: string[];
  cards?: string[];
  badge?: string;
  t: Dict;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "56px 64px",
        background: "linear-gradient(135deg, #0b0f14 0%, #121820 55%, #0f2a20 100%)",
        color: "#e8eef6",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <img src={railIconDataUri()} width={64} height={64} alt="" />
        <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em" }}>{WORDMARK}</span>
        <span style={{ fontSize: 26, color: "#8da0b6", marginLeft: 12 }}>{eyebrow}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 40 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: cards.length ? 720 : 1072 }}>
          {badge ? (
            <span
              style={{
                display: "flex",
                alignSelf: "flex-start",
                padding: "6px 18px",
                borderRadius: 999,
                background: "#3ea6ff",
                color: "#05121f",
                fontSize: 26,
                fontWeight: 700,
              }}
            >
              {badge}
            </span>
          ) : null}
          <span style={{ fontSize: title.length > 60 ? 50 : 62, fontWeight: 700, lineHeight: 1.1 }}>{title}</span>
          <span style={{ fontSize: 30, color: "#adbccd" }}>{facts.filter(Boolean).join("  ·  ")}</span>
        </div>
        {cards.length ? (
          <div style={{ display: "flex", gap: 16 }}>
            {cards.slice(0, 5).map((code) => (
              <Card key={code} code={code} />
            ))}
          </div>
        ) : null}
      </div>

      <span style={{ fontSize: 24, color: "#8da0b6" }}>{en.brand.tagline}</span>
    </div>
  );
}

/** The wordmark: the product name, the same in every language. */
const WORDMARK = "rail";

export const OG_SIZE = { width: 1200, height: 630 };
