# PokerConverter

Web aplikacija s dva taba:

1. **Converter** - konverzija WePlay hand history `.txt` fajlova u GG-stil izlaz (cash-only).
   Svaki validno konvertirani hand se sprema u Supabase.
2. **Hand Replayer** - vizualni replayer s animiranim stolom, kartama i žetonima.
   Handovi se biraju iz baze (s filterima) ili se uploada/zalijepi pojedinačni hand.

Sve se izvršava u browseru; jedini backend je Supabase (Postgres + PostgREST).

## Struktura

- `frontend/` - React + TypeScript aplikacija (Vite)
  - `src/lib/converter.ts` - WePlay -> GG konverzija
  - `src/lib/handParser.ts` - GG tekst -> strukturirani hand
  - `src/lib/replay.ts` - strukturirani hand -> vremenska traka frameova za replayer
  - `src/lib/db/` - spremanje, pretraga, failure corpus i share linkovi (Supabase)
  - `src/components/replayer/` - stol, karte, žetoni, kontrole
- `backend/` - test harness (nije runtime backend); testira i frontend libove
- `supabase/migrations/` - shema baze
- `weplay-hh/`, `gg-hh/` - sample ulazni i referentni podaci

## Pokretanje

```bash
cd frontend
npm install
cp .env.example .env.local   # pa upiši Supabase URL i anon key
npm run dev
```

Frontend default: `http://localhost:5173`

Bez `.env.local` aplikacija i dalje radi, ali samo konverzija + download;
spremanje u bazu i replayer iz baze su isključeni (UI to jasno prikazuje).

## Testovi

```bash
cd backend
npm test
```

Pokriva konverziju, parser i replay engine nad **stvarnim** sample fajlovima iz
`gg-hh/` i `weplay-hh/`: svaki hand mora se isparsirati bez nepoznatih linija,
zbroj uloga mora odgovarati `Total pot` liniji, nijedan stack ne smije otići u
minus tijekom replaya, i cijeli pot mora biti isplaćen u zadnjem frameu.

## Database (Supabase)

Project: `riybwcfnclphacnfawiq` (`poker converter`), Postgres 17.

Full documentation — every column, the RLS reasoning, which query each index
serves, how to apply a migration, and how to triage the failure corpus — is in
**[`docs/DATABASE.md`](docs/DATABASE.md)**. The short version:

Baseline migration: `supabase/migrations/20260916190000_phf_baseline.sql`.
Client layer: `frontend/src/lib/db/`.

### Tables

| Table | What it holds |
| --- | --- |
| `hands` | One successfully converted hand: the canonical `phf jsonb` document, the rendered GG-style `standard_text`, the original `source_text`, plus a denormalized column per searchable field (site, hero, cards, board, stakes, pot, profit, …). Unique on `hand_key`, so re-uploading a file never duplicates. |
| `unparsed_hands` | The **failure corpus** — hand histories we could not convert, kept deliberately as reference material for writing the next parser. Deduped by `fingerprint` with an occurrence counter and a triage `status`. |
| `unparsed_gaps` | View: the corpus rolled up by site / stage / reason, ordered by impact. "Which converter do we build next." |
| `shares` | Short-slug public links to one hand. Sealed from the client; reachable only through `create_share()` / `resolve_share()`. |

Money is stored as **integer minor units** everywhere, matching PHF.

### RLS

The app has no login and the deployed bundle is public, so the anon key is
public by construction. Policies are written for an untrusted caller:

- `select` — **allowed** for `anon` on `hands` and `unparsed_hands`
- `insert` — **allowed** for `anon` on `hands`
- `update` / `delete` — **never**, on any table
- `shares` — no grants and no policies at all; a slug is a capability URL, and
  being able to list the table would defeat the point

The worst a stranger can do is add junk rows; nothing can be destroyed or
altered. Counters that must move (failure occurrences, share views) do so inside
`security definer` functions that can touch nothing else. Cleanup is a service
role operation. Insert volume is bounded by size caps, shape checks and a global
rate limiter.

### Applying migrations

`supabase db push` **does not work here** — the CLI cannot get a login role. Use
the Management API with the personal access token from the macOS keychain; the
exact commands and the verification queries are in
[`docs/DATABASE.md`](docs/DATABASE.md#applying-a-migration).

## Funkcionalnost

### Converter tab

- Drag & drop ili odabir više `.txt` fajlova
- Lokalna konverzija u GG format
- Automatsko spremanje validnih handova u bazu (može se isključiti)
- Download pojedinačnog ili kombiniranog fajla
- Log preskočenih handova (Omaha, bomb pot, tournament, korumpirani handovi)

### Hand Replayer tab

- **Iz baze**: filteri po boardu, hero hole kartama (karte ili klasa), igraču,
  stolu, minimalnom potu, datumu; sortiranje; paginacija
- **Upload / paste**: ako je hand već u GG formatu ide direktno u replay; ako je
  WePlay, prvo se konvertira pa onda replaya; uploadani hand se može spremiti
- Replay: play/pause, korak naprijed/nazad, scrubber, skok na street, brzina
  0.5x-4x, "prikaži sve poznate karte"
- Tipkovnica: `←` `→` korak, `space` play/pause, `Home`/`End` početak/kraj
- Prikazuje se pot po ulici, ulozi ispred igrača, all-in status, dealer button,
  run-it-twice board i raspodjela pota na kraju

Grafika (stol, karte, žetoni) je generirana kao CSS/SVG unutar aplikacije -
nema vanjskih slika, pa nema ni runtime ovisnosti ni licencnih ograničenja, a
prikaz je oštar na svakoj rezoluciji.

## Produkcija (Vercel)

Live: **https://poker-hand-converter.vercel.app**

- **Root Directory**: `frontend`
- **Framework preset**: Vite (build `npm run build`, output `dist`)
- **Env varijable** (Settings -> Environment Variables, sva tri environmenta):
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

Bez tih varijabli deploy radi, ali samo kao offline converter.

Svaki push u `main` automatski deploya produkciju. Ručni deploy:

```bash
cd frontend
npx vercel deploy --prod
```

## Supabase frontend hosting (Storage) - legacy fallback

> Produkcijski hosting je na Vercelu (gore). Ovaj put je zadržan samo kao ručni
> fallback - workflow se više ne okida na push, samo preko `workflow_dispatch`.

Workflow: `.github/workflows/deploy-frontend-supabase-storage.yml`, bucket
`frontend-site` (public read). Potrebni GitHub secrets:
`SUPABASE_PROJECT_REF`, `SUPABASE_SERVICE_ROLE_KEY`.

```bash
SUPABASE_PROJECT_REF="<project-ref>" \
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
node scripts/deploy-frontend-to-supabase.mjs
```
