import { defineStore } from 'pinia'

export type Persona = {
  operator: string
  role: '仓库放行人' | '质量部' | '值班管理员'
  warehouse: string
}

// 预置值班身份：仓库放行人按仓库归属分工，冻结/批准解冻收在质量部，值班管理员只读。
export const PERSONAS: Persona[] = [
  { operator: '王强', role: '仓库放行人', warehouse: '原料库' },
  { operator: '李梅', role: '仓库放行人', warehouse: '原料库' },
  { operator: '赵磊', role: '仓库放行人', warehouse: '辅料库' },
  { operator: '陈晨', role: '仓库放行人', warehouse: '包材库' },
  { operator: '孙洁', role: '质量部', warehouse: '' },
  { operator: '值班管理员', role: '值班管理员', warehouse: '' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: '值班管理员' as Persona['role'],
    warehouse: '',
    shiftLabel: '白班 08:00-20:00',
    scope: '制药企业洁净区与批生产记录管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    actor: (state): Persona => ({
      operator: state.operator,
      role: state.role,
      warehouse: state.warehouse,
    }),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setPersona(persona: Persona) {
      this.operator = persona.operator
      this.role = persona.role
      this.warehouse = persona.warehouse
    },
  },
})
