/**
 * Smoke tests for speaker assign range remapping (run: node scripts/test-speaker-assign-remap.js)
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(
  path.join(__dirname, "../js/wavrick-speaker-assign.js"),
  "utf8"
);
const sandbox = { window: {}, globalThis: {} };
vm.runInNewContext(src, sandbox);
const SA = sandbox.window.WavrickSpeakerAssign;

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const plain = "こんにちは今日は2024年で10000人が集まりました";
const ranges = [
  { id: 1, start: 0, end: 5, speakerIndex: 1 },
  { id: 2, start: 5, end: 20, speakerIndex: 2 },
  { id: 3, start: 20, end: plain.length, speakerIndex: 1 }
];

const deleted = plain.slice(0, 10) + plain.slice(15);
const remDel = SA.remapSpeakerAssignRanges(plain, deleted, ranges);
assert(remDel.length >= 2, "delete middle keeps surrounding ranges");
assert(
  deleted.slice(remDel[0].start, remDel[0].end).includes("こんに"),
  "first range text preserved"
);

const inserted =
  plain.slice(0, 10) + "とても" + plain.slice(10);
const remIns = SA.remapSpeakerAssignRanges(plain, inserted, ranges);
assert(remIns[0].start === 0 && remIns[0].end === 5, "insert after range 1 leaves range 1");
assert(remIns[1].end === ranges[1].end + 3, "insert inside range 2 extends its end");
assert(remIns[2].start === ranges[2].start + 3, "insert before range 3 shifts its start");

const typo = plain.replace("2024", "2025");
const remTypo = SA.remapSpeakerAssignRanges(plain, typo, ranges);
assert(remTypo.length === 3, "typo keeps three ranges");
assert(
  typo.slice(remTypo[1].start, remTypo[1].end).includes("2025"),
  "edited number stays in assigned range"
);

const srtLike =
  "[00:00.00 - 00:05.00] こんにちは\n[00:05.00 - 00:10.00] 今日は2024年";
const plainFromSrt = "こんにちは 今日は2024年";
const rangesSrt = [{ id: 1, start: 0, end: 5, speakerIndex: 1 }];
const editedSrt = srtLike.replace("2024", "2025");
const plainEdited = plainFromSrt.replace("2024", "2025");
const remSrt = SA.remapSpeakerAssignRanges(plainFromSrt, plainEdited, rangesSrt);
assert(remSrt.length === 1, "plain edit keeps range after srt-style mismatch");
assert(plainEdited.slice(remSrt[0].start, remSrt[0].end).includes("こんに"), "range text preserved");

const map = SA.buildPlainOffsetMap("abc0000def", "abc0000def");
assert(map[0] === 0 && map[9] === 9, "identity map");

console.log("OK: speaker assign remap tests passed");
