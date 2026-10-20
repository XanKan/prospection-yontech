-- Relances réservées aux prospects engagés : vraie ouverture ou clic, robots
-- (passerelles de sécurité qui suivent les liens) exclus. Réglage activé.
CREATE OR REPLACE FUNCTION public.yontech_prospection_followup_due(target_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(message_id uuid, stage smallint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.id,
    case when exists(select 1 from public.yontech_prospection_followups f where f.message_id=m.id and f.stage=1 and f.status='sent') then 2 else 1 end::smallint
  from public.yontech_prospection_messages m, public.yontech_prospection_settings s
  where s.id=1 and s.followup_enabled
    and m.status='sent' and m.sent_at is not null and m.replied_at is null
    and (s.followup_since is null or m.sent_at>=s.followup_since)
    and not exists(select 1 from public.yontech_prospection_suppressions x where x.email=m.email)
    and not exists(select 1 from public.yontech_maquettes q where q.message_id=m.id)
    and (not s.followup_opened_only or ((m.opened_at is not null or m.site_clicked_at is not null) and m.scanner_at is null))
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
$function$;

update public.yontech_prospection_settings set followup_opened_only=true where id=1;
