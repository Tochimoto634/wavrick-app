# YouTube Audio Proxy — 本番運用（INFRA-4）

Railway（または同等のコンテナホスト）で `services/youtube-audio-proxy` を動かし、Supabase Edge `media-pipeline` / `youtube-video-meta` から呼び出す手順です。

## 1. デプロイ構成

| 項目 | 推奨 |
|------|------|
| ビルド | `services/youtube-audio-proxy/Dockerfile.railway`（Root Directory 設定時） |
| ビルド（Root Directory なし） | リポジトリ直下 `Dockerfile.railway-audio-proxy` |
| プロセス | `gunicorn --worker-class gthread --workers 1 --threads 4 --timeout 240 app:app` |
| yt-dlp | Railway は **pre-release 固定**（`requirements-railway.txt`）。`Failed to extract any player response` は版が古いサイン → pin を上げて再デプロイ |
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

## 2-b. YouTube のボット判定（datacenter IP）

`Sign in to confirm you're not a bot` / `Failed to extract any player response` /
`0 tracks` は、ほぼ全て **Railway が datacenter IP である** ことが原因です。
cookies も POT も yt-dlp の版も**アプリケーション層**の対策で、YouTube の IP
レピュテーション判定はそれより手前で走るため、これらでは解決しません。

まず `/health` で application 層が揃っているか確認します:

```bash
curl -sS --max-time 10 "https://handsome-warmth-production-d61f.up.railway.app/health" \
  | python3 -c 'import sys,json; h=json.load(sys.stdin); print({k:h.get(k) for k in ["extractBuild","ytDlpVersion","imageBuiltAt","potProviderReady","youtubeCookiesEnabled","ytProxyConfigured","ytProxy","ytProxyDirectDownload"]})'
```

`potProviderReady: true` かつ `ytDlpVersion` が nightly なのに 403 が出るなら、
残っているのは IP 層だけです。

### 住宅プロキシ（IP 層の唯一の直接対策）

```env
WAVRICK_YT_PROXY=http://USER:PASS@gate.example.com:7777
```

コード側は配線済みなので、Railway に環境変数を入れて再デプロイするだけです。

**スティッキーセッション必須。** googlevideo の URL は、それを発行した probe の
出口 IP に紐づきます。リクエストごとに IP が変わるローテーティング型を使うと、
probe と download で IP が食い違って必ず HTTP 403 になります。ジョブ単位で IP を
固定できるプランを選んでください。

**スキームは http / https を推奨。** 直 URL ダウンロード（probe が発行した
googlevideo URL を yt-dlp を再度通さずに取る近道）は urllib で行うため、
socks では同じプロキシを通せません。socks を指定した場合はこの近道を自動的に
無効化し、yt-dlp 経由のダウンロードにフォールバックします（socks は yt-dlp が
自前で扱えるため正しく動きますが、その分だけ遅くなります）。
`/health` の `ytProxyDirectDownload` で今どちらかを確認できます。

**帯域の目安。** 128kbps・10 分の動画で約 10MB。$3〜8/GB のプランなら 1 回あたり
数円です。Supabase Storage へのアップロードはプロキシを通さない実装なので、
課金対象は YouTube との通信だけです。

### 併用する緩和策

- **音声ファイルのアップロード:** 顧客は動画の所有者なので元マスターを持っています。
  128kbps 再エンコードより音質が良く、文字起こし精度も上がります。
- **キャッシュ:** 同一動画は Supabase `youtube_audio_cache` に 30 日残り、
  ユーザー横断で再利用されます。キャッシュヒット時は YouTube に一切触りません。

## 2-c. YouTube 接触方針（必須）

Wavrick は「通すためなら何度でも試す」ではなく、**接触を抑えて通す**を方針にします。

1. **player_client は `web_embedded` 1つだけ** — 総当たりしない。
2. **probe は 1 回だけ。その info を使い回してダウンロードする** — ADR の
   「原音 + ja」でも YouTube の player API 接触は合計 1 回。
3. **format は probe が返した `format_id` を直接指定** — `bestaudio…/best` の
   カスケードに落とさない（`best` は映像込みで重い）。
