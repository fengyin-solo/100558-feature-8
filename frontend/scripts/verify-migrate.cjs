const assert = require('assert')

let store = {}
globalThis.window = {
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v
    },
  },
}

async function main() {
  const { mig } = await import('/tmp/migrate-bundle.mjs'); const { migrateRows } = mig
  let passed = 0
  const ok = (cond, msg) => {
    assert.ok(cond, msg)
    passed++
  }

  // 模拟改造前的旧 localStorage 物料放行数据
  const legacy = [
    {
      id: 1, status: '待放行', pending: true, abnormal: false,
      '物料批号': 'YL-1001', '物料名称': '旧辅料', '供应商': '旧供应商',
      '检验单号': 'MATE-0001', '放行数量': 10, '放行人': '物料放行样例1',
      '放行日期': '2026-09-01', '放行状态': '待放行',
    },
    {
      id: 2, status: '已放行', pending: true, abnormal: true,
      '物料批号': 'BC-2002', '物料名称': '旧包材', '供应商': '旧供应商',
      '检验单号': 'MATE-0002', '放行数量': 20, '放行人': '',
      '放行日期': '', '放行状态': '已放行',
    },
    {
      id: 3, status: '已冻结', pending: true, abnormal: false,
      '物料批号': 'CP-3003', '物料名称': '旧成品', '供应商': 'X',
      '检验单号': 'MATE-0003', '放行数量': 30, '放行人': '赵成',
      '放行日期': '2026-09-03', '放行状态': '已冻结',
      '冻结人': '周严', '冻结时间': '2026-09-09 10:00',
    },
    {
      id: 4, status: '莫名其妙旧状态', pending: true, abnormal: false,
      '物料批号': 'XX-4004', '物料名称': '未知', '供应商': 'X',
      '检验单号': 'MATE-0004', '放行数量': '不是数字', '放行人': '',
      '放行日期': '', '放行状态': 'X',
    },
  ]

  const out1 = migrateRows({ materialrelease: legacy, batchrecord: [{ id: 1, status: '待编制', '批号': 'B1' }] })
  const a = out1.materialrelease[0]
  const b = out1.materialrelease[1]
  const c = out1.materialrelease[2]
  const d = out1.materialrelease[3]

  ok(a['归属仓库'] === '原辅料仓', '1 YL 批号回填原辅料仓')
  ok(a['分工放行人'] === '王原', '2 回填分工放行人王原')
  ok(a['放行上限'] === 10, '3 旧单无上限时按数量回填上限')
  ok(a['单据号'].startsWith('RL-LEGACY-'), '4 旧单补单据号')
  ok(Array.isArray(a['操作日志']) && a['操作日志'][0].operator === '系统迁移', '5 生成迁移日志')
  ok(a.pending === true && a.abnormal === false, '6 待放行旗标归一')

  ok(b['归属仓库'] === '包材仓' && b['分工放行人'] === '李包', '7 BC 批号归包材仓')
  ok(b['放行人'] === '李包', '8 已放行无放行人时回填分工放行人')
  ok(b['台账结论'].includes('按旧记录回填'), '9 已放行回填台账结论')
  ok(b['操作日志'].some((l) => l.action.includes('确认放行')), '10 已放行补确认日志')
  ok(b.pending === false && b.abnormal === false, '11 已放行 pending 归一')

  ok(c['归属仓库'] === '成品仓' && c['分工放行人'] === '赵成', '12 CP 批号归成品仓')
  ok(c.abnormal === true, '13 已冻结标异常')
  ok(c['操作日志'].some((l) => l.operator === '周严'), '14 冻结日志保留冻结人')

  ok(d.status === '待放行', '15 无法识别的旧状态归一为待放行')
  ok(d['放行数量'] === 0 && d['放行上限'] === 100, '16 非数字数量回填为 0/默认上限 100')
  ok(d['归属仓库'] === '原辅料仓', '17 未知前缀兜底原辅料仓')

  ok(out1.batchrecord[0]['放行台账回写'] === '' && out1.batchrecord[0]['迁移标记'], '18 批记录补回写字段与迁移标记')

  // 幂等：再迁移一次，日志不重复追加
  const logsOnce = a['操作日志'].length
  const out2 = migrateRows(out1)
  ok(out2.materialrelease[0]['操作日志'].length === logsOnce, '19 二次迁移不重复回填')
  ok(out2.materialrelease[0]['归属仓库'] === '原辅料仓', '20 二次迁移结果稳定')

  console.log(`\n存量迁移 ${passed} 项断言全部通过 ✅`)
}

main().catch((e) => {
  console.error('❌ 迁移验证失败:', e.message)
  process.exit(1)
})
