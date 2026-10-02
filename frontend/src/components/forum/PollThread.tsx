"use client";

/**
 * A poll post's body: the spot and the question, then — once answered — the
 * whole hand, how everyone answered, and the discussion (#51).
 *
 * Nothing here hides anything. The server sends the spot (`poll_phf`) to a
 * reader who has not answered, and the whole document only to one who has;
 * the comments are invisible to the first reader by policy. This component
 * only asks again after a vote and draws what came back.
 */

import { useCallback, useEffect, useState } from "react";
import { analysisFitsHand } from "../../lib/analysis/share";
import type { DecisionAnalysis, HandAnalysis } from "../../lib/analysis/types";
import { useAuth } from "../../lib/auth";
import { readSharedAnalysis } from "../../lib/db/analysisShare";
import { forumErrorMessage, readCommentsAsMe, readPoll, votePoll } from "../../lib/db/forum";
import { CHOICE_LABEL } from "../../lib/forum/poll";
import { pollReference } from "../../lib/forum/pollReference";
import { AnalysisShareToggle } from "../analysis/AnalysisShareToggle";
import { PollOptionLine, PollReference } from "./PollReference";
import type { ForumComment, PollChoice, PollState } from "../../lib/forum/types";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { ReplayViewer } from "../replayer/ReplayViewer";
import { CommentComposer } from "./CommentComposer";
import { CommentThread } from "./CommentThread";
import { PostDiscussion } from "./PostDiscussion";
import styles from "./forum.module.css";

/** Sizes offered for a bet or raise, as a percentage of the pot. */
const SIZES = [33, 50, 75, 100, 150];

