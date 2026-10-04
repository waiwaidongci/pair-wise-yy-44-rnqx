<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useWorkshopStore } from '../stores/workshop'
import { useOccupancyStore } from '../stores/occupancy'
import { fmtTime } from '../lib/stage-geometry'

const store = useWorkshopStore()
const occupancy = useOccupancyStore()
const query = ref('')
const selectedAct = ref('全部')
const acts = computed(() => ['全部', ...new Set(store.cues.map((cue) => cue.act))])
const script = computed(() =>
  [...store.cues]
    .filter((cue) => selectedAct.value === '全部' || cue.act === selectedAct.value)
    .filter((cue) => `${cue.title}${cue.owner}${cue.note}`.includes(query.value))
    .sort((a, b) => a.time.localeCompare(b.time)),
)

// 占用批次：勾选待确认提示，合并为一个舞台占用批次抢单。
const selectedIds = ref<Set<string>>(new Set())
const pendingCues = computed(() =>
  store.cues
    .filter((cue) => !occupancy.isOccupied(cue.id))
    .sort((a, b) => a.time.localeCompare(b.time)),
)
const heldEntries = computed(() =>
  [...occupancy.held.entries()].map(([id, info]) => ({ id, ...info })),
)
const batches = computed(() => [...occupancy.log].reverse())

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function confirmSelected() {
  if (!selectedIds.value.size) {
    ElMessage.info('请先勾选要并入占用批次的提示')
    return
  }
  occupancy.confirmBatch([...selectedIds.value])
  selectedIds.value = new Set()
}

function confirmCue(id: string) {
  store.selectedId = id
  const result = occupancy.confirmBatch([id])
  if (result === 'committed') ElMessage.success(`${id} 已并入舞台占用批次`)
}

