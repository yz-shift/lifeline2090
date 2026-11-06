# PROGRESS — LifeLine2090 人生长河

> 进度日志。新的写在最上面；只追加，不删改旧记录。

## 2026-11-06 12:50 · T-002 · 完成
- 上线：用户同意后 push 到 main，CI（测试+部署）通过；线上 i18n_en.json 可访问，浏览器打开线上网站切到 English，出生卡为英文

## 2026-11-06 · T-002 · 待用户同意 push
- 做了：全部 15012 条文字译完（历史事件 5163 条、世界线说明 1199 条、各国当地背景等）；匹配器补了多句模板、嵌套引号、多段姓名、生平地图标题、金额；英文排版修好（出生卡、游戏工具栏、手机页头、出生/死亡/人生长卷海报，印章改英文）
- 改了：src/i18n/index.js、src/ui/cards.js、src/ui/styles.css、death/family/game 页的姓名首字、tools/i18n_extract.mjs、i18n/en/*、tests/i18n.test.mjs
- 验证：i18n_coverage 模拟 528 局（修完后再跑 264 局）残留 0 行；浏览器里玩完多局并查了关于页、设置、成就、大家的人生、纪念馆；手机宽度无横向溢出；npm test 312/312 通过
- 问题：生平地图里极少数悬停标题（事件第二分句或截断处含变量，如"纳吉布拉拿着伞在车站等你"）仍可能显示中文；海报上阿拉伯文货币符号方向不理想；AI 模式下的英文输出依赖模型（内置引擎不受影响）
- 下一步：等用户决定是否 push 上线

## 2026-11-05 16:30 · T-002 · 进行中
- 做了：加了翻译层（引擎和存档仍是中文，显示时才翻译，同一种子两种语言人生相同，旧存档也能看英文）；页头和设置页加了中文/English 切换；提取工具收集到约 1.9 万条要翻译的文字；界面文字 1936 条译完
- 改了：src/i18n/（新增）、src/ui/langSwitch.js（新增）、tools/i18n_extract.mjs、tools/i18n_batch.mjs、tools/serve.mjs（新增）、i18n/、data/i18n_en.json、tests/i18n.test.mjs、src/main.js、src/ui/（dom、app、cards、charts、settings 等）
- 验证：npm test 见本次提交；浏览器里切到 English，首页和导航是英文、切换不用刷新、页面没有横向溢出
- 问题：剧情、历史事件、国家名和姓名还没译，所以英文模式目前是中英混杂；本地 python http.server 不带字符集会让页面打不开，npm run serve 已换成 tools/serve.mjs
- 下一步：翻译剩余约 30 万字（等用户决定方式），加英文自由输入，模拟多局查漏

## 2026-10-30 18:10 · 源码上 GitHub + 自动部署 · 完成
- 做了：用户同意上线。CI 加了部署步骤（测试通过才部署），Pages 从 `site-legacy` 分支切到 GitHub Actions；10-27 的"人生长卷"海报和高考分数随之上线
- 改了：.github/workflows/ci.yml
- 验证：Actions 里 test 和 deploy 都是绿的；线上 app.js 哈希 = 本地从源码构建的哈希（de238dd4）；浏览器打开首页、点"随机出生"生成出生登记卡，控制台 0 报错
- 问题：海报只在测试里验证过，没在线上完整玩一局到结尾看海报（未验证）。`site-legacy` 分支还留着当备份
- 下一步：以后改代码 push 到 main 就自动部署，`dist-web/.git` 那套手动推送不再使用。继续 T-001（README 等）

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
