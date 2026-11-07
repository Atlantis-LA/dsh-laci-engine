/**
 * core/ledger.mjs —— 显存 / 主机内存账本（M4）
 *
 * 核心决策（任务书 §账本 + 主文档 §4.3、§5.10，写代码前就定死了）：
 *
 *   账本      → 记录"我承诺了多少"，用于显示 + 启动瞬间的预留
 *   实时 nvidia-smi → 真正的判断依据，每次预估都读实时 free
 *
 * 由此推出三条实现规则，别搞反：
 *   1. **运行中的实例不从实时 free 里扣**。它们的占用已经反映在 nvidia-smi 的 free 里了，
 *      再按账本减一次就是双计——那正是旧代码"先关 A 才能起 B"的来源。
 *   2. **只有进行中的预留（lease）才从实时 free 里扣**。lease 对应"进程马上要起、还没进入
 *      nvidia-smi"的那几百毫秒，这是账本存在的唯一硬理由：防两个并发启动同时判"够"。
 *   3. **账本允许为负**。force 之后承诺超过卡总量，只让界面标红，不参与任何判断，
 *      所以不需要"负数之后怎么恢复"的规则。
 *
 * 显存不够时**返回差多少，不拒绝**；由界面问用户，点「仍然加载」就 force 起。
 * 内存（os.freemem）和显存两栏都要报：显存够内存不够，崩得更晚、更难查。
 */
import os from 'node:os';
import { loadEngine, loadInstances, loadModel } from './registry.mjs';
import { estimateModels, readGpu } from './footprint.mjs';

const MIB = 1024 * 1024;

/** 还在占资源的实例状态。error 表示进程已经没了，不该再记账 */
export const RUNNING_PHASES = Object.freeze(['starting', 'ready', 'stopping']);

/** 判断"能不能再开一个实例"时算作"已经有实例了"的状态：
 *  stopping 不算——换模型时先 stop 再 start，算上 stopping 会让正常切换被硬拦。 */
export const OCCUPYING_PHASES = Object.freeze(['starting', 'ready']);

/** 预留的存活时间：正常路径都会 release，它兜的是崩溃/异常路径漏 release */
export const LEASE_TTL_MS = 10 * 60 * 1000;

/** 运行中实例的估价缓存：文件 stat 和指纹比对没必要每次刷新都做一遍 */
export const INSTANCE_CACHE_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// 输入归一化
// ---------------------------------------------------------------------------

function normalizeInstances(instances) {
  if (instances === undefined) {
    try {
      return normalizeInstances(loadInstances());
    } catch {
      // 数据层读失败不应该让整个预估炸掉：按"没有实例"记，界面上仍能看显存
      return {};
    }
  }
  if (!instances) return {};
  if (instances instanceof Map) return Object.fromEntries(instances);
  if (Array.isArray(instances)) {
    return Object.fromEntries(
      instances.filter((item) => item && item.id).map((item) => [item.id, item]),
    );
  }
  return typeof instances === 'object' ? instances : {};
}

function phaseOf(instance) {
  if (!instance || typeof instance !== 'object') return 'idle';
  if (typeof instance.phase === 'string' && instance.phase) return instance.phase;
  // 老数据 / 只存了 pid 的情况：有 pid 就当成在跑
  return instance.pid ? 'ready' : 'idle';
}

/** M1 的接口约定是同步的；万一某个实现返回 Promise，宁可报清楚也不要算出假数字 */
function assertSyncModel(model, id) {
  if (model && typeof model.then === 'function') {
    throw new Error(
      `M1 registry 的 loadModel(${id}) 返回了 Promise，但 ledger.estimate 是同步 API`,
    );
  }
  return model;
}

/**
 * 账本。整个进程只该有一个（`ledger` 单例），因为"承诺"是全局的。
 */
export class VramLedger {
  constructor({
    now = () => Date.now(),
    gpuProvider = readGpu,
    ramFreeProvider = () => os.freemem(),
    leaseTtlMs = LEASE_TTL_MS,
    instanceCacheMs = INSTANCE_CACHE_MS,
  } = {}) {
    this._now = now;
    this._readGpu = gpuProvider;
    this._ramFree = ramFreeProvider;
    this._leaseTtlMs = leaseTtlMs;
    this._instanceCacheMs = instanceCacheMs;
    this._leases = new Map();
    this._instanceCache = new Map();
    this._seq = 0;
  }

