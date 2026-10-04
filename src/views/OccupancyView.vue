<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useOccupancyStore } from '../stores/occupancy'
import { CONFLICT_LABEL, KIND_LABEL, formatSeconds, type OccupancyClaim } from '../domain/occupancy'

const store = useOccupancyStore()
const selectedKey = ref('')

const sortedClaims = computed(() => [...store.claims].sort((a, b) => a.window.start - b.window.start))
const conflictKeys = computed(() => new Set(store.conflicts.flatMap((conflict) => conflict.claimKeys)))
const allConflicts = computed(() => [...store.conflicts, ...store.confirmRaces])

function claimStatus(claim: OccupancyClaim): { label: string; type: 'danger' | 'success' | 'info' } {
  if (store.holds.includes(claim.key)) return { label: '待命 · 危险区未腾空', type: 'danger' }
  const record = store.confirmations.find((item) => item.claimKey === claim.key)
  if (record) return { label: `已确认 · ${record.operator}`, type: 'success' }
  return { label: '待确认', type: 'info' }
}

function envelopeText(claim: OccupancyClaim) {
  const { minX, minY, maxX, maxY } = claim.envelope
  return `(${minX},${minY}) → (${maxX},${maxY})`
}

async function confirm(claim: OccupancyClaim) {
  const result = await store.confirmClaim(claim.key)
  if (result.held) ElMessage.warning(`${claim.cueId} 待命中:演员未离开危险区,机械与爆闪禁止放行`)
  else if (result.accepted) ElMessage.success(`${claim.cueId} 占用已确认`)
  else ElMessage.warning(`${claim.cueId} 确认未生效:他人先到,已留冲突记录`)
}

async function race(claim: OccupancyClaim) {
  await store.simulateRace(claim.key)
  ElMessage.info('双人同时确认完成:先到生效,后到留冲突')
}

async function persist() {
  await store.persist()
  if (store.persistState === 'saved') ElMessage.success('占用批次已写入,预占生效')
  else if (store.persistState === 'failed') ElMessage.error('写入失败,可从最后确认点恢复重试')
}

function recalcPrint() {
  store.generatePrintManifest()
  ElMessage.success('打印清单已按最新占用批次重算')
}
</script>

