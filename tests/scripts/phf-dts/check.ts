/**
 * The TypeScript declarations generated from the Rust PHF model
 * (`core/rail-core-wasm/types/phf.d.ts`, docs/RAIL-PLAN.md R0.4) declare exactly
 * the types of `frontend/src/lib/phf/types.ts`.
 *
 * Type-level only: `npm run phf:dts-check` type-checks this file with `tsc` and
 * nothing runs. Each `same<...>()` line fails to compile when the two sides are
 * not *identical* - TypeScript's identity relation, which is stricter than
 * mutual assignability: it also catches an extra or missing optional property,
 * `x?: T` against `x: T | undefined`, and `T | null` against `T`. Because the
 * comparison is deep, `same<Ts.PhfHand, Rs.PhfHand>` alone covers the whole
 * model; the per-type lines are there so a failure names the type that moved.
 *
 * Since R4.1 `types.ts` re-exports the generated types instead of declaring
 * its own, so every line below compares a type with itself; the check stays
 * so a hand-written declaration that creeps back into `types.ts` has to be
 * identical to the model's.
 *
 * What it does not see: anything that is not a type. `types.ts` also exports
 * functions and constants (`parseAmount`, `USD`, `assignPositions`, ...), which
 * the Rust side ports in R0.5 with their own tests. And the comparison is of
 * declarations, so it cannot tell whether a field the types allow ever occurs -
 * the golden round trip (`cargo test`) covers the values.
 */
import type * as Ts from "../../../frontend/src/lib/phf/types";
import type * as Rs from "../../../core/rail-core-wasm/types/phf";

/** `true` when A and B are identical types, not merely mutually assignable. */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function same<_ extends true>(): void {}
function differ<_ extends false>(): void {}

// The check itself: things it must tell apart, so a pass above means something.
differ<Same<{ a?: string }, { a?: string | null }>>();
differ<Same<{ a: string | null }, { a?: string | null }>>();
differ<Same<{ a: string }, { a: string; b?: number }>>();
differ<Same<"x" | "y", "x">>();
same<Same<{ a: Array<{ b: number }> }, { a: { b: number }[] }>>();

// Scalars and string unions.
same<Same<Ts.Amount, Rs.Amount>>();
same<Same<Ts.PhfSchema, Rs.PhfSchema>>();
same<Same<Ts.CurrencyUnit["kind"], Rs.CurrencyKind>>();
same<Same<Ts.DecimalStyle, Rs.DecimalStyle>>();
same<Same<Ts.Street, Rs.Street>>();
same<Same<Ts.Variant, Rs.Variant>>();
same<Same<Ts.LimitType, Rs.LimitType>>();
same<Same<Ts.GameFormat, Rs.GameFormat>>();
same<Same<Ts.AnteModel, Rs.AnteModel>>();
same<Same<Ts.Position, Rs.Position>>();
same<Same<Ts.ActionType, Rs.ActionType>>();
same<Same<Ts.PotHalf, Rs.PotHalf>>();
same<Same<Ts.SeatOutcome, Rs.SeatOutcome>>();
same<Same<Ts.PhfChipMovement["anchor"], Rs.ChipMovementAnchor>>();

// Objects, leaves first.
same<Same<Ts.CurrencyUnit, Rs.CurrencyUnit>>();
same<Same<Ts.PhfStraddle, Rs.PhfStraddle>>();
same<Same<Ts.PhfBombPot, Rs.PhfBombPot>>();
same<Same<Ts.PhfGame, Rs.PhfGame>>();
same<Same<Ts.PhfTable, Rs.PhfTable>>();
same<Same<Ts.PhfTournament["bounties"][number], Rs.PhfBounty>>();
same<Same<Ts.PhfTournament, Rs.PhfTournament>>();
same<Same<Ts.PhfPlayer, Rs.PhfPlayer>>();
same<Same<Ts.PhfAction, Rs.PhfAction>>();
same<Same<Ts.PhfRunout["markerLabels"], Rs.PhfMarkerLabels>>();
same<Same<Ts.PhfRunout, Rs.PhfRunout>>();
same<Same<Ts.PhfBoard, Rs.PhfBoard>>();
same<Same<Ts.PhfChipMovement, Rs.PhfChipMovement>>();
same<Same<Ts.PhfFees, Rs.PhfFees>>();
same<Same<Ts.PhfPlayerResult, Rs.PhfPlayerResult>>();
same<Same<Ts.PhfResults["pots"][number], Rs.PhfPot>>();
same<Same<Ts.PhfResults["winners"][number], Rs.PhfWinner>>();
same<Same<Ts.PhfResults, Rs.PhfResults>>();
same<Same<Ts.PhfWarning, Rs.PhfWarning>>();
same<Same<Ts.PhfTextStyle, Rs.PhfTextStyle>>();
same<Same<Ts.PhfMeta, Rs.PhfMeta>>();

// The whole hand, deeply.
same<Same<Ts.PhfHand, Rs.PhfHand>>();
