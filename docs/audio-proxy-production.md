# YouTube Audio Proxy — 本番運用（INFRA-4）

Railway（または同等のコンテナホスト）で `services/youtube-audio-proxy` を動かし、Supabase Edge `media-pipeline` / `youtube-video-meta` から呼び出す手順です。

## 1. デプロイ構成

| 項目 | 推奨 |
|------|------|
| ビルド | `services/youtube-audio-proxy/Dockerfile.railway`（Root Directory 設定時） |
| ビルド（Root Directory なし） | リポジトリ直下 `Dockerfile.railway-audio-proxy` |
| プロセス | `gunicorn --bind 0.0.0.0:$PORT --timeout 300 app:app` |
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
```

YouTube が Railway のデータセンター IP を拒否する場合（502 / 403）:

```env
WAVRICK_YT_PROXY=socks5h://user:pass@proxy.example.com:7000
WAVRICK_YT_PLAYER_CLIENT=android,web
```

住宅系プロキシが必要なケースがあります。

**ボット判定**（`Sign in to confirm you're not a bot`）が出たら、ログイン済み cookies を Railway に渡す:

```bash
./scripts/export-youtube-cookies-for-railway.sh
```

Railway Variables:

```env
WAVRICK_YT_COOKIES_B64=<スクリプトが出力した base64 1行>
```

（ローカルファイルマウント可能な環境のみ `WAVRICK_YT_COOKIES=/path/to/cookies.txt` も可。cookies は数週間で再設定が必要なことがあります。）

**重要:** 環境変数だけ追加では不十分です。**GitHub から Railway を再デプロイ**し、最新の `app.py`（cookies + `ejs:github` 対応）を反映してください。

デプロイ後 `GET /health` で確認:

```json
"youtubeCookiesLoaded": true,
"remoteComponents": ["ejs:github"]
```

どちらかが `false` / 空なら設定ミスです。

## 3. Supabase secrets

```text
YOUTUBE_AUDIO_PROXY_URL=https://<your-service>.up.railway.app/extract
YOUTUBE_AUDIO_PROXY_SECRET=<PROXY_SECRET と同じ>
```

`youtube-video-meta` は URL 末尾の `/extract` を自動で除去して `/video-meta` を呼びます。

## 4. 本番確認スクリプト

リポジトリ直下で:

```bash
# .local/secrets.env に YOUTUBE_AUDIO_PROXY_URL を書いておくと便利
export YOUTUBE_AUDIO_PROXY_URL=https://xxxx.up.railway.app/extract
export YOUTUBE_AUDIO_PROXY_SECRET=your-secret
./scripts/check-audio-proxy-production.sh
```

成功時: `ok: true`、ffmpeg パス、`rateLimit` オブジェクトが表示されます。

## 5. ログ・障害時

| 症状 | 確認 |
|------|------|
| 502 / extract failed | Railway ログで yt-dlp 403。プロキシ無効化や音声ファイル直接アップロードを案内 |
| 401 | `Authorization: Bearer` と `PROXY_SECRET` の不一致 |
| 429 | レート制限。`Retry-After` 秒後に再試行 |
| タイムアウト | gunicorn `--timeout 300`。長い動画は demucs OFF 推奨 |
| 書き起こしが途中で終わる | 旧版は yt-dlp `max_filesize` で元音声が途中切断されていた（10分→約4〜5分）。`WAVRICK_MAX_AUDIO_BYTES`（既定48MB）は **変換後** の返却のみに適用（128kbps MP3 想定・約50分弱） |

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
```
