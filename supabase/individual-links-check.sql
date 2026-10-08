-- Run after finish-expired.sql. Everything is rolled back, including the two test users.
begin;
insert into auth.users(id,email) values
  ('70000000-0000-4000-8000-000000000001','foco-check-one@example.invalid'),
  ('70000000-0000-4000-8000-000000000002','foco-check-two@example.invalid');
insert into public.foco_tests(owner_id,id,share_token,quiz) values(
  '70000000-0000-4000-8000-000000000001', 'check-test', '70000000-0000-4000-8000-000000000003',
  '{"id":"check-test","title":"Teste","durationMinutes":1,"questions":[{"id":"q1","type":"multiple","text":"Pergunta","options":[{"letter":"A","text":"a"},{"letter":"B","text":"b"},{"letter":"C","text":"c"},{"letter":"D","text":"d"}],"correct":"A"}]}'
);

select set_config('request.jwt.claim.sub','70000000-0000-4000-8000-000000000001',true);
do $$
declare link_token uuid; expired uuid; first jsonb; resumed jsonb; report jsonb;
begin
 link_token := public.foco_create_link('check-test');
 expired := public.foco_create_link('check-test');
 assert link_token <> expired, 'Cada cópia deve gerar um link novo';
 assert not (public.foco_public_test(link_token)->'quiz' ? 'questions'), 'Perguntas expostas antes do início';
 update public.foco_links set expires_at = now() - interval '1 second' where foco_links.token = expired;
 begin
  perform public.foco_start(expired,'Pessoa');
  raise exception 'Expiração ignorada';
 exception when raise_exception then
  if sqlerrm <> 'O link expirou. Peça um novo link ao avaliador.' then raise; end if;
 end;
 first := public.foco_start(link_token,'Pessoa');
 resumed := public.foco_start(link_token,'Outro nome');
 assert first = resumed, 'Reinício alterou tentativa, participante ou prazo';
 assert not (first->'quiz'->'questions'->0 ? 'correct'), 'Gabarito exposto';
 report := first->'attempt';
 assert public.foco_save(link_token,report || '{"responses":{"q1":"A"}}'), 'Salvamento recusado';
 assert public.foco_public_test(link_token)->'attempt'->'responses'->>'q1' = 'A', 'Resposta não retomada';
 update public.foco_links set expires_at = now() - interval '1 second' where foco_links.token = link_token;
 assert public.foco_public_test(link_token)->'attempt'->>'id' = report->>'id', 'Expiração bloqueou tentativa iniciada';
 begin
  perform public.foco_submit(link_token,first->>'revision',report || jsonb_build_object('id','forged','submittedAt',clock_timestamp(),'submissionReason','manual'));
  raise exception 'Outra tentativa aceita';
 exception when raise_exception then
  if sqlerrm <> 'Este link já está vinculado a outra tentativa.' then raise; end if;
 end;
 update public.foco_links set attempt = attempt || jsonb_build_object('deadline',floor(extract(epoch from clock_timestamp()) * 1000)-1) where foco_links.token = link_token;
 assert not public.foco_save(link_token,report), 'Respostas aceitas depois do prazo';
 report := report || jsonb_build_object('submittedAt',clock_timestamp(),'submissionReason','manual','responses','{"q1":"B"}'::jsonb);
 assert public.foco_submit(link_token,first->>'revision',report), 'Envio recusado';
 assert public.foco_submit(link_token,first->>'revision',report), 'Reenvio não idempotente';
 assert (select count(*) = 1 from public.foco_attempts), 'Resultado duplicado';
 assert (select data->'responses'->>'q1' = 'A' and data->>'submissionReason' = 'time' from public.foco_attempts), 'Prazo não aplicado no servidor';
 begin
  perform public.foco_public_test(link_token);
  raise exception 'Link finalizado reaberto';
 exception when raise_exception then
  if sqlerrm <> 'Esta avaliação já foi finalizada.' then raise; end if;
 end;
end $$;
do $$
declare expired uuid; active uuid; first jsonb; deadline timestamptz;
begin
 assert not has_function_privilege('anon','public.foco_finish_expired()','execute'), 'Finalizador acessível publicamente';
 assert not has_function_privilege('authenticated','public.foco_finish_expired()','execute'), 'Finalizador acessível ao avaliador';
 expired := public.foco_create_link('check-test');
 active := public.foco_create_link('check-test');
 first := public.foco_start(expired,'Notebook em repouso');
 perform public.foco_start(active,'Ainda respondendo');
 assert public.foco_save(expired,first->'attempt' || '{"responses":{"q1":"A"}}'), 'Resposta inicial não salva';
 deadline := to_timestamp(floor(extract(epoch from clock_timestamp()) * 1000) / 1000) - interval '1 second';
 update public.foco_links set attempt = attempt || jsonb_build_object('deadline',extract(epoch from deadline)*1000) where token = expired;
 perform public.foco_finish_expired();
 assert (select data->'responses'->>'q1' = 'A' and data->>'submissionReason' = 'time'
   and (data->>'submittedAt')::timestamptz = deadline and data->>'snapshotLocked' = 'true'
   from public.foco_attempts where id = first->'attempt'->>'id'), 'Encerramento sem navegador incorreto';
 assert (select attempt->>'submittedAt' is null from public.foco_links where token = active), 'Tentativa ativa encerrada antes do prazo';
 assert public.foco_submit(expired,first->>'revision',first->'attempt' || jsonb_build_object(
   'submittedAt',clock_timestamp(),'submissionReason','manual','responses','{"q1":"B"}'::jsonb)), 'Reenvio após repouso recusado';
 perform public.foco_finish_expired();
 assert (select count(*) = 1 and bool_and(data->'responses'->>'q1' = 'A') from public.foco_attempts
   where id = first->'attempt'->>'id'), 'Reenvio duplicou ou alterou respostas';
end $$;
rollback;
