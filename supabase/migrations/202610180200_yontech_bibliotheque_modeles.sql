-- Bibliothèque de modèles de maquettes : sites sur mesure déjà dessinés,
-- transformés une fois en modèles à trous, puis remplis par le code (sans IA).
begin;
create table if not exists public.yontech_maquette_templates(
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.yontech_maquettes(id) on delete set null,
  kind text not null check (kind in ('refonte','creation')),
  famille text not null default '',
  photos integer not null default 0,
  status text not null default 'attente' check (status in ('attente','en_cours','ok','echec')),
  batch text, html text, error text,
  uses integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.yontech_maquette_templates enable row level security;
-- Textes par métier pour les créations (rédigés une fois).
create table if not exists public.yontech_metier_textes(
  metier text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.yontech_metier_textes enable row level security;
commit;
