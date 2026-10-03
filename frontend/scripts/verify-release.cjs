// 纯逻辑验证：用 esbuild 把 TS 业务模块打成可在 Node 直接跑的 ESM，注入 localStorage 垫片。
// 运行：node scripts/verify-release.mjs（由 npm script 经 esbuild 打包后执行）
const assert = require('assert')

let store = {}
const localStorageShim = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = v
  },
  removeItem: (k) => {
    delete store[k]
  },
}
globalThis.window = { localStorage: localStorageShim }

async function main() {
  const mod = await import('/tmp/release-bundle.mjs')
  const { runReleaseAction, createReleaseOrder, releaseLedger } = mod.release
  const { allRows } = mod.store
  const users = mod.access

  const qa = users.USER_BY_NAME.get('周严')
  const qa2 = users.USER_BY_NAME.get('秦检')
  const wang = users.USER_BY_NAME.get('王原') // 原辅料仓放行人
  const li = users.USER_BY_NAME.get('李包') // 包材仓放行人
  const zhao = users.USER_BY_NAME.get('赵成') // 成品仓放行人
  const keeper = users.USER_BY_NAME.get('陈管') // 原辅料仓管理员

  const find = (id) => allRows().materialrelease.find((r) => r.id === id)
  const batch = (no) => allRows().batchrecord.find((r) => r['批号'] === no)
  let r
  let passed = 0
  const ok = (cond, msg) => {
    assert.ok(cond, msg)
    passed++
  }

  // 1. 跨仓/无权人员对「待放行」单的确认一律拒绝并说明原因
  r = runReleaseAction(2, '确认放行', '', li)
  ok(!r.ok && /跨仓/.test(r.message), '1a 跨仓放行人确认应被拒绝')
  r = runReleaseAction(2, '确认放行', '', keeper)
  ok(!r.ok && /管理员无放行权限/.test(r.message), '1b 仓管员无权放行')
  r = runReleaseAction(2, '确认放行', '', qa)
  ok(!r.ok && /质量部不承担仓库放行/.test(r.message), '1c 质量部不能放行')

  // 1d-g. 已放行单转只读：非分工人只给只读提示；仅质量部可冻结；冻结后解冻重新放行（验证幂等前先把 id=1 还原）
  r = runReleaseAction(1, '确认放行', '', li)
  ok(!r.ok && /已放行并转只读/.test(r.message), '1d 已放行单对其余角色只读')
  r = runReleaseAction(1, '冻结物料', '', wang)
  ok(!r.ok && /冻结权限已收归质量部/.test(r.message), '1e 已放行单仓库无权冻结')
  r = runReleaseAction(1, '冻结物料', '质量部例行抽检冻结', qa)
  ok(r.ok && find(1).status === '已冻结', '1f 质量部可冻结已放行单')
  r = runReleaseAction(1, '申请解冻', '抽检合格解除冻结', wang)
  r = runReleaseAction(1, '解冻审批通过', '', qa)
  ok(r.ok && find(1).status === '待放行', '1g 解冻通过回到待放行')

  // 2. 幂等：王原重新确认 id=1 放行成功；之后再点只算一次，不重复回写
  r = runReleaseAction(1, '确认放行', '', wang)
  ok(r.ok && find(1).status === '已放行', '2pre 解冻后由分工放行人重新放行')
  const before = batch('Y-240901')['放行台账回写']
  const logsBefore = find(1)['操作日志'].length
  r = runReleaseAction(1, '确认放行', '', wang)
  ok(r.ok && /只计一次/.test(r.message), '2a 重复确认幂等提示')
  ok(find(1)['操作日志'].length === logsBefore, '2b 幂等确认不新增日志')
  ok(batch('Y-240901')['放行台账回写'] === before, '2c 幂等确认不重复回写')

  // 3. 越级：待放行单不能直接解冻审批；已拒绝单无动作
  r = runReleaseAction(2, '解冻审批通过', '', qa)
  ok(!r.ok && /越级/.test(r.message), '3a 越级审批拒收')
  r = runReleaseAction(2, '申请解冻', '', wang)
  ok(!r.ok && /越级/.test(r.message), '3b 待放行不能申请解冻')
  r = runReleaseAction(6, '确认放行', '', li)
  ok(!r.ok && /越级/.test(r.message), '3c 已拒绝终态不可再放行')

  // 4. 非分工放行人（同仓不同人场景用跨仓覆盖；这里验跨仓冻结/放行权限边界）
  r = runReleaseAction(2, '冻结物料', '', wang)
  ok(!r.ok && /冻结权限已收归质量部/.test(r.message), '4 仓库放行人不能冻结')

  // 5. 正常放行：王原确认 id=2（580 ≤ 600，且 ≤ 投料 600kg）
  r = runReleaseAction(2, '确认放行', '', wang)
  ok(r.ok, '5a 分工放行人放行成功: ' + r.message)
  ok(find(2).status === '已放行' && find(2)['放行人'] === '王原', '5b 状态/放行人写入')
  ok(/已放行 580kg/.test(batch('Y-240905')['放行台账回写']), '5c 台账回写数量')

  // 6. 数量越界：把数量改成超上限再放行（先造一张新单：999 > 上限 500）
  r = createReleaseOrder(
    { batchNo: 'YL-240999', materialName: '越界物料', supplier: 'X', qcNo: 'QC-999', qty: 999, limit: 500, unit: 'kg', linkedBatch: 'Y-240905' },
    keeper,
  )
  ok(!r.ok && /超过放行上限/.test(r.message), '6a 登记时超限挡回')

  // 非正数
  r = createReleaseOrder(
    { batchNo: 'YL-240998', materialName: '零数量', supplier: 'X', qcNo: 'QC-998', qty: 0, limit: 500, unit: 'kg', linkedBatch: 'Y-240905' },
    keeper,
  )
  ok(!r.ok && /大于 0/.test(r.message), '6b 零数量挡回')

  // 超批记录投料量：上限 600 但批记录投料 600kg —— 用新批号挂 Y-240905，qty=600 边界通过；qty=601 挡回
  r = createReleaseOrder(
    { batchNo: 'YL-240997', materialName: '超投料', supplier: 'X', qcNo: 'QC-997', qty: 601, limit: 900, unit: 'kg', linkedBatch: 'Y-240905' },
    keeper,
  )
  ok(r.ok, '6c 登记允许（确认时再比对投料）')
  const newId = allRows().materialrelease.find((x) => x['物料批号'] === 'YL-240997').id
  r = runReleaseAction(newId, '确认放行', '', wang)
  ok(!r.ok && /超过批生产记录.*投料量/.test(r.message), '6d 超投料量放行挡回')
  ok(find(newId).status === '待放行', '6e 挡回不改状态')

  // 7. 冻结闭环：质量部冻结已放行单 → 仓库申请解冻 → QA 通过 → 回到待放行 → 重新放行
  r = runReleaseAction(2, '冻结物料', '质量回顾发现趋势异常', qa2)
  ok(r.ok && find(2).status === '已冻结', '7a QA冻结')
  r = runReleaseAction(2, '申请解冻', '复检合格附报告', li)
  ok(!r.ok && /跨仓/.test(r.message), '7b 跨仓不能申请解冻')
  r = runReleaseAction(2, '申请解冻', '', wang)
  ok(!r.ok && /必须填写/.test(r.message), '7c 解冻申请无理由拒收')
  r = runReleaseAction(2, '申请解冻', '复检合格附报告 QC-R1', wang)
  ok(r.ok && find(2).status === '待解冻审批', '7d 仓库重新提解冻申请')
  r = runReleaseAction(2, '解冻审批通过', '', wang)
  ok(!r.ok && /解冻审批权限在质量部/.test(r.message), '7e 仓库不能审批解冻')
  r = runReleaseAction(2, '解冻审批驳回', '依据不足', qa2)
  ok(r.ok && find(2).status === '已冻结', '7f QA 驳回维持冻结')
  r = runReleaseAction(2, '申请解冻', '已补无菌复测 QC-R2', wang)
  ok(r.ok, '7g 补正后重新申请')
  r = runReleaseAction(2, '解冻审批通过', '', qa)
  ok(r.ok && find(2).status === '待放行', '7h QA 通过回到待放行')
  ok(find(2)['放行人'] === '' && find(2)['冻结人'] === '', '7i 解冻后清空冻结/放行痕迹，须重新确认')
  r = runReleaseAction(2, '确认放行', '', wang)
  ok(r.ok && find(2).status === '已放行', '7j 解冻后由分工放行人重新放行')

  // 8. 已放行只读：解冻审批中的单子（id=5）只有 QA 能审批
  r = runReleaseAction(5, '解冻审批通过', '', zhao)
  ok(!r.ok && /解冻审批权限在质量部/.test(r.message), '8a 成品仓放行人不能审批')
  r = runReleaseAction(5, '解冻审批通过', '', qa)
  ok(r.ok && find(5).status === '待放行', '8b QA 解冻通过')
  r = runReleaseAction(5, '确认放行', '', wang)
  ok(!r.ok && /跨仓/.test(r.message), '8c 解冻后跨仓仍不能放行')

  // 9. 拒绝放行必须有原因，且只读
  r = runReleaseAction(4, '拒绝放行', '', li)
  ok(!r.ok && /必须填写原因/.test(r.message), '9a 拒绝无原因拒收')
  r = runReleaseAction(4, '拒绝放行', '印刷缺陷', li)
  ok(r.ok && find(4).status === '已拒绝', '9b 包材仓放行人拒绝')
  ok(/已拒绝/.test(batch('Y-240912')['放行台账回写']), '9c 拒绝结论回写台账')

  // 10. 登记鉴权：包材批号不能由原辅料仓登记；重复在途批号挡回
  r = createReleaseOrder(
    { batchNo: 'BC-250101', materialName: '新包材', supplier: 'X', qcNo: 'QC-1', qty: 10, limit: 10, unit: '套', linkedBatch: 'Y-240912' },
    keeper,
  )
  ok(!r.ok && /跨仓登记/.test(r.message), '10a 跨仓登记拒收')
  r = createReleaseOrder(
    { batchNo: 'BC-250101', materialName: '新包材', supplier: 'X', qcNo: 'QC-1', qty: 10, limit: 10, unit: '套', linkedBatch: 'Y-240912' },
    users.USER_BY_NAME.get('钱管'),
  )
  ok(r.ok, '10b 本仓管理员登记成功')
  r = createReleaseOrder(
    { batchNo: 'BC-250101', materialName: '新包材', supplier: 'X', qcNo: 'QC-1B', qty: 10, limit: 10, unit: '套', linkedBatch: 'Y-240912' },
    users.USER_BY_NAME.get('钱管'),
  )
  ok(!r.ok && /在途放行单/.test(r.message), '10c 同批号重复登记挡回')

  // 11. 台账视图：放行数量唯一数据源
  const led = releaseLedger().find((x) => x.batchNo === 'YL-240905')
  ok(led.releaseQty === 580 && led.linkedBatch === 'Y-240905', '11 台账数量来自放行单')

  console.log(`\n全部 ${passed} 项业务规则断言通过 ✅`)
}

main().catch((e) => {
  console.error('❌ 验证失败:', e.message)
  process.exit(1)
})