function lock() {
  store.lockBaseline()
  ElMessage.success('演出基线已锁定，后续修改将从新分支开始')
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">REHEARSAL / 排练脚本</p>
        <h1>按时间顺序编排排练</h1>
        <p class="muted">提示与走位按时间码串联；未确认节点不会进入锁定基线。</p>
      </div>
      <div class="actions">
        <el-button :disabled="store.locked" @click="lock">锁定演出基线</el-button>
        <el-button v-if="store.locked" type="warning" plain @click="store.unlockBaseline">解锁修订</el-button>
        <el-button type="primary" @click="$router.push('/print')">生成执行清单</el-button>
      </div>
    </div>

    <div class="panel script-toolbar">
      <el-input v-model="query" clearable placeholder="搜索提示、角色或说明" style="max-width: 320px" />
      <el-segmented v-model="selectedAct" :options="acts" />
      <div class="baseline-status">
        <span class="status-dot" :style="{ background: store.locked ? '#41936b' : '#d68c27' }" />
        {{ store.locked ? `基线 ${store.revision} 已锁定` : `${store.revision} · ${store.cues.filter((cue) => cue.status !== '已确认').length} 项待确认` }}
      </div>
    </div>

    <section class="panel batch-panel">
      <div class="panel-head">
        <div>
          <h3>舞台占用批次</h3>
          <span class="muted">按运动范围预占舞台区，重叠即列冲突；机械与爆闪在演员未腾空危险区时待命。</span>
        </div>
        <div class="batch-controls">
          <el-tag size="small" :type="occupancy.knownBase === occupancy.seq ? 'success' : 'warning'" effect="plain">
            基准 R{{ occupancy.knownBase }} / 最新 R{{ occupancy.seq }}
          </el-tag>
          <el-button
            v-if="occupancy.knownBase !== occupancy.seq"
            size="small"
            plain
            @click="occupancy.rebase()"
          >
            重新基准
          </el-button>
          <el-switch v-model="occupancy.forceWriteFailure" active-text="模拟写入失败" inline-prompt />
          <el-button size="small" @click="occupancy.simulateConcurrent">模拟他人抢先确认</el-button>
          <el-button
            size="small"
            type="primary"
            :disabled="store.locked || selectedIds.size === 0"
            @click="confirmSelected"
          >
            确认占用批次（{{ selectedIds.size }}）
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="!occupancy.printValid"
        class="batch-alert"
        type="error"
        show-icon
        :closable="false"
        title="确认与打印清单已失效"
        description="时间、路线或部门发生变更，已确认占用作废并需重新确认；打印清单暂停生成。"
      />

      <el-alert
        v-if="occupancy.failedWrite"
        class="batch-alert"
        type="error"
        show-icon
        :closable="false"
        title="写入失败：占用未送达确认点"
        :description="`确认点 ${occupancy.failedWrite.key.slice(0, 8)}… 挂起，重试复用同一占位键，不重复占位。`"
      >
        <div class="failed-actions">
          <el-button size="small" type="primary" @click="occupancy.retryFailed(false)">从最后确认点重试</el-button>
          <el-button size="small" @click="occupancy.retryFailed(true)">重新基准后重试</el-button>
          <el-button size="small" text @click="occupancy.clearFailed">放弃</el-button>
        </div>
      </el-alert>

      <div class="batch-grid">
        <div class="batch-col">
          <h4>待并入批次（{{ pendingCues.length }}）</h4>
          <div class="pending-list">
            <label v-for="cue in pendingCues" :key="cue.id" class="pending-item">
              <el-checkbox
                :model-value="selectedIds.has(cue.id)"
                :disabled="store.locked"
                @change="toggleSelect(cue.id)"
              />
              <span class="pending-id">{{ cue.id }}</span>
              <span class="pending-title">{{ cue.title }}</span>
              <time>{{ cue.time }}</time>
            </label>
            <el-empty v-if="!pendingCues.length" description="全部提示已占用" :image-size="40" />
          </div>
        </div>

        <div class="batch-col">
          <h4>待命与冲突</h4>
          <div class="hold-list">
            <div v-for="item in heldEntries" :key="item.id" class="hold-item">
              <el-tag size="small" type="warning" effect="dark">待命</el-tag>
              <strong>{{ item.id }}</strong>
              <span>至 {{ fmtTime(item.until) }}</span>
            </div>
            <div v-for="(conflict, index) in occupancy.conflicts" :key="index" class="conflict-item">
              <el-tag size="small" :type="conflict.kind === '安全互锁' ? 'warning' : 'danger'" effect="plain">
                {{ conflict.kind }}
              </el-tag>
              <span>{{ conflict.description }}</span>
            </div>
            <el-empty v-if="!heldEntries.length && !occupancy.conflicts.length" description="无待命 / 无冲突" :image-size="40" />
          </div>
        </div>

        <div class="batch-col">
          <h4>确认点日志（{{ batches.length }}）</h4>
          <div class="batch-log">
            <div v-for="point in batches" :key="point.key" class="log-item" :class="point.status">
              <div class="log-head">
                <el-tag size="small" :type="point.status === '已生效' ? 'success' : 'info'" effect="plain">
                  {{ point.status }}
                </el-tag>
                <span class="log-seq">R{{ point.seq }}</span>
                <span class="log-key">{{ point.key.slice(0, 8) }}</span>
              </div>
              <div class="log-cues">{{ point.cueIds.join('、') }}</div>
              <div v-if="point.conflicts.length" class="log-conflicts">
                <span v-for="(conflict, index) in point.conflicts" :key="index">
                  {{ conflict.kind }}：{{ conflict.description }}
                </span>
              </div>
            </div>
            <el-empty v-if="!batches.length" description="暂无确认点" :image-size="40" />
          </div>
        </div>
      </div>
    </section>

    <div class="script-layout">
      <section class="timeline">
        <article v-for="(cue, index) in script" :key="cue.id" class="timeline-item">
          <div class="time-column">
            <strong>{{ cue.time }}</strong>
            <span>{{ cue.duration }}s</span>
          </div>
          <div class="timeline-rail">
            <i />
            <b v-if="index < script.length - 1" />
          </div>
          <div class="script-card panel">
            <div class="script-card-head">
              <div>
                <span>{{ cue.id }} · {{ cue.act }} / {{ cue.scene }}</span>
                <h3>{{ cue.title }}</h3>
              </div>
              <el-tag :type="cue.status === '已确认' ? 'success' : cue.status === '待确认' ? 'warning' : 'info'" effect="plain">
                {{ cue.status }}
              </el-tag>
            </div>
            <p>{{ cue.note || '暂无补充说明' }}</p>
            <div class="script-meta">
              <span>责任：{{ cue.owner }}</span>
              <span>部门：{{ cue.department }}</span>
              <span>路线：{{ cue.route.length }} 节点</span>
              <span v-if="cue.comments.length">留言：{{ cue.comments.length }}</span>
            </div>
            <div class="script-actions">
              <el-button size="small" @click="store.selectedId = cue.id; $router.push('/stage')">编辑走位</el-button>
              <el-button v-if="cue.status !== '已确认'" size="small" type="primary" plain @click="confirmCue(cue.id)">确认节点</el-button>
              <span v-else class="confirmed">已纳入 {{ store.revision }}</span>
            </div>
          </div>
        </article>
      </section>

      <aside class="panel version-panel">
        <div class="panel-head">
          <h3>版本记录</h3>
          <span class="muted">自动保存</span>
        </div>
        <div class="version-list">
          <div class="version active">
            <span>当前草稿</span>
            <strong>{{ store.revision }}</strong>
            <small>{{ store.lastSaved }} · {{ store.cues.length }} 个节点</small>
          </div>
          <div class="version">
            <span>舞台调度修订</span>
            <strong>R11</strong>
            <small>09-27 14:16 · 陈曦</small>
          </div>
          <div class="version">
            <span>灯光提示更新</span>
            <strong>R10</strong>
            <small>09-26 18:42 · 王灯控</small>
          </div>
        </div>
        <div class="version-actions">
          <el-button :disabled="!store.canUndo" @click="store.undo">回退上一步</el-button>
          <el-button :disabled="!store.canRedo" @click="store.redo">恢复修改</el-button>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.script-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 18px;
  padding: 12px 14px;
}

