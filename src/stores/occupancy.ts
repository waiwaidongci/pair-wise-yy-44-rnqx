import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { useWorkshopStore, type Cue } from './workshop'
import {
  cueEnd,
  cueStart,
  dangerEnvelopeFor,
  envelopeFor,
  fingerprintOf,
  fmtTime,
  isMachinery,
  isMover,
  isStrobe,
  rectsOverlap,
  windowsOverlap,
} from '../lib/stage-geometry'

export type OccupationStatus = '已生效' | '待命' | '冲突待决' | '已失效'
export type ConflictKind = '时空重叠' | '安全互锁'

export type OccupationConflict = {
  kind: ConflictKind
  /** 参与冲突的双方提示 id。 */
  cueIds: [string, string]
  with: string
  description: string
}

export type ConfirmationPoint = {
  key: string
  seq: number
  baseSeq: number
  at: string
  cueIds: string[]
  status: '已生效' | '冲突待决'
  prints: Record<string, string>
  conflicts: OccupationConflict[]
}

export type FailedWrite = {
  key: string
  baseSeq: number
  cueIds: string[]
  error: string
}

const LOG_KEY = 'stage-scheduler-occupations-v1'

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** 机械 vs 演员：演员未在机械启动前腾空危险区，则机械待命。 */
function safetyHold(machinery: Cue, mover: Cue): string | null {
  if (!windowsOverlap(machinery, mover)) return null
  if (!rectsOverlap(envelopeFor(mover), dangerEnvelopeFor(machinery))) return null
  if (cueEnd(mover) > cueStart(machinery)) {
    return `演员 ${mover.id} 未离开危险区（预计 ${fmtTime(cueEnd(mover))} 腾空）`
  }
  return null
}

/** 爆闪 vs 机械：机械未到位前爆闪禁止触发。 */
function strobeHold(strobe: Cue, machinery: Cue): string | null {
  if (!windowsOverlap(strobe, machinery)) return null
  if (cueStart(strobe) < cueEnd(machinery)) {
    return `机械 ${machinery.id} 未到位（${fmtTime(cueEnd(machinery))} 到位），爆闪禁止触发`
  }
  return null
}

