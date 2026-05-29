-- 顧客音声アップロード（Whisper 文字起こし用・公開読み取り）
insert into storage.buckets (id, name, public)
values ('customer-uploads', 'customer-uploads', true)
on conflict (id) do update set public = true;

drop policy if exists "customer_uploads_auth_insert" on storage.objects;
create policy "customer_uploads_auth_insert"
on storage.objects for insert
to authenticated
with check (bucket_id = 'customer-uploads');