.baseline-status {
  margin-left: auto;
  color: #5e6d79;
  font-size: 12px;
}

.batch-panel {
  margin-bottom: 18px;
  padding: 0 15px 14px;
}

.batch-panel .panel-head {
  margin: 0 -15px 12px;
}

.batch-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.batch-alert {
  margin-bottom: 10px;
}

.failed-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.batch-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.batch-col h4 {
  margin: 0 0 8px;
  color: #33465a;
  font-size: 13px;
}

.pending-list,
.hold-list,
.batch-log {
  display: grid;
  gap: 6px;
  max-height: 230px;
  overflow: auto;
  padding-right: 4px;
}

.pending-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid #e6ebed;
  border-radius: 6px;
  font-size: 12px;
}

.pending-id {
  color: #1d7371;
  font-weight: 700;
}

.pending-title {
  flex: 1;
  color: #33465a;
}

.pending-item time {
  color: #8a959d;
  font-family: ui-monospace, monospace;
  font-size: 11px;
}

.hold-item,
.conflict-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid #f0e2c4;
  border-radius: 6px;
  background: #fdf8ec;
  color: #6b5a2e;
  font-size: 12px;
}

.conflict-item {
  border-color: #f0d4cd;
  background: #fdf1ee;
  color: #8a4a3e;
}

.hold-item strong {
  color: #1d7371;
}

.batch-log .log-item {
  padding: 7px 9px;
  border: 1px solid #e6ebed;
  border-radius: 6px;
  font-size: 11px;
}

.batch-log .log-item.冲突待决 {
  border-color: #e6c7c0;
  background: #fdf4f1;
}

.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-seq {
  color: #1d7371;
  font-weight: 700;
}

.log-key {
  margin-left: auto;
  color: #9aa4ad;
  font-family: ui-monospace, monospace;
}

.log-cues {
  margin-top: 4px;
  color: #33465a;
  font-weight: 600;
}

.log-conflicts {
  display: grid;
  gap: 2px;
  margin-top: 4px;
  color: #8a4a3e;
}

@media (max-width: 1080px) {
  .batch-grid {
    grid-template-columns: 1fr;
  }
}

.script-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 270px;
  gap: 18px;
}

.timeline {
  display: grid;
}

.timeline-item {
  display: grid;
  grid-template-columns: 74px 22px minmax(0, 1fr);
}

.time-column {
  padding-top: 14px;
  text-align: right;
}

.time-column strong,
.time-column span {
  display: block;
}

.time-column strong {
  color: #176d6c;
  font-family: ui-monospace, monospace;
  font-size: 13px;
}

.time-column span {
  margin-top: 4px;
  color: #8b969e;
  font-size: 10px;
}

.timeline-rail {
  position: relative;
}

.timeline-rail i {
  position: absolute;
  z-index: 2;
  top: 21px;
  left: 8px;
  width: 7px;
  height: 7px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #2d8681;
  box-shadow: 0 0 0 1px #2d8681;
}

.timeline-rail b {
  position: absolute;
  top: 29px;
  bottom: -1px;
  left: 11px;
  width: 1px;
  background: #cbd6da;
}

.script-card {
  margin-bottom: 10px;
  padding: 13px;
}

.script-card-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.script-card-head span {
  color: #71808b;
  font-size: 11px;
}

.script-card h3 {
  margin: 5px 0 0;
  font-size: 15px;
}

.script-card > p {
  margin: 11px 0;
  color: #55636e;
  font-size: 13px;
  line-height: 1.6;
}

.script-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  color: #7a8791;
  font-size: 11px;
}

.script-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.confirmed {
  color: #34805e;
  font-size: 11px;
}

.version-panel {
  align-self: start;
}

.version-list {
  padding: 10px;
}

.version {
  padding: 11px;
  border-bottom: 1px solid #ebeff1;
}

.version span,
.version strong,
.version small {
  display: block;
}

.version span {
  color: #53616c;
  font-size: 12px;
}

.version strong {
  margin: 5px 0;
  color: #183845;
  font-size: 17px;
}

.version small {
  color: #8a959d;
}

.version.active {
  border-left: 3px solid #2c8681;
  background: #f2f8f7;
}

.version-actions {
  display: grid;
  gap: 8px;
  padding: 10px;
}

@media (max-width: 900px) {
  .script-layout {
    grid-template-columns: 1fr;
  }

  .version-panel {
    order: -1;
  }
}

@media (max-width: 680px) {
  .script-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .baseline-status {
    margin-left: 0;
  }

  .timeline-item {
    grid-template-columns: 58px 16px minmax(0, 1fr);
  }

  .timeline-rail i {
    left: 5px;
  }

  .timeline-rail b {
    left: 8px;
  }
}
</style>
