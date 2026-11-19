# PourVentory

PourVentory is a Next.js stocktaking app for hospitality venues. The current deployed source has been recovered here so changes can be reviewed and tracked in GitHub.

## Environment variables

Set these in Vercel for each environment. Do not commit real values in `.env` files.

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `GEMINI_API_KEY` (server-side only; do not prefix it with `NEXT_PUBLIC_`)

A placeholder file is provided at `.env.example`.

## Build

Install dependencies with `npm install`, then run `npm run build`.

## Vercel

The production branch is `main`. The Vercel project `redwillow-loose-stock` serves `pourventory.vercel.app`. Pushes to `main` publish production updates; other branches are used for previews.