  /**
   * 把 id / 模型对象 / 实例对象 / 数组 统一成模型对象列表。
   * 同一个模型只算一次（否则多模型实例会把自己的价算重）。
   */
  resolveModels(input) {
    const collected = [];

    const push = (value) => {
      if (value == null) return;
      if (Array.isArray(value)) {
        for (const item of value) push(item);
        return;
      }
      if (typeof value === 'string') {
        const model = assertSyncModel(loadModel(value), value);
        if (!model) throw new Error(`模型不存在：${value}`);
        collected.push(model);
        return;
      }
      if (typeof value !== 'object') {
        throw new TypeError('estimate() 需要模型 id、模型对象或实例对象');
      }
      if (Array.isArray(value.modelIds)) {
        for (const modelId of value.modelIds) push(modelId);
        return;
      }
      if (value.files || value.params) {
        collected.push(value);
        return;
      }
      if (typeof value.id === 'string') {
        const model = assertSyncModel(loadModel(value.id), value.id);
        if (!model) throw new Error(`模型不存在：${value.id}`);
        collected.push(model);
        return;
      }
      throw new TypeError('无法识别的模型/实例参数');
    };

    push(input);

    const unique = new Map();
    for (const model of collected) {
      const key = model.id ?? `anonymous-${unique.size}`;
      if (!unique.has(key)) unique.set(key, model);
    }
    if (!unique.size) throw new TypeError('estimate() 至少需要一个模型');
    return [...unique.values()];
  }

  /**
   * 预估 + 判断。
   *
   * @param {string|object|Array} input 模型 id / 模型对象 / 实例对象 / 数组
   * @param {{instances?:object, freshGpu?:boolean, poolTokensByModel?:object}} [options]
   * @returns {{
   *   ok:boolean, known:boolean, unit:'MiB',
   *   source:'measured'|'manual'|'formula',
   *   neededVram:number, neededRam:number,
   *   freeVram:number|null, freeRam:number,
   *   shortVram:number|null, shortRam:number,
   *   breakdown:object, modelIds:string[], sources:object[], reason:string,
   *   warnings:string[],
   *   reservations:{count:number, vramMiB:number, ramMiB:number},
   *   ledger:{committedVramMiB:number, committedRamMiB:number, freeVramMiB:number|null, negative:boolean,
   *           runningCount:number, running:object[]},
   *   gpu:{ok:boolean, gpu:string|null, driver:string|null, totalMiB:number|null,
   *        freeMiB:number|null, error:string|null, at:number}
   * }}
   */
  estimate(input, options = {}) {
    const models = this.resolveModels(input);
    const now = this._now();
    this._purgeLeases(now);

    const gpu = this._readGpu({ fresh: Boolean(options.freshGpu) });
    const priced = estimateModels(models, {
      gpu,
      poolTokensByModel: options.poolTokensByModel,
    });

    // 唯一从实时值里扣的东西：进行中的预留（进程还没起来，没进 nvidia-smi）
    const reservations = this._reservationTotals();
    const liveFreeVram = gpu.ok ? gpu.freeMiB : null;
    const freeVram = liveFreeVram == null ? null : liveFreeVram - reservations.vramMiB;

    // 内存用 os.freemem()，不自己记；预留同样要扣，理由和显存一样
    const freeRam = this._ramFree() / MIB - reservations.ramMiB;

    const shortVram = freeVram == null ? null : Math.max(0, priced.vramMiB - freeVram);
    const shortRam = Math.max(0, priced.hostRamMiB - freeRam);
    const known = freeVram != null;
    // 显存读不到时不拦（"问，不拦"），界面标"未知"即可
    const ok = known ? shortVram <= 0 && shortRam <= 0 : true;

    // 以下纯粹是"显示账"：运行中实例 + 进行中预留 = 我承诺了多少。
    // 它不参与上面的 ok / short 计算。
    const running = this._runningCommitments(options.instances, gpu);
    const committedVramMiB = running.vramMiB + reservations.vramMiB;
    const committedRamMiB = running.ramMiB + reservations.ramMiB;
    const freeByLedger = gpu.ok ? gpu.totalMiB - committedVramMiB : null; // 可以是负数，只用于显示

    return {
      ok,
      known,
      unit: 'MiB',
      source: priced.source,

      neededVram: priced.vramMiB,
      neededRam: priced.hostRamMiB,

      freeVram,
      freeRam,
      shortVram,
      shortRam,

      // 主文档 §4.3 里的另一组字段名（同义，单位都是 MiB），
      // 让按不同文档接入的模块都能直接取到值
      neededMiB: priced.vramMiB,
      freeMiB: freeVram,
      shortfallMiB: shortVram,

      breakdown: priced.breakdown,
      modelIds: priced.modelIds ?? models.map((model) => model.id ?? null),
      sources: priced.sources ?? [],
      reason: priced.reason,
      degraded: Boolean(priced.degraded),
      degradedReason: priced.degradedReason ?? null,
      measuredAt: priced.measuredAt ?? null,
      lastFailure: priced.lastFailure ?? null,
      warnings: priced.warnings ?? [],

      reservations: {
        count: reservations.count,
        vramMiB: reservations.vramMiB,
        ramMiB: reservations.ramMiB,
      },
      ledger: {
        committedVramMiB,
        committedRamMiB,
        freeVramMiB: freeByLedger,
        negative: freeByLedger != null && freeByLedger < 0,
        runningCount: running.instances.length,
        running: running.instances,
      },
      gpu: {
        ok: gpu.ok,
        gpu: gpu.gpu,
        driver: gpu.driver,
        totalMiB: gpu.totalMiB,
        freeMiB: gpu.freeMiB,
        error: gpu.error,
        at: gpu.at,
      },
    };
  }