export const useOccupancyStore = defineStore('occupancy', () => {
  const workshop = useWorkshopStore()

  const seq = ref(100)
  /** 本方客户端已知的基准版本；他人抢先确认后此基准过期，抢单即留冲突。 */
  const knownBase = ref(100)
  const log = ref<ConfirmationPoint[]>([])
  const failedWrite = ref<FailedWrite | null>(null)
  const forceWriteFailure = ref(false)

  // 从最后确认点恢复（写入失败/刷新后不丢确认点）。
  function recover() {
    try {
      const raw = localStorage.getItem(LOG_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { seq?: number; log?: ConfirmationPoint[] }
      if (typeof parsed.seq === 'number') seq.value = parsed.seq
      if (Array.isArray(parsed.log)) log.value = parsed.log
      knownBase.value = seq.value
    } catch {
      /* 损坏的日志忽略，回到空确认点 */
    }
  }
  recover()

  function persist() {
    localStorage.setItem(LOG_KEY, JSON.stringify({ seq: seq.value, log: log.value }))
  }

  function cueById(id: string): Cue | undefined {
    return workshop.cues.find((cue) => cue.id === id)
  }

  function capturePrints(cueIds: string[]): Record<string, string> {
    const prints: Record<string, string> = {}
    for (const id of cueIds) {
      const cue = cueById(id)
      if (cue) prints[id] = fingerprintOf(cue)
    }
    return prints
  }

  /** 重放日志，得到当前有效占用（含失效判定）。 */
  const occupations = computed(() => {
    const map = new Map<string, { point: ConfirmationPoint; status: OccupationStatus }>()
    for (const point of log.value) {
      for (const id of point.cueIds) {
        const cue = cueById(id)
        if (!cue) continue
        if (point.status === '冲突待决') {
          map.set(id, { point, status: '冲突待决' })
          continue
        }
        const valid = fingerprintOf(cue) === point.prints[id]
        map.set(id, { point, status: valid ? '已生效' : '已失效' })
      }
    }
    return map
  })

  function statusOf(id: string): OccupationStatus | undefined {
    const occ = occupations.value.get(id)
    if (!occ) return undefined
    if (occ.status === '已生效' && held.value.has(id)) return '待命'
    return occ.status
  }

  function isOccupied(id: string): boolean {
    const status = statusOf(id)
    return status === '已生效' || status === '待命'
  }

  /** 待命：机械等演员腾空、爆闪等机械到位。 */
  const held = computed(() => {
    const result = new Map<string, { until: number; reason: string }>()
    const activeIds = [...occupations.value.entries()]
      .filter(([, occ]) => occ.status === '已生效')
      .map(([id]) => id)
    const activeCues = activeIds.map(cueById).filter((c): c is Cue => Boolean(c))

    for (const cue of activeCues) {
      if (isMachinery(cue)) {
        for (const other of activeCues) {
          if (other.id === cue.id || !isMover(other)) continue
          const reason = safetyHold(cue, other)
          if (reason) result.set(cue.id, { until: cueEnd(other), reason })
        }
      }
      if (isStrobe(cue)) {
        for (const other of activeCues) {
          if (other.id === cue.id || !isMachinery(other)) continue
          const reason = strobeHold(cue, other)
          if (reason) result.set(cue.id, { until: cueEnd(other), reason })
        }
      }
    }
    return result
  })

  /** 两两冲突：时空重叠 + 安全互锁。 */
  const conflicts = computed<OccupationConflict[]>(() => {
    const list: OccupationConflict[] = []
    const active = [...occupations.value.entries()]
      .filter(([, occ]) => occ.status === '已生效')
      .map(([id]) => cueById(id))
      .filter((c): c is Cue => Boolean(c))

    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i]
        const b = active[j]
        if (windowsOverlap(a, b) && rectsOverlap(envelopeFor(a), envelopeFor(b))) {
          list.push({
            kind: '时空重叠',
            cueIds: [a.id, b.id],
            with: b.id,
            description: `${a.id} 与 ${b.id} 运动范围在时间窗内重叠`,
          })
        }
        const machinery = isMachinery(a) ? a : isMachinery(b) ? b : null
        const mover = isMover(a) ? a : isMover(b) ? b : null
        if (machinery && mover) {
          const reason = safetyHold(machinery, mover)
          if (reason) {
            list.push({
              kind: '安全互锁',
              cueIds: [machinery.id, mover.id],
              with: mover.id,
              description: `${machinery.id} 待命：${reason}`,
            })
          }
        }
        const strobe = isStrobe(a) ? a : isStrobe(b) ? b : null
        const mach = isMachinery(a) ? a : isMachinery(b) ? b : null
        if (strobe && mach) {
          const reason = strobeHold(strobe, mach)
          if (reason) {
            list.push({
              kind: '安全互锁',
              cueIds: [strobe.id, mach.id],
              with: mach.id,
              description: `${strobe.id} 待命：${reason}`,
            })
          }
        }
      }
    }
    return list
  })

  /** 候选批次与当前已生效占用的冲突（抢单失败后“后到留冲突”用）。 */
  function conflictsAgainst(cueIds: string[]): OccupationConflict[] {
    const list: OccupationConflict[] = []
    const existing = [...occupations.value.entries()]
      .filter(([, occ]) => occ.status === '已生效')
      .map(([id]) => cueById(id))
      .filter((c): c is Cue => Boolean(c))
    const candidates = cueIds.map(cueById).filter((c): c is Cue => Boolean(c))

    for (const cand of candidates) {
      for (const occ of existing) {
        if (windowsOverlap(cand, occ) && rectsOverlap(envelopeFor(cand), envelopeFor(occ))) {
          list.push({
            kind: '时空重叠',
            cueIds: [cand.id, occ.id],
            with: occ.id,
            description: `${cand.id} 与已生效的 ${occ.id} 运动范围在时间窗内重叠`,
          })
        }
        if (isMachinery(cand) && isMover(occ)) {
          const reason = safetyHold(cand, occ)
          if (reason) {
            list.push({
              kind: '安全互锁',
              cueIds: [cand.id, occ.id],
              with: occ.id,
              description: `${cand.id} 待命：${reason}`,
            })
          }
        }
        if (isMover(cand) && isMachinery(occ)) {
          const reason = safetyHold(occ, cand)
          if (reason) {
            list.push({
              kind: '安全互锁',
              cueIds: [cand.id, occ.id],
              with: occ.id,
              description: `${cand.id} 进入 ${occ.id} 危险区：${reason}`,
            })
          }
        }
        if (isStrobe(cand) && isMachinery(occ)) {
          const reason = strobeHold(cand, occ)
          if (reason) {
            list.push({
              kind: '安全互锁',
              cueIds: [cand.id, occ.id],
              with: occ.id,
              description: `${cand.id} 待命：${reason}`,
            })
          }
        }
      }
    }
    return list
  }

  const invalidIds = computed(() =>
    [...occupations.value.entries()].filter(([, occ]) => occ.status === '已失效').map(([id]) => id),
  )

  const printValid = computed(() => invalidIds.value.length === 0)

  /**
   * 提交一个占用批次。
   * - 幂等：同一 key 已提交则直接返回，不重复占位。
   * - 乐观并发：baseSeq 与当前 seq 一致才生效（先到生效）；否则记为冲突待决（后到留冲突）。
   * - 写入失败：落到 failedWrite，等待重试；重试复用同一 key，不重复占位。
   */
  function attemptCommit(
    cueIds: string[],
    baseSeq: number,
    key: string,
  ): 'committed' | 'conflict' | 'failed' {
    if (log.value.some((point) => point.key === key)) return 'committed'

    if (baseSeq !== seq.value) {
      const point: ConfirmationPoint = {
        key,
        seq: seq.value,
        baseSeq,
        at: new Date().toISOString(),
        cueIds,
        status: '冲突待决',
        prints: capturePrints(cueIds),
        conflicts: conflictsAgainst(cueIds),
      }
      log.value.push(point)
      persist()
      return 'conflict'
    }

    if (forceWriteFailure.value || workshop.isOffline) {
      failedWrite.value = {
        key,
        baseSeq,
        cueIds,
        error: workshop.isOffline ? '离线，写入未送达' : '模拟写入失败',
      }
      return 'failed'
    }

    seq.value += 1
    log.value.push({
      key,
      seq: seq.value,
      baseSeq,
      at: new Date().toISOString(),
      cueIds,
      status: '已生效',
      prints: capturePrints(cueIds),
      conflicts: [],
    })
    persist()
    failedWrite.value = null
    return 'committed'
  }

  /** 确认占用批次：生成幂等 key，以本方已知基准抢单（先到生效，后到留冲突）。 */
  function confirmBatch(cueIds: string[]): 'committed' | 'conflict' | 'failed' {
    if (!cueIds.length) return 'failed'
    const key = uuid()
    const result = attemptCommit(cueIds, knownBase.value, key)
    if (result === 'committed') {
      knownBase.value = seq.value
      for (const id of cueIds) {
        const cue = cueById(id)
        if (cue) cue.status = '已确认'
      }
      ElMessage.success(`占用批次已生效（${cueIds.length} 项），版本 R${seq.value}`)
    } else if (result === 'conflict') {
      ElMessage.warning('他人已先确认，本批次留冲突待决，可重新基准后重试')
    } else {
      ElMessage.error('写入失败：已从最后确认点挂起，可重试（不重复占位）')
    }
    return result
  }

  /** 同步本方基准到最新版本（他人抢先确认后，重新基准再抢单）。 */
  function rebase() {
    knownBase.value = seq.value
  }

  /** 重试失败的写入；rebase=true 时以当前 seq 为基准（丢弃过期基准）。 */
  function retryFailed(rebase = false): 'committed' | 'conflict' | 'failed' {
    const failed = failedWrite.value
    if (!failed) return 'committed'
    const baseSeq = rebase ? seq.value : failed.baseSeq
    const result = attemptCommit(failed.cueIds, baseSeq, failed.key)
    if (result === 'committed') {
      knownBase.value = seq.value
      for (const id of failed.cueIds) {
        const cue = cueById(id)
        if (cue) cue.status = '已确认'
      }
      failedWrite.value = null
      ElMessage.success(`占用批次重试生效，版本 R${seq.value}`)
    } else if (result === 'conflict') {
      failedWrite.value = null
      knownBase.value = seq.value
      ElMessage.warning('重试时基准已过期，已留冲突待决')
    }
    return result
  }

  /** 模拟另一人抢先确认：抬高 seq，使本方下一笔抢单失败。 */
  function simulateConcurrent() {
    const target = workshop.cues.find((cue) => !isOccupied(cue.id))
    if (!target) {
      ElMessage.info('没有可抢先的提示了')
      return
    }
    const result = attemptCommit([target.id], seq.value, uuid())
    if (result === 'committed') {
      const cue = cueById(target.id)
      if (cue) cue.status = '已确认'
      ElMessage.warning(`他人已抢先确认 ${target.id}，版本 R${seq.value}`)
    }
  }

  function clearFailed() {
    failedWrite.value = null
  }

  // 时间/路线/部门一改，已确认占用失效，回退为待确认，打印清单随之失效。
  watch(
    occupations,
    (map) => {
      for (const [id, occ] of map.entries()) {
        if (occ.status !== '已失效') continue
        const cue = cueById(id)
        if (cue && cue.status === '已确认' && !workshop.locked) cue.status = '待确认'
      }
    },
    { deep: false },
  )

  return {
    seq,
    knownBase,
    log,
    failedWrite,
    forceWriteFailure,
    occupations,
    held,
    conflicts,
    invalidIds,
    printValid,
    statusOf,
    isOccupied,
    envelopeFor: (cue: Cue) => envelopeFor(cue),
    dangerEnvelopeFor: (cue: Cue) => dangerEnvelopeFor(cue),
    attemptCommit,
    confirmBatch,
    retryFailed,
    rebase,
    simulateConcurrent,
    clearFailed,
  }
})
