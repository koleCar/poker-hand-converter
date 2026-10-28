// The shapes the desktop app's IPC answers with, for the mock: copies of the
// types in `app/src/lib/ipc.ts`, the shared UI package's models
// (`packages/ui/{hands,reports,players}/model.ts`, `web/src/lib/stats/display.ts`)
// and the PHF (`core/rail-core-wasm/types/phf.d.ts`) - only those the mock
// serves. Copied, not imported: the app's files resolve `@rail/ui/...` and
// extensionless imports the way Vite does, which this package's `nodenext`
// typecheck cannot follow. When the app changes a shape, change it here too
// (the screens then show what is missing, and the capture fails on a target).

/* ----------------------------------------------------------- statistics - */

export type StatGroupName = 'preflop' | 'postflop' | 'showdown' | 'results';
export type StatUnit = 'percent' | 'bb_per_100' | 'bb' | 'ratio' | 'count' | 'money';
export type StatTone = 'very-low' | 'low' | 'normal' | 'high' | 'very-high';
export type HudPlace = 'panel' | 'popup' | 'none';

export interface StatText {
  en: string;
  hr: string;
}

export interface StatBand {
  below?: number;
  tone: StatTone;
}

export interface StatDefinition {
  id: string;
  group: StatGroupName;
  players: 'any' | 'hero';
  label: StatText;
  name: StatText;
  description: StatText;
  formula: string;
  format: { unit: StatUnit; decimals: number };
  sample: { of?: string; min: number };
  bands: StatBand[];
  hud: HudPlace;
}

export interface Definition extends StatDefinition {
  custom: boolean;
}

export interface Shown {
  value: number | null;
  text: string | null;
  tone: StatTone | null;
  sample: number | null;
  full: boolean;
  reliability: {
    level: 'insufficient' | 'low' | 'ok';
    opacity: number;
    interval: { low: number; high: number } | null;
    intervalText: { low: string; high: string } | null;
  };
}

/* ------------------------------------------------------------- settings - */

export type Theme = 'system' | 'dark' | 'light';
export type Density = 'comfortable' | 'compact';
export type Locale = 'en' | 'hr';

export interface Settings {
  version: number;
  theme: Theme;
  density: Density;
  locale: Locale;
  startAtLogin: boolean;
  firstRunDone: boolean;
}

export interface CoreInfo {
  coreVersion: string;
  phfSchema: string;
  parsers: string[];
  configVersion: number;
  sites: number | null;
  configError: string | null;
}

export interface AppInfo {
  version: string;
  identifier: string;
  logDir: string | null;
  dataDir: string | null;
  settingsFile: string;
  debug: boolean;
}

/* -------------------------------------------------------------- folders - */

export interface FoundFolder {
  site: string;
  name: string;
  path: string;
  files: number;
  complete: boolean;
  newestMs: number | null;
  verified: boolean;
  sampleLooked: number | null;
  sampleClaimed: number | null;
  watched: boolean;
}

export interface Discovery {
  os: 'macos' | 'windows' | null;
  folders: FoundFolder[];
  rooms: { site: string; name: string; verified: boolean }[];
}

export interface AddedFolder {
  path: string;
  id: number;
  marked: number;
}

export interface StoreStatus {
  path: string;
  error: string | null;
  schemaVersion: number;
  hands: number;
  handsToday: number;
  files: number;
  filesWithErrors: number;
  sources: number;
  quarantined: number;
  unsupported: number;
  outbox: number;
}

export interface Backfill {
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  hands: number;
  startedAt: number;
  secondsLeft: number | null;
}

export interface WatchSource {
  id: number;
  path: string;
  enabled: boolean;
  site: string | null;
  siteName: string | null;
  siteOverride: string | null;
  state: 'watching' | 'polling' | 'unavailable' | 'error' | 'disabled';
  error: string | null;
  recursive: boolean;
  pollOnly: boolean;
  files: number;
  hands: number;
  handsToday: number;
  quarantined: number;
  fileErrors: number;
  pending: number;
  backfill: Backfill | null;
  lastImportAt: number | null;
}

export interface WatchStatus {
  running: boolean;
  paused: boolean;
  threads: number;
  threadsAllowed: number;
  error: string | null;
  sources: WatchSource[];
}

export interface RoomChoice {
  parser: string;
  name: string;
}

