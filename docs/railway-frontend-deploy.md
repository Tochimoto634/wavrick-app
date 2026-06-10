# Railway: wavrick-app-production（静的サイト）

GitHub の `main` をデプロイする設定例。

## Railway Dashboard

1. サービス **wavrick-app-production** を開く
2. **Settings → Source**
   - Repository: `Tochimoto634/wavrick-app`
   - Branch: **`main`**
   - Root Directory: **空**（リポジトリルート）
3. **Settings → Config-as-code**（または Build 内の Railway Config File）
   - **`railway.frontend.toml`** を指定
   - ※ ルートの `railway.toml` は **ideal-commitment（音声プロキシ）** 用で UI から Dockerfile を変えられない。フロントサービスは別 toml が必要
4. **Deployments → Deploy / Redeploy**

## 成功確認

```bash
curl -s "https://wavrick-app-production.up.railway.app/" | grep app.js
# → app.js?v=deploy-2026-06-09-async
```

```bash
curl -s "https://wavrick-app-production.up.railway.app/app.js" | grep -c pollMediaPipelineTranscribe
# → 1 以上
```

## 注意

- `ideal-commitment` サービスとは **別サービス**。混同しない
- `git push origin main` だけでは自動更新されない場合、Settings の GitHub 連携と Deploy を確認
