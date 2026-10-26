# Privacy policy

> **Draft - not yet in force; pending the owner's and legal review.**
> This text was written from how Rail actually stores and moves data (see
> `docs/DATABASE.md` and `docs/RAIL-PLAN.md`), as a starting point for review.
> It is not legal advice. Everything in `[square brackets]` is for the owner
> to fill in or confirm.

Last updated: [date it comes into force]

## 1. Who is responsible

Rail ("we") is run by [OWNER: legal name of the person or company], [OWNER:
address], [OWNER: OIB / company registration number]. We are the controller of
the personal data described here.

Contact for anything about your data: [OWNER: privacy contact email].
[OWNER / legal: whether a data protection officer must be appointed; if one is,
their contact.]

## 2. The short version

- You can use the converter and the replayer without an account. **A file you
  drop into the web converter is read in your browser and never leaves it
  unless you save it** to your account.
- With an account we store what you save: your hands, what Rail computes from
  them, your notes, charts and settings, and what you post on the forum.
- We do not sell data, show ads, or use analytics or tracking cookies.
- The desktop app keeps your hands on your computer; it sends them to your
  account only when you sign in and turn sync on.
- You can download all your data and delete your account yourself, in
  Settings, at any time.

## 3. What we process, and why

### 3.1 Your account

Your email address, your password (stored only as a hash by our
authentication provider), your username, when you signed up and last signed
in, and the security logs of signing in (time, IP address, browser). We need
these to give you an account and keep it secure (Art. 6(1)(b) GDPR: the
contract; Art. 6(1)(f): security).

Your **username, karma and the date you joined are public** (your profile
page), as is everything you post on the forum.

### 3.2 Your hands

- **The web converter** converts in your browser. Nothing is uploaded until
  you choose to save to your account.
- **When you save**, we store each hand as a structured document (PHF, Rail's
  hand format), search fields derived from it and the name of the file it
  came from; for hands saved from the converter's single run also the
  converted and the original hand-history text. A bulk upload stores the
  structured document only.
- **The original files** of a bulk upload are stored only if you tick "Also
  keep the original files" for that upload (compressed, in a private storage
  area only your account can read).
- **The desktop app** stores hands in a database on your computer. When you
  are signed in with sync on, it sends the structured document and per-seat
  statistics of each hand - never the original files or their text.
- **Hand histories you could not convert**: when you save a drop on the web,
  hands Rail could not read are kept with the reason, readable only by you
  and by us, so we can add support for them (Art. 6(1)(f): improving the
  converter). The desktop app sends such a sample only with your consent,
  anonymised on your computer first (player names, table names and hand
  numbers replaced).

**Other players in your hands.** Hand histories contain the screen names of
the players you played against. We store them as part of your hands, readable
only by you, because the statistics, notes and analysis you ask for depend on
them (Art. 6(1)(f)). When you **share** a hand, opponents' names are hidden by
default; when you **publish** a hand on the forum, every name is replaced
(Hero, Villain1, ...) unless you choose otherwise, and the table, hand number
and exact time are always removed. We never pass opponent data from one
account to another.

### 3.3 What Rail computes and what you add

Statistics, all-in EV, analysis and grades of your decisions, session
reviews, leak summaries, drills and trainer answers, course progress, study
plans, your own preflop charts, tournament payouts you enter, notes on
players, HUD layouts, your folders' names and the device names of the
computers that sync. Stored to provide the features you use (Art. 6(1)(b)).

### 3.4 The forum and sharing

Posts, comments, votes, saved posts, watched threads, notifications, polls,
published hands, share links and reports you file. Posts, comments, published
hands and shared hands are **public** (anyone with the link, or anyone, as
the feature says). Moderation (removing content, bans, reports) keeps a log of
what was done and why, to keep the forum safe and to handle complaints and
legal claims (Art. 6(1)(f)).

### 3.5 Payments [applies once paid plans launch]

Payments are handled by Stripe. We never see or store your card details. We
store your plan, its status and renewal date, and Stripe's reference numbers
for you and your subscription (Art. 6(1)(b)). Your customer record at Stripe
and its invoices are tax records: they are kept for as long as tax and
accounting law requires (Art. 6(1)(c)), also after you delete your account.

### 3.6 Technical data

Our hosting providers log requests (IP address, browser, time, address
requested) to run and protect the service. We keep counters per account to
limit abuse (for example how many hands an account can save in ten minutes);
they are cleared after two days. Sign-up and sign-in are protected by
Cloudflare Turnstile, which checks that a person, not a script, is signing in
(Art. 6(1)(f): security).

### 3.7 In your browser

We use only what the site needs to work: a cookie that keeps you signed in, a
cookie with the language you chose, and the browser's local storage for
things like an unfinished hand you are entering, where an interrupted upload
stopped, and cached course progress. **No advertising, analytics or tracking
cookies**, so we do not ask for cookie consent. Turnstile, on the sign-in
form, may set what it needs for its check.

### 3.8 The desktop app

