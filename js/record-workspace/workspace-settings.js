/**
 * 収録ワークスペース — 実験的機能フラグ（詳細設定のオンオフ）
 */

export const RW_FEATURE_STORAGE_PREFIX = "wavrick_rw_feat_";

/** @typedef {{ id: string, label: string, default: boolean, help: string }} WorkspaceFeatureDef */

/** @type {WorkspaceFeatureDef[]} */
export const WORKSPACE_FEATURES = [
  {
    id: "pingPongPreview",
    label: "ピンポン試聴",
    default: false,
    help: "お手本（①）と採用 Take を交互に短く聴き比べます。音声編集パネルに「ピンポン試聴」ボタンが出ます。"
  },
  {
    id: "loopLineRegion",
    label: "ループ区間（現在の台本行）",
    default: false,
    help: "▶ 再生中、いま選んでいる台本行の開始〜終了をループします。同じフレーズの繰り返し練習向けです。"
  },
  {
    id: "takeColorLabels",
    label: "テイク色分け",
    default: false,
    help: "Take カードをクリックして「採用候補／NG／要再録」に色分けできます（採用中は緑枠）。"
  },
  {
    id: "markerList",
    label: "マーカーリスト",
    default: false,
    help: "台本の収録状況一覧を表示します。行をクリックするとそのセリフへ移動します。"
  },
  {
    id: "noiseGateSuggest",
    label: "ノイズゲート簡易版",
    default: false,
    help: "編集パネルに「無音カット候補」ボタンが出ます。前後の無音を検出してトリム候補を入れます（要確認）。"
  },
  {
    id: "bpmClickCountdown",
    label: "3-2-1 に BPM クリック",
    default: false,
    help: "カウントダウン中にメトロノーム風のクリックを重ねます（ピッ音がオンのときのみ）。"
  },
  {
    id: "dualScreenMode",
    label: "二画面モード",
    default: false,
    help: "テレプロンプターを大きく、波形ドックを下に固定するレイアウトに切り替えます。"
  },
  {
    id: "sessionExport",
    label: "セッション書き出し",
    default: false,
    help: "台本・Take 情報・設定を JSON でダウンロードします（音声ファイル本体は含みません）。"
  },
  {
    id: "inputLevelMeter",
    label: "入力レベルメーター",
    default: false,
    help: "収録ブース／録音中にマイク入力の音量メーターを表示します。大きすぎると警告色になります。"
  },
  {
    id: "overdubMonitor",
    label: "オーバーダブ比較",
    default: false,
    help: "新しく録音するとき、ひとつ前の採用 Take を小さく流して重ね録りの参考にします。"
  }
];

/**
 * @returns {Record<string, boolean>}
 */
export function loadWorkspaceFeatures() {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const f of WORKSPACE_FEATURES) {
    try {
      const raw = localStorage.getItem(`${RW_FEATURE_STORAGE_PREFIX}${f.id}`);
      out[f.id] =
        raw === "1" ? true : raw === "0" ? false : Boolean(f.default);
    } catch {
      out[f.id] = Boolean(f.default);
    }
  }
  return out;
}

/**
 * @param {string} id
 * @param {boolean} on
 */
export function saveWorkspaceFeature(id, on) {
  try {
    localStorage.setItem(`${RW_FEATURE_STORAGE_PREFIX}${id}`, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} id
 * @returns {string}
 */
export function featureCheckboxId(id) {
  return `rwFeat_${id}`;
}
