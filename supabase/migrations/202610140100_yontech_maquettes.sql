-- Maquettes de refonte (mode test) : site du prospect refait automatiquement,
-- servi sur <slug>.yontech.fr par un Worker Cloudflare qui lit la fonction
-- publique yontech-maquette. Accès réservé au rôle service (RLS sans politique).
begin;

create table if not exists public.yontech_maquettes(
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$'),
  message_id uuid references public.yontech_prospection_messages(id) on delete set null,
  source_url text not null,
  host text not null default '',
  company text not null default '',
  status text not null default 'en_ligne' check (status in ('en_ligne','retire')),
  data jsonb not null default '{}'::jsonb,
  html text not null,
  views integer not null default 0,
  last_view_at timestamptz,
  emailed_at timestamptz,
  email_to text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists yontech_maquettes_message on public.yontech_maquettes(message_id);
create index if not exists yontech_maquettes_host on public.yontech_maquettes(host);
alter table public.yontech_maquettes enable row level security;

create or replace function public.yontech_maquette_view(target_slug text)
returns void language sql security definer set search_path=public,pg_temp as $$
  update public.yontech_maquettes set views=views+1, last_view_at=now() where slug=target_slug and status='en_ligne';
$$;
revoke all on function public.yontech_maquette_view(text) from public, anon, authenticated;
grant execute on function public.yontech_maquette_view(text) to service_role;

commit;
