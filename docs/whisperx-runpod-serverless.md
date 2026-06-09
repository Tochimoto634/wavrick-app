# WhisperX on RunPod Serverless（Load Balancer）

Wavrick の WhisperX を **RunPod Serverless Load Balancer** で動かす手順です。既存の FastAPI（`/health`, `/transcribe`）をそのまま使えます。

## Pod との違い

| 項目 | GPU Pod | Serverless LB |
|------|---------|---------------|
| 課金 | 起動中ずっと | リクエスト処理中のみ |
| URL | TCP マッピング（IP:ポート） | `https://<ENDPOINT_ID>.api.runpod.ai` |
| 認証 | `WHISPERX_SERVICE_SECRET` | `RUNPOD_API_KEY`（+ 任意で SECRET） |
| 実装変更 | なし | クライアントが RunPod URL を向ける |

キュー型 Serverless（`/runsync`）ではなく **Load Balancer 型** を使う理由:

- multipart の音声 POST がそのまま使える（20MB JSON 制限を回避）
- 長尺文字起こしに同期 HTTP が使える
- 既存 `app.py` をほぼそのままデプロイできる

---

## 1. Docker イメージをビルド & push

依存（torch CUDA / transformers / numpy<2 等）は **ビルド時に自動検証** されます。

```bash
./scripts/deploy-whisperx-serverless.sh YOUR_USER/wavrick-whisperx-serverless:stable
```

`:latest` は RunPod がキャッシュすることがあるため **`:stable` など固定タグ推奨**。

## 2. RunPod で Endpoint を作成

1. [RunPod Console](https://www.console.runpod.io/serverless) → **New Endpoint**
2. **Import from Docker Registry** → 上記イメージ
3. **Endpoint Type**: **Load Balancer**
4. **GPU**: RTX 4090 / A4000 など 16GB+ VRAM 推奨
5. **Container Disk**: 20GB+
6. **Network Volume**（任意・推奨）: 10〜50GB を `/runpod-volume` にマウント（モデルキャッシュ）
7. **Expose HTTP Ports**: `80`
8. 環境変数: `runpod-serverless.env.example` を参考に設定（`PORT=80` / `PORT_HEALTH=80`）
9. **Workers**: Min `0`（アイドル課金なし）または `1`（コールドスタート回避）
10. **Idle timeout**: 長め（例: 300秒）推奨 — モデル常駐を維持

## 3. 疎通確認

Endpoint ID を控え、RunPod の **Settings → API Keys** から API Key を取得:

```bash
export RUNPOD_API_KEY=rpa_...
export RUNPOD_WHISPERX_ENDPOINT_ID=xxxxxxxx
./scripts/test-remote-whisperx.sh
./scripts/test-remote-whisperx.sh /path/to/audio.mp3
```

`GET /ping` が `204` → モデルロード中、`200` → 準備完了。

## 4. Mac ローカル（`.local/secrets.env`）

```env
RUNPOD_API_KEY=rpa_...
RUNPOD_WHISPERX_ENDPOINT_ID=xxxxxxxx
```

`WHISPERX_SERVICE_URL` は **不要**（`RUNPOD_WHISPERX_ENDPOINT_ID` が優先されます）。  
認証は `RUNPOD_API_KEY` のみ（ワーカー側 `WHISPERX_SERVICE_SECRET` は空でよい）。

```bash
./scripts/start-local-ai.sh   # ローカル 8081 はスキップ
```

## 5. Supabase（本番 Edge）

Project → **Edge Functions → Secrets**:

```
RUNPOD_API_KEY=rpa_...
RUNPOD_WHISPERX_ENDPOINT_ID=xxxxxxxx
```

`media-pipeline` を再デプロイ。

---

## エンドポイント一覧

| Path | 用途 |
|------|------|
| `GET /ping` | RunPod LB ヘルス（204=ロード中, 200=ready） |
| `GET /health` | 人間向けステータス |
| `POST /transcribe` | 文字起こし（multipart `file` または JSON `audioUrl`） |

ベース URL: `https://<ENDPOINT_ID>.api.runpod.ai`

認証ヘッダ: `Authorization: Bearer <RUNPOD_API_KEY>`

---

## 運用のコツ

- **Min workers = 0**: コスト最小。初回リクエストはモデルロードで数分かかることがある
- **Min workers = 1**: 常時ウォーム。Pod に近い体験だがアイドル課金あり
- **Network Volume**: 2 回目以降のコールドスタートを短縮
- **FlashBoot**（RunPod 側）: イメージのウォーム起動を高速化

## トラブルシュート

| 症状 | 対処 |
|------|------|
| `/ping` がずっと 204 | モデル DL 中 or GPU メモリ不足。ログを確認 |
| `401` | `RUNPOD_API_KEY` 不一致 |
| `403` on `/transcribe` | ワーカーに `WHISPERX_SERVICE_SECRET` が残っている → 空にするか `RUNPOD_SERVERLESS=1` |
| タイムアウト | Endpoint の max execution time を延長。長尺は `WHISPERX_MODEL=medium` も検討 |
| CUDA OOM | 小さい GPU → `WHISPERX_MODEL=medium` |

---

## 関連

- GPU Pod（常駐・TCP 直結）: [whisperx-runpod.md](./whisperx-runpod.md)
- 一般のリモート移行: [whisperx-remote-server.md](./whisperx-remote-server.md)

---

## 非同期文字起こし（Queue 型・推奨）

長尺動画では Edge Function のタイムアウトを避けるため、**Queue 型 Endpoint** + `media-pipeline` の非同期フローを使います。

### フロー

1. **transcribe 開始** — Edge が RunPod `/run` に `{ audioUrl }` を投入 → `jobId` を数秒で返却（`async: true`）
2. **ブラウザ** — 30 秒ごとに Edge へ `mode: "status"` で進捗確認
3. **完了** — Edge が RunPod `/status` を確認し、結果を DB に保存 → ブラウザが表示

### RunPod 設定（Queue 型）

1. **Endpoint Type**: **Queue**（Load Balancer ではない）
2. Docker: `Dockerfile.runpod-queue`（`runpod_handler.py`）
3. デプロイ例:

```bash
docker build -f services/whisperx-service/Dockerfile.runpod-queue -t YOUR_USER/wavrick-whisperx-queue:stable .
docker push YOUR_USER/wavrick-whisperx-queue:stable
```

4. Supabase secrets（Load Balancer 時と同じキー名）:

```
RUNPOD_API_KEY=rpa_...
RUNPOD_WHISPERX_ENDPOINT_ID=<Queue Endpoint ID>
RUNPOD_WHISPERX_ASYNC=1
```

`media-pipeline` を再デプロイ。ブラウザは最新 `app.js` が必要です。

### Load Balancer のみの場合

`/run` が使えないため、Edge は **バックグラウンド同期文字起こし**（`waitUntil`）にフォールバックします。短い動画向けです。長尺は Queue 型 Endpoint へ移行してください。

`RUNPOD_WHISPERX_ASYNC=0` で従来の同期 transcribe（1 リクエスト完結）に戻せます。
