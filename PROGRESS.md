# PROGRESS — LifeLine2090 人生长河

> 进度日志。新的写在最上面；只追加，不删改旧记录。

## 2026-10-30 17:50 · 源码上 GitHub · 进行中
- 做了：用户决定源码放进 yz-shift/lifeline2090。旧的纯网页历史保存在 `site-legacy` 分支，Pages 改由它提供（网站没断）；源码 force push 到 `main`；加了 CI（构建 + 单元测试）
- 改了：package.json（`npm test` 改成显式 glob，原来在 Node 24 下一个测试都没跑）、.github/workflows/ci.yml（新增）
- 验证：干净克隆能构建，数据文件和线上逐字节一致；`npm test` 285/285 通过；GitHub Actions CI 绿色；线上 app.js 哈希没变
- 问题：从源码构建出的 app.js / index.html 和线上不同，因为 10-27 的"人生长卷"海报和高考分数还没发布。改成 Actions 部署会把它们一起上线
- 下一步：等我同意后，加部署 workflow、Pages 切到 Actions，确认网站正常后删掉 `site-legacy`（删之前问我）

## 2026-10-30 16:39 · 初始化 · 完成
- 做了：接入工作流（AGENTS / TASKS / PROGRESS / CLAUDE），加 .gitignore，源码首次建 git 仓库并本地提交（163 个文件）
- 改了：只新增上述文件，没改代码
- 验证：扫描过密钥，没有；命中的两处是维基百科链接
- 问题：源码还没推到 GitHub，要先决定放进现有仓库还是另建
- 下一步：T-001 出方案
