/**
 * Your data (Rail R6.5): Settings -> Your data (the export) and Settings ->
 * Delete account, and the README inside the export. English, the source
 * locale.
 */

const num = (value: number) => value.toLocaleString("en-GB");

export const yourDataEn = {
  data: {
    heading: "Your data",
    intro:
      "Download everything Rail holds about your account in one ZIP file: your profile and plan, every hand as stored, your notes, charts, settings and HUD layouts, your shares, what you wrote on the forum, and the rest. The file is made here in your browser, page by page; no copy is kept on our servers.",
    derived: "Also include statistics and analysis (Rail rebuilds them from your hands; about three times the file and four times the wait)",
    originals: "Include the original files you kept when uploading, if any (they can be large)",
    start: "Download my data",
    cancel: "Cancel",
    counting: "Counting your data…",
    pickFile: "Choose where to save the file…",
    progressHands: (done: number, total: number) => `Hands: ${num(done)} of ${num(total)}`,
    progressSections: (done: number, total: number) => `Other data: ${num(done)} of ${num(total)} tables`,
    progressOriginals: (done: number, total: number) => `Original files: ${num(done)} of ${num(total)}`,
    written: (size: string) => `${size} written so far`,
    finishing: "Finishing the file…",
    done: (name: string, size: string) => `Your export is ready: ${name} (${size}).`,
    saveAgain: "Save the file",
    savedToDisk: "It was written to the file you chose.",
    cancelled: "The export was cancelled. Nothing was kept.",
    failed: (reason: string) => `The export stopped: ${reason}. Try again; it starts from the beginning.`,
    rateLimited: "You have started 10 exports today. Try again tomorrow.",
    bigHint:
      "A large library takes a while (a few minutes per 100 000 hands). In Chrome and Edge you choose the file first and it is written as it is made; in other browsers it downloads when it is complete. Keep this tab open.",
    formats:
      "Machine-readable: JSON and NDJSON (one JSON object per line), your hands in PHF, the JSON hand format Rail uses everywhere. A README inside explains every file.",
  },

  delete: {
    heading: "Delete account",
    intro: "This deletes your account and everything in it, at once. It cannot be undone.",
    whatHeading: "What happens",
    what: [
      "Your hands, statistics, analysis, notes, charts, settings, HUD layouts and sources are deleted, and the original files you kept.",
      "Your share links stop working.",
      "Forum: your posts nobody answered and your published hands are deleted. A post others replied to stays as “[deleted]”, without your words or your name, so their replies still make sense; your comments become “deleted” placeholders the same way. Your votes are removed.",
      "A paid subscription is canceled first.",
      "Your username is kept reserved for a year so nobody can pose as you, then released.",
    ],
    desktopNote:
      "The desktop app keeps its own copy of your hands on your computer. Deleting the account does not reach it: remove it there (the app's Settings → Account says how).",
    exportFirst: "Download your data first",
    confirmLabel: (username: string) => `Type your username, ${username}, to confirm`,
    passwordLabel: "Your password",
    passwordHint: "We ask for it again so nobody else can delete your account from a browser you left signed in.",
    submit: "Delete my account permanently",
    deleting: "Deleting your account… A large library can take up to an hour. You can close this tab: once the deletion is under way it finishes on its own.",
    step: {
      billing: "Canceling the subscription…",
      storage: "Deleting stored files…",
      content: "Removing your forum content…",
      hands: "Deleting your hands…",
    },
    resumeNotice:
      "A deletion of this account was started and did not finish. Continue it to delete the rest.",
    resume: "Continue the deletion",
    mismatch: "That is not your username. Type it exactly as shown.",
    needPassword: "Enter your password.",
    wrongPassword: "That password did not sign you in. Check it and try again.",
    errors: {
      not_signed_in: "Your session ended. Sign in again, then delete the account.",
      invalid_request: "The request was not understood. Reload the page and try again.",
      reauth_required: "Please sign in again (enter your password) to delete the account.",
      confirmation_mismatch: "That is not your username. Type it exactly as shown.",
      rate_limited: "Too many attempts. Wait an hour and try again.",
      billing_unavailable:
        "Your subscription could not be canceled right now, so nothing was deleted. Try again later or contact us.",
      unavailable: "Something went wrong part of the way. Nothing is lost by trying again: it continues where it stopped.",
    },
    deletedHeading: "Your account has been deleted",
    deletedBody:
      "Everything was removed as described. Thank you for using Rail. If you use the desktop app, remove its local data on your computer too.",
  },

  /** The README.md inside the export. Notes on single tables come from the database, in English. */
  readme: {
    title: "Your Rail data",
    generated: (at: string, id: string) => `Exported ${at} for account ${id}.`,
    about:
      "This archive holds the data Rail stored for your account when it was made (GDPR Art. 15 and 20). It is machine-readable: open the JSON files in any text editor or load them with any JSON library.",
    formatsHeading: "Formats",
    formats: [
      "`*.json` - one JSON document.",
      "`*.ndjson` - newline-delimited JSON: one object per line, one line per database row. Column names are the database's.",
      "Hands are split into files of up to 2 000 (1 000 with statistics and analysis; `hands/hands-00001.ndjson`, ...). Each line has the hand's id, key, origin and times, any stored standard or source text, and `phf`: the hand as stored, in PHF (Poker Hand Format), the JSON format Rail uses everywhere. Every Rail product imports it back.",
      "Ids are UUIDs and refer across files (a statistics row's `hand_id` is a hand's `id`).",
      "Times are ISO 8601 in UTC. Amounts are in the hand's smallest unit (cents for USD) unless a column says otherwise.",
    ],
    filesHeading: "What is in it",
    filesIntro: "One line per kind of data Rail holds about an account:",
    included: "included",
    inProfile: "in profile.json",
    notIncluded: "not included",
    reasons: {
      derived: "a summary rebuilt from the rows above it",
      internal: "operational state with nothing of yours in it",
      on_request: "moderation records naming other people; ask us for yours",
    },
    optionsHeading: "Options of this export",
    derivedOn: "Statistics and analysis rows: included (`hand_stats/`, `analysis/`).",
    derivedOff: "Statistics and analysis rows: not included (they are rebuilt from your hands).",
    originalsOn: "Original files kept on upload: included (`originals/`, gzip, as stored).",
    originalsOff: "Original files kept on upload: not included.",
    manifest: "`manifest.json` lists every file with its row count, the counts the server reported, and this inventory.",
    desktopHeading: "The desktop app",
    desktop:
      "The desktop app keeps its own database on your computer; it is not in this archive. Its hands that synced are here (origin `desktop`).",
    contact: "Questions about your data: see the privacy policy at /privacy.",
  },
} as const;