<template>
  <section class="page occupancy-page">
    <div class="page-head">
      <div>
        <p class="eyebrow">OCCUPANCY / 占用批次</p>
        <h1>舞台占用批次 · {{ store.batchId }}</h1>
        <p class="muted">执行提示、路线节点与部门操作按运动范围预占舞台区;重叠列冲突,危险区未腾空则机械与爆闪待命。</p>
      </div>
      <div class="actions">
        <el-select v-model="store.operator" size="default" style="width: 170px">
          <el-option v-for="item in store.operators" :key="item" :label="item" :value="item" />
        </el-select>
        <el-tag :type="store.batchStatus === '已确认' ? 'success' : store.batchStatus === '部分确认' ? 'warning' : 'info'" effect="dark">
          {{ store.batchStatus }} · {{ store.confirmations.length }}/{{ store.confirmableCount }}
        </el-tag>
      </div>
    </div>

    <el-alert
      v-if="store.recalculated"
      class="banner"
      type="error"
      show-icon
      title="时间、路线或部门已变更:确认记录与打印清单失效,批次已按最新走位重算"
      description="请重新核对冲突并逐项确认占用,再到打印中心重算清单。"
    >
      <template #close>
        <el-button size="small" @click="store.acknowledgeRecalc()">知道了</el-button>
      </template>
    </el-alert>

    <el-alert
      v-if="store.holds.length"
      class="banner"
      type="warning"
      show-icon
      :closable="false"
      :title="`${store.holds.length} 项机械 / 爆闪待命:演员未离开危险区`"
      description="待命占用禁止确认放行;请调整走位时间或路线,待危险区腾空后批次自动解除待命。"
    />

    <div class="occupancy-grid">
      <section class="panel map-panel">
        <div class="panel-head">
          <h3>舞台预占图</h3>
          <span class="muted">包络 = 运动范围 + 安全边距</span>
        </div>
        <div class="map-scroll">
          <svg class="map-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <pattern id="occ-grid" width="5" height="5" patternUnits="userSpaceOnUse">
                <path d="M 5 0 L 0 0 0 5" fill="none" stroke="#cbd6da" stroke-width="0.15" />
              </pattern>
            </defs>
            <rect width="100" height="100" fill="url(#occ-grid)" />
            <rect x="3" y="2" width="94" height="12" rx="1" class="backstage" />
            <rect x="5" y="88" width="90" height="9" rx="1" class="apron" />
            <g
              v-for="claim in sortedClaims"
              :key="claim.key"
              :class="['claim', claim.kind, { hold: store.holds.includes(claim.key), conflict: conflictKeys.has(claim.key), selected: claim.key === selectedKey }]"
              @click="selectedKey = claim.key"
            >
              <rect
                :x="claim.envelope.minX"
                :y="claim.envelope.minY"
                :width="claim.envelope.maxX - claim.envelope.minX"
                :height="claim.envelope.maxY - claim.envelope.minY"
                rx="1.2"
              />
              <text :x="claim.envelope.minX + 1.5" :y="claim.envelope.minY + 3.4">{{ claim.cueId }}</text>
            </g>
          </svg>
        </div>
        <div class="map-legend">
          <span v-for="(label, kind) in KIND_LABEL" :key="kind"><i :class="kind" />{{ label }}</span>
          <span><i class="hold-swatch" />待命</span>
        </div>
      </section>

      <aside class="panel batch-panel">
        <div class="panel-head">
          <h3>占用清单 · {{ sortedClaims.length }} 项</h3>
          <span class="muted">指纹 {{ store.fingerprint }}</span>
        </div>
        <div class="claim-list">
          <article
            v-for="claim in sortedClaims"
            :key="claim.key"
            class="claim-row"
            :class="{ active: claim.key === selectedKey }"
            @click="selectedKey = claim.key"
          >
            <div class="claim-row-head">
              <el-tag size="small" effect="plain" :type="claim.hazard ? 'danger' : 'info'">{{ KIND_LABEL[claim.kind] }}</el-tag>
              <strong>{{ claim.cueId }} · {{ claim.title }}</strong>
              <el-tag size="small" :type="claimStatus(claim).type" effect="dark">{{ claimStatus(claim).label }}</el-tag>
            </div>
            <div class="claim-meta">
              <span>{{ formatSeconds(claim.window.start) }} – {{ formatSeconds(claim.window.end) }}</span>
              <span>区域 {{ envelopeText(claim) }}</span>
              <span>{{ claim.department }}</span>
              <span v-if="claim.envelopeSource === 'legacy-fallback'" class="legacy">旧提示 · 按起退点补一版</span>
            </div>
            <div class="claim-actions">
              <el-button
                size="small"
                type="primary"
                plain
                :disabled="store.holds.includes(claim.key) || store.confirmations.some((item) => item.claimKey === claim.key)"
                @click.stop="confirm(claim)"
              >
                确认占用
              </el-button>
              <el-button size="small" text @click.stop="race(claim)">模拟双人确认</el-button>
            </div>
          </article>
        </div>
      </aside>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head">
          <h3>冲突列表 · {{ allConflicts.length }}</h3>
          <span class="muted">重叠即列冲突</span>
        </div>
        <div class="conflict-list">
          <div v-for="conflict in allConflicts" :key="conflict.id" class="conflict-row" :class="conflict.reason">
            <el-tag size="small" :type="conflict.reason === 'hazard-not-clear' ? 'danger' : conflict.reason === 'confirm-race' ? 'warning' : 'info'" effect="plain">
              {{ CONFLICT_LABEL[conflict.reason] }}
            </el-tag>
            <p>{{ conflict.detail }}</p>
          </div>
          <el-empty v-if="allConflicts.length === 0" description="当前批次无冲突" :image-size="52" />
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h3>写入与恢复</h3>
          <el-switch v-model="store.simulateFailure" active-text="模拟写入失败" />
        </div>
        <div class="persist-body">
          <dl class="persist-meta">
            <div><dt>待写入确认</dt><dd>{{ store.outbox.length }} 项</dd></div>
            <div><dt>最后确认点</dt><dd>{{ store.checkpoint ? `${store.checkpoint.confirmations.length} 项 · ${new Date(store.checkpoint.savedAt).toLocaleTimeString('zh-CN')}` : '尚未写入' }}</dd></div>
            <div><dt>写入状态</dt><dd>{{ { idle: '待写入', saving: '写入中', failed: '写入失败', saved: '已写入' }[store.persistState] }}</dd></div>
          </dl>
          <el-alert
            v-if="store.persistState === 'failed'"
            type="error"
            show-icon
            :closable="false"
            title="写入失败,停于最后确认点"
            description="已占位的确认不会丢失;重试按幂等键去重,不重复占位。"
          />
          <el-alert
            v-else-if="store.lastPersistResult && store.lastPersistResult.duplicates.length"
            type="info"
            show-icon
            :closable="false"
            :title="`重试完成:${store.lastPersistResult.duplicates.length} 项已占位被跳过,未重复写入`"
          />
          <div class="persist-actions">
            <el-button type="primary" :loading="store.persistState === 'saving'" :disabled="store.outbox.length === 0" @click="persist">
              写入占用批次
            </el-button>
            <el-button v-if="store.persistState === 'failed'" type="warning" @click="store.retryPersist()">
              从最后确认点恢复重试
            </el-button>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h3>打印清单联动</h3>
          <el-tag :type="store.printStale ? 'warning' : 'success'" effect="plain">
            {{ store.printStale ? '清单失效 · 需重算' : '清单有效' }}
          </el-tag>
        </div>
        <div class="persist-body">
          <p class="muted print-hint">
            {{ store.printStale ? '批次指纹已变化,打印中心的走位表与执行清单已失效。' : `清单与批次 ${store.batchId} 一致,生成于 ${new Date(store.printManifest!.generatedAt).toLocaleString('zh-CN')}。` }}
          </p>
          <div class="persist-actions">
            <el-button v-if="store.printStale" type="primary" plain @click="recalcPrint">重算打印清单</el-button>
            <el-button @click="$router.push('/print')">前往打印中心</el-button>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.occupancy-page {
  background: #eef2f4;
}

