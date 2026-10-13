-- Automate de prospection de l'outil interne prospection.yontech.fr.
--
-- Projet indépendant de l'outil Piloz : toutes les tables, fonctions et
-- tâches planifiées sont préfixées « yontech_prospection_ » et peuvent vivre
-- sur un projet Supabase dédié ou cohabiter sans collision.
--
-- Entièrement automatique : le serveur cherche lui-même des entreprises dans
-- la base SIRENE (tous secteurs, selon le ciblage enregistré), trouve leur
-- site internet et leur adresse e-mail sur le web, les met en file et leur
-- envoie un e-mail depuis la boîte Hostinger de Yontech, un message à la
-- fois, dans un créneau horaire, sous un quota journalier qui monte
-- progressivement (montée en charge de la réputation du domaine). Jusqu'à
-- deux relances dans le même fil, puis on n'insiste plus.
--
-- Toutes les tables sont réservées au service_role : le navigateur passe
-- exclusivement par la fonction yontech-prospection-api. Le planificateur
-- pg_cron réveille yontech-prospection-sender quand un envoi est dû et
-- yontech-prospection-sourcer quand la file baisse.
-- Rejouable sans dégât (if not exists, on conflict, create or replace).
begin;

create extension if not exists pgcrypto;
create extension if not exists pg_net with schema extensions;

/* ===================== Tables ===================== */

