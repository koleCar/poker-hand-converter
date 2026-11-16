"use client";

/**
 * The post preview: the post's settings on the left, the post as readers will
 * see it on the right, updated as the settings change. Opened in a new tab by
 * "Post to the forum" in the share popover.
 *
 * Nothing is public until Post. Then, as before: a hand not in the library is
 * saved, `publish_hand` scrubs it in SQL in the chosen names mode, and
 * `create_post` / `create_poll_post` opens the thread. The preview's own copy
 * of the hand (`previewScrub`, `previewPoll`) is display only.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AnalysisShareToggle } from "../../../components/analysis/AnalysisShareToggle";
import { PostDiscussion } from "../../../components/forum/PostDiscussion";
import { PostText } from "../../../components/forum/PostText";
import { HandSummary } from "../../../components/hand/HandSummary";
import { formatStakes } from "../../../components/share/preview";
import { AppFrame } from "../../../components/shell/AppFrame";
import { BusyLabel } from "../../../components/shell/BusyLabel";
import type { HandAnalysis } from "../../../lib/analysis/types";
import { useAuth } from "../../../lib/auth";
import { getHand, saveHand } from "../../../lib/db";
import { fetchHandAnalysis } from "../../../lib/db/analysis";
import { createPollPost, createPost, forumErrorMessage, listOpenBoards } from "../../../lib/db/forum";
import { publishErrorMessage, publishHand, type PublishMode } from "../../../lib/db/publishing";
import { CHOICE_LABEL, pollSpots } from "../../../lib/forum/poll";
import { dropPostDraft, previewPoll, previewScrub, readPostDraft } from "../../../lib/forum/postPreview";
import type { BoardRef } from "../../../lib/forum/types";
import { useDict } from "../../../lib/i18n/client";
import { toStandardText } from "../../../lib/phf";
import type { PhfHand } from "../../../lib/phf/types";
import { useMyProfile } from "../../../lib/profile/context";
import { paths } from "../../../lib/routes";
import { ReplayViewer } from "@rail/ui/replayer/ReplayViewer";
import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import forum from "../../../components/forum/forum.module.css";
import styles from "./PostPreview.module.css";

const MODES: PublishMode[] = ["pseudonyms", "positions", "as-imported"];

export function PostPreviewScreen({ handId, draftId }: { handId: string | null; draftId: string | null }) {
  return (
    <AppFrame tab="forum" wide>
      {() => <PostPreview handId={handId} draftId={draftId} />}
    </AppFrame>
  );
}

type Loaded = { status: "loading" } | { status: "gone" } | { status: "ok"; hand: PhfHand };

function PostPreview({ handId, draftId }: { handId: string | null; draftId: string | null }) {
  const en = useDict();
  const t = en.chrome.share.forum;
  const p = t.preview;
  const auth = useAuth();
  const { profile } = useMyProfile();
  const router = useRouter();

  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [analysis, setAnalysis] = useState<HandAnalysis | null>(null);
  const [analysisShared, setAnalysisShared] = useState(false);
  const [boards, setBoards] = useState<BoardRef[] | null>(null);

  const [kind, setKind] = useState<"hand" | "poll">("hand");
  const [spotIndex, setSpotIndex] = useState(0);
  const [hideCards, setHideCards] = useState(false);
  const [board, setBoard] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<PublishMode>("pseudonyms");
  const [namesConfirmed, setNamesConfirmed] = useState(false);
  const [view, setView] = useState<"thread" | "feed">("thread");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The hand: a library row (the author's own; RLS answers nobody else) or the local draft.
  useEffect(() => {
    let live = true;
    if (draftId) {
      const hand = readPostDraft(draftId);
      setLoaded(hand ? { status: "ok", hand } : { status: "gone" });
    } else if (handId && auth.isSignedIn) {
      getHand(handId).then(
        (row) => live && setLoaded(row ? { status: "ok", hand: row.phf } : { status: "gone" }),
        () => live && setLoaded({ status: "gone" }),
      );
      fetchHandAnalysis(handId).then(
        (value) => live && setAnalysis(value),
        () => undefined,
      );
    } else if (!handId) {
      setLoaded({ status: "gone" });
    }
    return () => {
      live = false;
    };
  }, [handId, draftId, auth.isSignedIn]);

  useEffect(() => {
    if (!auth.isSignedIn) return;
    let live = true;
    listOpenBoards().then(
      (rows) => {
        if (!live) return;
        setBoards(rows);
        setBoard((current) => current || rows[0]?.slug || "");
      },
      (err) => live && setError(forumErrorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [auth.isSignedIn]);

  const hand = loaded.status === "ok" ? loaded.hand : null;
  const spots = useMemo(() => (hand ? pollSpots(hand) : []), [hand]);
  const spot = kind === "poll" ? (spots[spotIndex] ?? null) : null;
  const shown = useMemo(() => {
    if (!hand) return null;
    const scrubbed = previewScrub(hand, mode);
    return spot ? previewPoll(scrubbed, spot.action, hideCards) : scrubbed;
  }, [hand, mode, spot, hideCards]);

  if (!auth.isSignedIn) {
    return (
      <section className="card stack">
        <p>{t.signIn}</p>
        <div>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn(t.signIn)}>
            {en.chrome.share.signInButton}
          </button>
        </div>
      </section>
    );
  }
  if (loaded.status === "loading") {
    return <RailLoader showLabel label={p.loading} />;
  }
  if (!hand || !shown) {
    return <p className="notice notice--warn">{p.handGone}</p>;
  }

  const boardName = boards?.find((entry) => entry.slug === board)?.name ?? "";
  const titleMissing = title.trim().length < 3;
  const namesUnconfirmed = mode === "as-imported" && !namesConfirmed;
  const blocked = profile?.postingBlockReason ?? null;
  const hint = tried ? (titleMissing ? p.addTitle : namesUnconfirmed ? p.confirmNames : null) : null;
  const hero = hand.players.find((player) => player.isHero) ?? null;
  const heroCards = kind === "poll" && hideCards ? [] : (hero?.holeCards ?? []);
  const handLine = [formatStakes(hand), hero?.position, heroCards.join(" ")].filter(Boolean).join(" · ");
  const showAnalysis = kind === "hand" && analysisShared && analysis !== null;

  function back() {
    window.close();
    // A tab the browser will not let a script close: go to the library instead.
    window.setTimeout(() => router.push(paths.library()), 150);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (titleMissing || namesUnconfirmed) {
      setTried(true);
      return;
    }
    if (!hand || blocked) return;
    setBusy(true);
    setError(null);
    let publicId: string;
    try {
      const id = handId ?? (await saveHand(hand, toStandardText(hand))).id;
      if (!id) throw new Error(t.notSaved);
      publicId = (await publishHand(id, mode, title, hand)).publicId;
    } catch (err) {
      setError(publishErrorMessage(err));
      setBusy(false);
      return;
    }
    try {
      const post =
        spot !== null
          ? await createPollPost({
              board,
              title,
              body,
              hand: publicId,
              stopIndex: spot.action.index,
              options: spot.options,
              hideHeroCards: hideCards,
            })
          : await createPost({ board, title, body, hand: publicId });
      if (draftId) dropPostDraft(draftId);
      router.push(paths.post(post.board, post.publicId, post.slug));
    } catch (err) {
      setError(forumErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.bar}>
        <button type="button" className="btn btn--ghost btn--sm" onClick={back}>
          <Icon name="chevronLeft" />
          {p.back}
        </button>
        <span className={styles.grow} />
        <div className={styles.seg} role="tablist" aria-label={p.viewLabel}>
          {(["thread", "feed"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              className={view === value ? styles.segOn : undefined}
              onClick={() => setView(value)}
            >
              {p.views[value]}
            </button>
          ))}
        </div>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
        <button
          type="button"
          className="btn btn--primary"
          aria-disabled={titleMissing || namesUnconfirmed || Boolean(blocked)}
          disabled={busy || Boolean(blocked)}
          onClick={() => void submit()}
        >
          <BusyLabel busy={busy} busyLabel={t.submitting}>
            {t.submit}
          </BusyLabel>
        </button>
      </div>

      {blocked ? <p className="notice notice--warn">{blocked}</p> : null}
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.layout}>
        {/* ------------------------------------------------ settings */}
        <form className={styles.settings} onSubmit={(event) => void submit(event)}>
          <section className={styles.panel}>
            <div className={styles.seg} role="radiogroup" aria-label={p.kindLabel} data-full="">
              {(["hand", "poll"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={kind === value}
                  disabled={value === "poll" && spots.length === 0}
                  title={value === "poll" && spots.length === 0 ? en.forum.submit.poll.noSpots : undefined}
                  className={kind === value ? styles.segOn : undefined}
                  onClick={() => setKind(value)}
                >
                  {p.kinds[value]}
                </button>
              ))}
            </div>

            {kind === "poll" && spots.length ? (
              <div className={styles.field}>
                <span>{p.spot}</span>
                <div className={styles.chips}>
                  {spots.map((entry, index) => (
                    <button
                      key={entry.action.index}
                      type="button"
                      className={`${styles.chip}${index === spotIndex ? ` ${styles.chipOn}` : ""}`}
                      aria-pressed={index === spotIndex}
                      onClick={() => setSpotIndex(index)}
                    >
                      {en.forum.submit.poll.spotLabel(entry.action.street, entry.facingBet, CHOICE_LABEL[entry.did])}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`${styles.chip}${hideCards ? ` ${styles.chipOn}` : ""}`}
                    aria-pressed={hideCards}
                    onClick={() => setHideCards((value) => !value)}
                  >
                    {p.hideCards}
                  </button>
                </div>
              </div>
            ) : null}

            <label className={styles.field}>
              <span>{t.board}</span>
              <select value={board} onChange={(event) => setBoard(event.target.value)} disabled={!boards} required>
                {(boards ?? []).map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>{t.title}</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t.titlePlaceholder}
                minLength={3}
                maxLength={140}
                aria-invalid={tried && titleMissing}
              />
            </label>
            <label className={styles.field}>
              <span>{t.comment}</span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={t.commentPlaceholder}
                rows={5}
                maxLength={40000}
              />
            </label>
          </section>

          <section className={styles.panel} role="radiogroup" aria-label={t.names}>
            <span className={styles.label}>{t.names}</span>
            {MODES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                className={`${styles.mode}${mode === value ? ` ${styles.modeOn}` : ""}`}
                onClick={() => setMode(value)}
              >
                <span className={styles.radio} aria-hidden="true" />
                <span className={styles.modeName}>{en.publish.modes[value].label}</span>
                <span className={styles.modeHint}>{en.publish.modes[value].hint}</span>
              </button>
            ))}
            {mode === "as-imported" ? (
              <div className={styles.warn}>
                <p>{en.publish.asImportedWarning}</p>
                <label className={styles.confirm}>
                  <input
                    type="checkbox"
                    checked={namesConfirmed}
                    onChange={(event) => setNamesConfirmed(event.target.checked)}
                  />
                  <span>{en.publish.asImportedConfirm}</span>
                </label>
              </div>
            ) : null}
            <p className={styles.small}>{en.publish.alwaysRemoved}</p>
          </section>

          {/* A7.1: the hand's analysis flag. Only a library hand has one. */}
          {handId ? (
            <section className={styles.panel}>
              <AnalysisShareToggle
                surface="hand"
                id={handId}
                poll={kind === "poll"}
                compact
                onState={(state) => setAnalysisShared(state.shared)}
              />
            </section>
          ) : null}
        </form>

        {/* ------------------------------------------------ the post, as readers see it */}
        <section className={styles.preview} aria-label={p.viewLabel}>
          {view === "thread" ? (
            <article className={forum.post}>
              <p className={forum.meta}>{en.forum.post.backToBoard(boardName)}</p>
              <div className="stack">
                <h1 className={`${forum.postTitle}${title.trim() ? "" : ` ${styles.placeholder}`}`}>
                  {title.trim() || t.titlePlaceholder}
                </h1>
                <p className={forum.meta}>
                  <span>
                    {en.forum.by} <b>{profile?.username ?? ""}</b>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{p.justNow}</span>
                </p>
              </div>
              {body.trim() ? <PostText body={body} /> : <p className={styles.placeholder}>{t.commentPlaceholder}</p>}

              {spot ? (
                <section className={`card stack ${forum.poll}`}>
                  <h2 className={forum.cardTitle}>{en.forum.poll.heading}</h2>
                  <div className={forum.replay}>
                    {/* Keyed so a new spot or names mode starts the replayer over. */}
                    <ReplayViewer key={`${spot.action.index}:${mode}:${hideCards}`} hand={shown} initialPosition={{ kind: "end" }} />
                  </div>
                  {hideCards ? <p className="muted">{en.forum.poll.cardsHidden}</p> : null}
                  <p>{p.pollIntro}</p>
                  <div className={forum.pollChoices}>
                    {spot.options.map((option) => (
                      <span key={option} className="btn" aria-disabled="true">
                        {CHOICE_LABEL[option]}
                      </span>
                    ))}
                  </div>
                  <p className="muted">{p.pollAfter}</p>
                </section>
              ) : (
                <>
                  <section className="card">
                    <HandSummary t={en} hand={shown} />
                  </section>
                  <PostDiscussion key={`${mode}:${showAnalysis}`} hand={shown} analysis={showAnalysis ? analysis : null}>
                    {handId && !analysisShared && analysis ? (
                      <p className={styles.ghost}>
                        <Icon name="lock" />
                        {p.analysisHidden}
                      </p>
                    ) : null}
                  </PostDiscussion>
                </>
              )}
              <p className={styles.ghost}>{p.repliesHere}</p>
            </article>
          ) : (
            <article className={forum.card}>
              <div className={forum.cardBody}>
                <h2 className={forum.cardTitle}>
                  <span className={forum.badge}>{spot ? en.forum.poll.badge(0) : en.forum.handBadge}</span>
                  <span className={title.trim() ? undefined : styles.placeholder}>{title.trim() || t.titlePlaceholder}</span>
                </h2>
                {handLine ? <p className={forum.handLine}>{handLine}</p> : null}
                <p className={forum.meta}>
                  <span>{boardName}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {en.forum.by} {profile?.username ?? ""}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{p.justNow}</span>
                  <span aria-hidden="true">·</span>
                  <span>{en.forum.commentCount(0)}</span>
                </p>
              </div>
            </article>
          )}
        </section>
      </div>
    </div>
  );
}
