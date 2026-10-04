import { http, HttpResponse, delay } from 'msw'
import { seedCues, seedMovers, seedProject } from '../stores/workshop'
import type { ConfirmRecord } from '../domain/occupancy'

let cues = structuredClone(seedCues)

// 占用批次服务端状态:确认仲裁按到达顺序,先到生效
const confirmedByServer = new Map<string, ConfirmRecord>()
// 已占位幂等表:批次 -> claimKey 集合,重试不重复占位
const persistedByServer = new Map<string, Set<string>>()

export const handlers = [
  http.get('/api/project', () => HttpResponse.json(seedProject)),
  http.get('/api/cues', () =>
    HttpResponse.json(
      cues.map((cue) => ({
        ...cue,
        conflict: cue.id === 'C-06' ? '此提示与道具运输时间重叠 4 分钟' : '',
      })),
    ),
  ),
  http.post('/api/cues/:id/comments', async ({ params, request }) => {
    const body = (await request.json()) as { author: string; content: string }
    const cue = cues.find((item) => item.id === params.id)
    if (!cue) return new HttpResponse(null, { status: 404 })
    cue.comments.push({
      id: `comment-${Date.now()}`,
      author: body.author,
      content: body.content,
      createdAt: new Date().toISOString(),
      resolved: false,
    })
    return HttpResponse.json(cue, { status: 201 })
  }),
  http.post('/api/sync', async ({ request }) => {
    const body = (await request.json()) as { cues: typeof cues }
    cues = structuredClone(body.cues)
    return HttpResponse.json({ syncedAt: new Date().toISOString(), revision: Date.now() })
  }),
  http.post('/api/occupancy/confirm', async ({ request }) => {
    const body = (await request.json()) as ConfirmRecord & { batchId: string }
    await delay(120)
    const existing = confirmedByServer.get(body.claimKey)
    if (existing) {
      return HttpResponse.json({ error: 'confirm-race', existing }, { status: 409 })
    }
    const record: ConfirmRecord = {
      claimKey: body.claimKey,
      operator: body.operator,
      confirmedAt: body.confirmedAt,
      seq: body.seq,
    }
    confirmedByServer.set(body.claimKey, record)
    return HttpResponse.json(record, { status: 201 })
  }),
  http.post('/api/occupancy/batch', async ({ request }) => {
    const url = new URL(request.url)
    if (url.searchParams.get('fail')) {
      return new HttpResponse(null, { status: 500 })
    }
    const body = (await request.json()) as { batchId: string; fingerprint: string; confirmations: ConfirmRecord[] }
    const persisted = persistedByServer.get(body.batchId) ?? new Set<string>()
    const added: string[] = []
    const duplicates: string[] = []
    for (const record of body.confirmations) {
      if (persisted.has(record.claimKey)) {
        duplicates.push(record.claimKey)
      } else {
        persisted.add(record.claimKey)
        added.push(record.claimKey)
      }
    }
    persistedByServer.set(body.batchId, persisted)
    return HttpResponse.json({ batchId: body.batchId, added, duplicates, persistedAt: new Date().toISOString() })
  }),
]

export { seedMovers }