create table if not exists public.yontech_prospection_settings(
  id smallint primary key default 1 check(id=1),
  paused boolean not null default true,
  pause_reason text,
  sender_name text not null default 'Équipe Yontech',
  sender_email text check(sender_email is null or sender_email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  reply_to text check(reply_to is null or reply_to ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  signature text not null default 'Équipe Yontech'||chr(10)||'Logiciels métier et applications sur-mesure · Vendée'||chr(10)||'https://yontech.fr',
  footer_identity text not null default 'Yontech · logiciels métier, sites internet et applications sur-mesure · https://yontech.fr',
  video_url text not null default '' check(video_url='' or video_url ~* '^https://[^\s]+$'),
  daily_cap integer not null default 1000 check(daily_cap between 1 and 3000),
  -- Domaine neuf en prospection : montée en charge activée (50 le premier jour, +50 par jour d'envoi).
  warmup_enabled boolean not null default true,
  warmup_start integer not null default 50 check(warmup_start between 1 and 3000),
  warmup_step integer not null default 50 check(warmup_step between 0 and 1000),
  window_start time not null default '08:30',
  window_end time not null default '17:30',
  send_days smallint[] not null default '{1,2,3,4,5}',
  min_gap_seconds integer not null default 20 check(min_gap_seconds between 5 and 7200),
  max_gap_seconds integer not null default 45 check(max_gap_seconds between 5 and 7200),
  max_consecutive_errors integer not null default 3 check(max_consecutive_errors between 1 and 20),
  -- Volume maximum : les entreprises sans prénom de dirigeant connu sont contactées aussi (« Bonjour »).
  require_first_name boolean not null default false,
  followup_enabled boolean not null default false,
  followup1_days integer not null default 7,
  followup2_days integer not null default 21,
  followup_opened_only boolean not null default true,
  followup_since timestamptz,
  autopilot boolean not null default true,
  autopilot_target jsonb not null default '{}'::jsonb,
  autopilot_min_score integer not null default 0 check(autopilot_min_score between 0 and 100),
  autopilot_batch integer not null default 150 check(autopilot_batch between 5 and 500),
  sourcing_cursor jsonb not null default '{}'::jsonb,
  last_sourcing_at timestamptz,
  last_sourcing_report jsonb,
  next_send_at timestamptz,
  consecutive_errors integer not null default 0,
  last_error text,
  last_error_at timestamptz,
  last_run_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint yontech_prospection_settings_gap_order check(max_gap_seconds>=min_gap_seconds),
  constraint yontech_prospection_settings_window_order check(window_end>window_start),
  constraint yontech_prospection_settings_days check(send_days<@'{1,2,3,4,5,6,7}'::smallint[] and cardinality(send_days)>0),
  constraint yontech_prospection_settings_followup_days check(followup1_days between 1 and 90 and followup2_days between 2 and 180 and followup2_days>followup1_days)
);
-- Boîte d'envoi de Yontech, pré-remplie ; le mot de passe reste un secret côté serveur.
insert into public.yontech_prospection_settings(id,sender_email) values(1,'contact@yontech.fr') on conflict(id) do nothing;

-- Secret partagé entre pg_cron et les fonctions réveillées. Il n'est jamais
-- renvoyé au navigateur. L'adresse de la fonction d'envoi est alignée sur
-- l'URL réelle du projet par yontech-prospection-api au premier chargement.
create table if not exists public.yontech_prospection_runtime(
  id smallint primary key default 1 check(id=1),
  cron_secret text not null default replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),
  sender_url text not null default 'https://PROJET.supabase.co/functions/v1/yontech-prospection-sender',
  last_bounce_uid integer not null default 0,
  last_bounce_scan_at timestamptz
);
insert into public.yontech_prospection_runtime(id) values(1) on conflict(id) do nothing;

create table if not exists public.yontech_prospection_templates(
  id uuid primary key default gen_random_uuid(),
  name text not null check(char_length(name) between 1 and 120),
  subject text not null check(char_length(subject) between 1 and 200),
  body text not null check(char_length(body) between 1 and 8000),
  active boolean not null default true,
  kind text not null default 'initial' check(kind in('initial','relance1','relance2')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Un message par entreprise et par adresse, pour toujours : l'automate ne
-- recontacte jamais une entreprise déjà présente dans la file ou l'historique.
create table if not exists public.yontech_prospection_messages(
  id uuid primary key default gen_random_uuid(),
  siren text check(siren is null or siren ~ '^[0-9]{9}$'),
  email text not null check(email=lower(email) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  company text not null default '',
  data jsonb not null default '{}'::jsonb,
  score integer check(score is null or score between 0 and 100),
  origin text not null default 'manuel' check(origin in('manuel','autopilote')),
  status text not null default 'queued' check(status in('queued','sending','sent','failed','skipped')),
  template_id uuid references public.yontech_prospection_templates(id) on delete set null,
  subject text,
  body text,
  message_id text,
  error text,
  attempts integer not null default 0,
  unsubscribe_token uuid not null default gen_random_uuid(),
  tracking_token uuid not null default gen_random_uuid(),
  opened_at timestamptz,
  open_count integer not null default 0,
  video_clicked_at timestamptz,
  site_clicked_at timestamptz,
  click_count integer not null default 0,
  scanner_at timestamptz,
  scanner_hits integer not null default 0,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz
);
create unique index if not exists yontech_prospection_messages_email_key on public.yontech_prospection_messages(email);
create unique index if not exists yontech_prospection_messages_siren_key on public.yontech_prospection_messages(siren) where siren is not null;
create unique index if not exists yontech_prospection_messages_token_key on public.yontech_prospection_messages(unsubscribe_token);
create unique index if not exists yontech_prospection_messages_tracking_key on public.yontech_prospection_messages(tracking_token);
create index if not exists yontech_prospection_messages_queue_idx on public.yontech_prospection_messages(status,created_at);
create index if not exists yontech_prospection_messages_queued_score_idx on public.yontech_prospection_messages(score desc nulls last,created_at) where status='queued';
create index if not exists yontech_prospection_messages_sent_idx on public.yontech_prospection_messages(sent_at desc) where sent_at is not null;
create index if not exists yontech_prospection_messages_opened_idx on public.yontech_prospection_messages(opened_at) where opened_at is not null;
create index if not exists yontech_prospection_messages_scanner_idx on public.yontech_prospection_messages(scanner_at) where scanner_at is not null;

create table if not exists public.yontech_prospection_suppressions(
  email text primary key check(email=lower(email)),
  siren text,
  reason text not null default 'desinscription' check(reason in('desinscription','rebond','manuel','deja_contacte')),
  created_at timestamptz not null default now()
);

create table if not exists public.yontech_prospection_followups(
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.yontech_prospection_messages(id) on delete cascade,
  stage smallint not null check(stage in(1,2)),
  status text not null default 'queued' check(status in('queued','sending','sent','failed')),
  template_id uuid references public.yontech_prospection_templates(id) on delete set null,
  subject text,
  body text,
  message_id_header text,
  error text,
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique(message_id,stage)
);
create index if not exists yontech_prospection_followups_status_idx on public.yontech_prospection_followups(status,claimed_at);

-- Entreprises déjà examinées par la découverte web (avec ou sans adresse
-- trouvée) : elles ne sont pas réexaminées tant que le ciblage tourne, et
-- les compteurs de l'écran Automate s'en servent.
create table if not exists public.yontech_prospection_scanned(
  siren text primary key check(siren ~ '^[0-9]{9}$'),
  site text not null default '',
  email text not null default '',
  how text not null default '',
  scanned_at timestamptz not null default now()
);
create index if not exists yontech_prospection_scanned_at_idx on public.yontech_prospection_scanned(scanned_at desc);

alter table public.yontech_prospection_settings enable row level security;
alter table public.yontech_prospection_runtime enable row level security;
alter table public.yontech_prospection_templates enable row level security;
alter table public.yontech_prospection_messages enable row level security;
alter table public.yontech_prospection_suppressions enable row level security;
alter table public.yontech_prospection_followups enable row level security;
alter table public.yontech_prospection_scanned enable row level security;
revoke all on public.yontech_prospection_settings,public.yontech_prospection_runtime,public.yontech_prospection_templates,
  public.yontech_prospection_messages,public.yontech_prospection_suppressions,public.yontech_prospection_followups,
  public.yontech_prospection_scanned from public,anon,authenticated;
grant select,insert,update,delete on public.yontech_prospection_settings,public.yontech_prospection_runtime,public.yontech_prospection_templates,
  public.yontech_prospection_messages,public.yontech_prospection_suppressions,public.yontech_prospection_followups,
  public.yontech_prospection_scanned to service_role;

/* ===================== Modèles livrés avec l'outil ===================== */
-- Un angle par modèle (l'automate tire au sort parmi les modèles actifs) :
-- application sur-mesure, site internet (Querax), logiciel métier (Piloz,
-- Nétozia), version courte. Objet court en minuscules, une question
-- d'ouverture, un seul appel à l'action (répondre « ok »), lisible sur un
-- téléphone. Chaque modèle n'est inséré que s'il n'existe pas déjà sous ce nom.

insert into public.yontech_prospection_templates(name,subject,body,active,kind)
select 'Application sur-mesure','une application pour {entreprise} ?','{bonjour},

Chez {entreprise}, combien de tâches passent encore par des fichiers Excel, des carnets ou des messages éparpillés ? Dans {metier|votre secteur}, c''est souvent le planning, le suivi des clients ou les comptes rendus.

Nous sommes Yontech, une équipe de développement en Vendée. Nous créons des applications sur-mesure pour les entreprises de 5 à 200 personnes : un outil pensé pour votre métier, pas un logiciel générique à adapter. Nous avons déjà conçu Piloz (BTP), Nétozia (nettoyage) et des dizaines de sites internet avec Querax.

Première étape : une maquette cliquable de votre futur outil, sans engagement, pour voir à quoi il ressemblerait.

Si le sujet vous parle, répondez simplement « ok » : nous vous rappelons pour en discuter 15 minutes.

Bien cordialement,',true,'initial'
where not exists(select 1 from public.yontech_prospection_templates where name='Application sur-mesure');

insert into public.yontech_prospection_templates(name,subject,body,active,kind)
select 'Site internet','le site internet de {entreprise}','{bonjour},

Quand un client cherche {entreprise} sur Google, que trouve-t-il ? Un site à jour qui donne envie d''appeler, ou une page qui n''a pas bougé depuis des années ?

Nous sommes Yontech, en Vendée. Avec Querax, nous créons des sites internet sur-mesure pour les entreprises de {metier|votre secteur} : conception, référencement et suivi après la mise en ligne, avec une intervention sous 48 h en cas de problème. Et si votre besoin va plus loin (espace client, prise de rendez-vous, outil interne), nous développons aussi des applications sur-mesure.

Vous recevez un devis sous 48 h ouvrées, sans engagement.

Répondez « ok » et nous regardons ensemble ce que votre site pourrait devenir.

Bien cordialement,',true,'initial'
where not exists(select 1 from public.yontech_prospection_templates where name='Site internet');

insert into public.yontech_prospection_templates(name,subject,body,active,kind)
select 'Logiciel métier','{entreprise} : un logiciel fait pour votre métier','{bonjour},

Un logiciel qui fait exactement ce dont {entreprise} a besoin, et rien d''autre : c''est ce que nous construisons chez Yontech, en Vendée.

Nous avons créé Piloz pour les entreprises du bâtiment (planning des équipes, pointage des heures) et Nétozia pour les sociétés de nettoyage (planning, check-lists, rapports d''intervention signés par le client). Pour les autres métiers, nous développons l''application sur-mesure : vos clients, vos interventions, vos équipes, sur le téléphone de chacun.

Vous nous expliquez votre fonctionnement, nous vous montrons une maquette cliquable, puis nous développons. Une seule équipe, du premier appel au suivi.

Si vous voulez voir ce que ça donnerait pour {entreprise}, répondez « ok » : 15 minutes suffisent.

Bien cordialement,',true,'initial'
where not exists(select 1 from public.yontech_prospection_templates where name='Logiciel métier');

insert into public.yontech_prospection_templates(name,subject,body,active,kind)
select 'Version courte','une question, {entreprise}','{bonjour},

Quel est l''outil qui vous manque chez {entreprise} ? Celui que vous remplacez aujourd''hui par un tableur, un carnet ou des messages ?

Nous sommes Yontech, une équipe de développement en Vendée : applications sur-mesure, logiciels métier (Piloz pour le BTP, Nétozia pour le nettoyage) et sites internet (Querax). Nous commençons toujours par une maquette cliquable, sans engagement.

Répondez « ok » et nous vous rappelons.

Bien cordialement,',true,'initial'
where not exists(select 1 from public.yontech_prospection_templates where name='Version courte');

insert into public.yontech_prospection_templates(name,subject,body,active,kind)
select 'Relance 1 (J+7)','Re : (objet du premier message)','{bonjour},

Je me permets de revenir vers vous : mon message de la semaine dernière est peut-être passé sous la pile.

La question reste la même : quel outil manque aujourd''hui chez {entreprise} ? Si c''est un sujet, répondez simplement « ok » et nous vous rappelons. Sinon, pas de souci, je ne vous relancerai qu''une fois.

Bien cordialement,',true,'relance1'
where not exists(select 1 from public.yontech_prospection_templates where kind='relance1');

insert into public.yontech_prospection_templates(name,subject,body,active,kind)
select 'Relance 2 (J+21)','Re : (objet du premier message)','{bonjour},

Dernier message de ma part, promis.

Si un logiciel sur-mesure ou un nouveau site internet n''est pas un sujet chez {entreprise} en ce moment, je comprends. Si ça le devient, vous trouverez tout ce que nous faisons sur https://yontech.fr et nous répondons toujours sous 48 h.

Bonne continuation,',true,'relance2'
where not exists(select 1 from public.yontech_prospection_templates where kind='relance2');

/* ===================== Quota et compteurs ===================== */

-- Quota du jour : pendant la montée en charge, le plafond démarre bas et
-- augmente à chaque journée où l'automate a réellement envoyé.
create or replace function public.yontech_prospection_daily_cap(target_now timestamptz default now())
returns integer language sql stable security definer set search_path=public,pg_temp as $$
  select case when not s.warmup_enabled then s.daily_cap
    else least(s.daily_cap,s.warmup_start+s.warmup_step*(
      select count(distinct (m.sent_at at time zone 'Europe/Paris')::date)::integer
      from public.yontech_prospection_messages m
      where m.status='sent' and m.sent_at<(date_trunc('day',target_now at time zone 'Europe/Paris') at time zone 'Europe/Paris')
    )) end
  from public.yontech_prospection_settings s where s.id=1
$$;

-- Les relances comptent dans le quota du jour.
create or replace function public.yontech_prospection_sent_today(target_now timestamptz default now())
returns integer language sql stable security definer set search_path=public,pg_temp as $$
  select (
    (select count(*) from public.yontech_prospection_messages
      where status in('sent','sending')
        and claimed_at>=(date_trunc('day',target_now at time zone 'Europe/Paris') at time zone 'Europe/Paris'))
    +
    (select count(*) from public.yontech_prospection_followups
      where status in('sent','sending')
        and claimed_at>=(date_trunc('day',target_now at time zone 'Europe/Paris') at time zone 'Europe/Paris'))
  )::integer
$$;

-- Envois par jour (heure de Paris), premiers contacts et relances, sur tout l'historique.
create or replace function public.yontech_prospection_per_day()
returns table(day date, premiers integer, relances integer) language sql stable security definer set search_path=public,pg_temp as $$
  select d, sum(p)::integer, sum(r)::integer from (
    select (sent_at at time zone 'Europe/Paris')::date d, count(*) p, 0 r from public.yontech_prospection_messages where status='sent' and sent_at is not null group by 1
    union all
    select (sent_at at time zone 'Europe/Paris')::date, 0, count(*) from public.yontech_prospection_followups where status='sent' and sent_at is not null group by 1
  ) t group by d order by d
$$;

/* ===================== Relances ===================== */

-- Prochaine relance due (sans la réserver) : la logique est partagée entre
-- la réservation et les compteurs de l'écran Automate.
create or replace function public.yontech_prospection_followup_due(target_now timestamptz default now())
returns table(message_id uuid,stage smallint) language sql stable security definer set search_path=public,pg_temp as $$
  select m.id,
    case when exists(select 1 from public.yontech_prospection_followups f where f.message_id=m.id and f.stage=1 and f.status='sent') then 2 else 1 end::smallint
  from public.yontech_prospection_messages m, public.yontech_prospection_settings s
  where s.id=1 and s.followup_enabled
    and m.status='sent' and m.sent_at is not null and m.replied_at is null
    and (s.followup_since is null or m.sent_at>=s.followup_since)
    and not exists(select 1 from public.yontech_prospection_suppressions x where x.email=m.email)
    and (not s.followup_opened_only or m.opened_at is not null)
    and (
      (not exists(select 1 from public.yontech_prospection_followups f where f.message_id=m.id and f.stage=1)
        and m.sent_at<=target_now-make_interval(days=>s.followup1_days)
        and exists(select 1 from public.yontech_prospection_templates t where t.active and t.kind='relance1'))
      or
      (exists(select 1 from public.yontech_prospection_followups f where f.message_id=m.id and f.stage=1 and f.status='sent')
        and not exists(select 1 from public.yontech_prospection_followups f where f.message_id=m.id and f.stage=2)
        and m.sent_at<=target_now-make_interval(days=>s.followup2_days)
        and exists(select 1 from public.yontech_prospection_templates t where t.active and t.kind='relance2'))
    )
  order by m.sent_at
$$;

create or replace function public.yontech_prospection_followup_stats(target_now timestamptz default now())
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'due',(select count(*) from public.yontech_prospection_followup_due(target_now)),
    'sent',(select count(*) from public.yontech_prospection_followups where status='sent'),
    'sent_today',(select count(*) from public.yontech_prospection_followups where status in('sent','sending')
      and claimed_at>=(date_trunc('day',target_now at time zone 'Europe/Paris') at time zone 'Europe/Paris')),
    'replied',(select count(*) from public.yontech_prospection_messages where replied_at is not null)
  )
$$;

/* ===================== Réservation et issue des envois ===================== */

-- Réservation atomique du prochain envoi. Le verrou sur la ligne de réglages
-- sérialise deux réveils concurrents : jamais deux envois au même instant,
-- jamais de dépassement du quota. Ordre : 1. relances dues, 2. nouveaux
-- prospects par score décroissant puis ancienneté.
create or replace function public.yontech_prospection_claim_next(target_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  s public.yontech_prospection_settings%rowtype;
  m public.yontech_prospection_messages%rowtype;
  f public.yontech_prospection_followups%rowtype;
  due record;
  paris timestamp:=target_now at time zone 'Europe/Paris';
  opening timestamptz;
  first_slot timestamptz;
  sent_today integer;
  cap integer;
  gap integer;
begin
  select * into s from public.yontech_prospection_settings where id=1 for update;
  if not found then return jsonb_build_object('state','unconfigured'); end if;
  update public.yontech_prospection_settings set last_run_at=target_now where id=1;

  -- Un envoi resté « en cours » plus de 10 minutes a pu partir ou non :
  -- par prudence il n'est jamais renvoyé automatiquement.
  update public.yontech_prospection_messages set status='failed',
    error='Envoi interrompu : statut inconnu, non renvoyé par sécurité.'
  where status='sending' and claimed_at<target_now-interval '10 minutes';
  update public.yontech_prospection_followups set status='failed',
    error='Envoi interrompu : statut inconnu, non renvoyé par sécurité.'
  where status='sending' and claimed_at<target_now-interval '10 minutes';

  if s.paused then return jsonb_build_object('state','paused'); end if;
  if s.sender_email is null then return jsonb_build_object('state','unconfigured'); end if;
  if not (extract(isodow from paris)::smallint=any(s.send_days)) then return jsonb_build_object('state','off_day'); end if;
  if paris::time<s.window_start or paris::time>=s.window_end then return jsonb_build_object('state','off_hours'); end if;

  -- Premier envoi de la journée décalé au hasard après l'ouverture du
  -- créneau, comme une personne qui commence sa matinée.
  opening:=(date_trunc('day',paris)+s.window_start) at time zone 'Europe/Paris';
  if s.next_send_at is null or s.next_send_at<opening then
    first_slot:=opening+make_interval(secs=>floor(random()*s.max_gap_seconds)::integer);
    if first_slot>target_now then
      update public.yontech_prospection_settings set next_send_at=first_slot where id=1;
      return jsonb_build_object('state','waiting','next_send_at',first_slot);
    end if;
  elsif s.next_send_at>target_now then
    return jsonb_build_object('state','waiting','next_send_at',s.next_send_at);
  end if;

  sent_today:=public.yontech_prospection_sent_today(target_now);
  cap:=public.yontech_prospection_daily_cap(target_now);
  if sent_today>=cap then return jsonb_build_object('state','cap_reached','cap',cap,'sent_today',sent_today); end if;

  gap:=s.min_gap_seconds+floor(random()*(s.max_gap_seconds-s.min_gap_seconds+1))::integer;

  -- 1. Relances dues (relance à réessayer d'abord, puis relance due).
  if s.followup_enabled then
    select * into f from public.yontech_prospection_followups where status='queued' order by created_at limit 1 for update skip locked;
    if not found then
      select * into due from public.yontech_prospection_followup_due(target_now) limit 1;
      if found then
        insert into public.yontech_prospection_followups(message_id,stage,status) values(due.message_id,due.stage,'queued')
        on conflict(message_id,stage) do nothing
        returning * into f;
      end if;
    end if;
    if f.id is not null then
      select * into m from public.yontech_prospection_messages where id=f.message_id for update;
      update public.yontech_prospection_followups set status='sending',claimed_at=target_now,attempts=attempts+1 where id=f.id
      returning * into f;
      update public.yontech_prospection_settings set next_send_at=target_now+make_interval(secs=>gap) where id=1;
      return jsonb_build_object('state','claimed','kind','followup','followup',to_jsonb(f),'message',to_jsonb(m),
        'settings',to_jsonb(s),'sent_today',sent_today+1,'cap',cap);
    end if;
  end if;

  -- 2. Nouveaux prospects : exclusions et prénom manquant écartés, meilleur score d'abord.
  update public.yontech_prospection_messages q set status='skipped',error='Adresse désinscrite avant l''envoi'
  where q.status='queued' and exists(select 1 from public.yontech_prospection_suppressions x where x.email=q.email);
  if s.require_first_name then
    update public.yontech_prospection_messages q set status='skipped',error='Prénom du dirigeant inconnu'
    where q.status='queued' and btrim(coalesce(q.data->>'prenom',''))='';
  end if;

  select * into m from public.yontech_prospection_messages
  where status='queued' order by score desc nulls last,created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('state','empty'); end if;

  update public.yontech_prospection_messages set status='sending',claimed_at=target_now,attempts=attempts+1 where id=m.id
  returning * into m;
  update public.yontech_prospection_settings set next_send_at=target_now+make_interval(secs=>gap) where id=1;
  return jsonb_build_object('state','claimed','kind','initial','message',to_jsonb(m),'settings',to_jsonb(s),
    'sent_today',sent_today+1,'cap',cap);
end $$;

-- Résultat d'un envoi. outcome :
--   sent                : parti ;
--   recipient_rejected  : adresse refusée par le serveur (rebond immédiat) ;
--   transient           : incident lié au message, il repart en file (3 essais) ;
--   throttled           : boîte saturée ou injoignable (quota Hostinger,
--                         réseau) : le message repart en file sans perdre
--                         d'essai et l'automate patiente target_retry_seconds ;
--   fatal               : configuration cassée (mot de passe...), pause.
create or replace function public.yontech_prospection_finish(
  target_id uuid,outcome text,target_template_id uuid default null,target_subject text default null,
  target_body text default null,target_message_id text default null,target_error text default null,
  target_retry_seconds integer default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.yontech_prospection_settings%rowtype; m public.yontech_prospection_messages%rowtype; errors integer; wait_seconds integer;
begin
  if outcome not in('sent','recipient_rejected','transient','throttled','fatal') then raise exception 'invalid_outcome'; end if;
  select * into s from public.yontech_prospection_settings where id=1 for update;
  select * into m from public.yontech_prospection_messages where id=target_id for update;
  if not found then return jsonb_build_object('ok',false,'error','message_not_found'); end if;

  if outcome='sent' then
    update public.yontech_prospection_messages set status='sent',sent_at=now(),template_id=target_template_id,
      subject=target_subject,body=target_body,message_id=target_message_id,error=null where id=target_id;
    update public.yontech_prospection_settings set consecutive_errors=0 where id=1;
    return jsonb_build_object('ok',true,'status','sent');
  end if;

  if outcome='recipient_rejected' then
    update public.yontech_prospection_messages set status='failed',template_id=target_template_id,subject=target_subject,
      body=target_body,error=left(coalesce(target_error,'Adresse refusée'),500) where id=target_id;
    insert into public.yontech_prospection_suppressions(email,siren,reason) values(m.email,m.siren,'rebond')
    on conflict(email) do nothing;
    return jsonb_build_object('ok',true,'status','failed');
  end if;

  if outcome='throttled' then
    wait_seconds:=greatest(60,least(coalesce(target_retry_seconds,3600),86400));
    update public.yontech_prospection_messages set status='queued',claimed_at=null,attempts=greatest(0,attempts-1),
      error=left(coalesce(target_error,'Boîte d''envoi momentanément indisponible'),500) where id=target_id;
    update public.yontech_prospection_settings set next_send_at=now()+make_interval(secs=>wait_seconds),
      last_error=left(coalesce(target_error,''),500),last_error_at=now() where id=1;
    return jsonb_build_object('ok',true,'status','queued','wait_seconds',wait_seconds);
  end if;

  if outcome='fatal' then
    update public.yontech_prospection_messages set status='queued',claimed_at=null,attempts=greatest(0,attempts-1),
      error=left(coalesce(target_error,'Erreur inconnue'),500) where id=target_id;
    update public.yontech_prospection_settings set paused=true,consecutive_errors=0,
      last_error=left(coalesce(target_error,'Erreur inconnue'),500),last_error_at=now(),
      pause_reason='Pause automatique : la boîte d''envoi refuse les envois. '||left(coalesce(target_error,''),300)
    where id=1;
    return jsonb_build_object('ok',true,'status','queued','paused',true);
  end if;

  errors:=s.consecutive_errors+1;
  update public.yontech_prospection_messages set
    status=case when m.attempts<3 then 'queued' else 'failed' end,
    claimed_at=null,error=left(coalesce(target_error,'Erreur inconnue'),500)
  where id=target_id;
  update public.yontech_prospection_settings set
    consecutive_errors=case when errors>=max_consecutive_errors then 0 else errors end,
    next_send_at=case when errors>=max_consecutive_errors then now()+interval '30 minutes' else next_send_at end,
    last_error=left(coalesce(target_error,'Erreur inconnue'),500),last_error_at=now()
  where id=1;
  return jsonb_build_object('ok',true,'status',case when m.attempts<3 then 'queued' else 'failed' end,
    'wait_seconds',case when errors>=s.max_consecutive_errors then 1800 else 0 end);
end $$;

-- Issue d'une relance : mêmes règles que pour le premier message.
create or replace function public.yontech_prospection_followup_finish(
  target_id uuid,outcome text,target_template_id uuid default null,target_subject text default null,
  target_body text default null,target_message_id text default null,target_error text default null,
  target_retry_seconds integer default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.yontech_prospection_settings%rowtype; f public.yontech_prospection_followups%rowtype; m public.yontech_prospection_messages%rowtype;
  errors integer; wait_seconds integer;
begin
  if outcome not in('sent','recipient_rejected','transient','throttled','fatal') then raise exception 'invalid_outcome'; end if;
  select * into s from public.yontech_prospection_settings where id=1 for update;
  select * into f from public.yontech_prospection_followups where id=target_id for update;
  if not found then return jsonb_build_object('ok',false,'error','followup_not_found'); end if;
  select * into m from public.yontech_prospection_messages where id=f.message_id;

  if outcome='sent' then
    update public.yontech_prospection_followups set status='sent',sent_at=now(),template_id=target_template_id,
      subject=target_subject,body=target_body,message_id_header=target_message_id,error=null where id=target_id;
    update public.yontech_prospection_settings set consecutive_errors=0 where id=1;
    return jsonb_build_object('ok',true,'status','sent');
  end if;

  if outcome='recipient_rejected' then
    update public.yontech_prospection_followups set status='failed',template_id=target_template_id,subject=target_subject,
      body=target_body,error=left(coalesce(target_error,'Adresse refusée'),500) where id=target_id;
    insert into public.yontech_prospection_suppressions(email,siren,reason) values(m.email,m.siren,'rebond')
    on conflict(email) do nothing;
    return jsonb_build_object('ok',true,'status','failed');
  end if;

  if outcome='throttled' then
    wait_seconds:=greatest(60,least(coalesce(target_retry_seconds,3600),86400));
    update public.yontech_prospection_followups set status='queued',claimed_at=null,attempts=greatest(0,attempts-1),
      error=left(coalesce(target_error,'Boîte d''envoi momentanément indisponible'),500) where id=target_id;
    update public.yontech_prospection_settings set next_send_at=now()+make_interval(secs=>wait_seconds),
      last_error=left(coalesce(target_error,''),500),last_error_at=now() where id=1;
    return jsonb_build_object('ok',true,'status','queued','wait_seconds',wait_seconds);
  end if;

  if outcome='fatal' then
    update public.yontech_prospection_followups set status='queued',claimed_at=null,attempts=greatest(0,attempts-1),
      error=left(coalesce(target_error,'Erreur inconnue'),500) where id=target_id;
    update public.yontech_prospection_settings set paused=true,consecutive_errors=0,
      last_error=left(coalesce(target_error,'Erreur inconnue'),500),last_error_at=now(),
      pause_reason='Pause automatique : la boîte d''envoi refuse les envois. '||left(coalesce(target_error,''),300)
    where id=1;
    return jsonb_build_object('ok',true,'status','queued','paused',true);
  end if;

  errors:=s.consecutive_errors+1;
  update public.yontech_prospection_followups set
    status=case when f.attempts<3 then 'queued' else 'failed' end,
    claimed_at=null,error=left(coalesce(target_error,'Erreur inconnue'),500)
  where id=target_id;
  update public.yontech_prospection_settings set
    consecutive_errors=case when errors>=max_consecutive_errors then 0 else errors end,
    next_send_at=case when errors>=max_consecutive_errors then now()+interval '30 minutes' else next_send_at end,
    last_error=left(coalesce(target_error,'Erreur inconnue'),500),last_error_at=now()
  where id=1;
  return jsonb_build_object('ok',true,'status',case when f.attempts<3 then 'queued' else 'failed' end,
    'wait_seconds',case when errors>=s.max_consecutive_errors then 1800 else 0 end);
end $$;

-- « A répondu » : arrête les relances pour cette entreprise. Réversible.
create or replace function public.yontech_prospection_mark_replied(target_id uuid,replied boolean default true)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.yontech_prospection_messages set replied_at=case when replied then coalesce(replied_at,now()) else null end where id=target_id;
  if replied then delete from public.yontech_prospection_followups where message_id=target_id and status='queued'; end if;
  return jsonb_build_object('ok',true,'replied',replied);
end $$;

/* ===================== Désinscription, rebonds, suivi ===================== */

create or replace function public.yontech_prospection_unsubscribe(target_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.yontech_prospection_messages%rowtype;
begin
  select * into m from public.yontech_prospection_messages where unsubscribe_token=target_token;
  if not found then return jsonb_build_object('ok',false); end if;
  insert into public.yontech_prospection_suppressions(email,siren,reason) values(m.email,m.siren,'desinscription')
  on conflict(email) do update set reason='desinscription';
  update public.yontech_prospection_messages set status='skipped',error='Désinscrit' where email=m.email and status='queued';
  return jsonb_build_object('ok',true,'email',m.email);
end $$;

create or replace function public.yontech_prospection_bounce(target_email text, target_error text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare normalized text:=lower(trim(target_email)); updated integer;
begin
  if normalized !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return jsonb_build_object('ok',false,'error','invalid_email'); end if;
  insert into public.yontech_prospection_suppressions(email,siren,reason)
  select normalized,m.siren,'rebond' from public.yontech_prospection_messages m where m.email=normalized
  union select normalized,null,'rebond' limit 1
  on conflict(email) do nothing;
  update public.yontech_prospection_messages set status='failed',
    error=left('Rebond après envoi : '||coalesce(nullif(trim(target_error),''),'adresse injoignable'),500)
  where email=normalized and status='sent';
  get diagnostics updated=row_count;
  update public.yontech_prospection_messages set status='skipped',error='Adresse en rebond, retirée de la file'
  where email=normalized and status='queued';
  return jsonb_build_object('ok',true,'updated',updated);
end $$;

-- Suivi d'un message : ouverture, clic vidéo, clic site, lien piège. Les
-- filtres de sécurité des destinataires (Hornetsecurity, Mimecast, Proofpoint,
-- Defender…) ouvrent le pixel et suivent tous les liens quelques secondes
-- après réception : un événement moins de 120 secondes après le dernier envoi,
-- un navigateur robot, le lien piège, deux liens différents à moins de 3
-- secondes d'écart, ou le pixel chargé puis un lien suivi dans les 2 secondes
-- sont comptés « scanner », à part des ouvertures et clics humains.
create or replace function public.yontech_prospection_track(target_token uuid, kind text, agent text default '')
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.yontech_prospection_messages%rowtype; last_send timestamptz; bot boolean; other timestamptz;
begin
  if kind not in('open','video','site','trap') then return false; end if;
  select * into m from public.yontech_prospection_messages where tracking_token=target_token and status='sent';
  if not found then return false; end if;
  select greatest(m.sent_at,max(f.sent_at)) into last_send from public.yontech_prospection_followups f where f.message_id=m.id and f.status='sent';
  last_send:=coalesce(last_send,m.sent_at);
  bot:=kind='trap'
    or (last_send is not null and now()-last_send<interval '120 seconds')
    or coalesce(agent,'') ~* '(bot|crawler|spider|scanner|scan|curl|wget|python|java/|go-http|okhttp|headless|phantom|mimecast|proofpoint|barracuda|hornet|sophos|symantec|trend ?micro|forcepoint|fortinet|check ?point|cisco|ironport|safelinks|urldefense|zscaler|bitdefender|kaspersky|eset)';
  if not bot and kind in('video','site') then
    other:=case when kind='video' then m.site_clicked_at else m.video_clicked_at end;
    if other is not null and abs(extract(epoch from (now()-other)))<3 then
      update public.yontech_prospection_messages set scanner_at=now(),scanner_hits=scanner_hits+2,
        video_clicked_at=null,site_clicked_at=null,
        click_count=greatest(0,click_count-1) where id=m.id;
      return true;
    end if;
    if m.open_count>0 and m.opened_at is not null and now()-m.opened_at<interval '2 seconds' then
      update public.yontech_prospection_messages set scanner_at=now(),scanner_hits=scanner_hits+1+open_count,
        opened_at=null,open_count=0 where id=m.id;
      return true;
    end if;
  end if;
  if bot then
    update public.yontech_prospection_messages set scanner_at=now(),scanner_hits=scanner_hits+1 where id=m.id;
    return true;
  end if;
  if kind='open' then
    update public.yontech_prospection_messages set opened_at=coalesce(opened_at,now()),open_count=open_count+1 where id=m.id;
  elsif kind='video' then
    update public.yontech_prospection_messages set opened_at=coalesce(opened_at,now()),
      video_clicked_at=coalesce(video_clicked_at,now()),click_count=click_count+1 where id=m.id;
  elsif kind='site' then
    update public.yontech_prospection_messages set opened_at=coalesce(opened_at,now()),
      site_clicked_at=coalesce(site_clicked_at,now()),click_count=click_count+1 where id=m.id;
  end if;
  return true;
end $$;

/* ===================== File, entreprises connues, découverte ===================== */

-- Mise en file en un seul appel. Les adresses invalides, désinscrites ou déjà
-- connues (même e-mail ou même SIREN) sont écartées sans erreur.
create or replace function public.yontech_prospection_enqueue(items jsonb,target_origin text default 'manuel')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare received integer; valid_count integer; allowed_count integer; inserted integer;
begin
  if jsonb_typeof(items)<>'array' then raise exception 'items_must_be_array'; end if;
  if jsonb_array_length(items)>2000 then raise exception 'too_many_items'; end if;
  with src as(
    select lower(trim(coalesce(i->>'email',''))) as email,
      nullif(regexp_replace(coalesce(i->>'siren',''),'[^0-9]','','g'),'') as siren,
      left(coalesce(i->>'company',''),200) as company,
      case when jsonb_typeof(i->'data')='object' then i->'data' else '{}'::jsonb end as data,
      case when coalesce(i->>'score','') ~ '^[0-9]{1,3}$' then least(100,(i->>'score')::integer) end as score
    from jsonb_array_elements(items) i
  ),valid as(
    select distinct on(email) * from src
    where email ~ '^[^\s@]+@[^\s@]+\.[a-z]{2,}$' and (siren is null or siren ~ '^[0-9]{9}$')
  ),allowed as(
    select * from valid v where not exists(select 1 from public.yontech_prospection_suppressions x where x.email=v.email or (v.siren is not null and x.siren=v.siren))
  ),ins as(
    insert into public.yontech_prospection_messages(siren,email,company,data,score,origin)
    select siren,email,company,data,score,case when target_origin='autopilote' then 'autopilote' else 'manuel' end from allowed
    on conflict do nothing
    returning 1
  )
  select (select count(*) from src),(select count(*) from valid),(select count(*) from allowed),(select count(*) from ins)
  into received,valid_count,allowed_count,inserted;
  return jsonb_build_object('received',received,'added',inserted,'already',allowed_count-inserted,
    'suppressed',valid_count-allowed_count,'invalid',received-valid_count);
end $$;

-- Entreprises déjà connues de l'automate (file, historique, désinscription,
-- ou déjà examinées par la découverte web), pour ne pas les refaire.
create or replace function public.yontech_prospection_known(target_sirens text[] default '{}',target_emails text[] default '{}')
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'sirens',coalesce((select jsonb_agg(distinct x.siren) from(
      select m.siren from public.yontech_prospection_messages m where m.siren=any(target_sirens)
      union select s.siren from public.yontech_prospection_suppressions s where s.siren=any(target_sirens)
      union select c.siren from public.yontech_prospection_scanned c where c.siren=any(target_sirens)) x where x.siren is not null),'[]'::jsonb),
    'emails',coalesce((select jsonb_agg(distinct x.email) from(
      select m.email from public.yontech_prospection_messages m where m.email=any(target_emails)
      union select s.email from public.yontech_prospection_suppressions s where s.email=any(target_emails)) x),'[]'::jsonb),
    'suppressed',coalesce((select jsonb_agg(s.email) from public.yontech_prospection_suppressions s where s.email=any(target_emails)),'[]'::jsonb)
  )
$$;

-- Mémorise les entreprises examinées par la découverte web.
create or replace function public.yontech_prospection_mark_scanned(items jsonb)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare inserted integer;
begin
  if jsonb_typeof(items)<>'array' then raise exception 'items_must_be_array'; end if;
  insert into public.yontech_prospection_scanned(siren,site,email,how)
  select regexp_replace(coalesce(i->>'siren',''),'[^0-9]','','g'),left(coalesce(i->>'site',''),200),left(lower(coalesce(i->>'email','')),254),left(coalesce(i->>'how',''),40)
  from jsonb_array_elements(items) i
  where regexp_replace(coalesce(i->>'siren',''),'[^0-9]','','g') ~ '^[0-9]{9}$'
  on conflict(siren) do update set site=excluded.site,email=excluded.email,how=excluded.how,scanned_at=now();
  get diagnostics inserted=row_count;
  return inserted;
end $$;

create or replace function public.yontech_prospection_scanned_stats(target_now timestamptz default now())
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'total',(select count(*) from public.yontech_prospection_scanned),
    'sites',(select count(*) from public.yontech_prospection_scanned where site<>''),
    'emails',(select count(*) from public.yontech_prospection_scanned where email<>''),
    'today',(select count(*) from public.yontech_prospection_scanned where scanned_at>=(date_trunc('day',target_now at time zone 'Europe/Paris') at time zone 'Europe/Paris')),
    'emails_today',(select count(*) from public.yontech_prospection_scanned where email<>'' and scanned_at>=(date_trunc('day',target_now at time zone 'Europe/Paris') at time zone 'Europe/Paris'))
  )
$$;

/* ===================== Planificateur ===================== */

create or replace function public.yontech_prospection_check_cron_secret(candidate text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.yontech_prospection_runtime r where r.id=1 and length(coalesce(candidate,''))>=32 and r.cron_secret=candidate)
$$;

-- L'envoi n'est réveillé que lorsqu'il y a réellement quelque chose à envoyer.
create or replace function public.yontech_prospection_should_wake(target_now timestamptz default now())
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce((
    select not s.paused and s.sender_email is not null
      and extract(isodow from target_now at time zone 'Europe/Paris')::smallint=any(s.send_days)
      and (target_now at time zone 'Europe/Paris')::time>=s.window_start
      and (target_now at time zone 'Europe/Paris')::time<s.window_end
      and (s.next_send_at is null or s.next_send_at<=target_now)
      and (exists(select 1 from public.yontech_prospection_messages m where m.status in('queued','sending'))
        or exists(select 1 from public.yontech_prospection_followups f where f.status in('queued','sending'))
        or (s.followup_enabled and exists(select 1 from public.yontech_prospection_followup_due(target_now))))
    from public.yontech_prospection_settings s where s.id=1
  ),false)
$$;

-- La recherche d'entreprises tourne jour et nuit, tant que la file est sous
-- deux jours d'envoi et que le dernier passage date de plus de 90 secondes.
create or replace function public.yontech_prospection_should_source(target_now timestamptz default now())
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce((
    select not s.paused and s.autopilot
      and (s.last_sourcing_at is null or s.last_sourcing_at<target_now-interval '90 seconds')
      and (select count(*) from public.yontech_prospection_messages m where m.status='queued')<greatest(s.daily_cap*2,s.autopilot_batch)
    from public.yontech_prospection_settings s where s.id=1
  ),false)
$$;

revoke all on function
  public.yontech_prospection_daily_cap(timestamptz),public.yontech_prospection_sent_today(timestamptz),public.yontech_prospection_per_day(),
  public.yontech_prospection_followup_due(timestamptz),public.yontech_prospection_followup_stats(timestamptz),
  public.yontech_prospection_claim_next(timestamptz),public.yontech_prospection_finish(uuid,text,uuid,text,text,text,text,integer),
  public.yontech_prospection_followup_finish(uuid,text,uuid,text,text,text,text,integer),public.yontech_prospection_mark_replied(uuid,boolean),
  public.yontech_prospection_unsubscribe(uuid),public.yontech_prospection_bounce(text,text),public.yontech_prospection_track(uuid,text,text),
  public.yontech_prospection_enqueue(jsonb,text),public.yontech_prospection_known(text[],text[]),public.yontech_prospection_mark_scanned(jsonb),
  public.yontech_prospection_scanned_stats(timestamptz),public.yontech_prospection_check_cron_secret(text),
  public.yontech_prospection_should_wake(timestamptz),public.yontech_prospection_should_source(timestamptz)
  from public,anon,authenticated;
grant execute on function
  public.yontech_prospection_daily_cap(timestamptz),public.yontech_prospection_sent_today(timestamptz),public.yontech_prospection_per_day(),
  public.yontech_prospection_followup_due(timestamptz),public.yontech_prospection_followup_stats(timestamptz),
  public.yontech_prospection_claim_next(timestamptz),public.yontech_prospection_finish(uuid,text,uuid,text,text,text,text,integer),
  public.yontech_prospection_followup_finish(uuid,text,uuid,text,text,text,text,integer),public.yontech_prospection_mark_replied(uuid,boolean),
  public.yontech_prospection_unsubscribe(uuid),public.yontech_prospection_bounce(text,text),public.yontech_prospection_track(uuid,text,text),
  public.yontech_prospection_enqueue(jsonb,text),public.yontech_prospection_known(text[],text[]),public.yontech_prospection_mark_scanned(jsonb),
  public.yontech_prospection_scanned_stats(timestamptz),public.yontech_prospection_check_cron_secret(text),
  public.yontech_prospection_should_wake(timestamptz),public.yontech_prospection_should_source(timestamptz)
  to service_role;

-- Trois tâches : envoi (chaque minute, si un envoi est dû), recherche
-- d'entreprises (toutes les deux minutes, si la file baisse), rebonds (toutes
-- les dix minutes). Les adresses dérivent de sender_url (table runtime).
do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    if exists(select 1 from cron.job where jobname='yontech-prospection-sender') then perform cron.unschedule('yontech-prospection-sender'); end if;
    perform cron.schedule('yontech-prospection-sender','* * * * *',
      $cron$select net.http_post(
        url:=r.sender_url,
        headers:=jsonb_build_object('Content-Type','application/json','x-prospection-cron',r.cron_secret),
        body:='{"job":"tick"}'::jsonb,
        timeout_milliseconds:=150000
      ) from public.yontech_prospection_runtime r where r.id=1 and public.yontech_prospection_should_wake(now());$cron$);

    if exists(select 1 from cron.job where jobname='yontech-prospection-sourcer') then perform cron.unschedule('yontech-prospection-sourcer'); end if;
    perform cron.schedule('yontech-prospection-sourcer','*/2 * * * *',
      $cron$select net.http_post(
        url:=replace(r.sender_url,'prospection-sender','prospection-sourcer'),
        headers:=jsonb_build_object('Content-Type','application/json','x-prospection-cron',r.cron_secret),
        body:='{"job":"source"}'::jsonb,
        timeout_milliseconds:=150000
      ) from public.yontech_prospection_runtime r where r.id=1 and public.yontech_prospection_should_source(now());$cron$);

    if exists(select 1 from cron.job where jobname='yontech-prospection-bounces') then perform cron.unschedule('yontech-prospection-bounces'); end if;
    perform cron.schedule('yontech-prospection-bounces','*/10 * * * *',
      $cron$select net.http_post(
        url:=replace(r.sender_url,'prospection-sender','prospection-bounces'),
        headers:=jsonb_build_object('Content-Type','application/json','x-prospection-cron',r.cron_secret),
        body:='{"job":"bounces"}'::jsonb,
        timeout_milliseconds:=120000
      ) from public.yontech_prospection_runtime r where r.id=1;$cron$);
  end if;
exception when undefined_table or insufficient_privilege or invalid_schema_name or undefined_function then
  raise notice 'pg_cron unavailable: schedule yontech-prospection-sender, -sourcer and -bounces externally';
end $$;

commit;