- Local data: your hands, statistics, settings, HUD layouts and logs are in
  the app's folders on your computer (Settings -> Account -> Your data shows
  where). They stay there whether you are signed in or not.
- When signed in: the session is kept in your system's keychain; the app
  syncs as described in 3.2 and your HUD layouts.
- The app downloads the room list (`sites.json`) and the solver library from
  our servers, which see your IP address as any download does.
- No telemetry. [If crash reporting is added it will be opt-in, and this
  section will say what it sends.]
- **The HUD** works only at poker rooms whose published rules allow it (a list
  checked before every release), only with your own hands and statistics, and
  never gives advice during play.

## 4. Who receives your data

We use these providers (processors) to run Rail, under data processing
agreements:

| Provider | What for | Where |
| --- | --- | --- |
| Supabase | Database, sign-in, file storage, server functions | Data stored in the EU (Frankfurt, Germany). Supabase Inc. is in the USA [legal: confirm the transfer basis - EU Standard Contractual Clauses / EU-US Data Privacy Framework] |
| Vercel | Hosting the website | Global network; Vercel Inc., USA [legal: as above] |
| Stripe [once paid plans launch] | Payments, subscriptions, tax | Stripe Payments Europe Ltd., Ireland (and its group) |
| Resend | Sending account emails (confirmation, password reset) | Resend, USA [legal: as above] |
| Cloudflare | Turnstile, the robot check at sign-in | Cloudflare Inc., USA [legal: as above] |
| [GitHub] | [Distributing the desktop app and its updates] | [GitHub Inc., USA] |

We do not sell or rent personal data and do not share it for advertising. We
disclose data to authorities only when the law requires it.

## 5. How long we keep it

| Data | Kept |
| --- | --- |
| Your account and everything in it | Until you delete it (or delete the item) |
| Backups made by our database provider | Up to [OWNER: the plan's backup / point-in-time-recovery window, e.g. 7 days] after deletion |
| Server and sign-in logs | [OWNER: confirm the providers' log retention, e.g. up to 30 days] |
| Abuse counters | 2 days |
| A deleted account's username | Reserved (not usable by anyone) for 1 year, then released |
| The record that a deletion was carried out (the account's id and times, no content) | 30 days |
| Moderation log entries | [OWNER: decide, e.g. 2 years]; the words of a deleted account's content are removed from it at deletion |
| Invoices and payment records | [legal: as long as Croatian tax and accounting law requires, e.g. 11 years] |

## 6. Your rights

You have the right to access your data and receive it in a portable format,
to correct it, to have it erased, to restrict or object to processing based
on our legitimate interests, and to withdraw a consent at any time (Art.
15-22 GDPR).

- **Access and portability**: Settings -> Your data -> "Download my data"
  gives you a ZIP of everything we hold about your account, in JSON with your
  hands in PHF, built in your browser. Moderation records that name other
  people are not in it; ask us for yours.
- **Correction**: your username and password in Settings; hands can be
  deleted from your library.
- **Erasure**: Settings -> Delete account (see section 7).
- **Complaints**: you can complain to the Croatian Personal Data Protection
  Agency (AZOP, azop.hr) or the authority where you live. We would like to
  hear from you first: [OWNER: privacy contact email].

## 7. Deleting your account

Settings -> Delete account. You confirm with your username and your
password, and the deletion starts at once (there is no waiting period - so
download your data first if you want it):

- your subscription is canceled at once (your customer record and invoices
  at Stripe stay, as tax records - section 3.5);
- your hands, statistics, analysis, notes, charts, settings, HUD layouts,
  sources, shares and kept original files are deleted;
- on the forum, posts nobody answered and your published hands are deleted;
  a post others replied to stays as "[deleted]" without your words or your
  name, and your comments become "deleted" placeholders, so other people's
  replies still make sense; your votes are removed; reports you filed stay
  for the moderators without your name or your words;
- your username stays reserved for a year so nobody can pose as you.

What deletion does **not** reach: the desktop app's data on your computer.
To remove it, quit Rail (also from the tray), uninstall it and delete its
folders: on macOS `~/Library/Application Support/app.rail.desktop` and
`~/Library/Logs/app.rail.desktop`; on Windows `%LOCALAPPDATA%\app.rail.desktop`
and `%APPDATA%\app.rail.desktop`. Signing out of the app removes its session
from your keychain. Copies in our provider's backups expire as in section 5.

## 8. Security

Every account's data is separated in the database itself (row-level security,
tested on every change), connections are encrypted, passwords are hashed by
the authentication provider, and only two narrowly scoped server functions use
administrative access (the desktop sign-in and the account deletion).

## 9. Age

Rail is for people aged 18 and over [OWNER: confirm; poker content]. We do not
knowingly hold data of anyone younger; tell us and we will delete it.

## 10. Changes

We will announce changes to this policy on the site, and by email for changes
that matter, before they take effect.

## 11. Contact

[OWNER: legal name], [OWNER: address], [OWNER: privacy contact email].
