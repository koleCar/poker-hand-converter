import { useEffect, useMemo, useState } from "react";
import { ShareHandButton } from "../components/share/ShareHandButton";
import { formatPlayedAt, formatStakes, shortGameName, topWinnerOf } from "../components/share/preview";
import { resolveShare } from "../components/share/shareClient";
import type { ResolveShareResult } from "../components/share/shareContract";
import { BrandMark } from "../components/shell/BrandMark";
import { PlayingCard } from "../components/replayer/PlayingCard";
import { ReplayViewer } from "../components/replayer/ReplayViewer";
import { formatMoney } from "../lib/format";
import { parseHand, type ParsedHand } from "../lib/handParser";
import { Link } from "./router";
import { paths, sharedHandUrl } from "./routes";
import { useDocumentMeta } from "./useDocumentMeta";

interface SharedHandPageProps {
  slug: string;
}

type PageState =
  | { kind: "loading" }
  | { kind: "ready"; hand: ParsedHand; createdAt: string | null; views: number }
  | { kind: "unparseable" }
  | { kind: "not-found" }
  | { kind: "gone" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string };

function toPageState(result: ResolveShareResult): PageState {
  switch (result.status) {
    case "ok": {
      const hand = parseHand(result.share.handText);
      return hand
        ? {
            kind: "ready",
            hand,
            createdAt: result.share.createdAt,
            views: result.share.views,
          }
        : { kind: "unparseable" };
    }
    case "not-found":
      return { kind: "not-found" };
    case "gone":
      return { kind: "gone" };
    case "unconfigured":
      return { kind: "unconfigured" };
    default:
      return { kind: "error", message: result.message };
  }
}

const LOADING: PageState = { kind: "loading" };

