// 舞台占用批次领域核心:包络预占、冲突检测、确认仲裁、检查点恢复。
// 全部为纯函数,不依赖 store,便于独立验证。

export type PointLike = { x: number; y: number }

export type Envelope = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type CueLike = {
  id: string
  title: string
  department: string
  time: string
  duration: number
  entry: PointLike
  exit: PointLike
  route?: PointLike[]
  envelope?: Envelope | null
}

export type ClaimKind = 'performer' | 'machinery' | 'pyro' | 'prop'

export type OccupancyClaim = {
  key: string
  cueId: string
  title: string
  department: string
  kind: ClaimKind
  hazard: boolean
  window: { start: number; end: number }
  envelope: Envelope
  envelopeSource: 'manual' | 'route' | 'legacy-fallback'
}

export type ConflictReason = 'overlap' | 'hazard-not-clear' | 'confirm-race'

export type OccupancyConflict = {
  id: string
  reason: ConflictReason
  claimKeys: string[]
  detail: string
}

export type ConfirmRecord = {
  claimKey: string
  operator: string
  confirmedAt: string
  seq: number
}

export type BatchCheckpoint = {
  batchId: string
  fingerprint: string
  confirmations: ConfirmRecord[]
  savedAt: string
}

export const STAGE_BOUNDS: Envelope = { minX: 0, minY: 0, maxX: 100, maxY: 100 }

export const KIND_LABEL: Record<ClaimKind, string> = {
  performer: '演员走位',
  machinery: '舞台机械',
  pyro: '爆闪特效',
  prop: '道具运输',
}

export const CONFLICT_LABEL: Record<ConflictReason, string> = {
  overlap: '区域重叠',
  'hazard-not-clear': '危险区未腾空',
  'confirm-race': '确认竞争',
}

const SAFETY_MARGIN: Record<ClaimKind, number> = {
  performer: 6,
  machinery: 10,
  pyro: 8,
  prop: 5,
}

const MACHINERY_RE = /升降台|机械|转台|吊杆|车台/
const PYRO_RE = /爆闪|烟火|频闪/

export function inferKind(cue: Pick<CueLike, 'title' | 'department'>): ClaimKind {
  if (PYRO_RE.test(cue.title)) return 'pyro'
  if (MACHINERY_RE.test(cue.title)) return 'machinery'
  if (cue.department === '道具') return 'prop'
  return 'performer'
}

export function parseTimeCode(time: string): number {
  const [h, m, s] = time.split(':').map((part) => Number(part) || 0)
  return h * 3600 + m * 60 + s
}

export function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function clampEnvelope(envelope: Envelope): Envelope {
  return {
    minX: Math.max(STAGE_BOUNDS.minX, envelope.minX),
    minY: Math.max(STAGE_BOUNDS.minY, envelope.minY),
    maxX: Math.min(STAGE_BOUNDS.maxX, envelope.maxX),
    maxY: Math.min(STAGE_BOUNDS.maxY, envelope.maxY),
  }
}

function bbox(points: PointLike[]): Envelope {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

function expand(envelope: Envelope, margin: number): Envelope {
  return clampEnvelope({
    minX: envelope.minX - margin,
    minY: envelope.minY - margin,
    maxX: envelope.maxX + margin,
    maxY: envelope.maxY + margin,
  })
}

// 运动范围预占:有手工包络用包络,否则按路线节点外扩安全边距;
// 旧提示缺包络与路线时,按起退点补一版。
export function deriveEnvelope(
  cue: CueLike,
  kind: ClaimKind,
): { envelope: Envelope; source: OccupancyClaim['envelopeSource'] } {
  if (cue.envelope) return { envelope: clampEnvelope(cue.envelope), source: 'manual' }
  const margin = SAFETY_MARGIN[kind]
  const route = (cue.route ?? []).filter(Boolean)
  if (route.length > 0) return { envelope: expand(bbox(route), margin), source: 'route' }
  return { envelope: expand(bbox([cue.entry, cue.exit]), margin), source: 'legacy-fallback' }
}

function hash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i += 1) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// 时间、路线或部门一变,指纹即变,确认与打印清单随之失效。
export function cueFingerprint(cue: CueLike): string {
  const route = (cue.route ?? []).map((point) => `${point.x},${point.y}`).join('>')
  return hash(
    [cue.id, cue.time, cue.department, cue.duration, route, `${cue.entry.x},${cue.entry.y}`, `${cue.exit.x},${cue.exit.y}`].join('|'),
  )
}

