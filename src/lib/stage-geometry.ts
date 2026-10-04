// 舞台占用几何与判定纯函数库
// 包络（envelope）= 提示在舞台上的运动范围，用百分比坐标的轴对齐矩形表示。
// 所有坐标均为 0-100 的舞台百分比。

import type { Cue, Department } from '../stores/workshop'

export type Envelope = { x: number; y: number; w: number; h: number }

export type OccupationKind = '时空重叠' | '安全互锁'

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 时间码 HH:MM:SS（或 MM:SS）转秒。 */
export function toSeconds(time: string): number {
  const parts = String(time).split(':').map((part) => Number(part))
  if (parts.some((part) => Number.isNaN(part))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] ?? 0
}

export function cueStart(cue: Pick<Cue, 'time'>): number {
  return toSeconds(cue.time)
}

export function cueEnd(cue: Pick<Cue, 'time' | 'duration'>): number {
  return toSeconds(cue.time) + (cue.duration || 0)
}

export function fmtTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/** 运动包络：入场点、路线节点、退场点的外接矩形，外扩 padding。 */
export function envelopeFor(cue: Pick<Cue, 'entry' | 'route' | 'exit'>, padding = 0): Envelope {
  const points = [cue.entry, ...(cue.route ?? []), cue.exit]
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = clamp(Math.min(...xs) - padding, 0, 100)
  const maxX = clamp(Math.max(...xs) + padding, 0, 100)
  const minY = clamp(Math.min(...ys) - padding, 0, 100)
  const maxY = clamp(Math.max(...ys) + padding, 0, 100)
  return {
    x: minX,
    y: minY,
    w: Math.max(maxX - minX, 1),
    h: Math.max(maxY - minY, 1),
  }
}

/** 机械危险半径：在运动包络外扩一圈安全距离。 */
export function dangerEnvelopeFor(cue: Pick<Cue, 'entry' | 'route' | 'exit'>): Envelope {
  return envelopeFor(cue, 8)
}

export function rectsOverlap(a: Envelope, b: Envelope): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function windowsOverlap(a: Pick<Cue, 'time' | 'duration'>, b: Pick<Cue, 'time' | 'duration'>): boolean {
  return cueStart(a) < cueEnd(b) && cueStart(b) < cueEnd(a)
}

/** 机械提示：舞台部门、由舞台机械操作，或标题为机械动作（上升/下降/到位等）。 */
export function isMachinery(cue: Pick<Cue, 'department' | 'title' | 'owner'>): boolean {
  if (cue.department !== ('舞台' as Department)) return false
  if (/机械|车台|吊点/.test(cue.owner)) return true
  return /升降台(上升|下降|启动|到位|位移)|平台(上升|下降|启动|位移)|车台(推入|推出|移动)/.test(cue.title)
}

/** 爆闪提示：灯光部门的频闪/爆闪。 */
export function isStrobe(cue: Pick<Cue, 'department' | 'title'>): boolean {
  if (cue.department !== ('灯光' as Department)) return false
  return /爆闪|频闪|闪| lightning/i.test(cue.title)
}

/** 演员走位：舞台部门、非机械、且有路线位移。 */
export function isMover(cue: Pick<Cue, 'department' | 'title' | 'owner' | 'route'>): boolean {
  return cue.department === ('舞台' as Department) && !isMachinery(cue) && (cue.route?.length ?? 0) > 1
}

/** 占用指纹：时间、路线、部门任一变化即失效。 */
export function fingerprintOf(cue: Pick<Cue, 'time' | 'department' | 'route'>): string {
  const route = (cue.route ?? []).map((p) => `${p.x},${p.y}`).join(';')
  return `${cue.time}|${cue.department}|${route}`
}