  /**
   * 启动瞬间的预留。**永远成功**（不够也只是记下来，由界面问用户），
   * 所以它不返回布尔值，而是返回一个必须 release 的 lease。
   *
   * @param {string|object|Array} input
   * @param {object} [options] 传给 estimate 的选项，外加：
   *   force   用户点了「仍然加载」
   *   label   给人看的备注（如"加载 qwen3.8-27b"）
   *   engineId
   *   estimate 已经算过的预估，避免重复读 nvidia-smi
   *   ttlMs   预留存活时间
   * @returns {object} lease：{ id, vramMiB, ramMiB, forced, estimate, release() }
   */
  reserve(input, options = {}) {
    const estimate = options.estimate ?? this.estimate(input, options);
    const now = this._now();
    const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : this._leaseTtlMs;
    this._purgeLeases(now);

    const lease = {
      id: `lease-${++this._seq}`,
      engineId: options.engineId ?? null,
      modelIds: estimate.modelIds,
      label: options.label ?? null,
      vramMiB: estimate.neededVram,
      ramMiB: estimate.neededRam,
      source: estimate.source,
      // 预留时就不够（或调用方强制）：只用于显示，不影响后续判断
      forced: Boolean(options.force) || !estimate.ok,
      shortVram: estimate.shortVram,
      shortRam: estimate.shortRam,
      createdAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
      released: false,
      expired: false,
      estimate,
      release: () => this._release(lease.id),
    };

    this._leases.set(lease.id, lease);
    return lease;
  }

  /**
   * "抢账本"：够才给 lease。后台定时器（自愈 / 空闲卸载 / 自动启动）用这个，
   * 抢不到就跳过这次，不硬来（M2 任务书：要动手的都抢账本）。
   *
   * @returns {{ok:boolean, estimate:object, lease:object|null}}
   */
  tryReserve(input, options = {}) {
    const estimate = this.estimate(input, options);
    if (!estimate.ok && !options.force) {
      return { ok: false, estimate, lease: null };
    }
    const lease = this.reserve(input, { ...options, estimate, force: Boolean(options.force) });
    return { ok: true, estimate, lease };
  }

