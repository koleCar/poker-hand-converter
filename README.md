# PokerConverter

Web aplikacija za konverziju WePlay hand history `.txt` fajlova u GG-stil izlaz.
Trenutni runtime je frontend-only (lokalno u browseru), cash-only.

## Struktura

- `frontend/` - React + TypeScript upload UI
- `backend/` - legacy lokalni parser test harness (nije runtime backend)
- `weplay-hh/` - ulazni sample podaci
- `gg-hh/` - referentni GG sample podaci

## Pokretanje

### Frontend (lokalno)

```bash
cd frontend
npm install
npm run dev
```

Frontend default: `http://localhost:5173`

## Funkcionalnost (trenutna)

- Upload više `.txt` fajlova iz WePlay formata
- Lokalna konverzija u GG-stil format direktno u browseru
- Download svakog konvertiranog fajla ili svih odjednom
- Podržan cash-only tok (tournament handovi se preskaču)

## Testovi

```bash
cd backend
npm test
```

Fixture-based testovi su u `backend/test/fixtures` i koriste iste parser transformacije koje primjenjuje ingest logika.

## Supabase frontend hosting (Storage)

Frontend je Vite staticki build i deploya se iz `frontend/dist`.

### 1) Build lokalno

```bash
cd frontend
npm install
npm run build
```

### 2) Bucket i policy

Projekt ima migracije koje osiguravaju javni bucket za frontend:
- `supabase/migrations/20260226123000_frontend_storage_bucket.sql`
- `supabase/migrations/20260308091000_frontend_storage_bucket_guards.sql`

Bucket: `frontend-site` (public read).

### 3) Auth URL konfiguracija

U `supabase/config.toml` su postavljeni placeholderi:
- `site_url = "https://your-frontend-domain.example"`
- `additional_redirect_urls = ["https://your-frontend-domain.example/*", "http://localhost:5173/*"]`

Prije produkcije zamijeni `your-frontend-domain.example` stvarnom domenom.

### 4) CI/CD deploy na main

Workflow: `.github/workflows/deploy-frontend-supabase-storage.yml`

Na svaki push u `main` workflow:
1. builda `frontend`
2. pokrece `node scripts/deploy-frontend-to-supabase.mjs`
3. uploada sve fajlove iz `frontend/dist` u Supabase Storage bucket `frontend-site`

Potrebni GitHub secrets:
- `SUPABASE_PROJECT_REF`
- `SUPABASE_SERVICE_ROLE_KEY`

Opcionalno, lokalni deploy bez GitHub Actions:

```bash
SUPABASE_PROJECT_REF="<project-ref>" \
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
node scripts/deploy-frontend-to-supabase.mjs
```
