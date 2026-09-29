/**
 * A hand, as plain HTML.
 *
 * Rendered on the server from a *published* (scrubbed) document, and the whole
 * reason a hand page can rank: real text about real cards — who sat where,
 * what was dealt, what everybody did on each street — in the document itself,
 * not in a JavaScript replayer a crawler may never run. The replayer is an
 * island below this; it adds nothing a search engine reads.
 *
 * Pure: no hooks, no data fetching, no browser APIs. It must stay renderable
 * from a Server Component, and it must only ever be handed a document that went
 * through `scrub_phf` — it prints every name it is given.
 *
 * Spoilers: the result is inside a closed `<details>`. A reader deciding what
 * they would do on the turn should not have the river in front of them; a
 * crawler reads a `<details>` body like any other text.
 */

import { en } from "../../lib/i18n/en";
import { toStandardText } from "../../lib/phf/serialize";
import { formatAmount, primaryBoard, type PhfAction, type PhfHand } from "../../lib/phf/types";
import styles from "./HandSummary.module.css";

const STREETS = ["preflop", "flop", "turn", "river", "showdown"] as const;

function money(hand: PhfHand, amount: number): string {
  return formatAmount(amount, hand.game.unit, "minimal", true);
}

function boardFor(hand: PhfHand, street: string): string[] {
  const board = primaryBoard(hand);
  if (street === "flop") return board.slice(0, 3);
  if (street === "turn") return board.slice(3, 4);
  if (street === "river") return board.slice(4, 5);
  return [];
}

function actionText(action: PhfAction): string {
  return `${action.player} ${action.label}`.trim();
}

export function HandSummary({ hand }: { hand: PhfHand }) {
  const board = primaryBoard(hand);
  const seats = [...hand.players].sort((a, b) => a.seat - b.seat);
  const byStreet = STREETS.map((street) => ({
    street,
    actions: hand.actions.filter(
      (action) =>
        action.street === street &&
        action.runoutIndex === 0 &&
        action.type !== "collect" &&
        action.type !== "show" &&
        action.type !== "muck",
    ),
  })).filter((group) => group.actions.length > 0 && group.street !== "showdown");

  let text = "";
  try {
    text = toStandardText(hand);
  } catch {
    // A document the serializer cannot render still has a summary above.
  }

  return (
    <section className={styles.summary}>
      <div className={styles.block}>
        <h2 className={styles.heading}>{en.handSummary.seats}</h2>
        <table className={styles.seats}>
          <thead>
            <tr>
              <th scope="col">{en.handSummary.seat}</th>
              <th scope="col">{en.handSummary.player}</th>
              <th scope="col">{en.handSummary.position}</th>
              <th scope="col">{en.handSummary.stack}</th>
            </tr>
          </thead>
          <tbody>
            {seats.map((player) => (
              <tr key={player.seat} className={player.isHero ? styles.hero : undefined}>
                <td>{player.seat}</td>
                <td>
                  {player.name}
                  {player.isHero && player.holeCards.length ? (
                    <span className={styles.cards}> {player.holeCards.join(" ")}</span>
                  ) : null}
                </td>
                <td>{player.position ?? ""}</td>
                <td>{money(hand, player.startingStack)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.block}>
        <h2 className={styles.heading}>{en.handSummary.action}</h2>
        {byStreet.map((group) => (
          <div key={group.street} className={styles.street}>
            <h3 className={styles.streetName}>
              {en.handSummary.streets[group.street]}
              {boardFor(hand, group.street).length ? (
                <span className={styles.cards}> {boardFor(hand, group.street).join(" ")}</span>
              ) : null}
            </h3>
            <ol className={styles.actions}>
              {group.actions.map((action) => (
                <li key={action.index}>{actionText(action)}</li>
              ))}
            </ol>
          </div>
        ))}
        {board.length === 0 ? <p className={styles.muted}>{en.handSummary.noFlop}</p> : null}
      </div>

      <details className={styles.block}>
        <summary className={styles.reveal}>{en.handSummary.revealResult}</summary>
        <p>
          {en.handSummary.board}: <span className={styles.cards}>{board.join(" ") || "—"}</span>
          {" · "}
          {en.handSummary.pot(money(hand, hand.results.totalPot))}
        </p>
        <ul className={styles.actions}>
          {hand.results.players
            .filter((result) => result.net !== 0)
            .map((result) => (
              <li key={result.seat}>
                {en.handSummary.net(result.player, `${result.net > 0 ? "+" : "−"}${money(hand, Math.abs(result.net))}`)}
                {result.shownCards.length ? (
                  <span className={styles.cards}> [{result.shownCards.join(" ")}]</span>
                ) : null}
                {result.handDescription ? ` — ${result.handDescription}` : null}
              </li>
            ))}
        </ul>
        {text ? (
          <details className={styles.text}>
            <summary>{en.handSummary.handText}</summary>
            <pre>{text}</pre>
          </details>
        ) : null}
      </details>
    </section>
  );
}
