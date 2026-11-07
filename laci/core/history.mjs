/**
 * 参数历史（按「引擎 + 模型」区分，最多留 10 条）
 *
 * 为什么要单独一个文件：历史是"某次保存时的参数快照"，和模型档案不是一回事；
 * 模型档案要能导出/分享，历史只在这台机器上有意义。
 *
 * 存储：`data/history/<engineId>__<modelId>.json`，最新的在前。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';

export const HISTORY_LIMIT = 10;

function safeId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_') || '_';
}

function historyDir() {
  return path.join(dataDir(), 'history');
}

function historyFile(engineId, modelId) {
  return path.join(historyDir(), `${safeId(engineId)}__${safeId(modelId)}.json`);
}

function localIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sameValues(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (String(a[key]) !== String(b[key])) return false;
  }
  return true;
}

/** 默认名字：131k · rk4v4-e8 · 视觉 */
function autoName(values) {
  const bits = [];
  if (Number(values.maxContext) > 0) bits.push(Math.round(Number(values.maxContext) / 1024) + 'k');
  if (values.kvDtype) bits.push(String(values.kvDtype));
  if (values.vision) bits.push('视觉');
  if (values.mtp) bits.push('MTP');
  return bits.join(' · ') || '默认';
}

function readAll(engineId, modelId) {
  const file = historyFile(engineId, modelId);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      file,
      items: Array.isArray(raw?.items) ? raw.items.filter((x) => x && x.id) : [],
    };
  } catch {
    return { file, items: [] };
  }
}

function writeAll(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

export function listHistory(engineId, modelId) {
  if (!engineId || !modelId) return [];
  return readAll(engineId, modelId).items;
}

/**
 * 记一条。返回 { appended, item, items }。
 * 和最新一条参数完全一样就不记（避免连点保存出一串重复）。
 */
export function appendHistory({ engineId, modelId, values, source = 'config', name = null }) {
  if (!engineId || !modelId || !values) throw new TypeError('appendHistory 需要 engineId / modelId / values');
  const { file, items } = readAll(engineId, modelId);
  if (items.length && sameValues(items[0].values, values)) {
    return { appended: false, item: items[0], items };
  }
  const item = {
    id: `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(name || autoName(values)).slice(0, 40),
    at: localIso(),
    source,
    values,
  };
  items.unshift(item);
  while (items.length > HISTORY_LIMIT) items.pop();
  writeAll(file, items);
  return { appended: true, item, items };
}

/** 改名。返回 { ok, items }；找不到这条返回 { ok:false }。 */
export function renameHistory({ engineId, modelId, itemId, name }) {
  const { file, items } = readAll(engineId, modelId);
  const item = items.find((x) => x.id === itemId);
  if (!item) return { ok: false, items };
  const clean = String(name ?? '').trim().slice(0, 40);
  if (!clean) return { ok: false, items };
  item.name = clean;
  writeAll(file, items);
  return { ok: true, item, items };
}
