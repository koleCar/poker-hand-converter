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
  - `src/lib/handStore.ts` - spremanje i pretraga handova u Supabaseu
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

## Baza (Supabase)

Projekt: `riybwcfnclphacnfawiq` (`poker converter`).

### Tablica `stored_hands`

Migracija: `supabase/migrations/20260916120000_stored_hands_replayer.sql`

Jedan red = jedan hand. Uz kanonski GG tekst (`hand_text`, iz kojeg replayer
re-parsira ruku) sprema se i denormalizirani sloj za pretragu:

| kolona | čemu služi |
| --- | --- |
| `hand_key` | unique, dedupe - ponovni upload istog fajla ne radi duplikate |
| `board_cards text[]` | GIN index, filter "board sadrži ove karte" |
| `hero_cards text[]` | GIN index, filter po točnim hero kartama |
| `hero_hand_class` | `AKs` / `AKo` / `TT` - filter po klasi ruke |
| `player_names text[]` | GIN index, filter po igraču |
| `total_pot`, `hero_profit`, `went_to_showdown`, `played_at` | sortiranje i brzi filteri |

### RLS

Aplikacija nema login, a deployani bundle je javan - znači anon ključ je javan.
Zato su politike namjerno postavljene ovako:

- `select` - **dozvoljeno** za `anon`
- `insert` - **dozvoljeno** za `anon`
- `update` / `delete` - **nisu dozvoljeni**

Najgore što netko izvana može napraviti je dodati smeće handove; postojeći
handovi se ne mogu obrisati ni izmijeniti. Brisanje se radi iz Supabase
dashboarda (service role).

### Primjena migracija

```bash
supabase db push            # ako imaš DB password
```

Alternativno, SQL se može izvršiti direktno iz Supabase dashboarda
(SQL Editor).

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
