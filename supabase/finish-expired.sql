-- Apply after individual-links.sql. Existing submitted results are preserved.
begin;
create or replace function public.foco_submit(p_token uuid, p_revision text, p_attempt jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare t public.foco_tests; answer record; question jsonb; existing public.foco_attempts; cleaned jsonb; link public.foco_links;
begin
  if not public.foco_valid_attempt(p_attempt) then raise exception 'Relatório inválido ou acima do limite permitido.'; end if;
  select * into link from public.foco_links where token = p_token for update;
  if not found or link.attempt is null then raise exception 'Link indisponível ou tentativa não iniciada.'; end if;
  select * into t from public.foco_tests where owner_id = link.owner_id and id = link.quiz_id;
  t.quiz := link.quiz; t.revision := link.revision;
  if p_attempt->>'id' is distinct from link.attempt->>'id' then raise exception 'Este link já está vinculado a outra tentativa.'; end if;
  p_attempt := p_attempt || jsonb_build_object('participant', link.attempt->'participant', 'startedAt', link.attempt->'startedAt');
  if clock_timestamp() >= to_timestamp((link.attempt->>'deadline')::numeric / 1000) then
    p_attempt := p_attempt || jsonb_build_object('responses', link.attempt->'responses', 'events', link.attempt->'events', 'submissionReason', 'time', 'submittedAt', to_timestamp((link.attempt->>'deadline')::numeric / 1000));
  end if;
  if not found then raise exception 'Avaliação indisponível. Peça um novo link ao avaliador.'; end if;
  select * into existing from public.foco_attempts where owner_id = t.owner_id and id = p_attempt->>'id';
  if found then
    if existing.quiz_id <> t.id then raise exception 'Identificador de tentativa já utilizado.'; end if;
    return true;
  end if;
  if p_revision is distinct from t.revision::text then raise exception 'A avaliação foi editada durante a aplicação. Baixe seu comprovante e avise o avaliador.'; end if;
  for question in select value from jsonb_array_elements(t.quiz->'questions') loop
    if length(trim(question->>'text')) = 0 then raise exception 'Avaliação incompleta.'; end if;
  end loop;
  for answer in select key, value from jsonb_each(p_attempt->'responses') loop
    select q into question from jsonb_array_elements(t.quiz->'questions') q where q->>'id' = answer.key;
    if not found then raise exception 'Resposta para pergunta desconhecida.'; end if;
    if question->>'type' = 'multiple' and (answer.value #>> '{}') not in ('','A','B','C','D') then raise exception 'Alternativa inválida.'; end if;
  end loop;
  cleaned := jsonb_build_object('id', p_attempt->'id', 'quizId', t.id, 'quizTitle', t.quiz->'title',
    'participant', trim(p_attempt->>'participant'), 'startedAt', p_attempt->'startedAt', 'submittedAt', p_attempt->'submittedAt',
    'submissionReason', p_attempt->'submissionReason', 'responses', p_attempt->'responses', 'events', p_attempt->'events',
    'quizSnapshot', t.quiz, 'snapshotLocked', true);
  insert into public.foco_attempts(owner_id,id,quiz_id,data) values(t.owner_id, p_attempt->>'id', t.id, cleaned)
    on conflict (owner_id,id) do nothing;
  update public.foco_links set attempt = p_attempt || jsonb_build_object('quizId', t.id, 'quizSnapshot', link.attempt->'quizSnapshot', 'deadline', link.attempt->'deadline') where token = p_token;
  -- ponytail: public links accept submissions; add CAPTCHA/rate limiting if shared beyond trusted participants.
  return true;
end $$;
create or replace function public.foco_finish_expired() returns integer
language plpgsql security definer set search_path = '' as $$
declare l public.foco_links; finished integer := 0;
begin
 for l in select * from public.foco_links
   where attempt is not null and attempt->>'submittedAt' is null
     and to_timestamp((attempt->>'deadline')::numeric / 1000) <= clock_timestamp()
   for update skip locked
 loop
  begin
   perform public.foco_submit(l.token, l.revision::text, l.attempt || jsonb_build_object(
     'submittedAt', to_timestamp((l.attempt->>'deadline')::numeric / 1000), 'submissionReason', 'time'));
   finished := finished + 1;
  exception when others then
   -- Keep one invalid attempt from delaying all other participants.
   raise warning 'foco_finish_expired: attempt %, SQLSTATE %', l.attempt->>'id', sqlstate;
  end;
 end loop;
 return finished;
end $$;
revoke execute on function public.foco_finish_expired() from public, anon, authenticated;
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('foco-finish-expired', '* * * * *', 'select public.foco_finish_expired()');
notify pgrst, 'reload schema';
commit;
