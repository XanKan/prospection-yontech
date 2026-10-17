-- Sites sur mesure dessinés par Claude (envoi en lot) pour chaque maquette.
-- design_status : attente → en_cours → ok | echec ; le gabarit reste la version de secours.
begin;
alter table public.yontech_maquettes
  add column if not exists design_status text check (design_status in ('attente','en_cours','ok','echec')),
  add column if not exists design_batch text,
  add column if not exists design_images jsonb,
  add column if not exists design_attempts integer not null default 0,
  add column if not exists design_direction text,
  add column if not exists design_error text,
  add column if not exists design_at timestamptz;
create index if not exists yontech_maquettes_design on public.yontech_maquettes(design_status) where design_status in ('attente','en_cours');
commit;
