/**
 * core/footprint.mjs —— 显存 / 主机内存预估（M4）
 *
 * 这里只算"这一个模型大概值多少"，不判断"现在能不能起"。
 * 判断在 ledger.mjs，且永远读实时 nvidia-smi 的 free（账本只记承诺）。
 *
 * 三级来源：
 *   measured —— 档案里有 footprint 且环境指纹匹配（最准）
 *   formula  —— 第一次 / 换了硬件（引擎 README 的公式）
 *   manual   —— 用户手填（他知道自己怎么混跑）
 *
 * 公式（任务书 §"显存预估"）：
 *   权重   ≈ 模型文件大小（目录型槽位不算，比如 Strata 的 pack）
 *   KV 池  = ceil(池 token 数 ÷ 64) × 每页 MiB
 *            每页价：bf16 4.0 / k8v4 1.67 / rk4v4-e8 1.16 / rk2v4-e8 0.84
 *   工作区 ≈ 256 MiB（prefill-chunk 决定，第一版固定）
 *
 * ⚠️ --host-kv-mib 是【主机内存】，不是显存：单独算 hostRamMiB，绝不并进 vramMiB。
 *    显存够、内存不够一样会失败，而且崩得更晚（跑到一半 OOM）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isPlainObject } from './config.mjs';
import { loadModel, saveModel } from './registry.mjs';

export const MIB = 1024 * 1024;

/** KV 池一页覆盖多少 token */
export const PAGE_TOKENS = 64;

/** 每页 KV 的显存价（MiB），来源：引擎 README */
export const KV_PAGE_MIB = Object.freeze({
  bf16: 4.0,
  k8v4: 1.67,
  'rk4v4-e8': 1.16,
  'rk2v4-e8': 0.84,
});

/** 不认识的 dtype 按最贵的算——公式宁可高估，低估会让人以为能起 */
export const DEFAULT_KV_DTYPE = 'bf16';

/**
 * 运行时工作区的**默认下限**（MiB）。
 *
 * ⚠️ 这个数字只是"第一次估"的起点，不是引擎的实际情况：
 * 2026-11-06 实测 ninfer 的这个构建在权重之后还要
 *   2496345088 bytes（≈2380 MiB）的 runtime reservation，
 * 是 256 MiB 的九倍多。所以：
 *   1. 引擎日志会直接报这个数（见 RESERVE_LOG_RE），抓到就回填成
 *      `params.runtimeReserveMib`，下次预估就用真值；
 *   2. 没抓到时宁可沿用这个小的默认值 + 在提示里说明"按默认工作区估"，
 *      也不要拍一个大数把人吓退——估错的代价由「仍然加载」出口兜。
 */
export const DEFAULT_RUNTIME_MIB = 256;

/** 兼容旧名（早期公式里叫「工作区」）。 */
export const WORKSPACE_MIB = DEFAULT_RUNTIME_MIB;

/**
 * 引擎自己的那句"还差多少运行时预留"（ninfer 实测格式）：
 *
 *   minimum Engine runtime reservation requires 2496345088 bytes
 *   in addition to 268435456 bytes of automatic headroom, ...
 *
 * 这是**引擎告诉你真值**的地方，比任何公式都准；抓它、回填、下次预估就对。
 */
export const RESERVE_LOG_RE =
  /(?:minimum\s+(?:engine\s+)?runtime\s+reservation\s+requires|runtime\s+reservation\s+requires)\s+([\d,]+)\s+bytes/i;

/** --host-kv-mib 的默认值（主机内存） */
export const DEFAULT_HOST_KV_MIB = 8192;

/** 环境指纹里 freeMiB 的容差：差超过 512 MiB 就算"变了" */
export const FINGERPRINT_FREE_TOLERANCE_MIB = 512;

/**
 * nvidia-smi 前后差值算不算"一次真实加载"的下限。
 * 低于 64 MiB 的差值基本是桌面占用抖动 / 测量窗口里别的进程释放了显存，
 * 不能当实测值写进档案（写进去下次就会低估）。
 */
export const MIN_MEASURABLE_VRAM_MIB = 64;

/** nvidia-smi 读到内存后缓存一会儿：一次启动流程里会问好几次，不缓存会卡顿 */
export const GPU_CACHE_MS = 1000;

/** 引擎没配 footprintLog 时用的默认正则（对应日志里的 capacity 行） */
export const DEFAULT_FOOTPRINT_LOG = 'capacity \\| KV ([\\d,]+) tokens.*?runtime ([\\d.]+) MiB';

