-- Familles de métiers des modèles (illustrations propres au métier d'origine).
begin;
alter table public.yontech_maquette_templates add column if not exists groupe text not null default 'autre';
update public.yontech_maquette_templates t set groupe = case
  when n ~ '^43\.32' then 'menuiserie' when n ~ '^(43\.21|42\.22)' then 'electricite' when n ~ '^(43\.22|42\.21)' then 'plomberie'
  when n ~ '^(43\.91|43\.99A)' then 'toiture' when n ~ '^(41\.|42\.|43\.1|43\.99[BCDE])' then 'gros_oeuvre' when n ~ '^(43\.3|43\.29)' then 'finitions' else 'autre' end
from (select q.id, upper(coalesce(m.data->>'naf','')) n from public.yontech_maquettes q left join public.yontech_prospection_messages m on m.id=q.message_id) s
where s.id=t.source_id;
commit;
select kind, groupe, count(*) from public.yontech_maquette_templates where status='ok' group by 1,2 order by 1,2;
