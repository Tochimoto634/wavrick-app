# WhisperX をレンタルサーバーに移す

Wavrick はもともと **HTTP API** で WhisperX に繋ぐ設計です。Mac 上の `8081` をやめて、借りたサーバーにサービスを置き、URL だけ差し替えます。

**YouTube 音声プロキシ**は既に Railway 向け設定あり（`services/youtube-audio-proxy/railway.json`）。  
**WhisperX** も同様に Railway に載せられますが、下記「Railway の注意」を読んでから選んでください。

## 構成

```
[ブラウザ / Mac 8889] ──音声バイト──▶ [WhisperX サーバー HTTPS]
[Supabase Edge]       ──音声バイト──▶  同上
```

- エンドポイント: `GET /health`, `POST /transcribe`（multipart `file`）
- 認証: `Authorization: Bearer <WHISPERX_SERVICE_SECRET>`

## 1. サーバー要件（目安）

| 項目 | 推奨 |
|------|------|
| OS | Ubuntu 22.04 / 24.04 |
| GPU | NVIDIA 12GB+ VRAM（`large-v3`） |
| RAM | 16GB+ |
| ディスク | 30GB+（モデルキャッシュ） |
| 公開 | **443 HTTPS**（Nginx / Caddy）。8081 は外に出さない |

CPU のみでも動きますが、1本の動画文字起こしがかなり遅くなります。

## 2. Railway に載せる（Render / Fly も同じ考え方）

リポジトリ内:

- `services/whisperx-service/railway.json`
- `services/whisperx-service/Dockerfile.railway`

### 手順（概要）

1. [Railway](https://railway.com) で **New Project → Deploy from GitHub**
2. サービスの **Root Directory** を `services/whisperx-service` にする  
   （音声プロキシとは **別サービス** にする）
3. Variables:

   | Variable | 例 |
   |----------|-----|
   | `WHISPERX_SERVICE_SECRET` | 長いランダム文字列 |
   | `WHISPERX_MODEL` | `large-v3`（重い）または `medium`（軽め） |
   | `WHISPERX_DEVICE` | `cpu`（Railway 標準は CPU のみ） |

4. デプロイ後、Railway の **Public URL**（`https://xxx.up.railway.app`）を控える
5. Mac / Supabase:

   ```env
   WHISPERX_SERVICE_URL=https://xxx.up.railway.app
   WHISPERX_SERVICE_SECRET=<同上>
   ```

6. 疎通: `./scripts/test-remote-whisperx.sh`

### Railway の注意（重要）

| 項目 | 内容 |
|------|------|
| **GPU** | 標準プランは CPU のみ。`large-v3` は **非常に遅い** |
| **メモリ** | モデルロードで 4〜8GB 以上使うことがある → プラン不足で OOM |
| **タイムアウト** | 長い動画は HTTP / Railway の上限に当たる可能性 |
| **コスト** | 常時起動 + 重いイメージでプロキシより高めになりがち |

**おすすめ:** 本番で速度が必要なら **RunPod GPU Pod** → **[whisperx-runpod.md](./whisperx-runpod.md)**（手順まとめ）  
その他 GPU VPS（ConoHa GPU 等）も可。Railway は CPU・短いリクエスト向け。

---

## 3. VPS（GPU）でセットアップ

```bash
# サーバーに SSH
sudo apt update
sudo apt install -y git ffmpeg python3.12 python3.12-venv

# アプリ配置（パスは環境に合わせる）
sudo useradd -r -m -d /opt/wavrick-app wavrick || true
sudo mkdir -p /opt/wavrick-app
sudo chown -R wavrick:wavrick /opt/wavrick-app

sudo -u wavrick git clone <your-repo-url> /opt/wavrick-app
cd /opt/wavrick-app
sudo -u wavrick ./scripts/install-whisperx-server.sh
```

`deploy/.env` に生成された `WHISPERX_SERVICE_SECRET` を控えます。

### systemd

`services/whisperx-service/deploy/wavrick-whisperx.service` の `User` / `WorkingDirectory` を実際のパスに合わせてから:

```bash
sudo cp services/whisperx-service/deploy/wavrick-whisperx.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wavrick-whisperx
curl -s http://127.0.0.1:8081/health
```

### HTTPS（例: Caddy）

```
wx.example.com {
    reverse_proxy 127.0.0.1:8081
}
```

ファイアウォールで **443 のみ** 開放。8081 は `127.0.0.1` バインドのまま。

## 4. Mac（ローカル開発）の設定

`.local/secrets.env` に追加:

```env
WHISPERX_SERVICE_URL=https://wx.example.com
WHISPERX_SERVICE_SECRET=<サーバー deploy/.env と同じ>
```

8889 を再起動:

```bash
./scripts/start-dev-server.sh
```

**Mac で 8081 を起動する必要はありません。**  
`./scripts/start-local-ai.sh` はリモート URL が設定されていると WhisperX ローカル起動をスキップします。

接続確認:

```bash
./scripts/test-remote-whisperx.sh
```

## 5. Supabase（本番 Edge Function）

Project → **Edge Functions → Secrets**:

| Secret | 値 |
|--------|-----|
| `WHISPERX_SERVICE_URL` | `https://wx.example.com` |
| `WHISPERX_SERVICE_SECRET` | サーバーと同じ |

`media-pipeline` を再デプロイ。

## 6. セキュリティ

- `WHISPERX_SERVICE_SECRET` は必ず長いランダム文字列にする
- 可能なら IP 制限（ファイアウォール / Cloudflare）を併用
- サービスは `0.0.0.0` 直公開より **リバースプロキシ + TLS** 推奨

## 7. トラブルシュート

| 症状 | 対処 |
|------|------|
| `WhisperX に接続できません` | URL・SECRET・HTTPS 証明書・ファイアウォール |
| `401/403` | `WHISPERX_SERVICE_SECRET` の不一致 |
| 極端に遅い | GPU 未使用 → `nvidia-smi` と `WHISPERX_DEVICE=cuda` |
| build が古い | サーバーで `git pull` → `systemctl restart wavrick-whisperx` |

## 8. ローカルに戻す

`.local/secrets.env` から `WHISPERX_SERVICE_URL` 行を削除（または `http://127.0.0.1:8081`）し、`./scripts/start-whisperx.sh` を起動。