export function batchFingerprint(cues: CueLike[]): string {
  return hash(cues.map(cueFingerprint).sort().join('#'))
}

export function buildClaims(cues: CueLike[]): OccupancyClaim[] {
  return cues.map((cue) => {
    const kind = inferKind(cue)
    const { envelope, source } = deriveEnvelope(cue, kind)
    const start = parseTimeCode(cue.time)
    return {
      key: `${cue.id}@${cueFingerprint(cue)}`,
      cueId: cue.id,
      title: cue.title,
      department: cue.department,
      kind,
      hazard: kind === 'machinery' || kind === 'pyro',
      window: { start, end: start + Math.max(0, cue.duration) },
      envelope,
      envelopeSource: source,
    }
  })
}

export function envelopesOverlap(a: Envelope, b: Envelope): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

export function windowsOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

// 时间窗与运动范围同时重叠即列冲突;危险源(机械/爆闪)与演员重叠
// 记为"危险区未腾空",危险源进入待命。
export function detectConflicts(claims: OccupancyClaim[]): OccupancyConflict[] {
  const conflicts: OccupancyConflict[] = []
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i]
      const b = claims[j]
      if (!windowsOverlap(a.window, b.window)) continue
      if (!envelopesOverlap(a.envelope, b.envelope)) continue
      const hazardSide = a.hazard && !b.hazard ? a : b.hazard && !a.hazard ? b : null
      const otherSide = hazardSide === a ? b : a
      if (hazardSide && otherSide.kind === 'performer') {
        conflicts.push({
          id: `hz-${hazardSide.key}-${otherSide.key}`,
          reason: 'hazard-not-clear',
          claimKeys: [hazardSide.key, otherSide.key],
          detail: `${otherSide.cueId} 演员未离开危险区,${hazardSide.cueId}(${KIND_LABEL[hazardSide.kind]})须待命`,
        })
      } else {
        conflicts.push({
          id: `ov-${a.key}-${b.key}`,
          reason: 'overlap',
          claimKeys: [a.key, b.key],
          detail: `${a.cueId} 与 ${b.cueId} 运动范围在 ${formatSeconds(Math.max(a.window.start, b.window.start))} 起重叠`,
        })
      }
    }
  }
  return conflicts
}

export function computeHolds(conflicts: OccupancyConflict[]): string[] {
  const holds = new Set<string>()
  for (const conflict of conflicts) {
    if (conflict.reason === 'hazard-not-clear') holds.add(conflict.claimKeys[0])
  }
  return [...holds]
}

// 两人同时确认同一占用:先到生效,后到留冲突。
export function applyConfirmation(
  confirmations: ConfirmRecord[],
  races: OccupancyConflict[],
  record: ConfirmRecord,
): { confirmations: ConfirmRecord[]; races: OccupancyConflict[]; accepted: boolean } {
  const existing = confirmations.find((item) => item.claimKey === record.claimKey)
  if (existing) {
    return {
      confirmations,
      races: [
        ...races,
        {
          id: `race-${record.claimKey}-${record.seq}`,
          reason: 'confirm-race',
          claimKeys: [record.claimKey],
          detail: `${record.operator} 的确认晚于 ${existing.operator},先到生效,本次留作冲突`,
        },
      ],
      accepted: false,
    }
  }
  return { confirmations: [...confirmations, record], races, accepted: true }
}

// 写入失败后从最后确认点恢复:指纹一致才恢复,按幂等键去重,重试不重复占位。
export function resumeFromCheckpoint(checkpoint: BatchCheckpoint | null, fingerprint: string): ConfirmRecord[] {
  if (!checkpoint || checkpoint.fingerprint !== fingerprint) return []
  const seen = new Set<string>()
  return checkpoint.confirmations.filter((record) => {
    if (seen.has(record.claimKey)) return false
    seen.add(record.claimKey)
    return true
  })
}

export function mergeConfirmations(base: ConfirmRecord[], incoming: ConfirmRecord[]): ConfirmRecord[] {
  const seen = new Set(base.map((record) => record.claimKey))
  return [...base, ...incoming.filter((record) => !seen.has(record.claimKey))]
}
