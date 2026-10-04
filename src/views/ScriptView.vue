<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useWorkshopStore } from '../stores/workshop'

const store = useWorkshopStore()
const query = ref('')
const selectedAct = ref('全部')
const acts = computed(() => ['全部', ...new Set(store.cues.map((cue) => cue.act))])
const script = computed(() =>
  [...store.cues]
    .filter((cue) => selectedAct.value === '全部' || cue.act === selectedAct.value)
    .filter((cue) => `${cue.title}${cue.owner}${cue.note}`.includes(query.value))
    .sort((a, b) => a.time.localeCompare(b.time)),
)

function confirmCue(id: string) {
  store.selectedId = id
  store.updateCue({ status: '已确认' })
  ElMessage.success(`${id} 已并入当前排练脚本`)
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