  /**
   * 起停前的硬规则检查（与显存无关的那几条）。
   * 显存/内存不够**不**在这里拦，只标 requiresConfirm，由界面问用户。
   *
   * 硬规则：
   *   - multiInstance 不是 true 的引擎已有实例 → 第二个直接拦，不管显存够不够
   *     （显式 false 和没声明都算，保守默认；§5.9 的"默认挡板"）
   *   - 一个实例多模型：引擎必须声明 supportsMultiModel 并且有 modelsArg（D1：只支持单槽位引擎）
   *   - 显式指定的引擎和模型所属引擎不一致
   *
   * @param {string|object|null} engine 引擎 id / 引擎对象；null 则按模型的 engineId 取
   * @returns {{
   *   allowed:boolean, blocked:object|null, blocks:object[], requiresConfirm:boolean,
   *   estimate:object, engine:object|null, runningInstances:object[]
   * }}
   */
  checkStart(engine, input, options = {}) {
    const models = this.resolveModels(input);

    let spec = engine;
    if (typeof spec === 'string') {
      spec = loadEngine(spec);
      if (!spec) throw new Error(`引擎不存在：${engine}`);
    }
    if (!spec) {
      const engineId = models[0]?.engineId;
      spec = engineId ? loadEngine(engineId) : null;
    }

    const engineId = spec?.id ?? models[0]?.engineId ?? null;
    const instances = normalizeInstances(options.instances);
    const runningInstances = Object.entries(instances)
      .filter(([, instance]) => {
        if (!instance) return false;
        if (String(instance.engineId ?? '') !== String(engineId)) return false;
        return OCCUPYING_PHASES.includes(phaseOf(instance));
      })
      .map(([instanceId, instance]) => ({
        instanceId,
        modelIds: instance.modelIds ?? [],
        port: instance.port ?? null,
        phase: phaseOf(instance),
      }));

    const blocks = [];
    const engineLabel = spec?.label ?? spec?.id ?? engineId ?? '（未知引擎）';

    if (spec?.multiInstance !== true && runningInstances.length > 0) {
      const why =
        spec?.multiInstance === false
          ? spec.why || 'multiInstance: false'
          : '引擎没有声明 multiInstance: true（保守默认按单实例处理）';
      blocks.push({
        code: 'multi-instance-disabled',
        message: `引擎「${engineLabel}」不支持同时运行多个实例（${why}）`,
        detail: '这是数据里的保守默认，不是引擎的硬限制；确要并行，改引擎定义里的 multiInstance。',
        runningInstances,
      });
    }

    if (models.length > 1) {
      if (spec?.supportsMultiModel !== true) {
        blocks.push({
          code: 'multi-model-unsupported',
          message: `引擎「${engineLabel}」不支持一个实例承载多个模型（没有声明 supportsMultiModel: true）`,
          detail: '多槽位引擎（如 Strata）永远一个进程一个模型。',
        });
      } else if (!spec?.modelsArg) {
        blocks.push({
          code: 'models-arg-missing',
          message: `引擎「${engineLabel}」声明了 supportsMultiModel，但没有 modelsArg，拼不出 --models`,
          detail: 'modelsArg 是引擎字段，不是模板变量。',
        });
      }
    }

    if (spec && models[0]?.engineId && String(models[0].engineId) !== String(spec.id)) {
      blocks.push({
        code: 'engine-mismatch',
        message: `模型「${models[0].id}」属于引擎「${models[0].engineId}」，不能挂到「${spec.id}」下`,
      });
    }

    const estimate = this.estimate(models, options);

    return {
      allowed: blocks.length === 0,
      blocked: blocks[0] ?? null,
      blocks,
      // 显存/内存不够不硬拦，只要求界面弹确认（两栏都报）
      requiresConfirm: blocks.length === 0 && !estimate.ok,
      estimate,
      engine: spec
        ? {
            id: spec.id ?? null,
            label: spec.label ?? null,
            multiInstance: spec.multiInstance === true,
            supportsMultiModel: spec.supportsMultiModel === true,
            modelsArg: spec.modelsArg ?? null,
          }
        : null,
      runningInstances,
    };
  }

  /** 给界面用的账本快照：不针对某个模型，只回答"现在账上是什么样" */
  snapshot({ instances } = {}) {
    const now = this._now();
    this._purgeLeases(now);
    const gpu = this._readGpu({});
    const running = this._runningCommitments(instances, gpu);
    const reservations = this._reservationTotals();
    const committedVramMiB = running.vramMiB + reservations.vramMiB;
    const committedRamMiB = running.ramMiB + reservations.ramMiB;
    const freeVramMiB = gpu.ok ? gpu.totalMiB - committedVramMiB : null;

    return {
      unit: 'MiB',
      gpu: {
        ok: gpu.ok,
        gpu: gpu.gpu,
        driver: gpu.driver,
        totalMiB: gpu.totalMiB,
        freeMiB: gpu.freeMiB,
        error: gpu.error,
        at: gpu.at,
      },
      ledger: {
        committedVramMiB,
        committedRamMiB,
        freeVramMiB,
        negative: freeVramMiB != null && freeVramMiB < 0,
        runningCount: running.instances.length,
        running: running.instances,
      },
      reservations: [...this._leases.values()].map((lease) => ({
        id: lease.id,
        label: lease.label,
        engineId: lease.engineId,
        modelIds: lease.modelIds,
        vramMiB: lease.vramMiB,
        ramMiB: lease.ramMiB,
        forced: lease.forced,
        createdAt: lease.createdAt,
        expiresAt: lease.expiresAt,
      })),
      // 和 estimate 一样：只扣"进行中的预留"。运行中实例占的内存已经在 os.freemem() 里了，
      // 再按 committedRam 减一次就是双计。
      ramFreeMiB: this._ramFree() / MIB - reservations.ramMiB,
    };
  }