export interface RefusedHand {
  id: number;
  file: string;
  stage: string;
  reason: string;
  message: string;
  detectedSite: string | null;
  parserVersion: string;
  lastSeen: number;
}

export interface Retryable {
  hands: number;
  files: number;
}

export interface QuarantineSummary {
  reasons: { reason: string; count: number }[];
  total: number;
  retryable: Retryable;
}

export interface QuarantineList {
  entries: RefusedHand[];
  truncated: boolean;
}

export interface FolderQuarantine {
  reasons: { reason: string; count: number }[];
  entries: RefusedHand[];
  truncated: boolean;
  retryable: Retryable;
}

/* ------------------------------------------------------- account, sync - */

export type AccountNotice =
  | 'cancelled'
  | 'timedOut'
  | 'notInProgress'
  | 'invalidLink'
  | 'linkRejected'
  | 'offline'
  | 'sessionEnded'
  | 'keychainUnavailable'
  | 'signedOutLocally'
  | 'browserFailed';

export type AccountStatus =
  | { state: 'notConfigured' }
  | { state: 'signedOut'; notice: AccountNotice | null }
  | { state: 'signingIn'; url: string; secondsLeft: number; notice: AccountNotice | null }
  | { state: 'signedIn'; email: string; userId: string; online: boolean; notice: AccountNotice | null };

export type SyncPhase =
  | { state: 'starting' }
  | { state: 'signedOut' }
  | { state: 'paused' }
  | { state: 'accountMismatch'; ownerEmail: string | null; email: string; localHands: number }
  | { state: 'declined'; ownerEmail: string | null; email: string; localHands: number }
  | { state: 'syncing' }
  | { state: 'upToDate' }
  | { state: 'offline'; retryAtMs: number }
  | { state: 'rateLimited'; retryAtMs: number }
  | { state: 'failed'; message: string; retryAtMs: number }
  | { state: 'planRequired'; feature: string };

export interface SyncStatus {
  phase: SyncPhase;
  paused: boolean;
  outbox: number;
  live: number;
  retrying: number;
  sent: number;
  total: number;
  rejected: { reason: string; count: number }[];
  pulled: number;
  pullSkipped: number;
  lastSyncAt: number | null;
  handsPerSecond: number | null;
  bytesPerSecond: number | null;
  cap: number | null;
  capNow: number | null;
  tablesOpen: boolean;
}

export interface PlanFeatures {
  desktopSync: boolean;
  hud: boolean;
  reportsFull: boolean;
  analysis: boolean;
  learn: boolean;
}

export interface EntitlementsStatus {
  effective: {
    plan: 'open' | 'pro' | 'free';
    reason: 'enforcementUnknown' | 'notEnforced' | 'signedOut' | 'notChecked' | 'pro' | 'free' | 'graceExpired';
    enforcement: 'unknown' | 'off' | 'on';
    features: PlanFeatures;
    proUntilMs: number | null;
    checkedAtMs: number | null;
  };
  check: { attemptedAtMs: number | null; succeededAtMs: number | null; failing: boolean };
  handsStored: number | null;
  handCap: number | null;
  serverReason: string | null;
  offlineGraceDays: number | null;
  upgradeUrl: string;
}

export interface StatsStatus {
  activity:
    | 'idle'
    | 'rebuilding'
    | 'indexing'
    | 'counting'
    | 'computing'
    | 'recomputing-ev'
    | 'paused-backfill'
    | 'paused-tables'
    | 'stopped';
  rebuildDone: number | null;
  rebuildTotal: number | null;
  rebuildJob: 'rows' | 'segments' | null;
  rebuildFills: boolean;
  evRecomputeDone: number | null;
  evRecomputeTotal: number | null;
  evPending: number;
  playersUnindexed: number;
  evComputed: number;
  evMillis: number;
  lastError: string | null;
}

/* ---------------------------------------------------------------- hands - */

