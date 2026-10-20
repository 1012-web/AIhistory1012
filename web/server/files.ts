/**
 * 读写书里的文件。写入走「先写临时文件再改名」，写到一半断电也不会留下半个文件。
 * 每份内容带一个 hash（内容的 sha256），网页拿它判断磁盘上的文件是不是自己上次见过的那份。
 */
import { createHash } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const TMP_SUFFIX = ".aih-tmp";

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

export interface FileSnapshot {
  text: string;
  hash: string;
  mtimeMs: number;
}

export async function readSnapshot(abs: string): Promise<FileSnapshot> {
  const [text, info] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
  return { text, hash: hashText(text), mtimeMs: info.mtimeMs };
}

export async function atomicWrite(abs: string, text: string): Promise<void> {
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}${TMP_SUFFIX}`);
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, abs);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export type SaveResult =
  | { ok: true; hash: string; mtimeMs: number }
  | { ok: false; conflict: FileSnapshot };

/**
 * 存盘。baseHash 是网页这份编辑所基于的磁盘版本；磁盘上现在的内容与它不同（别人改过），
 * 就不写，把磁盘上的内容交回去让用户选——绝不静默覆盖。force 为真表示用户已经看过差异、选了保留自己的。
 */
export async function saveText(abs: string, text: string, baseHash: string | null, force: boolean): Promise<SaveResult> {
  let current: FileSnapshot | null = null;
  try {
    current = await readSnapshot(abs);
  } catch {
    current = null;
  }
  if (current && !force && current.hash !== baseHash && current.hash !== hashText(text)) return { ok: false, conflict: current };
  await atomicWrite(abs, text);
  const info = await stat(abs);
  return { ok: true, hash: hashText(text), mtimeMs: info.mtimeMs };
}
