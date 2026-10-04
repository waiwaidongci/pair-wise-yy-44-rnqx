import { createRouter, createWebHashHistory } from 'vue-router'
import OverviewView from './views/OverviewView.vue'
import StageView from './views/StageView.vue'
import ScriptView from './views/ScriptView.vue'
import PrintView from './views/PrintView.vue'

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: OverviewView, meta: { title: '巡演总览' } },
    { path: '/stage', component: StageView, meta: { title: '舞台走位' } },
    { path: '/script', component: ScriptView, meta: { title: '排练脚本' } },
    { path: '/print', component: PrintView, meta: { title: '打印中心' } },
  ],
})