/** M1 的接口约定是同步的；返回 Promise 时宁可报清楚，也不要往档案里写坏数据 */
function loadModelForWrite(modelId) {
  const model = loadModel(modelId);
  if (model && typeof model.then === 'function') {
    throw new Error(
      `M1 registry 的 loadModel(${modelId}) 返回了 Promise，但 footprint 的写回是同步 API`,
    );
  }
  return model;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function roundMiB(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 本地时区的 ISO 时间（档案里给人看的，不是给机器比较的） */
export function localIso(date = new Date()) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(abs / 60)}:${pad(abs % 60)}`
  );
}

// ---------------------------------------------------------------------------
// 实时显卡信息（nvidia-smi）
// ---------------------------------------------------------------------------

let gpuCache = { at: 0, value: null };

/**
 * 读显卡实时状态（只读，不抛异常）。
 * 多卡时默认取 0 号卡；`devices` 里带着全部，将来做 --device 分卡时用得上。
 *
 * @returns {{
 *   ok: boolean, at: number, error: string|null,
 *   index: number|null, gpu: string|null, driver: string|null,
 *   totalMiB: number|null, freeMiB: number|null,
 *   devices: Array<{index:number,gpu:string,driver:string,totalMiB:number,freeMiB:number}>
 * }}
 */
export function readGpu({ fresh = false, cacheMs = GPU_CACHE_MS, index = 0 } = {}) {
  const now = Date.now();
  if (!fresh && gpuCache.value && now - gpuCache.at < cacheMs) return gpuCache.value;
  const value = queryGpu(index);
  gpuCache = { at: now, value };
  return value;
}

function queryGpu(index) {
  let out;
  try {
    out = execFileSync(
      'nvidia-smi',
      [
        '--query-gpu=index,name,driver_version,memory.total,memory.free',
        '--format=csv,noheader,nounits',
      ],
      { encoding: 'utf8', timeout: 4000, windowsHide: true },
    );
  } catch (err) {
    // 没有 N 卡 / 驱动没装 / nvidia-smi 不在 PATH：只报告，不抛。
    // 判断不了显存时 ledger 会标 known:false，仍然允许用户硬起（不拦）。
    const detail = err && (err.code || err.message) ? String(err.code || err.message) : '未知错误';
    return gpuUnavailable(`读不到 nvidia-smi（${detail}）`);
  }

  const devices = parseGpuQueryOutput(out);
  if (!devices.length) return gpuUnavailable('nvidia-smi 没有返回显卡信息');

  const chosen = devices.find((d) => d.index === index) || devices[0];
  return {
    ok: true,
    at: Date.now(),
    error: null,
    index: chosen.index,
    gpu: chosen.gpu,
    driver: chosen.driver,
    totalMiB: chosen.totalMiB,
    freeMiB: chosen.freeMiB,
    devices,
  };
}

/**
 * 解析 `nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.free
 *           --format=csv,noheader,nounits` 的输出。
 * 单独导出是为了能拿真实输出回放测试（有些沙箱不允许 node 起子进程抓 stdout）。
 *
 * @returns {Array<{index:number,gpu:string,driver:string,totalMiB:number,freeMiB:number}>}
 */
export function parseGpuQueryOutput(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map(parseGpuLine)
    .filter(Boolean);
}

/**
 * 解析一行 `index, name, driver, total, free`。
 * 名字里可能带逗号，所以从右往左认字段：最后三个是 driver/total/free。
 */
function parseGpuLine(line) {
  const text = String(line).trim();
  if (!text) return null;
  const parts = text.split(',').map((s) => s.trim());
  if (parts.length < 4) return null;

  const index = Number(parts[0]);
  const driver = parts[parts.length - 3];
  const totalMiB = Number(parts[parts.length - 2]);
  const freeMiB = Number(parts[parts.length - 1]);
  const gpu = parts.slice(1, -3).join(', ') || '未知显卡';
  if (!Number.isFinite(totalMiB) || !Number.isFinite(freeMiB)) return null;

  return {
    index: Number.isFinite(index) ? index : 0,
    gpu,
    driver,
    totalMiB,
    freeMiB,
  };
}

function gpuUnavailable(error) {
  return {
    ok: false,
    at: Date.now(),
    error,
    index: null,
    gpu: null,
    driver: null,
    totalMiB: null,
    freeMiB: null,
    devices: [],
  };
}

/**
 * 环境指纹：gpu + driver + totalMiB + freeMiB。
 * 为什么连 freeMiB 都要记：同型号的卡，桌面占用不同，可用显存能差几百 MiB；
 * 不记的话两张同型号卡会被当成同一张，沿用别人的实测值。
 */
export function fingerprintOf(gpu) {
  if (!gpu || gpu.ok !== true) return null;
  return {
    gpu: String(gpu.gpu ?? ''),
    driver: String(gpu.driver ?? ''),
    totalMiB: Math.round(gpu.totalMiB),
    freeMiB: Math.round(gpu.freeMiB),
  };
}

/**
 * 比对档案里的指纹和当前指纹。
 * gpu / driver / totalMiB 必须完全一致；freeMiB 允许 512 MiB 容差。
 *
 * @returns {{match:boolean, changes:Array<{field:string,was?:any,now?:any,reason:string}>, freeDeltaMiB?:number}}
 */
export function compareFingerprint(recorded, current) {
  if (!recorded || typeof recorded !== 'object') {
    return { match: false, changes: [{ field: 'fingerprint', reason: '档案里没有环境指纹' }] };
  }
  if (!current) {
    return { match: false, changes: [{ field: 'gpu', reason: '当前读不到显卡，无法核对指纹' }] };
  }

  const changes = [];
  if (String(recorded.gpu ?? '') !== String(current.gpu ?? '')) {
    changes.push({
      field: 'gpu',
      was: recorded.gpu,
      now: current.gpu,
      reason: `显卡变了（${recorded.gpu ?? '未知'} → ${current.gpu ?? '未知'}）`,
    });
  }
  if (String(recorded.driver ?? '') !== String(current.driver ?? '')) {
    changes.push({
      field: 'driver',
      was: recorded.driver,
      now: current.driver,
      reason: `驱动变了（${recorded.driver ?? '未知'} → ${current.driver ?? '未知'}）`,
    });
  }
  if (Number(recorded.totalMiB) !== Number(current.totalMiB)) {
    changes.push({
      field: 'totalMiB',
      was: recorded.totalMiB,
      now: current.totalMiB,
      reason: `显存总量变了（${recorded.totalMiB ?? '?'} → ${current.totalMiB ?? '?'} MiB）`,
    });
  }

  const recordedFree = Number(recorded.freeMiB);
  const currentFree = Number(current.freeMiB);
  const freeDeltaMiB =
    Number.isFinite(recordedFree) && Number.isFinite(currentFree) ? currentFree - recordedFree : null;
  if (freeDeltaMiB == null) {
    changes.push({ field: 'freeMiB', reason: '指纹里缺 freeMiB 或当前读数无效' });
  } else if (Math.abs(freeDeltaMiB) > FINGERPRINT_FREE_TOLERANCE_MIB) {
    changes.push({
      field: 'freeMiB',
      was: recordedFree,
      now: currentFree,
      reason:
        `空闲显存从 ${Math.round(recordedFree)} 变成 ${Math.round(currentFree)} MiB，` +
        `超过 ${FINGERPRINT_FREE_TOLERANCE_MIB} MiB（桌面占用不同，实测值不能沿用）`,
    });
  }

  return { match: changes.length === 0, changes, freeDeltaMiB };
}

// ---------------------------------------------------------------------------
// 模型文件大小（公式里的"权重"）
// ---------------------------------------------------------------------------

/** path → { at, value }，避免 UI 每次刷新都 stat 一遍几个 GB 的模型文件 */
const fileCache = new Map();

function measureFile(file, cacheMs) {
  const empty = { sizeMiB: null, missing: false, isDir: false };
  if (typeof file !== 'string' || !file.trim()) return empty;

  const now = Date.now();
  const hit = fileCache.get(file);
  if (hit && now - hit.at < cacheMs) return hit.value;

  let value;
  try {
    const st = fs.statSync(file);
    if (st.isFile()) value = { sizeMiB: st.size / MIB, missing: false, isDir: false };
    else value = { sizeMiB: null, missing: false, isDir: true }; // 目录不是权重
  } catch {
    value = { sizeMiB: null, missing: true, isDir: false };
  }
  fileCache.set(file, { at: now, value });
  return value;
}

/** 单个文件的 MiB；不是文件或读不到返回 null */
export function fileSizeMiB(file, { cacheMs = 15000 } = {}) {
  return measureFile(file, cacheMs).sizeMiB;
}

/**
 * 权重 ≈ 模型文件大小之和。
 * 目录型槽位（Strata 的 pack / tokenizer 目录）跳过；文件缺失记 0 并出警告——
 * 文件还没拷过来时也要能估个大概，不能因为估不了就拦住用户看界面。
 */
export function weightsOf(model, { cacheMs = 15000 } = {}) {
  const files = model?.files && typeof model.files === 'object' ? model.files : {};
  let weightsMiB = 0;
  const missing = [];
  const directories = [];

  for (const [key, file] of Object.entries(files)) {
    const measured = measureFile(file, cacheMs);
    if (measured.isDir) {
      directories.push(key);
      continue;
    }
    if (measured.sizeMiB == null) {
      if (measured.missing) missing.push({ key, path: file });
      continue;
    }
    weightsMiB += measured.sizeMiB;
  }

  return { weightsMiB, missing, directories, slotCount: Object.keys(files).length };
}

// ---------------------------------------------------------------------------
// KV 池 / 主机内存
// ---------------------------------------------------------------------------

/**
 * KV 池大小。
 * "池 token 数"优先取 params.kvWindow（引擎的 KV 窗口），没有就退 params.maxContext。
 * 注意引擎带 --kv-capacity auto 时会把池缩到当时显存装得下的量，
 * 所以公式拿到的是**上限**——第一次会偏大，实测回填后以实测为准。
 */
export function kvOf(model, { poolTokens } = {}) {
  const params = model?.params || {};
  const declaredDtype = typeof params.kvDtype === 'string' ? params.kvDtype.trim() : '';
  const dtype = KV_PAGE_MIB[declaredDtype] ? declaredDtype : DEFAULT_KV_DTYPE;
  const pageMiB = KV_PAGE_MIB[dtype];

  let tokens = 0;
  let poolSource = 'none';
  if (poolTokens != null && Number.isFinite(Number(poolTokens)) && Number(poolTokens) > 0) {
    tokens = Math.floor(Number(poolTokens));
    poolSource = 'override';
  } else if (Number.isFinite(Number(params.kvWindow)) && Number(params.kvWindow) > 0) {
    tokens = Math.floor(Number(params.kvWindow));
    poolSource = 'kvWindow';
  } else if (Number.isFinite(Number(params.maxContext)) && Number(params.maxContext) > 0) {
    tokens = Math.floor(Number(params.maxContext));
    poolSource = 'maxContext';
  }

  const pages = tokens > 0 ? Math.ceil(tokens / PAGE_TOKENS) : 0;
  return {
    dtype,
    dtypeKnown: declaredDtype !== '' && declaredDtype === dtype,
    pageMiB,
    poolTokens: tokens,
    poolSource,
    pages,
    kvMiB: pages * pageMiB,
  };
}

/** --host-kv-mib：主机内存，不是显存 */
export function hostRamOf(model) {
  const value = Number(model?.params?.hostKvMib);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_HOST_KV_MIB;
}

/**
 * 运行时预留（MiB）：引擎进程在权重之外还要的那块工作区。
 *
 * 来源优先级：
 *   1. `params.runtimeReserveMib` —— 实测回填的值（见 saveRuntimeReserve）
 *   2. `DEFAULT_RUNTIME_MIB`      —— 第一次估的下限
 *
 * 为什么不从引擎 spec 上读：同一个引擎跑不同模型，预留会变（上下文、
 * KV 类型、投机解码都影响），所以它属于**模型**，和 maxContext 一样。
 */
export function runtimeReserveOf(model) {
  const value = Number(model?.params?.runtimeReserveMib);
  if (Number.isFinite(value) && value >= 0) return Math.round(value);
  return DEFAULT_RUNTIME_MIB;
}

// ---------------------------------------------------------------------------
// 三级来源
// ---------------------------------------------------------------------------

/**
 * 纯公式：权重 + KV 池 + 工作区。
 * 不抛异常、不依赖环境（文件读不到就按 0 估 + 警告）。
 *
 * @returns {{
 *   modelId:string|null, source:'formula', vramMiB:number, hostRamMiB:number,
 *   breakdown:{weightsMiB:number,kvMiB:number,workspaceMiB:number},
 *   kv:object, reason:string, warnings:string[]
 * }}
 */
export function formulaEstimate(model, { poolTokens } = {}) {
  if (!model || typeof model !== 'object') throw new TypeError('formulaEstimate(model) 需要一个模型对象');

  const weights = weightsOf(model);
  const kv = kvOf(model, { poolTokens });
  const workspaceMiB = runtimeReserveOf(model);
  const declaredReserve = Number(model?.params?.runtimeReserveMib);
  const warnings = [];

  if (kv.poolSource === 'none') warnings.push('没有 kvWindow / maxContext，KV 池按 0 估');
  if (!Number.isFinite(declaredReserve)) {
    warnings.push(
      `运行时预留按默认 ${DEFAULT_RUNTIME_MIB} MiB 估；引擎实际要的往往更多，` +
        '起不来时日志里会写「runtime reservation requires N bytes」，抓到会自动回填',
    );
  }
  if (!kv.dtypeKnown && model?.params?.kvDtype) {
    warnings.push(`KV 数据类型「${model.params.kvDtype}」不认识，按 bf16 最贵价估算`);
  }
  for (const miss of weights.missing) warnings.push(`模型文件不存在：${miss.path}（权重按 0 估）`);
  if (weights.slotCount === 0) warnings.push('模型没有文件，权重按 0 估');

  return {
    modelId: model.id ?? null,
    source: 'formula',
    vramMiB: Math.round(weights.weightsMiB + kv.kvMiB + workspaceMiB),
    hostRamMiB: Math.round(hostRamOf(model)),
    breakdown: {
      weightsMiB: Math.round(weights.weightsMiB),
      kvMiB: Math.round(kv.kvMiB),
      workspaceMiB,
    },
    kv,
    runtimeReserveMiB: workspaceMiB,
    reason:
      `按公式估算（权重≈文件大小 + KV 池 + 运行时预留 ${workspaceMiB} MiB` +
      (Number.isFinite(declaredReserve) ? '，实测回填)' : '，默认值)'),
    warnings,
  };
}

/** 把档案里的 breakdown 规整成统一形状；缺了就按总价反推一个，保证求和时对得上 */
function normalizeBreakdown(breakdown, vramMiB, fallback) {
  const weights = Number(breakdown?.weightsMiB);
  const kv = Number(breakdown?.kvMiB);
  const runtime = Number(breakdown?.runtimeMiB ?? breakdown?.workspaceMiB);
  if (Number.isFinite(weights) && Number.isFinite(kv)) {
    return {
      weightsMiB: Math.round(weights),
      kvMiB: Math.round(kv),
      workspaceMiB: Math.round(Number.isFinite(runtime) ? runtime : fallback.workspaceMiB),
    };
  }
  // 手填 / 老档案只有总价：把工作区留给 breakdown 的固定值，剩下的算权重
  return {
    weightsMiB: Math.max(0, Math.round(vramMiB - fallback.workspaceMiB)),
    kvMiB: 0,
    workspaceMiB: fallback.workspaceMiB,
  };
}

/**
 * 估一个模型的价（显存 + 主机内存），自带三级来源选择。
 *
 * 选择规则：
 *   manual   —— 档案里 source=manual，直接用用户填的值（不看指纹，他可能有自己的混跑方式）
 *   measured —— 档案里 source=measured 且指纹匹配，直接用实测值
 *   formula  —— 其余情况；measured 指纹不匹配时降级，并说明"硬件变了"
 */
export function estimateModel(model, { gpu, poolTokens } = {}) {
  if (!model || typeof model !== 'object') throw new TypeError('estimateModel(model) 需要一个模型对象');

  const gpuInfo = gpu ?? readGpu();
  const formula = formulaEstimate(model, { poolTokens });
  const footprint = model.footprint;

  if (!footprint || typeof footprint !== 'object') {
    return { ...formula, measuredAt: null, fingerprint: null, degraded: false, degradedReason: null, lastFailure: null, footprint: null };
  }

  if (footprint.source === 'manual') {
    const vramMiB = roundMiB(footprint.vramMiB);
    if (vramMiB == null) {
      return {
        ...formula,
        reason: '手填的显存值无效，退回公式估算',
        measuredAt: footprint.measuredAt ?? null,
        fingerprint: footprint.fingerprint ?? null,
        degraded: false,
        degradedReason: null,
        lastFailure: footprint.lastFailure ?? null,
        footprint,
      };
    }
    return {
      ...formula,
      source: 'manual',
      vramMiB,
      hostRamMiB: roundMiB(footprint.hostRamMiB) ?? formula.hostRamMiB,
      breakdown: normalizeBreakdown(footprint.breakdown, vramMiB, formula.breakdown),
      reason: '用户手填的显存值',
      measuredAt: footprint.measuredAt ?? null,
      fingerprint: footprint.fingerprint ?? null,
      degraded: false,
      degradedReason: null,
      lastFailure: footprint.lastFailure ?? null,
      footprint,
    };
  }

  if (footprint.source === 'measured') {
    const currentFingerprint = fingerprintOf(gpuInfo);
    const compared = compareFingerprint(footprint.fingerprint, currentFingerprint);

    if (!compared.match) {
      const why = compared.changes.map((c) => c.reason).join('；');
      return {
        ...formula,
        reason: `硬件变了，按公式估算（${why}）`,
        measuredAt: footprint.measuredAt ?? null,
        fingerprint: currentFingerprint,
        degraded: true,
        degradedReason: why,
        fingerprintChanges: compared.changes,
        lastFailure: footprint.lastFailure ?? null,
        footprint,
      };
    }

    const vramMiB = roundMiB(footprint.vramMiB) ?? formula.vramMiB;
    return {
      ...formula,
      source: 'measured',
      vramMiB,
      hostRamMiB: roundMiB(footprint.hostRamMiB) ?? formula.hostRamMiB,
      breakdown: normalizeBreakdown(footprint.breakdown, vramMiB, formula.breakdown),
      reason: `用 ${footprint.measuredAt ?? '上次'} 的实测值（同卡同驱动）`,
      measuredAt: footprint.measuredAt ?? null,
      fingerprint: currentFingerprint,
      degraded: false,
      degradedReason: null,
      lastFailure: footprint.lastFailure ?? null,
      footprint,
    };
  }

  return {
    ...formula,
    reason: `档案里的预估来源「${footprint.source}」不认识，按公式估算`,
    measuredAt: footprint.measuredAt ?? null,
    fingerprint: footprint.fingerprint ?? null,
    degraded: false,
    degradedReason: null,
    lastFailure: footprint.lastFailure ?? null,
    footprint,
  };
}

const SOURCE_RANK = { formula: 0, manual: 1, measured: 2 };

/**
 * 估一个实例（1..N 个模型）的价。
 * 多模型实例：价 = 它承载的所有模型之和（任务书 §5.9.1）。
 * 主机内存取 max 不取和：--host-kv-mib 是**进程级** flag，多模型还是一个进程。
 *
 * @returns {{
 *   source:'measured'|'manual'|'formula',
 *   vramMiB:number, hostRamMiB:number,
 *   breakdown:{weightsMiB:number,kvMiB:number,workspaceMiB:number},
 *   modelIds:string[], models:object[], reason:string, warnings:string[]
 * }}
 */
export function estimateModels(models, { gpu, poolTokensByModel } = {}) {
  const list = (Array.isArray(models) ? models : [models]).filter(Boolean);
  if (!list.length) throw new TypeError('estimateModels() 至少需要一个模型');

  const gpuInfo = gpu ?? readGpu();
  const parts = list.map((model) =>
    estimateModel(model, { gpu: gpuInfo, poolTokens: poolTokensByModel?.[model.id] }),
  );

  const hostRamMiB = Math.round(Math.max(0, ...parts.map((p) => Number(p.hostRamMiB) || 0)));
  const modelIds = parts.map((p) => p.modelId ?? null);

  if (parts.length === 1) {
    const only = parts[0];
    return {
      ...only,
      hostRamMiB,
      modelIds,
      models: parts,
      sources: [{ modelId: only.modelId, source: only.source, vramMiB: only.vramMiB, reason: only.reason }],
      warnings: [...only.warnings],
    };
  }

  // 多模型：价 = 所有模型之和（§5.9.1 的硬规则）。
  // 工作区也各算一份（每个模型 256 MiB），偏保守；实测回填后会被修正。
  const vramMiB = Math.round(parts.reduce((sum, p) => sum + (Number(p.vramMiB) || 0), 0));
  const weightsMiB = Math.round(parts.reduce((sum, p) => sum + (Number(p.breakdown?.weightsMiB) || 0), 0));
  const kvMiB = Math.round(parts.reduce((sum, p) => sum + (Number(p.breakdown?.kvMiB) || 0), 0));
  const workspaceMiB = Math.round(
    parts.reduce((sum, p) => sum + (Number(p.breakdown?.workspaceMiB) || WORKSPACE_MIB), 0),
  );

  // 来源取最不可靠的那一个：混着公式值时，整条提示就不能说"实测"
  const source = parts.reduce(
    (worst, p) => (SOURCE_RANK[p.source] < SOURCE_RANK[worst] ? p.source : worst),
    'measured',
  );
  const degradedParts = parts.filter((p) => p.degraded);
  const reasons = [];
  if (parts.some((p) => p.source === 'formula')) reasons.push('部分模型没有实测值，按公式估算');
  if (degradedParts.length) reasons.push(`${degradedParts.length} 个模型的实测值因硬件变化作废`);

  return {
    source,
    vramMiB,
    hostRamMiB,
    breakdown: { weightsMiB, kvMiB, workspaceMiB },
    kv: null,
    modelIds,
    models: parts,
    sources: parts.map((p) => ({ modelId: p.modelId, source: p.source, vramMiB: p.vramMiB, reason: p.reason })),
    reason:
      `${parts.length} 个模型合计 ${vramMiB} MiB` +
      (reasons.length ? `；${reasons.join('；')}` : ''),
    degraded: degradedParts.length > 0,
    degradedReason: degradedParts.map((p) => p.degradedReason).filter(Boolean).join('；') || null,
    measuredAt: parts.every((p) => p.measuredAt) ? parts.map((p) => p.measuredAt).join(' / ') : null,
    lastFailure: parts.find((p) => p.lastFailure)?.lastFailure ?? null,
    warnings: parts.flatMap((p) => p.warnings ?? []),
  };
}

// ---------------------------------------------------------------------------
// 实测回填
// ---------------------------------------------------------------------------

/**
 * 从一行引擎日志里抓 KV 容量 / runtime。
 * 用 Engine 的 footprintLog 正则；抓不到返回 null（调用方退回公式，**不报错**）。
 *
 * @returns {{kvTokens:number|null, runtimeMiB:number|null, raw:string}|null}
 */
export function parseFootprintLine(line, engine) {
  if (typeof line !== 'string') return null;
  const text = line.trim();
  if (!text) return null;

  const pattern = typeof engine?.footprintLog === 'string' && engine.footprintLog
    ? engine.footprintLog
    : DEFAULT_FOOTPRINT_LOG;

  let regex;
  try {
    regex = new RegExp(pattern);
  } catch {
    // 用户把正则写坏了也不能让回填链路炸掉
    return null;
  }

  const match = regex.exec(text);
  if (!match) {
    // 兜底：引擎启动失败时会把"要多少运行时预留"直接打出来
    //（"minimum Engine runtime reservation requires 2496345088 bytes"）。
    // 这条不是成功日志，但它是**唯一的真值来源**，抓到就带回去回填。
    const reserve = RESERVE_LOG_RE.exec(text);
    if (!reserve) return null;
    const bytes = toNumber(reserve[1]);
    if (bytes == null || bytes <= 0) return null;
    return {
      kvTokens: null,
      runtimeMiB: Math.round((bytes / MIB) * 10) / 10,
      source: 'reservation',
      bytes,
      raw: text,
    };
  }

  // 约定：第 1 组是 KV tokens，第 2 组是 runtime MiB（M1 的 footprintLog 就是这两个捕获组）。
  // 少一组时尽力而为：只有 tokens 也能回填 KV，runtime 退回模型自己的运行时预留。
  const kvTokens = toNumber(match[1]);
  const runtimeMiB = match.length > 2 ? toNumber(match[2]) : null;
  if (kvTokens == null && runtimeMiB == null) return null;

  return { kvTokens, runtimeMiB, source: 'capacity', raw: text };
}

/**
 * 根据实测数据生成 footprint（不落盘）。
 * 显存优先用 nvidia-smi 启动前后的差值（它才是"这张卡真的少了几 MiB"）；
 * 差值不可信（≤0，或小到不像一次真实加载）时改用明细合计并给出警告。
 *
 * @returns {{footprint:object, basis:string, warnings:string[]}}
 */
export function measureFootprint({ model, parsed, beforeFreeMiB, afterFreeMiB, gpu } = {}) {
  if (!model || typeof model !== 'object') throw new TypeError('measureFootprint() 需要 model');

  const gpuInfo = gpu ?? readGpu();
  const weights = weightsOf(model);
  const kv = kvOf(model);
  const dtype = kv.dtype;
  const kvMiB =
    parsed?.kvTokens != null
      ? Math.ceil(parsed.kvTokens / PAGE_TOKENS) * KV_PAGE_MIB[dtype]
      : kv.kvMiB;
  const runtimeMiB =
    Number.isFinite(Number(parsed?.runtimeMiB)) && Number(parsed.runtimeMiB) >= 0
      ? Number(parsed.runtimeMiB)
      : runtimeReserveOf(model);

  const sumMiB = weights.weightsMiB + kvMiB + runtimeMiB;
  const delta =
    Number.isFinite(Number(beforeFreeMiB)) && Number.isFinite(Number(afterFreeMiB))
      ? Number(beforeFreeMiB) - Number(afterFreeMiB)
      : null;

  const warnings = [];
  let vramMiB;
  let basis;
  if (delta != null && delta >= MIN_MEASURABLE_VRAM_MIB) {
    vramMiB = Math.round(delta);
    basis = 'nvidia-smi 启动前后差值';
  } else {
    vramMiB = Math.round(sumMiB);
    basis = '权重 + KV + 工作区（明细合计）';
    if (delta == null) {
      warnings.push('没有启动前后的 nvidia-smi 读数，改用明细合计');
    } else if (delta <= 0) {
      warnings.push(`nvidia-smi 前后差值 ${delta} MiB（没有下降），改用明细合计`);
    } else {
      warnings.push(
        `nvidia-smi 前后差值只有 ${Math.round(delta)} MiB，不像一次真实加载，改用明细合计`,
      );
    }
  }

  return {
    footprint: {
      source: 'measured',
      vramMiB,
      hostRamMiB: Math.round(hostRamOf(model)),
      breakdown: {
        weightsMiB: Math.round(weights.weightsMiB),
        kvMiB: Math.round(kvMiB),
        runtimeMiB: Math.round(runtimeMiB),
      },
      measuredAt: localIso(),
      fingerprint: fingerprintOf(gpuInfo),
      lastFailure: null,
    },
    basis,
    warnings,
  };
}

/** 写回模型档案（唯一的写入点；M2 抓到日志行后调 backfillMeasured 即可） */
export function saveFootprint(modelId, footprint) {
  const model = loadModelForWrite(modelId);
  if (!model) throw new Error(`模型不存在：${modelId}`);
  model.footprint = footprint;
  saveModel(model);
  return model.footprint;
}

/**
 * 日志回填入口：一行日志 → 解析 → 合成 footprint → 写回档案。
 * 抓不到就原样返回（不写、不抛），下次预估继续用公式。
 */
export function backfillMeasured({
  model,
  modelId,
  line,
  parsed,
  beforeFreeMiB,
  afterFreeMiB,
  gpu,
  engine,
  save = true,
} = {}) {
  const target = model ?? (modelId ? loadModelForWrite(modelId) : null);
  if (!target) throw new Error(`模型不存在：${modelId ?? '(未提供)'}`);

  const hit = parsed !== undefined ? parsed : parseFootprintLine(line, engine);
  if (!hit) {
    return {
      footprint: null,
      saved: false,
      basis: null,
      warnings: ['日志里没抓到显存行，保留公式估算'],
    };
  }

  const measured = measureFootprint({
    model: target,
    parsed: hit,
    beforeFreeMiB,
    afterFreeMiB,
    gpu,
  });

  if (save) saveFootprint(target.id, measured.footprint);
  return { ...measured, saved: Boolean(save) };
}

/**
 * 把引擎自己报的「运行时预留」写回模型档案（`params.runtimeReserveMib`）。
 *
 * 什么时候调：日志里出现 `runtime reservation requires N bytes` 时（M2 的
 * InstanceLog 会把它作为 `reservation` 事件抛出来）。成功启动时也值得调一次——
 * 那说明这个值至少是引擎要的，下次预估就不会再低估。
 *
 * 为什么不写进 `footprint`：footprint 是"整块显存"的实测值，带了环境指纹；
 * 运行时预留是引擎要的**常数**，跟卡无关，放 params 才能被公式直接复用。
 *
 * @returns {{modelId:string, previous:number, value:number}|null} null = 没写（模型不存在 / 变化太小）
 */
export function saveRuntimeReserve(modelId, runtimeReserveMiB, { minDeltaMiB = 64 } = {}) {
  const model = loadModelForWrite(modelId);
  if (!model) return null;

  const value = Math.round(Number(runtimeReserveMiB));
  if (!Number.isFinite(value) || value < 0) return null;

  const declared = Number(model?.params?.runtimeReserveMib);
  const previous = Number.isFinite(declared) ? Math.round(declared) : runtimeReserveOf(model);
  // 几十 MiB 的抖动不值得写盘：每次启动都改用户档案，diff 会很难看
  if (Math.abs(value - previous) < minDeltaMiB) return null;

  const params = isPlainObject(model.params) ? { ...model.params } : {};
  params.runtimeReserveMib = value;
  model.params = params;
  const saved = saveModel(model);
  if (saved && saved.ok === false) return null;
  return { modelId, previous, value };
}

/** 起不来时把原因记进 lastFailure，下次提示更具体（手册 §5.10） */
export function recordFailure(modelId, failure) {
  const model = loadModelForWrite(modelId);
  if (!model) throw new Error(`模型不存在：${modelId}`);
  const message =
    typeof failure === 'string' ? failure : String(failure?.message ?? failure ?? '未知原因');
  const previous = model.footprint && typeof model.footprint === 'object' ? model.footprint : null;
  model.footprint = {
    source: previous?.source ?? 'formula',
    vramMiB: previous?.vramMiB ?? null,
    hostRamMiB: previous?.hostRamMiB ?? null,
    breakdown: previous?.breakdown ?? null,
    measuredAt: previous?.measuredAt ?? null,
    fingerprint: previous?.fingerprint ?? null,
    lastFailure: { message, at: localIso() },
  };
  saveModel(model);
  return model.footprint;
}