4. **キャッシュを本線にする** — 同一 `video_id` + 言語トラックは Storage 再利用。
5. **再試行を前提にする** — ADR で片方だけ成功した場合、再試行は未取得側だけになり
   YouTube 接触が減る。タイムアウト文言でも再試行を案内する。
6. **タイムアウト延長や深追い総当たりで粘らない** — IP 評判悪化・250秒切れの元凶になる。

### 実測（2026-09-10 / 住宅 IP 出口 / yt-dlp 2026.08.30 pin / 8分47秒の動画）

player_client 別 probe:

| client | 所要 | URL 付き音声形式 | ja |
|---|---|---|---|
| `web_embedded` | 4.0s | **89** | あり |
| `web` | 2.7s | 0（GVS PO Token / Visitor Data 不足） | なし |
| `tv` | 1.5s | 0（page needs to be reloaded） | なし |
| `tv_simply` | 1.4s | 0（bot 判定） | なし |
| `mweb` | 3.3s | 0（PO Token 必須） | なし |

ダウンロード方式別:

| 方式 | 所要 | 結果 |
|---|---|---|
| yt-dlp（トラックごとに再抽出） | 8.3〜9.0s | 成功 |
| yt-dlp（probe の info を再利用） | **0.7〜1.3s** | 成功 |
| urllib で直 googlevideo URL | 255s 無応答→0バイト / 403 | **失敗** |

直 URL の近道は **既定 OFF**（`WAVRICK_YT_DIRECT_URL=1` で比較用に復活）。
250 秒 PROXY_TIMEOUT の主因はこの経路でした。

### 等価な yt-dlp コマンド

```bash
# 1. probe（YouTube への player 接触はこの 1 回だけ）
yt-dlp -J --skip-download \
  --proxy "$WAVRICK_YT_PROXY" --no-playlist --socket-timeout 90 \
  --extractor-args "youtube:player_client=web_embedded;player_skip=webpage" \
  "https://www.youtube.com/watch?v=<id>" > info.json

# 2. トラックごとに info.json から取得（YouTube に再接触しない）
yt-dlp --load-info-json info.json \
  --proxy "$WAVRICK_YT_PROXY" --no-playlist --socket-timeout 90 \
  --retries 3 --fragment-retries 5 --nopart \
  -f 140-9 \
  -x --audio-format mp3 --audio-quality 128 -o "out.%(ext)s"
```

プロキシ利用時は `--force-ipv4` / `--force-ipv6` を **付けない**。IP ファミリの指定は
googlevideo ではなくプロキシホストへの接続に効くため、AAAA を持たないプロキシでは
ダウンロードごと失敗します。

上書きが必要なときだけ:

```env
WAVRICK_YT_PLAYER_CLIENT=web_embedded
WAVRICK_YT_LANG_PLAYER_CLIENT=web_embedded
```

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
YOUTUBE_DATA_API_KEY=<Google Cloud の YouTube Data API v3 キー>
```

`youtube-video-meta` は URL 末尾の `/extract` を自動で除去して `/video-meta` を呼びます。

### `YOUTUBE_DATA_API_KEY`（強く推奨）

チャンネル所有者の判定に使います。設定すると、フロントの事前チェックと Edge の
チャンネルガードが **yt-dlp を経由しなくなり**、ボット判定も 60 秒タイムアウトも
受けません。1 動画あたり 1 unit（日次 10,000）で、実質無料です。

Google Cloud コンソール → API とサービス → YouTube Data API v3 を有効化 → 認証情報で
API キーを作成。キーの制限は「YouTube Data API v3」のみに絞ってください。

未設定でも動作します（従来どおり yt-dlp `/video-meta` にフォールバック）が、
1 リクエストあたりの yt-dlp セッションが 1 回から 3 回に戻ります。非公開動画は
Data API では引けないため、その場合だけ自動的に yt-dlp 経路に落ちます。

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
| 502 / `FETCH_FAILED` + `player response` | yt-dlp が古い。`requirements-railway.txt` の pin を最新 `.dev0` に上げて Railway 再デプロイ。`/health` の `ytDlpVersion` を確認 |
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