.banner {
  margin-bottom: 12px;
}

.occupancy-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(340px, 0.85fr);
  gap: 12px;
}

.map-scroll {
  padding: 16px;
  background: #182633;
}

.map-svg {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  background: #eef1eb;
}

.backstage {
  fill: #d8ddd6;
  opacity: 0.75;
}

.apron {
  fill: #dfe5df;
  opacity: 0.65;
}

.claim {
  cursor: pointer;
}

.claim rect {
  fill-opacity: 0.16;
  stroke-width: 0.5;
}

.claim.performer rect {
  fill: #2f8580;
  stroke: #2f8580;
}

.claim.machinery rect {
  fill: #c36e23;
  stroke: #c36e23;
}

.claim.pyro rect {
  fill: #cc4f42;
  stroke: #cc4f42;
}

.claim.prop rect {
  fill: #735ca8;
  stroke: #735ca8;
}

.claim.conflict rect {
  fill-opacity: 0.3;
  stroke: #b3261e;
  stroke-width: 0.8;
}

.claim.hold rect {
  stroke-dasharray: 1.6 1.1;
  animation: hold-blink 1.1s linear infinite;
}

.claim.selected rect {
  stroke-width: 1.1;
  fill-opacity: 0.38;
}

.claim text {
  fill: #213d46;
  font-size: 2.6px;
  font-weight: 800;
  pointer-events: none;
}

@keyframes hold-blink {
  50% {
    stroke-opacity: 0.25;
  }
}

.map-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 10px 14px;
  color: #5d6b78;
  font-size: 11px;
}

.map-legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 5px;
  border-radius: 2px;
  vertical-align: -1px;
}

.map-legend .performer {
  background: #2f8580;
}

.map-legend .machinery {
  background: #c36e23;
}

.map-legend .pyro {
  background: #cc4f42;
}

.map-legend .prop {
  background: #735ca8;
}

.map-legend .hold-swatch {
  border: 1px dashed #b3261e;
  background: transparent;
}

.batch-panel {
  display: flex;
  max-height: 560px;
  flex-direction: column;
}

.claim-list {
  display: grid;
  gap: 8px;
  overflow: auto;
  padding: 12px;
}

.claim-row {
  padding: 10px 12px;
  border: 1px solid #e2e8eb;
  border-radius: 8px;
  background: #f9fbfb;
  cursor: pointer;
}

.claim-row.active {
  border-color: #2f8580;
  box-shadow: 0 0 0 2px rgb(47 133 128 / 14%);
}

.claim-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.claim-row-head strong {
  flex: 1;
  font-size: 13px;
}

.claim-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 7px;
  color: #74818c;
  font-size: 11px;
}

.claim-meta .legacy {
  color: #b05a2b;
}

.claim-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.bottom-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.conflict-list {
  display: grid;
  gap: 8px;
  max-height: 240px;
  overflow: auto;
  padding: 12px;
}

.conflict-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 10px;
  border-left: 3px solid #8a959d;
  border-radius: 4px;
  background: #f7f9f9;
}

.conflict-row.hazard-not-clear {
  border-left-color: #c0483d;
  background: #fdf1ef;
}

.conflict-row.confirm-race {
  border-left-color: #cf8a2d;
  background: #fdf6e9;
}

.conflict-row p {
  margin: 0;
  color: #4d5b66;
  font-size: 12px;
  line-height: 1.5;
}

.persist-body {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.persist-meta {
  display: grid;
  gap: 8px;
  margin: 0;
}

.persist-meta div {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}

.persist-meta dt {
  color: #7a8692;
}

.persist-meta dd {
  margin: 0;
  font-weight: 700;
}

.persist-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.print-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 1080px) {
  .occupancy-grid,
  .bottom-grid {
    grid-template-columns: 1fr;
  }

  .batch-panel {
    max-height: none;
  }
}
</style>
