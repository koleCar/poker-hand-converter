"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { AppFrame } from "../../components/shell/AppFrame";
import { useAuth } from "../../lib/auth";
import { createPollPost, createPost, forumErrorMessage } from "../../lib/db/forum";
import { CHOICE_LABEL, pollSpots } from "../../lib/forum/poll";
import type { Board, PollChoice } from "../../lib/forum/types";
import type { PhfHand } from "../../lib/phf/types";
import { useDict } from "../../lib/i18n/client";
import { useMyProfile } from "../../lib/profile/context";
import { paths } from "../../lib/routes";
import styles from "../../components/forum/forum.module.css";

interface Attached {
  publicId: string;
  label: string;
  title: string | null;
  phf: PhfHand;
}

export function SubmitScreen({
  boards,
  attached,
  initialBoard,
}: {
  boards: Board[];
  attached: Attached | null;
  initialBoard: string | null;
}) {
  return (
    <AppFrame tab="forum">
      {() => <SubmitForm boards={boards} attached={attached} initialBoard={initialBoard} />}
    </AppFrame>
  );
}

function SubmitForm({
  boards,
  attached,
  initialBoard,
}: {
  boards: Board[];
  attached: Attached | null;
  initialBoard: string | null;
}) {
  const en = useDict();
  const auth = useAuth();
  const { profile } = useMyProfile();
  const router = useRouter();
  const [board, setBoard] = useState(
    boards.find((entry) => entry.slug === initialBoard)?.slug ?? boards[0]?.slug ?? "",
  );
  const [title, setTitle] = useState(attached?.title ?? "");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #51: a hand post can instead ask "what would you do?" at one of the
  // author's own decisions. The server re-checks all of this.
  const spots = useMemo(() => (attached ? pollSpots(attached.phf) : []), [attached]);
  const [asPoll, setAsPoll] = useState(false);
  const [spotIndex, setSpotIndex] = useState(0);
  const spot = spots[spotIndex] ?? null;
  const [options, setOptions] = useState<PollChoice[]>([]);
  const [hideCards, setHideCards] = useState(false);
  const offered = spot ? (options.length ? options : spot.options) : [];

  function pickSpot(index: number) {
    setSpotIndex(index);
    setOptions(spots[index]?.options ?? []);
  }

  function toggleOption(choice: PollChoice) {
    if (!spot || choice === spot.did) return;
    if (offered.includes(choice)) {
      // Two to four answers: fewer is not a question, more is a menu.
      if (offered.length > 2) setOptions(offered.filter((value) => value !== choice));
    } else if (offered.length < 4) {
      setOptions([...offered, choice]);
    }
  }

  if (!auth.isSignedIn) {
    return (
      <section className="card stack">
        <h1 className={styles.postTitle}>{en.forum.submit.heading}</h1>
        <div>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn(en.forum.submit.signIn)}>
            {en.forum.submit.signIn}
          </button>
        </div>
      </section>
    );
  }

  const blocked = profile?.postingBlockReason ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        asPoll && attached && spot
          ? await createPollPost({
              board,
              title,
              body,
              hand: attached.publicId,
              stopIndex: spot.action.index,
              options: offered,
              hideHeroCards: hideCards,
            })
          : await createPost({ board, title, body, hand: attached?.publicId ?? null });
      router.push(paths.post(result.board, result.publicId, result.slug));
    } catch (err) {
      setError(forumErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h1 className={styles.postTitle}>{en.forum.submit.heading}</h1>
      <form className={styles.composer} onSubmit={(event) => void submit(event)}>
        <label className="stack">
          <span>{en.forum.submit.board}</span>
          <select value={board} onChange={(event) => setBoard(event.target.value)}>
            {boards.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="stack">
          <span>{en.forum.submit.title}</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={en.forum.submit.titlePlaceholder}
            maxLength={300}
            required
          />
        </label>
        <div className="stack">
          <span>{en.forum.submit.hand}</span>
          <p className="muted">{attached ? en.forum.submit.handAttached(attached.label) : en.forum.submit.handHint}</p>
        </div>
        {attached ? (
          <fieldset className={`stack ${styles.pollSetup}`}>
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={asPoll}
                disabled={spots.length === 0}
                onChange={(event) => {
                  setAsPoll(event.target.checked);
                  if (event.target.checked && options.length === 0) pickSpot(spotIndex);
                }}
              />
              <span>{en.forum.submit.poll.toggle}</span>
            </label>
            <p className="muted">{spots.length ? en.forum.submit.poll.toggleHint : en.forum.submit.poll.noSpots}</p>
            {asPoll && spot ? (
              <>
                <label className="stack">
                  <span>{en.forum.submit.poll.spot}</span>
                  <select value={spotIndex} onChange={(event) => pickSpot(Number(event.target.value))}>
                    {spots.map((entry, index) => (
                      <option key={entry.action.index} value={index}>
                        {en.forum.submit.poll.spotLabel(entry.action.street, entry.facingBet, CHOICE_LABEL[entry.did])}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="stack">
                  <span>{en.forum.submit.poll.options}</span>
                  <div className={styles.pollOptions}>
                    {(["fold", "check", "call", "bet", "raise", "allin"] as const).map((choice) => (
                      <label key={choice} className={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={offered.includes(choice)}
                          disabled={choice === spot.did}
                          onChange={() => toggleOption(choice)}
                        />
                        <span>
                          {CHOICE_LABEL[choice]}
                          {choice === spot.did ? ` (${en.forum.submit.poll.optionLocked})` : ""}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <label className={styles.checkRow}>
                  <input type="checkbox" checked={hideCards} onChange={(event) => setHideCards(event.target.checked)} />
                  <span>{en.forum.submit.poll.hideCards}</span>
                </label>
              </>
            ) : null}
          </fieldset>
        ) : null}
        <label className="stack">
          <span>{en.forum.submit.body}</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={en.forum.submit.bodyPlaceholder}
            rows={8}
            maxLength={40000}
            required={!attached}
          />
        </label>
        {blocked ? <p className="notice notice--warn">{blocked}</p> : null}
        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <button type="submit" className="btn btn--primary" disabled={busy || Boolean(blocked)}>
            {busy ? en.forum.submit.submitting : en.forum.submit.submit}
          </button>
        </div>
      </form>
    </section>
  );
}
