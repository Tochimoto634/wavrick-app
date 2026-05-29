/**
 * @deprecated 互換のため残置。タイムコード生成は SRT 経由に統一。
 */
import {
  buildScriptLinesFromWhisperSrt,
  buildBracketTimelineFromWhisperSegments,
  buildBracketTimelineFromAlignWords,
  buildBracketTimelineFromWhisperX,
  buildTimelineCuesFromAlignWords,
  buildTimelineCuesFromWhisperX,
  normalizeAlignWords,
  timelineCuesToLegacySegments,
  buildSrtFromWhisperSegments,
  SILENCE_GAP_LINE_MIN_SEC,
  SILENCE_GAP_BLOCK_MIN_SEC,
  INVALID_SEGMENT_END_FALLBACK_SEC
} from "./srt-timecode.js?v=rw-whisperx-tc-2026-05-28";

export {
  SILENCE_GAP_LINE_MIN_SEC,
  SILENCE_GAP_BLOCK_MIN_SEC,
  INVALID_SEGMENT_END_FALLBACK_SEC,
  normalizeAlignWords,
  buildTimelineCuesFromAlignWords,
  buildTimelineCuesFromWhisperX,
  timelineCuesToLegacySegments,
  buildBracketTimelineFromAlignWords,
  buildBracketTimelineFromWhisperX,
  buildSrtFromWhisperSegments,
  buildBracketTimelineFromWhisperSegments
};

export function buildScriptLinesFromWhisperSilenceGapRules(
  whisperSegments,
  durationSec = 0
) {
  return buildScriptLinesFromWhisperSrt(whisperSegments, durationSec);
}