export function PollThread({
  post,
  board,
  slug,
  initial,
  site,
  locked,
}: {
  post: string;
  board: string;
  slug: string;
  /** What an anonymous reader gets, rendered on the server. */
  initial: PollState | null;
  site: string | null;
  locked: boolean;
}) {
  const en = useDict();
  const auth = useAuth();
  const [poll, setPoll] = useState<PollState | null>(initial);
  const [comments, setComments] = useState<ForumComment[] | null>(null);
  const [choice, setChoice] = useState<PollChoice | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A7.1: the hand's shared analysis, as this reader may see it. The database
  // returns it only after the reveal (voted, author or moderator) and only if
  // the author shared it, so this asks whenever the poll is revealed.
  const [analysis, setAnalysis] = useState<HandAnalysis | null>(null);

  const loadComments = useCallback(() => {
    readCommentsAsMe(post, "best").then(setComments, () => setComments([]));
  }, [post]);

  const loadAnalysis = useCallback(() => {
    readSharedAnalysis("post", post).then(setAnalysis, () => setAnalysis(null));
  }, [post]);

  const revealed = poll?.revealed === true;
  useEffect(() => {
    if (revealed) loadAnalysis();
  }, [revealed, loadAnalysis]);

  // The server render is anonymous. A signed-in reader may already have
  // answered (or be the author), so ask again as them.
  useEffect(() => {
    if (!auth.isSignedIn) return;
    let live = true;
    readPoll(post).then(
      (next) => {
        if (!live || !next) return;
        setPoll(next);
        if (next.revealed) loadComments();
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [auth.isSignedIn, post, loadComments]);

  if (!poll) {
    return null;
  }

  async function answer() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      const next = await votePoll(post, choice, choice === "bet" || choice === "raise" ? size : null);
      setPoll(next);
      loadComments();
    } catch (err) {
      setError(forumErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const permalink = (seq: number) => paths.comment(board, post, slug, seq);
  // The polled decision's stored analysis, when the hand's analysis is shared
  // and lines up with the hand on screen.
  const decision =
    analysis && poll.phf && analysisFitsHand(analysis, poll.phf)
      ? (analysis.decisions.find((entry) => entry.actionIndex === poll.stopIndex) ?? null)
      : null;

  if (!poll.revealed) {
    return (
      <section className={`card stack ${styles.poll}`} aria-labelledby="poll-heading">
        <h2 id="poll-heading" className={styles.cardTitle}>
          {en.forum.poll.heading}
        </h2>
        {poll.phf ? (
          <div id="replay" className={styles.replay}>
            <ReplayViewer
              hand={poll.phf}
              site={site}
              // The end of the spot is the decision itself: the document stops
              // right before it, with the board dealt through its street.
              initialPosition={{ kind: "end" }}
            />
          </div>
        ) : (
          <p className="muted">{en.forum.poll.handGone}</p>
        )}
        {poll.hideHeroCards ? <p className="muted">{en.forum.poll.cardsHidden}</p> : null}
        <p>{en.forum.poll.intro(poll.votes)}</p>
        <div className={styles.pollChoices} role="radiogroup" aria-label={en.forum.poll.heading}>
          {poll.options.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={choice === option}
              className={`btn${choice === option ? " btn--primary" : ""}`}
              onClick={() => setChoice(option)}
            >
              {CHOICE_LABEL[option]}
            </button>
          ))}
        </div>
        {choice === "bet" || choice === "raise" ? (
          <div className="stack">
            <span className="muted">{en.forum.poll.size}</span>
            <div className={styles.pollChoices}>
              <button
                type="button"
                className={`btn btn--sm${size === null ? " btn--primary" : ""}`}
                onClick={() => setSize(null)}
              >
                {en.forum.poll.sizeNone}
              </button>
              {SIZES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`btn btn--sm${size === value ? " btn--primary" : ""}`}
                  onClick={() => setSize(value)}
                >
                  {value}%
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          {auth.isSignedIn ? (
            <button type="button" className="btn btn--primary" disabled={!choice || busy || locked} onClick={() => void answer()}>
              {busy ? en.forum.poll.voting : en.forum.poll.vote}
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn(en.forum.poll.signIn)}>
              {en.forum.poll.signIn}
            </button>
          )}
        </div>
        <p className="muted">{en.forum.poll.discussionLocked}</p>
      </section>
    );
  }

  return (
    <>
      <section className={`card stack ${styles.poll}`} aria-labelledby="poll-heading">
        <h2 id="poll-heading" className={styles.cardTitle}>
          {en.forum.poll.results}
        </h2>
        {poll.isAuthor ? <p className="muted">{en.forum.poll.authorNote}</p> : null}
        <PollResults poll={poll} decision={decision} />
        {analysis ? <PollReference decision={decision} /> : null}
        {poll.isAuthor ? (
          <>
            {analysis ? null : <p className="muted">{en.analysis.share.poll.authorHint}</p>}
            <AnalysisShareToggle surface="post" id={post} poll onChange={loadAnalysis} />
          </>
        ) : null}
      </section>
      <PostDiscussion
        hand={poll.phf}
        analysis={analysis}
        site={site}
        anchors={(comments ?? []).flatMap((comment) => (comment.anchor && !comment.deleted && !comment.removed ? [comment.anchor] : []))}
      >
        <section id="comments" className="stack">
          <CommentComposer post={post} locked={locked} />
          {comments ? (
            <CommentThread t={en} post={post} comments={comments} hand={poll.phf} locked={locked} permalink={permalink} />
          ) : null}
        </section>
      </PostDiscussion>
    </>
  );
}

function PollResults({ poll, decision }: { poll: PollState; decision: DecisionAnalysis | null }) {
  const en = useDict();
  // Each answer read against the reference at the polled decision (A7.1).
  const reference = decision && decision.grade !== null ? pollReference(decision, poll.options) : null;
  const action = poll.phf?.actions.find((entry) => entry.index === poll.stopIndex) ?? null;
  const happened: PollChoice | null = action
    ? action.allIn && poll.options.includes("allin")
      ? "allin"
      : (action.type as PollChoice)
    : null;
  const total = Object.values(poll.results ?? {}).reduce((sum, entry) => sum + (entry?.votes ?? 0), 0);

  return (
    <ul className={styles.pollResults}>
      {poll.options.map((option) => {
        const entry = poll.results?.[option];
        const votes = entry?.votes ?? 0;
        const share = total ? Math.round((votes / total) * 100) : 0;
        return (
          <li key={option} className={styles.pollResult}>
            <div className={styles.pollResultHead}>
              <strong>{CHOICE_LABEL[option]}</strong>
              <span className="muted">
                {share}% · {en.forum.poll.votes(votes)}
                {entry?.medianSizePct ? ` · ${en.forum.poll.median(entry.medianSizePct)}` : ""}
              </span>
              {option === happened ? <span className={styles.pollTag}>{en.forum.poll.hero}</span> : null}
              {poll.myVote?.choice === option ? <span className={styles.pollTag}>{en.forum.poll.yours}</span> : null}
            </div>
            <div className={styles.pollBar} aria-hidden="true">
              <span style={{ width: `${share}%` }} />
            </div>
            {reference && decision ? <PollOptionLine decision={decision} reference={reference[option]} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
