-- Maquettes sur plusieurs pages : une ligne par page intérieure (/volets…),
-- l'accueil reste dans yontech_maquettes.html.
begin;
create table if not exists public.yontech_maquette_pages(
  maquette_id uuid not null references public.yontech_maquettes(id) on delete cascade,
  path text not null check (path ~ '^/[a-z0-9-]{1,60}$'),
  html text not null,
  primary key (maquette_id, path)
);
alter table public.yontech_maquette_pages enable row level security;
commit;
