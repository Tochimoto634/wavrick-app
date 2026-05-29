/**
 * YouTube IFrame Player API wrapper.
 */

let apiPromise = null;

const YT_API_TIMEOUT_MS = 12000;

export function loadYouTubeIframeApi(timeoutMs = YT_API_TIMEOUT_MS) {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        apiPromise = null;
        reject(
          new Error(
            "YouTube API の読み込みがタイムアウトしました（広告ブロック等を確認）"
          )
        );
      });
    }, timeoutMs);

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") prev();
      finish(() => resolve(window.YT));
    };

    let poll = null;
    if (document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      poll = setInterval(() => {
        if (window.YT?.Player) finish(() => resolve(window.YT));
      }, 50);
    } else {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      tag.onerror = () => {
        finish(() => {
          apiPromise = null;
          reject(new Error("YouTube API スクリプトを読み込めませんでした"));
        });
      };
      document.head.appendChild(tag);
      poll = setInterval(() => {
        if (window.YT?.Player) finish(() => resolve(window.YT));
      }, 50);
    }
  });
  return apiPromise;
}

export class YouTubeSyncPlayer {
  /**
   * @param {string} containerId DOM element id
   * @param {string} videoId
   * @param {{ onTime?: (t:number)=>void, onState?: (state:number)=>void }} hooks
   */
  constructor(containerId, videoId, hooks = {}) {
    this.containerId = containerId;
    this.videoId = videoId;
    this.hooks = hooks;
    /** @type {YT.Player|null} */
    this.player = null;
    this.ready = false;
  }

  async mount() {
    const YT = await loadYouTubeIframeApi();
    const container = document.getElementById(this.containerId);
    if (container) container.style.visibility = "hidden";
    await new Promise((resolve) => {
      this.player = new YT.Player(this.containerId, {
        videoId: this.videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            this.ready = true;
            this.setMuted(true);
            const iframe = document.getElementById(this.containerId);
            if (iframe?.tagName === "IFRAME") {
              iframe.setAttribute("tabindex", "-1");
              iframe.style.visibility = "visible";
            }
            resolve();
          },
          onStateChange: (ev) => {
            this.hooks.onState?.(ev.data);
          }
        }
      });
    });
  }

  setMuted(muted) {
    if (!this.ready || !this.player) return;
    try {
      this.player.mute?.();
      this.player.setVolume?.(0);
    } catch {
      /* ignore */
    }
    if (!muted) {
      try {
        this.player.unMute?.();
        this.player.setVolume?.(100);
      } catch {
        /* ignore */
      }
    }
  }

  getCurrentTime() {
    if (!this.ready || !this.player?.getCurrentTime) return 0;
    return this.player.getCurrentTime() || 0;
  }

  getDuration() {
    if (!this.ready || !this.player?.getDuration) return 0;
    return this.player.getDuration() || 0;
  }

  getPlayerState() {
    if (!this.ready || !this.player?.getPlayerState) return -1;
    return this.player.getPlayerState();
  }

  seekTo(seconds, allowSeekAhead = true) {
    if (!this.ready || !this.player?.seekTo) return;
    this.player.seekTo(Math.max(0, seconds), allowSeekAhead);
    this.hooks.onTime?.(seconds);
  }

  play() {
    this.player?.playVideo?.();
  }

  pause() {
    this.player?.pauseVideo?.();
  }

  loadVideoById(videoId) {
    if (!this.ready) return;
    this.videoId = videoId;
    this.player?.loadVideoById?.(videoId);
  }

  destroy() {
    try {
      this.player?.destroy?.();
    } catch {
      /* ignore */
    }
    this.player = null;
    this.ready = false;
  }
}

export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5
};
