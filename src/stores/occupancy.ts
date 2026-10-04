import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import axios from 'axios'
import { useWorkshopStore } from './workshop'
import {
  applyConfirmation,
  batchFingerprint,
  buildClaims,
  computeHolds,
  detectConflicts,
  mergeConfirmations,
  resumeFromCheckpoint,
  type BatchCheckpoint,
  type ConfirmRecord,
  type OccupancyConflict,
} from '../domain/occupancy'

const CHECKPOINT_KEY = 'stage-occupancy-checkpoint-v1'
const PRINT_KEY = 'stage-occupancy-print-v1'

function loadCheckpoint(): BatchCheckpoint | null {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY)
    return raw ? (JSON.parse(raw) as BatchCheckpoint) : null
  } catch {
    return null
  }
}

function loadPrintManifest(): { fingerprint: string; generatedAt: string } | null {
  try {
    const raw = localStorage.getItem(PRINT_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export const useOccupancyStore = defineStore('occupancy', () => {
  const workshop = useWorkshopStore()

  const operators = ['舞台监督 · 陆鸣', '技术总监 · 卓娅']
  const operator = ref(operators[0])

  // 执行提示 + 路线节点 + 部门操作 → 占用批次
  const claims = computed(() => buildClaims(workshop.cues))
  const fingerprint = computed(() => batchFingerprint(workshop.cues))
  const batchId = computed(() => `OB-${fingerprint.value.toUpperCase()}`)
  const conflicts = computed(() => detectConflicts(claims.value))
  const holds = computed(() => computeHolds(conflicts.value))

  const confirmations = ref<ConfirmRecord[]>([])
  const confirmRaces = ref<OccupancyConflict[]>([])
  const recalculated = ref(false)
  const confirmSeq = ref(0)

  const checkpoint = ref<BatchCheckpoint | null>(loadCheckpoint())
  const outbox = ref<ConfirmRecord[]>([])
  const persistState = ref<'idle' | 'saving' | 'failed' | 'saved'>('idle')
  const simulateFailure = ref(false)
  const lastPersistResult = ref<{ added: string[]; duplicates: string[] } | null>(null)

  const printManifest = ref<{ fingerprint: string; generatedAt: string } | null>(loadPrintManifest())
  const printStale = computed(() => !printManifest.value || printManifest.value.fingerprint !== fingerprint.value)

  // 启动恢复:最后确认点指纹与当前一致才恢复,否则作废重算
  if (checkpoint.value) {
    const restored = resumeFromCheckpoint(checkpoint.value, fingerprint.value)
    if (restored.length > 0) {
      confirmations.value = restored
      confirmSeq.value = Math.max(...restored.map((record) => record.seq))
    } else {
      checkpoint.value = null
      localStorage.removeItem(CHECKPOINT_KEY)
    }
  }

  // 时间、路线或部门一改:确认与打印清单失效,批次重算
  watch(fingerprint, (next, prev) => {
    if (!prev || next === prev) return
    recalculated.value = true
    confirmations.value = []
    confirmRaces.value = []
    outbox.value = []
    persistState.value = 'idle'
    lastPersistResult.value = null
    checkpoint.value = null
    localStorage.removeItem(CHECKPOINT_KEY)
  })

  const confirmableCount = computed(() => claims.value.filter((claim) => !holds.value.includes(claim.key)).length)
  const batchStatus = computed(() => {
    if (confirmations.value.length === 0) return '待确认'
    if (confirmations.value.length >= confirmableCount.value) return '已确认'
    return '部分确认'
  })

  async function confirmClaim(claimKey: string, operatorName = operator.value) {
    if (holds.value.includes(claimKey)) return { accepted: false, held: true as const }
    const record: ConfirmRecord = {
      claimKey,
      operator: operatorName,
      confirmedAt: new Date().toISOString(),
      seq: (confirmSeq.value += 1),
    }
    const local = applyConfirmation(confirmations.value, confirmRaces.value, record)
    if (!local.accepted) {
      confirmRaces.value = local.races
      return { accepted: false, held: false as const }
    }
    if (workshop.isOffline) {
      confirmations.value = local.confirmations
      outbox.value = mergeConfirmations(outbox.value, [record])
      return { accepted: true, held: false as const }
    }
    try {
      await axios.post('/api/occupancy/confirm', { batchId: batchId.value, ...record })
      confirmations.value = local.confirmations
      outbox.value = mergeConfirmations(outbox.value, [record])
      return { accepted: true, held: false as const }
    } catch (error) {
      // 服务端仲裁:两人同时确认,先到生效,后到 409 留冲突
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const existing = (error.response.data as { existing?: ConfirmRecord }).existing
        confirmRaces.value = [
          ...confirmRaces.value,
          {
            id: `race-${claimKey}-${record.seq}`,
            reason: 'confirm-race',
            claimKeys: [claimKey],
            detail: `${operatorName} 的确认被驳回:${existing?.operator ?? '他人'} 先到已生效`,
          },
        ]
        return { accepted: false, held: false as const }
      }
      throw error
    }
  }

  async function simulateRace(claimKey: string) {
    await Promise.allSettled([confirmClaim(claimKey, operators[0]), confirmClaim(claimKey, operators[1])])
  }

  // 写入批次;失败保留 outbox,停于最后确认点
  async function persist() {
    if (outbox.value.length === 0) {
      persistState.value = 'saved'
      return
    }
    persistState.value = 'saving'
    try {
      const { data } = await axios.post<{ added: string[]; duplicates: string[] }>(
        '/api/occupancy/batch',
        { batchId: batchId.value, fingerprint: fingerprint.value, confirmations: outbox.value },
        { params: simulateFailure.value ? { fail: 1 } : {} },
      )
      lastPersistResult.value = data
      checkpoint.value = {
        batchId: batchId.value,
        fingerprint: fingerprint.value,
        confirmations: mergeConfirmations(checkpoint.value?.confirmations ?? [], outbox.value),
        savedAt: new Date().toISOString(),
      }
      localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint.value))
      outbox.value = []
      persistState.value = 'saved'
    } catch {
      persistState.value = 'failed'
    }
  }

  // 重试不重复占位:幂等键不变,服务端按 claimKey 去重
  async function retryPersist() {
    await persist()
  }

  function generatePrintManifest() {
    printManifest.value = { fingerprint: fingerprint.value, generatedAt: new Date().toISOString() }
    localStorage.setItem(PRINT_KEY, JSON.stringify(printManifest.value))
  }

  function acknowledgeRecalc() {
    recalculated.value = false
  }

  return {
    operators,
    operator,
    claims,
    fingerprint,
    batchId,
    conflicts,
    holds,
    confirmations,
    confirmRaces,
    recalculated,
    checkpoint,
    outbox,
    persistState,
    simulateFailure,
    lastPersistResult,
    printManifest,
    printStale,
    confirmableCount,
    batchStatus,
    confirmClaim,
    simulateRace,
    persist,
    retryPersist,
    generatePrintManifest,
    acknowledgeRecalc,
  }
})