export interface HandRow {
  handKey: string;
  site: string;
  siteName: string;
  siteHandId: string;
  playedAt: string | null;
  gameFormat: string;
  variant: string;
  limitType: string;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  maxSeats: number;
  tableName: string | null;
  heroPosition: string | null;
  heroCards: string[];
  board: string[];
  heroNet: number | null;
  heroNetBbMilli: number | null;
  allIn: boolean;
  evNet: number | null;
  evNetBbMilli: number | null;
  evPending: boolean;
  potType: string;
  totalPot: number;
  showdown: boolean;
  hasNote: boolean;
  tags: string[];
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface HandFacets {
  total: number;
  sites: (FacetCount & { name: string })[];
  formats: FacetCount[];
  variants: FacetCount[];
  limits: FacetCount[];
  sizes: FacetCount[];
  stakes: (FacetCount & {
    currency: string | null;
    currencySymbol: string | null;
    minorUnits: number | null;
    smallBlind: number | null;
    bigBlind: number | null;
  })[];
  positions: FacetCount[];
  potTypes: FacetCount[];
  results: FacetCount[];
  stacks: FacetCount[];
  allIn: FacetCount[];
  tags: FacetCount[];
  noted: number;
}

export interface HandPage {
  rows: HandRow[];
  next: { playedAt: string; handKey: string } | null;
}

export interface HandAnnotations {
  note: string | null;
  tags: string[];
}

export interface SavedFilter {
  id: number;
  name: string;
  filter: string;
}

/* -------------------------------------------------------------- reports - */

export interface Units {
  mixedKind: boolean;
  mixedCurrency: boolean;
  currency: string | null;
  symbol: string | null;
  minorUnits: number | null;
}

/** A report's row (`@rail/ui/reports/model` `StatGroup`). */
export interface GroupRow {
  key: string;
  label: string | null;
  hands: number;
  moneyHands: number;
  net: number | null;
  netBbMilli: number | null;
  stats: Shown[];
}

export interface GraphBucket {
  bucket: number;
  hands: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  cumHands: number;
  cumNetBbMilli: number;
  cumSdBbMilli: number;
  cumNsdBbMilli: number;
  cumEvBbMilli: number;
  cumNet: number | null;
  cumSdNet?: number | null;
  cumNsdNet?: number | null;
  cumEvNet?: number | null;
  moneyHands: number;
  cumMoneyHands: number;
}

export interface Graph {
  hands: number;
  buckets: GraphBucket[];
  allInEv: { allInHands: number; pending: number };
  mixedUnitKind: boolean;
  mixedCurrency: boolean;
  moneyHands: number;
}

export interface Report {
  units: Units;
  summary: {
    hands: number;
    moneyHands: number;
    net: number | null;
    netBbMilli: number | null;
    evNetBbMilli: number | null;
    stats: Shown[];
    ids: string[];
  };
  graph: Graph;
  columns: string[];
  byPosition: GroupRow[];
  byStake: GroupRow[];
  bySite: GroupRow[];
  bySize: GroupRow[];
  byFormat: GroupRow[];
}

export interface Breakdowns {
  columns: string[];
  potType: GroupRow[];
  stack: GroupRow[];
  handClass: GroupRow[];
  players: GroupRow[];
  street: GroupRow[];
}

export interface Session {
  startedAt: string;
  endedAt: string;
  current: boolean;
  gapMinutes: number;
  hands: number;
  tables: number | null;
  net: number | null;
  netBbMilli: number | null;
  units: Units;
  stats: Shown[];
  biggestPots: HandRow[];
}

/* -------------------------------------------------------------- players - */

export type PlayerColour = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export interface PlayerRow {
  site: string;
  siteName: string;
  player: string;
  hands: number;
  netBbMilli: number | null;
  moneyHands: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  colour: PlayerColour | null;
  labels: string[];
  hasNote: boolean;
}

export interface PlayerList {
  rows: PlayerRow[];
  matching: number;
  players: number;
  cashHands: number;
  chipsHands: number;
  mixedKind: boolean;
  hiddenHands: number;
}

export interface Together {
  hands: number;
  moneyHands: number;
  netBbMilli: number;
}

export interface PlayerSeen {
  hands: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  cash: Together;
  chips: Together;
}

export interface PlayerNotes {
  colour: PlayerColour | null;
  note: string;
  labels: string[];
}

export interface StakeSample {
  key: string;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  smallBlind: number;
  bigBlind: number;
}

export interface PlayerProfile {
  site: string;
  siteName: string;
  player: string;
  seen: PlayerSeen | null;
  notes: PlayerNotes;
  mixedKind: boolean;
  stats: Shown[];
  columns: string[];
  byPosition: GroupRow[];
  byStake: GroupRow[];
  bySize: GroupRow[];
  byFormat: GroupRow[];
  stakes: StakeSample[];
  lastPlayedAt: string | null;
}

export interface PlayerSite {
  value: string;
  name: string;
}

/* ------------------------------------------------------------------ HUD - */

export type GameFormat = 'cash' | 'mtt' | 'spin';

export interface DesignBand {
  below?: number;
  tone: StatTone;
}

export interface DesignCell {
  stat: string;
  when?: { belowBb?: number; atLeastBb?: number };
}

export interface StatOverride {
  bands?: DesignBand[];
  decimals?: number;
  minSample?: number;
}

export interface PopupSection {
  group?: StatGroupName;
  title?: string;
  stats: string[];
}

export interface HudDesign {
  version: number;
  name: string;
  preset?: string;
  format: GameFormat;
  columns: number;
  cells: DesignCell[];
  overrides?: Record<string, StatOverride>;
  popup: PopupSection[];
  legend: boolean;
  playerLabels: boolean;
  maxColourThresholds: number | null;
}

export type DesignProblem =
  | { code: 'version' | 'nameTooLong' | 'noCells' | 'tooManyCells' | 'columns' | 'tooManyPopup' | 'titleTooLong' }
  | { code: 'labels' | 'roomNotAllowed' }
  | {
      code:
        | 'unknownStat'
        | 'duplicateStat'
        | 'heroOnlyStat'
        | 'moneyStat'
        | 'badWhen'
        | 'badBands'
        | 'badDecimals'
        | 'badSample'
        | 'cardSplit'
        | 'gameStateSwitching';
      stat: string;
    }
  | { code: 'colourThresholds'; stat: string; count: number; max: number };

export interface HudRestrictions {
  ownHandsOnly: boolean;
  rawCountsOnly: boolean;
  maxColourThresholds: number | null;
  noCardSplitStats: boolean;
  noGameStateSwitching: boolean;
  noTendencySwitching: boolean;
  noPlayerLabels: boolean;
  noHandCharts: boolean;
  noGraphs: boolean;
  noHandInPlay: boolean;
  noOverlapTableGraphics: boolean;
}

export interface HudRoom {
  id: string;
  name: string;
  restrictions: HudRestrictions;
}

export interface HudStat {
  id: string;
  label: StatText;
  name: StatText;
  description: StatText;
  group: StatGroupName;
  unit: StatUnit;
  decimals: number;
  minSample: number;
  bands: DesignBand[];
  hud: HudPlace;
  custom: boolean;
  cardSplit: boolean;
  heroOnly: boolean;
  money: boolean;
}

export interface HudPreset {
  id: string;
  name: StatText;
  description: StatText;
  design: HudDesign;
}

export interface HudCheck {
  problems: DesignProblem[];
  rooms: Record<string, DesignProblem[]>;
}

export interface HudEditorState {
  presets: HudPreset[];
  defaults: Record<GameFormat, string>;
  designs: { id: string; design: HudDesign; updatedAt: number }[];
  assignments: {
    site: string;
    size: number | null;
    format: GameFormat | null;
    layout: string;
    refused: Record<string, DesignProblem[]>;
  }[];
  resolved: { site: string; size: number | null; format: GameFormat; layout: string; assigned: boolean }[];
  rooms: HudRoom[];
  stats: HudStat[];
  checks: Record<string, HudCheck>;
  positions: { site: string; size: number; panels: number }[];
  roomSettings: { site: string; preferredSeat: boolean | null }[];
  limits: {
    maxCells: number;
    maxColumns: number;
    maxDecimals: number;
    maxPopupSections: number;
    maxPopupStats: number;
  };
}

export interface HudSaved {
  id: string | null;
  problems: DesignProblem[];
  refused: Record<string, DesignProblem[]>;
}

export interface PreviewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PreviewItem =
  | { kind: 'fill'; rect: PreviewRect; radius: number; color: [number, number, number, number] }
  | {
      kind: 'text';
      rect: PreviewRect;
      text: string;
      px: number;
      color: [number, number, number, number];
      bold: boolean;
      align: 'center';
    };

export interface HudPreview {
  width: number;
  height: number;
  size: number;
  plates: PreviewRect[];
  board: PreviewRect;
  heroSlot: number;
  items: PreviewItem[];
  panels: { slot: number; rect: PreviewRect; stats: string[]; placedByUser: boolean; stackBb: number }[];
  legend: PreviewRect | null;
  problems: DesignProblem[];
}

export type RefusalReason = 'prohibited' | 'unknown' | 'not-a-room' | 'unknown-site';

export interface HudStatus {
  phase: string;
  error: string | null;
  tablesOpen: number;
  tablesWaiting: number;
  tables: { site: string; window: number; table: string | null; waiting: boolean }[];
  refused: { site: string; window: number; table: string | null; reason: RefusalReason }[];
  remotePolicy: boolean;
  permissionNeeded: string | null;
  permissionDeferred: string | null;
}

export interface RoomPolicy {
  id: string;
  name: string;
  kind: 'room' | 'network' | 'format';
  allowed: boolean | null;
  permitted: boolean;
  source: string | null;
  checkedAt: string | null;
  notes: string;
  restrictions: HudRestrictions | null;
  stricterThanShipped: boolean;
}

export interface HudPolicy {
  rooms: RoomPolicy[];
  remote: boolean;
  url: string | null;
  fetchedAt: number | null;
  lastCheck: {
    at: number;
    outcome: { kind: 'updated' } | { kind: 'current' } | { kind: 'refused'; error: string } | { kind: 'failed'; error: string };
  } | null;
  notes: string[];
}

export interface PopupBand {
  below: number | null;
  tone: StatTone;
}

export interface HudPopup {
  site: string;
  siteName: string;
  storeSite: string;
  table: string | null;
  player: string;
  hero: boolean;
  opaque: boolean;
  rules: { ownHandsOnly: boolean; colourThresholds: number | null; byPosition: boolean; words: boolean };
  hands: number;
  ids: string[];
  stats: Shown[];
  legend: { id: string; bands: PopupBand[] }[];
  together: PlayerSeen | null;
  notes: PlayerNotes | null;
  columns: string[];
  byPosition: GroupRow[] | null;
  sections: { group: StatGroupName | null; title: string | null; ids: string[] }[] | null;
}

/* ---------------------------------------------------- custom statistics - */

export interface CustomList {
  stats: never[];
  fields: { name: string; kind: 'bool' | 'number' | 'choice'; choices: string[] }[];
  shipped: string[];
  previewHands: number;
}

/* -------------------------------------------------------- the analysis - */

export interface AnalysisGate {
  run: boolean;
  reason: 'paused' | 'tables' | 'backfill' | 'statistics' | 'store' | 'plan' | null;
  paused: boolean;
}

export interface AnalysisCounts {
  hands: number;
  current: number;
  stale: number;
  missing: number;
  offline: number;
  notAnalysable: number;
}

/** `review::HandDto` (the shared review's `ReviewHand`, with its small blind; `stakesLabel` is the app's). */
export interface ReviewHandDto {
  handId: string;
  playedAt: string | null;
  site: string;
  gameFormat: string | null;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  smallBlind: number;
  bigBlind: number | null;
  tableName: string | null;
  position: string | null;
  heroCards: string[];
  handClass: string | null;
  board: string[];
  potType: string | null;
  potBb: number | null;
  net: number | null;
  netBbMilli: number | null;
  evNetBbMilli: number | null;
  grade: string | null;
  evLossBb: number | null;
}

/** `@rail/ui/review/model` `ReviewDecision`. */
export interface ReviewDecision {
  handId: string;
  ord: number;
  actionIndex: number;
  street: string;
  action: string;
  best: string | null;
  scenario: string | null;
  position: string | null;
  source: string | null;
  grade: string | null;
  evLossBb: number | null;
  evLossPot: number | null;
  chosenFreq: number | null;
}

/** `ipc.sessionReview`'s answer: the shared review's `SessionReview`, hands with their small blind. */
export interface SessionReviewDto {
  gapMinutes: number;
  session: {
    startedAt: string;
    endedAt: string;
    finished: boolean;
    previousAt: string | null;
    nextAt: string | null;
    hands: number;
    tables: number;
    allInHands: number;
    mixedUnitKind: boolean;
    mixedCurrency: boolean;
    cash: boolean;
    currency: string | null;
    currencySymbol: string | null;
    currencyMinorUnits: number | null;
    netBbMilli: number | null;
    evNetBbMilli: number | null;
    net: number | null;
    evNet: number | null;
  } | null;
  ongoing: { startedAt: string; endedAt: string } | null;
  coverage: { hands: number; analysed: number; graded: number; notAnalysed: number };
  worst: ReviewDecision[];
  chartDeviations: ReviewDecision[];
  pots: { handId: string; potBb: number }[];
  hands: Record<string, ReviewHandDto>;
}

export interface ReviewSessionRow {
  startedAt: string;
  endedAt: string;
  hands: number;
  tables: number;
  netBbMilli: number | null;
}

export interface SpotSumsDto {
  key: string;
  set: string | null;
  decisions: number;
  nonPerfect: number;
  mistakes: number;
  evLossBb: number;
  evLossPot: number;
  scoreSum: number;
  scoreSq: number;
}

export interface TopLeaksDto {
  last: string | null;
  current: { from: string; to: string } | null;
  prior: { from: string; to: string } | null;
  sample: { hands: number; graded: number; rows: SpotSumsDto[] };
  now: { hands: number; graded: number; rows: SpotSumsDto[] };
  was: { hands: number; graded: number; rows: SpotSumsDto[] };
}

export interface LeakExampleDto {
  handId: string;
  ord: number;
  actionIndex: number;
  playedAt: string | null;
  site: string;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  smallBlind: number;
  bigBlind: number;
  heroCards: string[];
  handClass: string | null;
  spotKey: string;
  grade: string;
  evLossBb: number;
  evLossPot: number;
}

/* ------------------------------------------------------------------ PHF - */

export interface CurrencyUnit {
  code: string;
  symbol: string;
  minorUnits: number;
  kind: 'cash' | 'chips';
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type Position = 'BTN' | 'SB' | 'BB' | 'UTG' | 'UTG+1' | 'UTG+2' | 'MP' | 'LJ' | 'HJ' | 'CO';
export type ActionType = 'small-blind' | 'big-blind' | 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'show' | 'collect';

export interface PhfPlayer {
  seat: number;
  name: string;
  startingStack: number;
  isHero: boolean;
  holeCards: string[];
  bounty: number | null;
  sittingOut: boolean;
  position: Position | null;
  dealtAnnounced: boolean;
  dealtCards: string[];
}

export interface PhfAction {
  index: number;
  street: Street;
  runoutIndex: number;
  seat: number | null;
  player: string;
  type: ActionType;
  amount: number;
  streetTotal: number;
  allIn: boolean;
  cards?: string[];
  description?: string;
  potName?: string;
  label: string;
  sourceLine: number | null;
  rawLine: string;
}

export interface PhfPlayerResult {
  seat: number;
  player: string;
  won: number;
  contributed: number;
  net: number;
  wentToShowdown: boolean;
  shownCards: string[];
  mucked: boolean;
  handDescription: string | null;
  positionLabels: string[];
  outcome: 'folded' | 'collected' | 'won' | 'lost' | 'mucked' | 'showed' | 'unknown';
  foldedStreet: Street | null;
  didntBet: boolean;
  cashoutRisk: number | null;
  raw: string | null;
}

export interface PhfHand {
  schema: 'phf/1';
  meta: {
    siteId: string;
    siteName: string;
    handId: string;
    handKey: string;
    originalFilename: string | null;
    parserId: string;
    parserVersion: string;
    warnings: { code: string; message: string }[];
    rawText: string;
    parsedAt: string;
    textStyle: {
      decimals: 'minimal' | 'fixed2';
      dealtLinesForAllPlayers: boolean;
      showdownSection: boolean;
      holeCardsSection: boolean;
      showdownLabels: string[];
      runItTwiceNote: boolean;
      padHour: boolean;
    };
  };
  game: {
    variant: 'holdem';
    limit: 'nl';
    hiLo: boolean;
    format: 'cash';
    unit: CurrencyUnit;
    smallBlind: number;
    bigBlind: number;
    anteModel: 'none';
    ante: number;
    straddles: never[];
    bombPot: null;
    label: string;
  };
  table: { name: string | null; maxSeats: number; buttonSeat: number | null };
  tournament: null;
  players: PhfPlayer[];
  actions: PhfAction[];
  board: {
    runouts: {
      index: number;
      flop: string[] | null;
      turn: string | null;
      river: string | null;
      markerLabels: { flop?: string; turn?: string; river?: string };
      summaryCards: string[] | null;
    }[];
  };
  results: {
    totalPot: number;
    pots: { name: string; amount: number }[];
    fees: { rake: number; jackpot: number; bingo: number; fortune: number; tax: number; other: number };
    players: PhfPlayerResult[];
    winners: { player: string; seat: number | null; amount: number; runoutIndex: number }[];
    heroNet: number | null;
    wentToShowdown: boolean;
    streetReached: Street;
  };
  playedAt: string | null;
}
