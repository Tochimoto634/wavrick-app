/**
 * Smoke tests for speaker assign → chronological cue timing.
 * Run: deno run --allow-read scripts/test-chronological-cues.ts
 */
import {
  buildChronologicalTimedCuesFromAssignRanges,
  buildTimedCuesBySpeakerFromAssignRanges,
  normalizePreviewTextForCompare,
  scriptsBySpeakerFromChronologicalCues,
} from "../supabase/functions/_shared/grok-timecode-prompt.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    Deno.exit(1);
  }
}

function parseFirstStartSec(scriptLine: string): number {
  const m = scriptLine.match(/^\[(\d{1,2}):(\d{2})\.(\d{2})/);
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
}

const plain = "AAAA" + "BBBB" + "CCCC" + "DDDD";

const segments = [
  { start: 0, end: 4, text: "AAAA" },
  { start: 4.5, end: 8, text: "BBBB" },
  { start: 10, end: 14, text: "CCCC" },
  { start: 20, end: 24, text: "DDDD" },
];

const timeline = [
  "[00:00.00 - 00:04.00] AAAA",
  "[00:04.50 - 00:08.00] BBBB",
  "[00:10.00 - 00:14.00] CCCC",
  "[00:20.00 - 00:24.00] DDDD",
].join("\n");

const assignRanges = [
  { start: 0, end: 4, speakerIndex: 1, text: "AAAA" },
  { start: 4, end: 8, speakerIndex: 2, text: "BBBB" },
  { start: 8, end: 12, speakerIndex: 1, text: "CCCC" },
  { start: 12, end: 16, speakerIndex: 2, text: "DDDD" },
];

const cues = buildChronologicalTimedCuesFromAssignRanges(
  plain,
  assignRanges,
  2,
  [
    { id: 1, label: "A" },
    { id: 2, label: "B" },
  ],
  { whisperSegments: segments, whisperTimeline: timeline, durationSec: 30 }
);

assert(cues.length === 4, "four assign ranges → four cues");
assert(
  cues[1].speakerIndex === 2 && cues[1].startSec > 4 && cues[1].startSec < 9,
  "second speaker gets timeline time near 00:04 not stacked after first block"
);

const spacedPlain = "AAAA BBBB CCCC DDDD";
const spacedRanges = [
  { start: 0, end: 4, speakerIndex: 1, text: "AAAA" },
  { start: 5, end: 9, speakerIndex: 2, text: "BBBB" },
  { start: 10, end: 14, speakerIndex: 1, text: "CCCC" },
  { start: 15, end: 19, speakerIndex: 2, text: "DDDD" },
];
const spacedBySpeaker = buildTimedCuesBySpeakerFromAssignRanges(
  spacedPlain,
  spacedRanges,
  2,
  { whisperSegments: segments, whisperTimeline: timeline, durationSec: 30 }
);
assert(
  spacedBySpeaker["2"]?.[0]?.startSec > 4 && spacedBySpeaker["2"]?.[0]?.startSec < 9,
  "spaced whisperTranscript still maps speaker 2 to correct timeline via text field"
);

const altSegments = [
  { start: 0, end: 4, text: "AAAA" },
  { start: 40, end: 44, text: "BBBB" },
  { start: 80, end: 84, text: "CCCC" },
  { start: 120, end: 124, text: "DDDD" },
];
const altTimeline = [
  "[00:00.00 - 00:04.00] AAAA",
  "[00:40.00 - 00:44.00] BBBB",
  "[01:20.00 - 01:24.00] CCCC",
  "[02:00.00 - 02:04.00] DDDD",
].join("\n");
const altRanges = [
  { start: 0, end: 4, speakerIndex: 1, text: "AAAA" },
  { start: 4, end: 8, speakerIndex: 2, text: "BBBB" },
  { start: 8, end: 12, speakerIndex: 1, text: "CCCC" },
  { start: 12, end: 16, speakerIndex: 2, text: "DDDD" },
];
const bySpeaker = buildTimedCuesBySpeakerFromAssignRanges(
  plain,
  altRanges,
  2,
  {
    whisperSegments: altSegments,
    whisperTimeline: altTimeline,
    durationSec: 200,
  }
);
assert(bySpeaker["1"]?.length === 2, "speaker 1 has two cues");
assert(bySpeaker["2"]?.length === 2, "speaker 2 has two cues");
assert(
  bySpeaker["1"][0].startSec < 5 && bySpeaker["1"][1].startSec > 70,
  "speaker 1 keeps video timeline gaps"
);
assert(
  bySpeaker["2"][0].startSec > 35 &&
    bySpeaker["2"][0].startSec < 45 &&
    bySpeaker["2"][1].startSec > 115,
  "speaker 2 lines use whisper timeline from alternating positions"
);

const grouped = scriptsBySpeakerFromChronologicalCues(cues);
const speaker1Lines = (grouped["1"] || "")
  .split(/\r?\n/)
  .filter((l) => /^\[\d/.test(l));
assert(
  speaker1Lines.length >= 2 &&
    parseFirstStartSec(speaker1Lines[0]) <
      parseFirstStartSec(speaker1Lines[speaker1Lines.length - 1]),
  "within each speaker block, lines are sorted by timecode"
);

console.log("OK: chronological cue tests passed");
