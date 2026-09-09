# YouTube Audio Proxy — 本番運用（INFRA-4）

Railway（または同等のコンテナホスト）で `services/youtube-audio-proxy` を動かし、Supabase Edge `media-pipeline` / `youtube-video-meta` から呼び出す手順です。

## 1. デプロイ構成

| 項目 | 推奨 |
|------|------|
| ビルド | `services/youtube-audio-proxy/Dockerfile.railway`（Root Directory 設定時） |
| ビルド（Root Directory なし） | リポジトリ直下 `Dockerfile.railway-audio-proxy` |
| プロセス | `gunicorn --worker-class gthread --workers 1 --threads 4 --timeout 240 app:app` |
| ヘルスチェック | `GET /health`（Railway `healthcheckPath` 済み） |
| ボーカル分離 | 本番 Railway は **OFF**（`WAVRICK_VOCAL_SEPARATION=0`）。CPU/メモリ節約 |

Demucs を本番で有効にする場合は GPU インスタンスと `WAVRICK_VOCAL_SEPARATION=1` を検討してください（コスト・起動時間増）。

## 2. 必須環境変数

```env
PROXY_SECRET=（ランダム長文字列。Supabase secrets の YOUTUBE_AUDIO_PROXY_SECRET と同一）
WAVRICK_CORS_ORIGIN=https://wavrick.com
PORT=8080
# 文字起こし用（Edge のメモリ節約: 音声を Storage に直接保存）
SUPABASE_URL=https://gdolqgcftxqxaacjyqla.supabase.co
SUPABASE_SERVICE_ROLE_KEY=（Supabase Dashboard → Settings → API → service_role）
```

任意（レート制限 SEC-5）:

```env
WAVRICK_RL_EXTRACT_PER_MIN=6
WAVRICK_RL_VIDEO_META_PER_MIN=30
WAVRICK_YT_MAX_CONCURRENT_EXTRACT=2
WAVRICK_YT_BUSY_WAIT_SEC=2
WAVRICK_GUNICORN_THREADS=4
WAVRICK_GUNICORN_TIMEOUT=240
WAVRICK_YT_SOCKET_TIMEOUT=90
```

Edge `media-pipeline` の fetch 打ち切りは **250 秒**（gunicorn 240 秒より長い）。混雑時はキューで待たせず 503 BUSY。

YouTube が Railway のデータセンター IP を拒否する場合（502 / 403）:

- **第一選択:** 依頼フォームで音声ファイル（mp3/m4a）を直接アップロード（`YT_EXTRACT_BLOCKED` UI）
- **第二選択:** しばらく待って再試行（同一動画は Supabase `youtube_audio_cache` で 30 日キャッシュ）
- **住宅プロキシ:** 将来検討（今回スコープ外）。必要なら `WAVRICK_YT_PROXY=socks5h://...`

### Cookies（非推奨・任意）

**本番では運営 Google アカウントの cookies 共有（`WAVRICK_YT_COOKIES_B64`）は使わないでください。**
アカウント停止リスクがあり、media-pipeline 側でチャンネル所有者チェック＋キャッシュが主な対策です。

ローカル検証のみ、明示的 opt-in:

```env
WAVRICK_YT_USE_COOKIES=1
WAVRICK_YT_COOKIES_B64=<base64 1行>   # または WAVRICK_YT_COOKIES=/path/to/cookies.txt
```

`WAVRICK_YT_USE_COOKIES` 未設定（既定）では cookies は **一切** yt-dlp に渡りません。

**重要:** 環境変数だけ追加では不十分です。**GitHub から Railway を再デプロイ**し、最新の `app.py` を反映してください。

デプロイ後 `GET /health` で確認:

```json
"youtubeCookiesEnabled": false,
"youtubeCookiesLoaded": false,
"maxConcurrentExtract": 2,
"remoteComponents": ["ejs:github"]
```

`youtubeCookiesEnabled: true` はローカル検証用のみ。本番は `false` が正常です。

## 3. Supabase secrets

```text
YOUTUBE_AUDIO_PROXY_URL=https://<your-service>.up.railway.app/extract
YOUTUBE_AUDIO_PROXY_SECRET=<PROXY_SECRET と同じ>
```

`youtube-video-meta` は URL 末尾の `/extract` を自動で除去して `/video-meta` を呼びます。

### media-pipeline 側（チャンネルガード・キャッシュ・レート制限）

マイグレーション `202609021200_youtube_audio_cache.sql` 適用後:

```bash
./scripts/apply-supabase-migrations.sh
supabase functions deploy media-pipeline youtube-video-meta
```

任意 Edge secrets:

