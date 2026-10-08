-- Apply to an existing Foco database before using the new links. Old shared links are retired.
begin;
create table public.foco_links (
 token uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 quiz_id text not null,
 quiz jsonb not null,
 revision uuid not null,
 expires_at timestamptz not null default (now() + interval '10 minutes'),
 attempt jsonb,
 foreign key(owner_id, quiz_id) references public.foco_tests(owner_id,id) on delete cascade
);
alter table public.foco_links enable row level security;
revoke all on public.foco_links from public, anon, authenticated;
create or replace function public.foco_create_link(p_quiz_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
 insert into public.foco_links(owner_id,quiz_id,quiz,revision)
 select owner_id,id,quiz,revision from public.foco_tests where owner_id = auth.uid() and id = p_quiz_id returning token into result;
 if result is null then raise exception 'Avaliação indisponível.'; end if;
 return result;
end $$;
create or replace function public.foco_link_quiz(q jsonb) returns jsonb
language sql immutable set search_path = '' as $$
 select q || jsonb_build_object('questions', (select jsonb_agg(value - 'correct') from jsonb_array_elements(q->'questions')));
$$;
create or replace function public.foco_public_test(p_token uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.foco_links;
begin
 select * into l from public.foco_links where token = p_token;
 if not found then raise exception 'Link inválido. Peça um novo link ao avaliador.'; end if;
 if l.attempt is null and clock_timestamp() >= l.expires_at then raise exception 'O link expirou. Peça um novo link ao avaliador.'; end if;
 if l.attempt->>'submittedAt' is not null then raise exception 'Esta avaliação já foi finalizada.'; end if;
 return jsonb_build_object('revision',l.revision,'attempt',l.attempt,'quiz',case when l.attempt is null then jsonb_build_object('id',l.quiz_id,'title',l.quiz->'title','instructions',l.quiz->'instructions','durationMinutes',l.quiz->'durationMinutes','questionCount',jsonb_array_length(l.quiz->'questions'),'multipleCount',(select count(*) from jsonb_array_elements(l.quiz->'questions') q where q->>'type'='multiple'),'freeCount',(select count(*) from jsonb_array_elements(l.quiz->'questions') q where q->>'type'='free')) else public.foco_link_quiz(l.quiz) end);
end $$;
create or replace function public.foco_start(p_token uuid,p_participant text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.foco_links; started timestamptz := clock_timestamp();
begin
 select * into l from public.foco_links where token = p_token for update;
 if not found then raise exception 'Link inválido.'; end if;
 if l.attempt is null then
  if started >= l.expires_at then raise exception 'O link expirou. Peça um novo link ao avaliador.'; end if;
  if p_participant is null or length(trim(p_participant)) not between 1 and 120 then raise exception 'Informe seu nome (até 120 caracteres).'; end if;
  l.attempt := jsonb_build_object('id',gen_random_uuid()::text,'quizId',l.quiz_id,'quizTitle',l.quiz->'title','participant',trim(p_participant),'startedAt',started,'deadline',floor(extract(epoch from (started + (l.quiz->>'durationMinutes')::int * interval '1 minute')) * 1000),'submittedAt',null,'submissionReason',null,'responses','{}'::jsonb,'events','[]'::jsonb,'quizSnapshot',public.foco_link_quiz(l.quiz));
  update public.foco_links set attempt = l.attempt where token = p_token;
 end if;
 return public.foco_public_test(p_token);
end $$;
create or replace function public.foco_save(p_token uuid,p_attempt jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare l public.foco_links; answer record; question jsonb;
begin
 select * into l from public.foco_links where token = p_token for update;
 if not found or l.attempt is null or l.attempt->>'submittedAt' is not null or p_attempt->>'id' is distinct from l.attempt->>'id' then raise exception 'Tentativa indisponível.'; end if;
 if clock_timestamp() >= to_timestamp((l.attempt->>'deadline')::numeric / 1000) then return false; end if;
 if not public.foco_valid_attempt(p_attempt || jsonb_build_object('startedAt',l.attempt->'startedAt','submittedAt',clock_timestamp(),'submissionReason','manual')) then raise exception 'Respostas inválidas.'; end if;
 for answer in select key,value from jsonb_each(p_attempt->'responses') loop
  select q into question from jsonb_array_elements(l.quiz->'questions') q where q->>'id' = answer.key;
  if not found or (question->>'type' = 'multiple' and (answer.value #>> '{}') not in ('','A','B','C','D')) then raise exception 'Resposta inválida.'; end if;
 end loop;
 update public.foco_links set attempt = l.attempt || jsonb_build_object('responses',p_attempt->'responses','events',p_attempt->'events') where token = p_token;
 return true;
end $$;
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


revoke execute on function public.foco_create_link(text),public.foco_link_quiz(jsonb),public.foco_start(uuid,text),public.foco_save(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.foco_create_link(text) to authenticated;
grant execute on function public.foco_public_test(uuid),public.foco_start(uuid,text),public.foco_save(uuid,jsonb),public.foco_submit(uuid,text,jsonb) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
