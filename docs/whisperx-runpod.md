# WhisperX on RunPod（GPU Pod）

Wavrick の WhisperX は **HTTP API**（`GET /health`, `POST /transcribe`）です。RunPod では **GPU Pod** に載せるのがいちばん簡単です。

## なぜ Pod か（Serverless ではない）

| 方式 | 向き |
|------|------|
| **GPU Pod** | 既存 FastAPI をそのまま動かせる。今回の構成と一致 |
| Serverless | ハンドラ書き直しが必要。キュー・コールドスタートあり |

## 重要: HTTP プロキシの 100 秒制限

RunPod の **`*.proxy.runpod.net`（HTTP Expose）** は Cloudflare 経由で **約 100 秒で切れます**。

文字起こしはそれを超えやすいので、次を推奨します。

1. **Expose TCP Ports** に `8081` を追加（HTTP プロキシは使わない）
2. Connect → **TCP Port Mapping** で表示される `公開IP:ポート` を `WHISPERX_SERVICE_URL` にする  
   例: `http://203.0.113.10:34521`

Mac / Supabase からは `Authorization: Bearer <WHISPERX_SERVICE_SECRET>` でその URL に POST します。

---

## 手順 A: 公式 PyTorch テンプレ + リポジトリ（手軽）

1. [RunPod Console](https://www.console.runpod.io/pods) → **Deploy Pod**
2. GPU: **RTX 4090 / A4000** など 16GB+ VRAM 推奨
3. テンプレ: **RunPod PyTorch** など（CUDA 入り）
4. **Volume**: Network Volume 10〜50GB を `/workspace` にマウント（モデルキャッシュ用・2回目以降が速い）
5. **Expose TCP Ports**: `8081`（**HTTP 8081 は付けない** — 100秒制限回避）
6. Pod 起動後、Web Terminal または SSH で:

```bash
cd /workspace
git clone <your-wavrick-repo-url> wavrick-app
cd wavrick-app
./scripts/install-whisperx-server.sh
```

7. `services/whisperx-service/deploy/.env` の `WHISPERX_SERVICE_SECRET` を控える

8. 常駐起動:

```bash
set -a && source /workspace/wavrick-app/services/whisperx-service/deploy/.env && set +a
cd /workspace/wavrick-app/services/whisperx-service
nohup .venv/bin/uvicorn app:app --host 0.0.0.0 --port 8081 --timeout-keep-alive 600 \
  >> /workspace/whisperx.log 2>&1 &
```

9. Pod → **Connect** → **TCP Port Mapping** の `8081` 行を見る  
   → `http://<IP>:<外部ポート>/health` をブラウザ or curl で確認

10. Mac の `.local/secrets.env`:

```env
WHISPERX_SERVICE_URL=http://<IP>:<外部ポート>
WHISPERX_SERVICE_SECRET=<deploy/.env と同じ>
```

11. 疎通:

```bash
./scripts/test-remote-whisperx.sh
./scripts/test-remote-whisperx.sh /path/to/audio.mp3
```

---

## 手順 B: Docker イメージ（再デプロイが楽）

1. イメージをビルド＆ Docker Hub 等へ push:

```bash
cd services/whisperx-service
docker build -f Dockerfile.runpod -t youruser/wavrick-whisperx:latest .
docker push youruser/wavrick-whisperx:latest
```

2. RunPod → **Deploy Pod** → **Custom Image** に上記イメージ
3. 環境変数:

| Variable | 値 |
|----------|-----|
| `WHISPERX_SERVICE_SECRET` | 長いランダム文字列 |
| `WHISPERX_DEVICE` | `cuda` |
| `WHISPERX_MODEL` | `large-v3` |
| `WHISPERX_COMPUTE_TYPE` | `float16` |
| `HF_HOME` | `/workspace/.cache/huggingface` |

4. **Expose TCP Ports**: `8081`
5. Network Volume を `/workspace` にマウント
6. TCP マッピング URL を `WHISPERX_SERVICE_URL` に設定（手順 A の 9〜11 と同じ）

---

## Supabase（本番 Edge）

Project → **Edge Functions → Secrets**:

```
WHISPERX_SERVICE_URL=http://<RunPod-IP>:<外部ポート>
WHISPERX_SERVICE_SECRET=<同上>
```

`media-pipeline` を再デプロイ。

※ Edge から RunPod の **生 IP + HTTP** への outbound が通る必要があります（多くの場合問題なし）。

---

## 料金・運用のコツ

- **Stop Pod** すると IP / ポートが変わることがある → URL 更新が必要
- 開発中は **On-Demand**、本番は常時起動 Pod か、使うときだけ起動して URL を更新
- 初回はモデル DL で数分かかる（Volume にキャッシュすると次回短縮）
- Mac ローカルでは **8081 を起動しない**（`WHISPERX_SERVICE_URL` が RunPod を向いていれば `start-local-ai.sh` がスキップ）

---

## トラブルシュート

| 症状 | 対処 |
|------|------|
| `524` / 100秒で切れる | HTTP プロキシをやめ **TCP** 公開にする |
| `Connection refused` | `uvicorn` が `0.0.0.0:8081` で動いているか |
| CUDA out of memory | 小さい GPU → `WHISPERX_MODEL=medium` |
| 401/403 | `WHISPERX_SERVICE_SECRET` 不一致 |
| Pod 再作成後に動かない | TCP マッピング・URL を再取得 |

---

## 関連

- 一般のリモート移行: [whisperx-remote-server.md](./whisperx-remote-server.md)
- Railway（CPU・短いリクエスト向け）: 同ドキュメント内 Railway 節
