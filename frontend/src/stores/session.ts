import { defineStore } from 'pinia'

import { USERS, USER_BY_NAME, type UserAccount } from '@/data/access'

const SESSION_KEY = 'pharma-cleanroom:session'

function restore(): UserAccount {
  // 默认以原辅料仓放行人进场；顶部可切换身份，所有写操作都按当前身份鉴权并记入日志。
  const fallback = USERS.find((user) => user.name === '王原') ?? USERS[0]
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const saved = window.localStorage.getItem(SESSION_KEY)
  if (saved) {
    const user = USER_BY_NAME.get(saved)
    if (user) {
      return user
    }
  }
  return fallback
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    user: restore() as UserAccount,
    shiftLabel: '白班 08:00-20:00',
    scope: '制药企业洁净区与批生产记录管理平台',
  }),
  getters: {
    operator: (state) => state.user.name,
    canOperate: (state) => state.user.name.length > 0,
  },
  actions: {
    switchUser(name: string) {
      const user = USER_BY_NAME.get(name)
      if (!user) {
        return
      }
      this.user = user
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(SESSION_KEY, name)
      }
    },
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
