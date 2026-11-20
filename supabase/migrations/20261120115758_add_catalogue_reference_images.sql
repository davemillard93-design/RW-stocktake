alter table public.bottle_catalogue
  add column if not exists source_barcode text,
  add column if not exists reference_images jsonb not null default '[]'::jsonb;

alter table public.loose_product_catalogue
  add column if not exists source_barcode text,
  add column if not exists reference_images jsonb not null default '[]'::jsonb;

