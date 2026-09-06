/**
 * DSH Studio 辅助工具 — 会话存档“体检/修复”。
 *
 * 背景：同一份 DSH_HOME 若同时跑两个内核（如网页版 + 桌面版）写同一条会话，
 * 存档里可能出现“同一条 seq 写了两遍”的重复行，导致读历史时报
 * “seq gap ... (expected N, got N)”。本工具只处理这种真重复：
 *   - 默认 dry-run：只体检，不改文件；
 *   - 加 --apply 才真正修复（会先做 .bak 备份）。
 * 修复前必须确保没有任何 DSH 在写这条会话（桌面版和网页版都退出）。
 *
 * 用法：
 *   node tools/fix-session-gap.mjs <会话目录或 .jsonl.zstd 文件路径> [--apply]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 4247762216;
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/** 复刻 DSH 的帧扫描：定位完整帧；文件尾不完整帧返回 tornStart。 */
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error("invalid frame magic");
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error("reserved block type");
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

function decode(buffer) {
	const { frames, tornStart } = scanZstdFrames(buffer);
	let text = "";
	for (const frame of frames) {
		text += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8");
	}
	return { text, frames, tornStart };
}

function encode(text) {
	const lines = text.split("\n");
	const headerLine = lines.find((line) => line.startsWith('{"type":"session"')) ?? "";
	const rest = lines.filter((line) => line !== "" && line !== headerLine).join("\n");
	const frames = [zstdCompressSync(Buffer.from(headerLine + "\n", "utf8"), CHECKSUM)];
	if (rest !== "") frames.push(zstdCompressSync(Buffer.from(rest + "\n", "utf8"), CHECKSUM));
	return Buffer.concat(frames);
}

/** 找“相邻重复 seq”的真重复行。 */
function findDuplicates(text) {
	const lines = text.split("\n");
	const result = [];
	let last = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		let parsed = null;
		try { parsed = JSON.parse(line); } catch { continue; }
		const seq = parsed && typeof parsed.seq === "number" ? parsed.seq : null;
		if (seq === null) continue;
		if (last !== null && seq === last) result.push({ lineNo: i, seq, text: line });
		else last = seq;
	}
	return result;
}

const arg = process.argv[2];
const apply = process.argv.includes("--apply");
if (!arg) {
	console.error("用法：node tools/fix-session-gap.mjs <会话目录或 .jsonl.zstd 文件路径> [--apply]");
	process.exit(2);
}

let file = arg;
try {
	const stat = statSync(arg);
	if (stat.isDirectory()) {
		const entries = readdirSync(arg);
		const candidate = entries.find((name) => name.endsWith(".jsonl.zstd"));
		if (!candidate) { console.error("目录里没找到 .jsonl.zstd 文件:", arg); process.exit(2); }
		file = join(arg, candidate);
	}
} catch {
	/* arg 是文件路径，直接使用 */
}

console.log("检查文件:", file);
const buffer = readFileSync(file);
const { text, frames, tornStart } = decode(buffer);
console.log(`完整帧: ${frames.length}${tornStart !== undefined && tornStart !== null ? `，注意文件尾有未写完帧 (tornStart=${tornStart})` : ""}`);

if (tornStart !== undefined && tornStart !== null && !apply) {
	console.error("⚠ 文件末尾有未写完的一帧：可能仍有 DSH 正在写入，或上次异常退出。");
	console.error("   请先彻底退出桌面版与网页版后再运行；体检仍会继续（只读完整帧）。");
}

const duplicates = findDuplicates(text);
console.log("发现真重复行数:", duplicates.length);
if (duplicates.length === 0) {
	console.log("结论：存档体检正常（相邻重复 seq = 0），无需修复。");
	console.log("若仍报错，多半是“网页版+桌面版同时开着”造成的瞬时问题：只开一个再打开该会话即可。");
	process.exit(0);
}
for (const dup of duplicates.slice(0, 10)) {
	console.log(`  行 ${dup.lineNo}  seq=${dup.seq}  ${dup.text.slice(0, 80)}`);
}

if (!apply) {
	console.log("\n这是 dry-run（只体检、没改动）。确认没有 DSH 在运行后，加 --apply 才会真正修复。");
	process.exit(0);
}

if (tornStart !== undefined && tornStart !== null) {
	console.error("文件尾有未写完帧，拒绝直接修复。请先确认没有任何 DSH 在写入这条会话。");
	process.exit(1);
}

const removeSet = new Set(duplicates.map((d) => d.lineNo));
const kept = text.split("\n").filter((_line, idx) => !removeSet.has(idx));
const fixed = kept.join("\n");

const backup = file + ".bak-" + Date.now();
writeFileSync(backup, buffer);
console.log("已备份原文件:", backup);

const tmp = file + ".fix-" + process.pid;
writeFileSync(tmp, encode(fixed));
renameSync(tmp, file);
console.log("修复完成：删除", duplicates.length, "行重复。重新体检：");
const check = decode(readFileSync(file));
console.log("修复后重复行数:", findDuplicates(check.text).length);
console.log("现在可以重新打开 DSH 验证该会话。");