```text
WAVRICK_RL_YT_EXTRACT_DAY=10
WAVRICK_RL_YT_EXTRACT_HOUR=2
WAVRICK_YT_CACHE_TTL_DAYS=30
```

- JWT 必須（未ログインは YouTube extract 不可）
- 登録チャンネルと一致しない URL は **403**（proxy に到達しない）
- 管理者のみバイパス（`admin_users_public`）

### テスト段階（チャンネルガード・レート制限オフ）

**本番公開前に必ず OFF に戻すこと。**

Supabase Edge secrets:

```text
WAVRICK_YT_TEST_MODE=1
```

または `WAVRICK_YT_CHANNEL_GUARD=0`（同等: チャンネル一致チェック無効）。

効果:

- ログイン済みなら **任意の YouTube URL** で extract（チャンネル meta ゲートなし）
- YouTube extract の **日次/時間レート制限スキップ**

フロント（本番 Hostinger）:

- 本番では `WAVRICK_YT_TEST_MODE` を **入れない**（チャンネル所有確認が無効になる）
- ローカル開発のみ: 依頼画面 URL に `?yt_test=1`（`wavrick.com` では無効）

```bash
supabase secrets set WAVRICK_YT_TEST_MODE=1
supabase functions deploy media-pipeline
```

## 4. 本番確認スクリプト

リポジトリ直下で:

```bash
# .local/secrets.env に YOUTUBE_AUDIO_PROXY_URL を書いておくと便利
export YOUTUBE_AUDIO_PROXY_URL=https://xxxx.up.railway.app/extract
export YOUTUBE_AUDIO_PROXY_SECRET=your-secret
./scripts/check-audio-proxy-production.sh
```

成功時: `ok: true`、ffmpeg パス、`rateLimit` オブジェクトが表示されます。

チャンネルガード・キャッシュキーの単体テスト:

```bash
node scripts/test-youtube-channel-cache.mjs
```

## 5. ログ・障害時

| 症状 | 確認 |
|------|------|
| 502 / `YT_EXTRACT_BLOCKED` | Railway ログで yt-dlp 403 / ボット判定。音声ファイル直接アップロードを案内 |
| 403 / `CHANNEL_MISMATCH` | 第三者チャンネル URL。登録チャンネルの動画のみ許可（正常動作） |
| Storage upload HTML 400 | Railway の `SUPABASE_URL` が `https://<ref>.supabase.co` か、`SUPABASE_SERVICE_ROLE_KEY` が JWT（`eyJ…`）か確認 |
| 401 / `AUTH_REQUIRED` | ログイン後に extract。Supabase JWT が media-pipeline に付与されているか |
| 429 | レート制限（IP / ユーザー）。`Retry-After` 秒後に再試行 |
| 503 / `BUSY` | 同時 extract 上限。2 秒待って空きがなければ即 503（`Retry-After: 8`）。Edge が最大 90 秒リトライ。`WAVRICK_YT_MAX_CONCURRENT_EXTRACT`（既定 2） |
| タイムアウト | gunicorn `--timeout 240`。Edge の AbortSignal は **250 秒**（gunicorn より長くし、`Signal timed out` を出さない）。混雑は BUSY で返す |
| `/health` が遅い | 旧 sync workers=1 だと extract 中にヘルスも止まる。gthread 再デプロイ後は extract 中でも `/health` が数秒で返る |
| 2 回目以降が速い | `youtube_audio_cache` ヒット（YouTube 再アクセスなし） |

## 6. グレースフルシャットダウン

Railway は SIGTERM でコンテナを停止します。進行中の `/extract` は最大 gunicorn timeout まで待機後に切断されます。デプロイはトラフィックが少ない時間帯が安全です。

## 7. Edge 側レート制限（SEC-5）

`media-pipeline` / `youtube-video-meta` は Supabase マイグレーション `202606031200_api_rate_limits.sql` 適用後、DB でカウント共有します（未適用時は Edge インスタンス内メモリのみ）。

```bash
supabase db push
# または SQL Editor で migrations/202606031200_api_rate_limits.sql を実行
supabase functions deploy media-pipeline youtube-video-meta
```

環境変数（Edge secrets、任意）:

```text
WAVRICK_RL_TRANSCRIBE_HOUR=8
WAVRICK_RL_SCRIPT_HOUR=24
WAVRICK_RL_FULL_HOUR=4
WAVRICK_RL_BURST_PER_MIN=30
WAVRICK_RL_VIDEO_META_PER_MIN=40
WAVRICK_RL_YT_EXTRACT_DAY=10
WAVRICK_RL_YT_EXTRACT_HOUR=2
```
