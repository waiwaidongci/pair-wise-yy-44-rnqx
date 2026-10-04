<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import axios from 'axios'
import { useWorkshopStore } from '../stores/workshop'

const store = useWorkshopStore()
const { data: project } = useQuery({
  queryKey: ['project'],
  queryFn: async () => (await axios.get('/api/project')).data,
  enabled: import.meta.env.DEV,
  initialData: {
    name: '潮汐来信',
    venue: '上海大剧院 · 大剧场',
    rehearsalDate: '2026-10-08',
    company: '远岸剧团',
  },
})

const pending = computed(() => store.cues.filter((cue) => cue.status !== '已确认').length)
const comments = computed(() => store.cues.reduce((total, cue) => total + cue.comments.filter((item) => !item.resolved).length, 0))
const totalMinutes = computed(() => Math.round(store.cues.reduce((sum, cue) => sum + cue.duration, 0) / 60))
const byDepartment = computed(() =>
  ['舞台', '灯光', '音响', '道具'].map((department) => ({
    department,
    count: store.cues.filter((cue) => cue.department === department).length,
  })),
)
const nextCues = computed(() => [...store.cues].sort((a, b) => a.time.localeCompare(b.time)).slice(0, 4))
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">TOUR CONTROL / 巡演控制</p>
        <h1>{{ project.name }} · 巡演总览</h1>
        <p class="muted">{{ project.venue }} · 排练日 {{ project.rehearsalDate }} · {{ project.company }}</p>
      </div>
      <div class="actions">
        <el-button @click="store.toggleOffline">{{ store.isOffline ? '恢复在线' : '模拟离线' }}</el-button>
        <el-button type="primary" @click="$router.push('/stage')">进入舞台工作区</el-button>
      </div>
    </div>

    <div class="metric-grid">
      <article class="metric">
        <span>脚本节点</span>
        <strong>{{ store.cues.length }}</strong>
        <small>覆盖三幕 {{ new Set(store.cues.map((cue) => cue.scene)).size }} 个场景</small>
      </article>
      <article class="metric">
        <span>待确认事项</span>
        <strong class="amber">{{ pending }}</strong>
        <small>确认后进入演出基线</small>
      </article>
      <article class="metric">
        <span>未解决留言</span>
        <strong class="red">{{ comments }}</strong>
        <small>跨部门协同处理中</small>
      </article>
      <article class="metric">
        <span>计划时长</span>
        <strong>{{ totalMinutes }}<small> 分</small></strong>
        <small>当前版本 {{ store.revision }}</small>
      </article>
    </div>

    <div class="overview-grid">
      <section class="panel">
        <div class="panel-head">
          <h3>下一组执行节点</h3>
          <span class="online">{{ store.isOffline ? '离线草稿' : '多人编辑中' }}</span>
        </div>
        <div class="cue-list">
          <button v-for="cue in nextCues" :key="cue.id" class="cue-row" @click="store.selectedId = cue.id; $router.push('/stage')">
            <time>{{ cue.time }}</time>
            <span>
              <strong>{{ cue.title }}</strong>
              <small>{{ cue.act }} / {{ cue.scene }} · {{ cue.owner }}</small>
            </span>
            <el-tag :type="cue.status === '已确认' ? 'success' : cue.status === '待确认' ? 'warning' : 'info'" effect="plain">
              {{ cue.status }}
            </el-tag>
          </button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h3>部门负荷</h3>
          <span class="muted">按提示数</span>
        </div>
        <div class="dept-list">
          <div v-for="item in byDepartment" :key="item.department" class="dept-row">
            <span>{{ item.department }}</span>
            <div class="bar-track"><i :style="{ width: `${(item.count / store.cues.length) * 100}%` }" /></div>
            <strong>{{ item.count }}</strong>
          </div>
        </div>
        <div class="conflict-card" :class="{ ok: store.conflicts.length === 0 }">
          <strong>{{ store.conflicts.length ? `发现 ${store.conflicts.length} 项潜在冲突` : '未发现时间冲突' }}</strong>
          <p>{{ store.conflicts.length ? '同一场景存在同时触发的提示，请在舞台工作区核对优先级。' : '当前提示的时间与场景编排一致。' }}</p>
          <el-button v-if="store.conflicts.length" text type="warning" @click="$router.push('/stage')">定位冲突</el-button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.amber {
  color: #b77014 !important;
}

.red {
  color: #bd4b3f !important;
}

.overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.65fr);
  gap: 14px;
}

.cue-list {
  padding: 6px;
}

.cue-row {
  display: grid;
  width: 100%;
  grid-template-columns: 76px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 13px 10px;
  border: 0;
  border-bottom: 1px solid #edf0f2;
  text-align: left;
  background: transparent;
  cursor: pointer;
}

.cue-row:hover {
  background: #f5f8f8;
}

.cue-row time {
  color: #247c7c;
  font-family: ui-monospace, monospace;
  font-weight: 700;
}

.cue-row strong,
.cue-row small {
  display: block;
}

.cue-row small {
  margin-top: 4px;
  color: #7a8692;
}

.dept-list {
  display: grid;
  gap: 18px;
  padding: 20px;
}

.dept-row {
  display: grid;
  grid-template-columns: 48px 1fr 24px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.bar-track {
  height: 8px;
  overflow: hidden;
  border-radius: 8px;
  background: #e7ecee;
}

.bar-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #2f8580;
}

.conflict-card {
  margin: 0 16px 16px;
  padding: 14px;
  border-left: 3px solid #d8912d;
  background: #fff8e8;
}

.conflict-card.ok {
  border-left-color: #4b9d72;
  background: #f0f8f3;
}

.conflict-card p {
  margin: 6px 0 0;
  color: #687582;
  font-size: 12px;
  line-height: 1.55;
}

.online {
  color: #2e8064;
  font-size: 12px;
}

@media (max-width: 1050px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 600px) {
  .cue-row {
    grid-template-columns: 64px 1fr;
  }

  .cue-row .el-tag {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