  /** 释放所有预留（退出 / 测试用） */
  releaseAll() {
    for (const lease of this._leases.values()) {
      lease.released = true;
    }
    this._leases.clear();
  }

  // -- 内部 ---------------------------------------------------------------

  _release(id) {
    const lease = this._leases.get(id);
    if (!lease || lease.released) return false;
    lease.released = true;
    this._leases.delete(id);
    return true;
  }

  _purgeLeases(now = this._now()) {
    for (const [id, lease] of this._leases) {
      // 每个 lease 可以有自己的 TTL（reserve 时传），没有就按类默认
      const ttl = Number(lease.ttlMs) > 0 ? Number(lease.ttlMs) : this._leaseTtlMs;
      if (now - lease.createdAt >= ttl) {
        lease.expired = true;
        lease.released = true;
        this._leases.delete(id);
      }
    }
  }

  _reservationTotals() {
    let vramMiB = 0;
    let ramMiB = 0;
    for (const lease of this._leases.values()) {
      vramMiB += Number(lease.vramMiB) || 0;
      ramMiB += Number(lease.ramMiB) || 0;
    }
    return { count: this._leases.size, vramMiB, ramMiB };
  }

  /**
   * 运行中实例的"承诺"（只用于显示）。
   * 用 footprint 的估价，不读实时 free：因为这些实例已经在实时 free 里了。
   */
  _runningCommitments(instances, gpu) {
    const map = normalizeInstances(instances);
    const now = this._now();
    const rows = [];
    let vramMiB = 0;
    let ramMiB = 0;

    for (const [instanceId, instance] of Object.entries(map)) {
      const phase = phaseOf(instance);
      if (!RUNNING_PHASES.includes(phase)) continue;

      const modelIds = Array.isArray(instance?.modelIds)
        ? instance.modelIds
        : instance?.modelId
          ? [instance.modelId]
          : [];
      if (!modelIds.length) continue;

      const cacheKey = `${instanceId}|${modelIds.join(',')}`;
      const cached = this._instanceCache.get(cacheKey);
      let priced = cached && now - cached.at < this._instanceCacheMs ? cached.value : null;

      if (!priced) {
        const models = [];
        for (const modelId of modelIds) {
          try {
            const model = assertSyncModel(loadModel(modelId), modelId);
            if (model) models.push(model);
          } catch {
            // 模型档案读不出来时跳过这一个，不影响其它实例的显示
          }
        }
        if (!models.length) continue;
        priced = estimateModels(models, { gpu });
        this._instanceCache.set(cacheKey, { at: now, value: priced });
      }

      vramMiB += Number(priced.vramMiB) || 0;
      ramMiB += Number(priced.hostRamMiB) || 0;
      rows.push({
        instanceId,
        modelIds,
        port: instance.port ?? null,
        phase,
        vramMiB: priced.vramMiB,
        ramMiB: priced.hostRamMiB,
        source: priced.source,
      });
    }

    // 缓存别无限长
    if (this._instanceCache.size > 64) {
      for (const [key, entry] of this._instanceCache) {
        if (now - entry.at >= this._instanceCacheMs) this._instanceCache.delete(key);
      }
    }

    return { instances: rows, vramMiB, ramMiB };
  }
}

/** 整个进程只有一个账本 */
export const ledger = new VramLedger();

// 进程级薄封装：别的模块只 import 函数也行，不用关心单例
export function estimate(input, options) {
  return ledger.estimate(input, options);
}

export function reserve(input, options) {
  return ledger.reserve(input, options);
}

export function tryReserve(input, options) {
  return ledger.tryReserve(input, options);
}

export function checkStart(engine, input, options) {
  return ledger.checkStart(engine, input, options);
}

export function snapshot(options) {
  return ledger.snapshot(options);
}

export function releaseAllLeases() {
  return ledger.releaseAll();
}
