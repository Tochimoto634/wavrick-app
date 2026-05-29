# WhisperX Service (Phase 1)

Word-level transcription for Wavrick media pipeline.

## レンタルサーバーに置く

Mac の負荷を下げる場合は VPS / GPU サーバーに常駐させ、クライアントは URL だけ向けます。

→ **[docs/whisperx-runpod.md](../../docs/whisperx-runpod.md)**（**RunPod GPU 推奨**）  
→ [docs/whisperx-remote-server.md](../../docs/whisperx-remote-server.md)（VPS / Railway）

```env
# .local/secrets.env または Supabase secrets
WHISPERX_SERVICE_URL=https://wx.example.com
WHISPERX_SERVICE_SECRET=<サーバーと同じ>
```

## Run locally (CPU, macOS)

**Python 3.10–3.12 が必要**（3.14 は WhisperX 非対応）。

```bash
# リポジトリルートから
brew install python@3.12   # 未導入の場合のみ
./scripts/install-whisperx.sh
./scripts/start-whisperx.sh
```

別ターミナル:

```bash
./scripts/test-whisperx.sh
./scripts/test-whisperx.sh /path/to/audio.mp3
```

手動起動:

```bash
cd services/whisperx-service
source .venv/bin/activate
export WHISPERX_SERVICE_SECRET=wavrick-local-dev-secret
export WHISPERX_DEVICE=cpu
uvicorn app:app --host 127.0.0.1 --port 8081
```

## API

- `GET /health`
- `POST /transcribe` — multipart `file`, or JSON `{ "audioUrl": "https://...", "batchSize": 16 }`
- Header: `Authorization: Bearer <WHISPERX_SERVICE_SECRET>` (optional if secret unset)

## Response shape

```json
{
  "source": "whisperx",
  "model": "large-v3",
  "language": "ja",
  "duration": 120.5,
  "words": [{ "word": "hello", "start": 0.1, "end": 0.4 }],
  "segments": [{ "start": 0.0, "end": 2.1, "text": "...", "words": [] }]
}
```

## Env

| Variable | Default |
|----------|---------|
| `WHISPERX_MODEL` | `large-v3` |
| `WHISPERX_DEVICE` | `cpu` |
| `WHISPERX_COMPUTE_TYPE` | `int8` (cpu) / `float16` (cuda) |
| `WHISPERX_MAX_BYTES` | `25165824` |
| `WHISPERX_SERVICE_SECRET` | (empty = no auth) |
