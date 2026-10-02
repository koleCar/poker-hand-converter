/**
 * Croatian for the sentences the server writes (#55).
 *
 * Every refusal in this schema is a `raise exception` with an English
 * sentence meant for the reader — "Titles are 3 to 300 characters." — and
 * Supabase Auth answers in English too. Translating them where they are
 * written would mean a locale argument on every RPC; translating them here
 * means one lookup on the way out of `rpc()` (and the sign-in dialog), keyed
 * by the exact English text.
 *
 * Exact text is brittle on purpose: a sentence changed in a migration and not
 * here simply shows in English, which is a visible, harmless miss, never a
 * wrong message. Messages that are not for readers (batch sizes, internal
 * function names) are left out and stay English.
 */

import type { Locale } from "./types";

const HR: Record<string, string> = {
  // gates and identity
  "Confirm your email address before posting. The link is in the email we sent when you signed up.":
    "Potvrdi e-mail adresu prije objavljivanja. Link je u e-mailu koji smo poslali pri registraciji.",
  "Your account is still being set up. Try again in a moment.": "Tvoj račun se još postavlja. Pokušaj ponovno za trenutak.",
  "This account has been suspended and cannot post.": "Ovaj račun je suspendiran i ne može objavljivati.",
  'Names starting with "user_" are reserved for new accounts.': "Imena koja počinju s „user_” rezervirana su za nove račune.",
  "That username is not allowed.": "To korisničko ime nije dopušteno.",
  "That username is taken.": "To korisničko ime je zauzeto.",
  "That username is not available.": "To korisničko ime nije dostupno.",
  "Usernames are at least 3 characters.": "Korisničko ime ima najmanje 3 znaka.",
  "Usernames are at most 24 characters.": "Korisničko ime ima najviše 24 znaka.",
  "Usernames can use only letters, numbers and underscores.": "Korisničko ime smije sadržavati samo slova, brojke i podvlake.",
  "Usernames start with a letter or a number.": "Korisničko ime počinje slovom ili brojkom.",
  "No one goes by that name.": "Nitko se ne zove tako.",
  "You must be signed in.": "Moraš biti prijavljen/a.",
  "You must be signed in to choose a username.": "Za odabir korisničkog imena moraš biti prijavljen/a.",
  "You must be signed in to comment.": "Za komentiranje moraš biti prijavljen/a.",
  "You must be signed in to post.": "Za objavu moraš biti prijavljen/a.",
  "You must be signed in to publish a hand.": "Za objavu ruke moraš biti prijavljen/a.",
  "You must be signed in to read statistics.": "Za statistiku moraš biti prijavljen/a.",
  "You must be signed in to rebuild statistics.": "Za obnovu statistike moraš biti prijavljen/a.",
  "You must be signed in to analyse hands.": "Za analizu ruku moraš biti prijavljen/a.",
  "You must be signed in to read the analysis.": "Za analizu moraš biti prijavljen/a.",
  "You must be signed in to share an analysis.": "Za dijeljenje analize moraš biti prijavljen/a.",
  "You must be signed in to save an analysis.": "Za spremanje analize moraš biti prijavljen/a.",
  "You must be signed in to prune the analysis.": "Za čišćenje analize moraš biti prijavljen/a.",
  "Sign in to post.": "Prijavi se za objavu.",
  "Sign in to vote.": "Prijavi se za glasanje.",
  "Sign in to save posts.": "Prijavi se za spremanje postova.",
  "Sign in to follow threads.": "Prijavi se za praćenje threadova.",
  "Sign in to report something.": "Prijavi se da bi nešto prijavio/la.",
  "Sign in to keep notes.": "Prijavi se za bilješke.",

  // posts and comments
  "That board does not exist.": "Taj board ne postoji.",
  "This board is closed to new posts.": "Ovaj board je zatvoren za nove postove.",
  "Titles are 3 to 300 characters.": "Naslov ima od 3 do 300 znakova.",
  "Titles are at most 140 characters.": "Naslov ima najviše 140 znakova.",
  "Posts are at most 40,000 characters.": "Post ima najviše 40.000 znakova.",
  "Comments are 1 to 10,000 characters.": "Komentar ima od 1 do 10.000 znakova.",
  "Say something, or attach a hand.": "Napiši nešto ili priloži ruku.",
  "A text post needs some text.": "Post bez ruke treba tekst.",
  "That post does not exist.": "Taj post ne postoji.",
  "That comment does not exist.": "Taj komentar ne postoji.",
  "The comment you are replying to does not exist.": "Komentar na koji odgovaraš ne postoji.",
  "This thread is locked.": "Ovaj thread je zaključan.",
  "This thread is as deep as it goes. Reply further up.": "Thread ne ide dublje. Odgovori na komentar više gore.",
  "A removed post cannot be edited.": "Uklonjeni post ne može se uređivati.",
  "Only a hand post has moments to comment on.": "Samo post s rukom ima trenutke koje se može komentirati.",
  "A vote is 1, -1 or 0.": "Glas je 1, -1 ili 0.",

  // publishing and polls
  "That hand does not exist.": "Ta ruka ne postoji.",
  "That published hand does not exist.": "Ta objavljena ruka ne postoji.",
  "Hands from this poker room cannot be published.": "Ruke iz ove pokerske sobe ne mogu se objaviti.",
  "This hand could not be anonymised safely, so it was not published. Nothing was made public.":
    "Ovu ruku nije bilo moguće sigurno anonimizirati, pa nije objavljena. Ništa nije postalo javno.",
  "This hand could not be prepared for publishing.": "Ovu ruku nije bilo moguće pripremiti za objavu.",
  "That hand already has a thread; a poll needs a hand nobody has discussed yet.":
    "O ovoj ruci već postoji thread; anketa treba ruku o kojoj se još nije raspravljalo.",
  "A poll offers two to four of: fold, check, call, bet, raise, all-in.":
    "Anketa nudi dva do četiri od: fold, check, call, bet, raise, all-in.",
  "A poll stops at one of your own decisions.": "Anketa staje na jednoj od tvojih odluka.",
  "That post has no poll.": "Taj post nema anketu.",
  "That is not one of the options.": "To nije jedan od ponuđenih odgovora.",
  "A size goes with a bet or a raise, as 1 to 1000 percent of the pot.":
    "Veličina ide uz bet ili raise, kao 1 do 1000 posto pota.",
  "You already know what you did.": "Ti već znaš što si odigrao/la.",
  "You have already answered this one.": "Na ovo si već odgovorio/la.",

  // notes and reports
  "Notes are at most 2,000 characters.": "Bilješka ima najviše 2.000 znakova.",
  "Notes are for players you have played with, in rooms that show real screen names.":
    "Bilješke su za igrače s kojima si igrao/la, u sobama koje prikazuju prava imena.",
  "Up to eight tags of 24 characters.": "Najviše osam oznaka od po 24 znaka.",
  "There is nothing there to report.": "Tu nema ničega za prijaviti.",
  "Unknown report reason.": "Nepoznat razlog prijave.",

  // moderation
  "Only moderators can do that.": "To mogu samo moderatori.",
  "Only moderators can see this.": "Ovo mogu vidjeti samo moderatori.",
  "Only moderators can see the queue.": "Red mogu vidjeti samo moderatori.",
  "Only moderators can see the spam queue.": "Red spama mogu vidjeti samo moderatori.",
  "Only moderators can ban.": "Zabranu mogu dati samo moderatori.",
  "Only moderators can lift a ban.": "Zabranu mogu ukinuti samo moderatori.",
  "Only moderators can shadowban.": "Shadowban mogu dati samo moderatori.",
  "Only an admin can ban a moderator.": "Moderatora može zabraniti samo admin.",
  "Only an admin can lift a permanent ban.": "Trajnu zabranu može ukinuti samo admin.",
  "Only an admin can shadowban a moderator.": "Moderatoru shadowban može dati samo admin.",
  "Only an admin can change roles.": "Uloge može mijenjati samo admin.",
  "Only an admin can create boards.": "Boardove može stvarati samo admin.",
  "Only an admin can appoint board moderators.": "Moderatore boarda može imenovati samo admin.",
  "Only an admin can purge.": "Trajno brisati može samo admin.",
  "Moderators can ban for up to 30 days.": "Moderatori mogu zabraniti na najviše 30 dana.",
  "A ban is at least one day.": "Zabrana traje najmanje jedan dan.",
  "A ban needs a reason.": "Zabrana treba razlog.",
  "A purge needs a reason.": "Trajno brisanje treba razlog.",
  "You cannot ban yourself.": "Ne možeš zabraniti sam/a sebe.",
  "An admin cannot demote themselves; ask another admin.": "Admin ne može sam/a sebi oduzeti ulogu; zamoli drugog admina.",
  "A board with that address already exists.": "Board s tom adresom već postoji.",
  "That report does not exist.": "Ta prijava ne postoji.",

  // Supabase Auth
  "Invalid login credentials": "Pogrešan e-mail ili lozinka.",
  "Email not confirmed": "E-mail adresa još nije potvrđena. Link je u e-mailu koji smo poslali.",
  "User already registered": "Račun s tim e-mailom već postoji.",
  "Password should be at least 6 characters.": "Lozinka mora imati najmanje 6 znakova.",
};

const HR_PATTERNS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^Write rate limit exceeded for bucket /, () => "Previše pokušaja u kratkom vremenu. Pokušaj ponovno malo kasnije."],
  [
    /^You can change your username once every 30 days\. The next change is possible on (.+)\.$/,
    (m) => `Korisničko ime možeš mijenjati jednom u 30 dana. Sljedeća promjena moguća je ${m[1]}.`,
  ],
  [/^The options have to include what you actually did \((.+)\)\.$/, (m) => `Ponuđeni odgovori moraju uključiti ono što si odigrao/la (${m[1]}).`],
  [/^captcha protection/i, () => "Provjera da nisi robot nije prošla. Pokušaj ponovno."],
  [/^For security purposes, you can only request this after (\d+) seconds?\.?$/, (m) => `Iz sigurnosnih razloga pričekaj još ${m[1]} s pa pokušaj ponovno.`],
];

/** The reader's version of a server sentence; the original when there is none. */
export function localizeServerMessage(message: string, locale: Locale): string {
  if (locale !== "hr") return message;
  const exact = HR[message.trim()];
  if (exact) return exact;
  for (const [pattern, render] of HR_PATTERNS) {
    const match = message.trim().match(pattern);
    if (match) return render(match);
  }
  return message;
}