export function SharedHandPage({ slug }: SharedHandPageProps) {
  // Keyed by slug rather than reset inside the effect, so navigating between
  // two shares never shows the previous hand for a frame.
  const [resolved, setResolved] = useState<{ slug: string; state: PageState } | null>(null);
  const state = resolved?.slug === slug ? resolved.state : LOADING;

  useEffect(() => {
    let cancelled = false;
    void resolveShare(slug).then((result) => {
      if (!cancelled) {
        setResolved({ slug, state: toPageState(result) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const hand = state.kind === "ready" ? state.hand : null;

  const meta = useMemo(() => {
    if (!hand) {
      return {
        title: "Shared poker hand | PokerConverter",
        description:
          "Replay a shared poker hand action by action, free and without an account, on PokerConverter.",
      };
    }
    const stakes = formatStakes(hand);
    const game = shortGameName(hand.gameLabel);
    const top = topWinnerOf(hand.winners);
    return {
      title: `${stakes} ${game} — ${formatMoney(hand.currency, hand.totalPot)} pot | PokerConverter`,
      description: [
        `${hand.seats.length}-handed ${stakes} ${game}`,
        hand.board.length ? `board ${hand.board.join(" ")}` : "no flop",
        top ? `${top.player} wins ${formatMoney(hand.currency, top.amount)}` : null,
        "Replay it action by action on PokerConverter.",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }, [hand]);

  useDocumentMeta({
    title: meta.title,
    description: meta.description,
    canonicalPath: paths.sharedHand(slug),
    noIndex: !hand,
  });

  return (
    <div className="sharepage">
      <header className="sharepage__bar">
        <div className="sharepage__bar-inner">
          <BrandMark showTagline={false} />
          <div className="sharepage__bar-actions">
            <Link to={paths.replayer()} className="sharepage__bar-link">
              Replay your own hands
            </Link>
            <Link to={paths.converter()} className="btn btn--primary btn--sm">
              Open the app
            </Link>
          </div>
        </div>
      </header>

      <main className="sharepage__main">
        {state.kind === "loading" ? <SharedHandSkeleton /> : null}

        {state.kind === "ready" ? (
          <SharedHandContent
            hand={state.hand}
            createdAt={state.createdAt}
            views={state.views}
            slug={slug}
          />
        ) : null}

        {state.kind !== "loading" && state.kind !== "ready" ? (
          <SharedHandProblem state={state} />
        ) : null}
      </main>

      <footer className="sharepage__footer">
        <p>
          <strong>PokerConverter</strong> — convert hand histories from any poker room and replay
          any hand in your browser.
        </p>
        <Link to={paths.converter()} className="btn btn--sm">
          Try it free
        </Link>
      </footer>
    </div>
  );
}

/* --------------------------------------------------------------- content */

function SharedHandContent({
  hand,
  createdAt,
  views,
  slug,
}: {
  hand: ParsedHand;
  createdAt: string | null;
  views: number;
  slug: string;
}) {
  const playedAt = formatPlayedAt(hand.playedAt);
  const sharedAt = formatPlayedAt(createdAt);
  const top = topWinnerOf(hand.winners);

  return (
    <>
      <section className="sharepage__hero">
        <div className="sharepage__hero-main">
          <p className="sharepage__eyebrow">Shared hand</p>
          <h1 className="sharepage__title">
            {formatStakes(hand)} {shortGameName(hand.gameLabel)}
          </h1>
          <ul className="sharepage__facts">
            <li>
              <span>Pot</span>
              <strong>{formatMoney(hand.currency, hand.totalPot)}</strong>
            </li>
            <li>
              <span>Players</span>
              <strong>{hand.seats.length}-handed</strong>
            </li>
            <li>
              <span>Game</span>
              <strong>{hand.gameType === "cash" ? "Cash game" : "Tournament"}</strong>
            </li>
            {playedAt ? (
              <li>
                <span>Played</span>
                <strong>{playedAt}</strong>
              </li>
            ) : null}
            {hand.tableName ? (
              <li>
                <span>Table</span>
                <strong>{hand.tableName}</strong>
              </li>
            ) : null}
            {top ? (
              <li>
                <span>Winner</span>
                <strong>
                  {top.player} · {formatMoney(hand.currency, top.amount)}
                </strong>
              </li>
            ) : null}
          </ul>
        </div>

        <div className="sharepage__hero-board">
          <span className="sharepage__board-label">
            {hand.board.length ? "Board" : "No flop — decided preflop"}
          </span>
          {hand.board.length ? (
            <div className="sharepage__board">
              {hand.board.map((card, index) => (
                <PlayingCard key={`${card}-${index}`} code={card} size="sm" />
              ))}
            </div>
          ) : null}
          <div className="sharepage__hero-actions">
            {/* The link already exists — copy it, do not mint a second share. */}
            <ShareHandButton hand={hand} label="Copy link" presetUrl={sharedHandUrl(slug)} />
          </div>
        </div>
      </section>

      <section className="sharepage__replay">
        <ReplayViewer hand={hand} />
      </section>

      <section className="sharepage__cta">
        <div>
          <h2>Replay and convert your own hands</h2>
          <p>
            Drop in a hand history from any poker room and get a shareable replay like this one.
            Free, in the browser, no account.
          </p>
        </div>
        <div className="sharepage__cta-actions">
          <Link to={paths.replayer()} className="btn btn--primary">
            Open the replayer
          </Link>
          <Link to={paths.converter()} className="btn btn--ghost">
            Convert a hand history
          </Link>
        </div>
      </section>

      <p className="sharepage__shared-at">
        {[
          sharedAt ? `Shared ${sharedAt}` : null,
          views > 0 ? `${views.toLocaleString("en-GB")} ${views === 1 ? "view" : "views"}` : null,
          `/h/${slug}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </>
  );
}

function SharedHandSkeleton() {
  return (
    <section className="sharepage__skeleton" aria-busy="true" aria-label="Loading hand">
      <div className="sharepage__skeleton-line sharepage__skeleton-line--title" />
      <div className="sharepage__skeleton-line" />
      <div className="sharepage__skeleton-table" />
    </section>
  );
}

const PROBLEMS: Record<string, { title: string; body: string }> = {
  "not-found": {
    title: "This hand link does not exist",
    body: "The link may have a typo, or the hand was never shared. Check the address and try again.",
  },
  gone: {
    title: "This hand is no longer available",
    body: "The person who shared it deleted the hand, or the link expired.",
  },
  unparseable: {
    title: "This hand could not be replayed",
    body: "The stored hand history is damaged or in a format we cannot read yet.",
  },
  unconfigured: {
    title: "Shared hands are unavailable right now",
    body: "This deployment has no database configured, so shared links cannot be opened. The converter and the uploader still work.",
  },
};

function SharedHandProblem({ state }: { state: PageState }) {
  const copy =
    state.kind === "error"
      ? { title: "Something went wrong loading this hand", body: state.message }
      : (PROBLEMS[state.kind] ?? PROBLEMS["not-found"]);

  return (
    <section className="sharepage__problem">
      <span className="sharepage__problem-mark" aria-hidden="true">
        ♠
      </span>
      <h1>{copy.title}</h1>
      <p>{copy.body}</p>
      <div className="sharepage__problem-actions">
        <Link to={paths.replayer()} className="btn btn--primary">
          Replay your own hand
        </Link>
        <Link to={paths.converter()} className="btn btn--ghost">
          Go to PokerConverter
        </Link>
      </div>
    </section>
  );
}
