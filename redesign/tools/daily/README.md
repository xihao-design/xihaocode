# XihaoUC 每日采集流水线

每天定时从 GitHub 生态里挑出**真能装的 Android 开源 App**，下载 APK、解析元数据、抠出图标、
生成审核表，并可自动上传百度网盘、自动建带提取码的分享链接。

```
发现候选 → 核实真有 APK → 下载并校验 sha256 → 解析包名/版本/签名/图标
        → 产出审核表 + 上传目录 → 上传网盘 + 建分享链接 → 回填链接
```

---

## 一、先说清楚能做到什么、做不到什么

| 事项 | 谁来做 | 说明 |
| --- | --- | --- |
| 每天定时发现 + 下载 App | ✅ 脚本全自动 | Windows 计划任务每天 21:00 定点跑 |
| 核实仓库、协议、Star、是否归档 | ✅ 脚本全自动 | GitHub API |
| 解析 APK 拿包名/版本/签名/图标 | ✅ 脚本全自动 | 零依赖自研解析器，读文件本身，不靠猜 |
| 准备好上传目录与登记表 | ✅ 脚本全自动 | 每个 App 一个文件夹 + `links.txt` + `上传说明.md` |
| **上传百度网盘** | 🖐 **你手动** | 用网盘客户端拖文件夹（也可切回自动，见第三节） |
| **建分享链接** | 🖐 **你手动** | 在网盘里对每个文件夹右键分享 |
| 把链接写进站点数据 | ✅ 脚本全自动 | 你把链接粘进 `links.txt`，一条 `publish` 命令搞定 |
| **重建并部署站点** | ⚠️ 一半一半 | 重建 `dist` 脚本做；**部署到线上要你操作** |
| **写中文文案**（tagline / 正文） | ❌ 刻意不自动 | 站点原则是「不编造」。脚本只提供事实来源（见下） |
| **决定收不收** | ❌ 刻意不自动 | 分类建议、风险标记由脚本给出，最终由你点头 |
| 「每天定时」这件事本身 | ⚠️ 定时的是脚本，不是我 | AI 不能自己醒来；每天定点干活的是装在你机器上的计划任务 |

**关于文案**：F-Droid 索引里有 **1081 条官方中文摘要**和不少官方中文详细描述（人工翻译，不是机器翻译）。
脚本会把这些作为「事实来源」原样放进 `bundle.json` 的 `factsForCopy` 与审核表，
写文案时直接引用即可 —— 这既不编造，又省掉大半工作量。
但 `merge.mjs` 会**拒绝**文案为空的条目，这是硬闸门：宁可少发，不发错。

---

## 二、两个发现源，主次分明

### 主源：F-Droid 索引（清华 TUNA 镜像）

官方 `f-droid.org` 在本机不可达，实测 `mirrors.tuna.tsinghua.edu.cn/fdroid/repo/index-v1.json` 可用
（59MB / 4385 个 App，4 秒下完），本地缓存 3 天。

为什么它比 GitHub 搜索强得多 —— 这是实测对比出来的，不是推测：

| | F-Droid 索引 | GitHub Search |
| --- | --- | --- |
| 候选是否真是手机 App | 全部是（F-Droid 只收录 Android 应用） | 需自己过滤，很容易捞进服务端项目 |
| APK 是否真有 | 一定有（索引里就写着文件名和大小） | 要逐个查 Release，实测 18 个候选只有 2 个有 APK |
| 完整性校验 | 索引直接给 **sha256**，独立第三方背书 | 部分仓库给 digest，多数没有 |
| 签名可用性 | F-Droid 官方构建并签名 | 作者自签，质量参差 |
| 中文文案 | **1081 条官方中文摘要** + 部分中文详细描述 | 无，只有英文描述 |
| 合规 | F-Droid 本身就在再分发这些包，附源码包名 | 需自己确认协议与源码获取方式 |
| 许可证/反特性 | 结构化字段 | 只有 SPDX 标识 |

### 补源：GitHub Search（带 Android 硬约束）

用于捞 F-Droid 没收录的高星项目。这里踩过一个坑值得记下来：
最初检索切片里放了 `topic:self-hosted`、`topic:open-source`，
结果捞进来的 143 个候选里绝大多数是服务端 Web 项目（linkding、dashy、listmonk、ArchiveBox…），
**18 个候选跑完 Release 检查只有 2 个有 APK**。

现在的做法：
1. 检索切片**只用 Android 专属 topic**（`android` / `android-app` / `f-droid` / `jetpack-compose` …），
   关键词一律与 `topic:android` 组合，保证结果一定是 Android 项目；
2. 加一道 `androidAppCheck` 硬闸门：必须同时满足「像 Android 应用」，
   命中 `self-hosted` / `docker` / `backend` / `library` / `browser extension` 等信号直接扣分拒收。

### 新源：电脑软件（Windows）—— 独立配额，2 个/天

桌面软件走的是另一套假设，实现在 `tools/daily/desktop.mjs`：

| | 手机 App | 电脑软件 |
| --- | --- | --- |
| 发现 | F-Droid 索引 + GitHub（Android topic） | GitHub（`topic:windows` / `desktop-app`，按星数区间轮换） |
| 铁证 | APK 能解析出包名/签名/SDK | Release 里**真有能装的 Windows 资产**（桌面端没有 APK 这种身份证） |
| 解析 | 解析 APK 拿包名/版本/签名/图标 | **整段绕开**：版本取 release tag + 读 exe 的 PE `VERSIONINFO` 交叉验证；图标走源码仓库 |
| 配额 | `filters` 那 4 个 | `desktop.quota`，**独立 2 个** |

**为什么配额独立**：桌面包比 APK 大一个量级，百度网盘上传是真实瓶颈。
共用一个名额池，要么手机 App 被挤掉，要么桌面包撑爆上传时间。所以 `--quota` 不影响桌面，
`--desktop-quota=N` 单独改。

**便携版 zip 会解包，并删掉原始压缩包**：网盘用户拿到一个看不出内容的 zip 没法核对
（那正是第三方下载站捆绑包的形态）。解包后把主程序名写进 README.txt，原始资产名也记下来备查；
原始 zip 内容与 `app/` 完全重复，留着等于让用户白传一份（实测 29MB 的包 + 60MB 的 exe = 89MB）。

**桌面端脚本替不了你的两件事**：安装包没有 APK 签名那种可自动核验的东西，安装器还可能捆绑推广组件
→ 发布前实机装一遍；上传前先算总体积，超过 1GB 分批。

### 频道页 `/desktop/` 会自动亮，不用改代码

桌面条目进站后，`build.mjs` 会按**核实到的 platform 字段**（提到 Windows / macOS / Linux / 跨平台）
把条目归到一起，产出 `/desktop/` 频道页 —— 判据与站内「支持桌面端」标签用的是同一套，
不会出现两个页面口径不一致。

门槛是 **8 条**（写在 `site.config.json` 的 `minItems`，与标签页同一套 minItems 逻辑）：

- 不够 8 条：页面、主导航项、sitemap 条目**一律不产出**，首页「电脑软件」那张卡显示「筹备中 · 已有 6/8 条」
- 够了 8 条：下一次 `npm run build` 自动上线，页脚/导航/首页频道卡一起生效

每次构建都会打印当前进度，例如 `电脑软件频道 未上线（6/8 条，差 2 条）`。
临时想看这一页长什么样：把 `minItems` 改成 3 跑一次构建即可（看完记得改回去）。

---

## 三、一次性配置（只做一次）

### 1. 装 Node（已有就跳过）

要求 Node 18+，本机实测 v22.20.0 可用。

> **注意 PowerShell 执行策略**：本机 `npm run xxx` 会报「无法加载文件 npm.ps1，因为在此系统上禁止运行脚本」。
> 两种绕法（任选）：
> ```powershell
> npm.cmd run build          # 用 npm.cmd 而不是 npm
> node redesign\build.mjs    # 或直接跑 node，最省事
> ```
> 计划任务不受影响 —— 它走 `run-daily.cmd` 直接调 node，不经过 npm。

### 2. 配置 GitHub Token（强烈建议）

不配也能跑，但**未认证的核心 API 只有 60 次/小时**，核实 Release 时会中途配额耗尽，经常凑不满配额。

建一个**只读 fine-grained token**（不需要勾任何权限），存成文本文件：

```
redesign/tools/daily/state/github-token.txt
```

或设环境变量 `GITHUB_TOKEN`。配了之后配额是 5000 次/小时。
（该文件已加进 `.gitignore`。）

**配完一定要验证。**「配了没生效」是这里最常见的坑：路径写错、Token 过期、记事本写进 BOM、
文件名后缀变成 `.txt.txt` —— 这些**都不会报错**，只会让采集悄悄退回 60 次/小时，等你发现时已经跑了好几天。

```powershell
npm run token
```

它不猜：直接拿 Token 打一次 GitHub，把**实际配额、授权范围、Token 形态**打印回来，
并区分「文件不存在 / 文件存在但为空 / Token 无效 / 未过期但没被接受」这几种情况。
（只打印掩码，完整 Token 永不输出。）

写文件建议用这一条，避开 BOM 与多余换行：

```powershell
[IO.File]::WriteAllText(
  'D:\vitepress\redesign\tools\daily\state\github-token.txt',
  'ghp_你的token',
  [Text.UTF8Encoding]::new($false))
```

**为什么现在特别重要**：未认证的 60 次/小时是「按目录收技能」这条路的硬瓶颈 ——
扫一个仓库的目录树找 `SKILL.md` 就是 1 次请求，一小时只能内省 60 个仓库；
装有 183 个 skill 的仓库（如 `wshobson/agents`）扫一次就要 1 次请求。
配了 Token 是 5000 次/小时，量级完全不同。另外 `npm run topics`（采集源选型探测）
在未认证下会被 10 次/分钟的 Search 限速卡住。

### 3. 装 BaiduPCS-Go 并登录（**仅「自动上传」模式需要，手动上传可跳过**）

当前 `config.json` 里是 `netdisk.mode = "manual"`，也就是**你手动上传**，
所以这一节可以整节跳过。等哪天想改成全自动再把 `mode` 改成 `"auto"`，然后按下面配置：

```powershell
# 1) 下载 BaiduPCS-Go.exe（开源，Apache-2.0）
#    项目地址：https://github.com/qjfoidnh/BaiduPCS-Go
#    放到：redesign\tools\daily\bin\BaiduPCS-Go.exe
#    （或在 config.json 的 netdisk.binPath 里写绝对路径）

# 2) 登录。浏览器登录 pan.baidu.com，F12 → Application → Cookies
#    方式一（上游推荐）：复制完整 Cookies
redesign\tools\daily\bin\BaiduPCS-Go.exe login --cookies="BDUSS=xxx; STOKEN=xxx; BAIDUID=xxx; ..."
#    方式二：只取 BDUSS 与 STOKEN（STOKEN 必须从网盘页面取，普通站点 cookie 里的那份无效）
redesign\tools\daily\bin\BaiduPCS-Go.exe login --bduss=<BDUSS> --stoken=<STOKEN>

# 3) 确认登录成功 —— 一定要看 uid，别看 loglist！
redesign\tools\daily\bin\BaiduPCS-Go.exe who
#    已登录：当前帐号 uid: 123456, 用户名: someone, ...
#    未登录：当前帐号 uid: 0, 用户名: , ...
```

> **为什么用 `who` 而不是 `loglist` 验证**：未登录时 `loglist` 会打印一行表头
> `# UID 用户名 性别 AGE` 但没有任何数据行 —— 这行表头极易被误读成"已登录有账号"
> （本项目的登录检测就被它骗过一次，已改为解析 `who` 的 uid）。
> 另外 `quota` 报错 `31045 ... user not exists` 同样表示未登录。

不做这步也能跑：采集、下载、解析、审核表照常，只是网盘环节会跳过并生成 `upload.ps1` 供你手动补。

> **风险提示（必修）**：BDUSS/STOKEN 等同于你的账号密码，BaiduPCS-Go 会把它明文存在
> `%APPDATA%\BaiduPCS-Go`。请确保这台机器只有你能用。
> 另外批量上传 + 批量建分享可能触发百度风控（限速、分享被和谐、严重时封号）。
> 建议先用几天手动上传观察，确认没问题再开自动。

### 4. 注册每日计划任务

```powershell
# 默认每天 21:00，配额 4 个
powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1

# 自定义时间与数量
powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1 -Time 08:30 -Quota 5

# 查看状态 / 立刻跑一次 / 卸载
powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1 -Status
powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1 -RunNow
powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1 -Uninstall
```

任务设为「**仅在用户登录时运行**」，原因很实际：百度网盘凭据存在当前用户的
`%APPDATA%` 下，设成「不管是否登录都运行」要么得存密码，要么读不到那份配置。
所以要求：到点时机器开着、你登录着。错过的运行会在下次开机后补跑（`StartWhenAvailable`）。

> **如果 `-Status` 提示「无法读取计划任务库」**：这不是「任务不存在」，而是当前环境
> （沙箱 / 权限不足）读不到计划任务库。用系统自带命令交叉验证：
> `schtasks /query /tn "XihaoUC-Daily-Collect" /fo LIST`
> 注册任务本身也需要访问 Task Scheduler，受限环境下可能被拒绝访问。

---

## 四、每天怎么用

### 第一次跑：建议按这个顺序验证

```powershell
# ① 先不下 APK，只验证「发现 + 筛选 + 审核表」这条链路（约 1 分钟）
node redesign\tools\daily\collect.mjs --quota=2 --no-download

# ② 看产物：_daily\<日期>\draft.md
#    重点看「一、需要你做的事」和「六、落选原因」，据此决定要不要调 config.json 的门槛

# ③ 再跑一次带真实下载的，验证下载 + 解析 + 图标（约 20 秒）
node redesign\tools\daily\collect.mjs --quota=2

# ④ 按 _daily\<日期>\上传说明.md 走一遍：上传 → 填 links.txt → 发布
node redesign\tools\daily\publish.mjs --date=<日期> --dry-run   # 先演示
node redesign\tools\daily\publish.mjs --date=<日期>             # 真发布

# ⑤ 都通了，再注册计划任务
powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1
```

### 日常：四步

计划任务每天 21:00 跑完采集后，你按这四步走。

#### 第 1 步：看审核表

```
_daily\<日期>\draft.md        ← 每天唯一需要你亲自看的东西
```

分七节：待办清单 / 交付清单 / 逐个详情 / 网盘情况 / 接下来怎么做 / 落选原因 / 失败项。
**第一节「需要你做的事」是重点**，它把该人工处理的项目全列出来了：

- 文案待写（`tagline` / `desc` / `features`）
- 分类待确认（脚本只给建议）
- 缺图标或图标来源可疑
- 未检出签名（这种包很可能装不上）
- 内容风险标记、协议义务、自托管依赖等风险

#### 第 2 步：写文案

编辑 `_daily\<日期>\bundle.json`，给每个要收录的 App 填 `tagline` / `desc` / `features` / `catSuggestion`。

`factsForCopy` 里有 **F-Droid 官方中文摘要与详细描述**（人工翻译，不是机器翻译），直接引用即可，别自己编。
`merge` 会**拒绝**文案为空的条目 —— 这是硬闸门。

（这一步也可以直接叫我做：把 `draft.md` 给我，我按官方描述写，写完你过一遍。）

#### 第 3 步：上传到百度网盘，填登记表

```powershell
# 打开这个目录，把里面每个文件夹整个拖进百度网盘
_daily\<日期>\upload\
```

每个文件夹里是：APK + `README.txt`（来源/协议/源码/哈希）+ `LICENSE.txt`。
**`README.txt` 不要删** —— GPL/AGPL 要求随包提供源码获取方式，它也是你日后自查的凭据。

在网盘里对每个文件夹右键 → 分享，然后把分享内容粘进 `_daily\<日期>\links.txt`：

```
### amazefilemanager | Amaze 文件管理器 | amazefilemanager-3.11.3.apk
链接: 链接：https://pan.baidu.com/s/1xxxx 提取码：ab12
提取码: 
```

整段粘贴就能认（带「链接：」「提取码：」或者手机 App 的分享口令都行，
`https://pan.baidu.com/share/init?surl=xxx` 这种形态也会自动转成标准短链）。
**不要改 `###` 那一行**，程序靠它对应到具体是哪个 App。

#### 更省事的方式：把链接直接发给 AI

前面两步（写文案 + 填登记表）都可以交给我。你只需要上传网盘，然后把链接发过来：

```
Amaze 文件管理器  链接：https://pan.baidu.com/s/1xxxx 提取码：ab12
antennapod 复制这段内容后打开百度网盘手机App，操作更方便哦 链接:https://pan.baidu.com/s/1yyyy?pwd=xy34
```

我会：用 `apply-links.mjs` 把链接对号入座（并打印对照表给你确认）→ 按 F-Droid 官方中文描述写好
`tagline` / `desc` / `features` 与分类 → 跑 `publish` 把 `dist` 重建好 → 告诉你产物路径和文件数。
你最后把它传上去，再跑 `verify-live` 确认生效。

> **建议每条都带上 App 名。** 不写名字也能按顺序匹配，但会标注「⚠ 按顺序匹配，请确认」。
> 之所以这么谨慎：链接和 App 一旦对应错，访客从 A 的下载按钮会拿到 B 的网盘，比没有链接更糟。
> 所以 `apply-links.mjs` 宁可报错也不猜 —— **一行同时匹配到多个 App、或同一个链接给了两个 App，
> 都会拒绝写入且不改动任何文件**。匹配用的标识可以是 slug、中文名、应用内名称或包名。

#### 第 4 步：一条命令发布

```powershell
node redesign\tools\daily\publish.mjs --date=<日期>
```

它会依次做：读登记表 → 校验 → 写回 `bundle.json` → 合并进站点数据 → 重建 `dist` → 校验产物。
跑完会自动打开 `redesign\dist\` 文件夹并列出上传清单，你把它传上去覆盖旧文件即可。

传完后**务必核对线上是否真的生效**：

```powershell
node redesign\tools\daily\verify-live.mjs
```

（`verify-live` 会直接抓线上页面，检查条目集合、详情页、网盘链接是否都对 —— 详见第五节。）

常用变体：

| 命令 | 作用 |
| --- | --- |
| `... --dry-run` | 只演示会发生什么，绝不写盘 |
| `... --allow-missing` | 只发布已填链接的那些（比如某个 App 的分享被和谐了，先发别的） |
| `... --skip-build` | 只改数据，不重建站点 |

`publish` 的校验会拦住三类错误：链接格式不对、**两个 App 误用了同一个分享链接**、提取码为空（只警告）。
同时 `merge` 在写盘前会把三个数据文件备份到 `_daily\<日期>\_backup-data\`，要撤销直接复制回去即可。

---

## 五、你上传的东西是怎么变成网站页面的

这一节解释「机制」——搞懂之后，出问题你能自己定位。

### 一条数据要落到四个地方

站点是**纯静态生成**的：`build.mjs` 读四个数据源，直出全部 HTML，没有数据库、没有运行时。

| 数据源 | 装什么 | 谁写进去 |
| --- | --- | --- |
| `.kb-raw.json`（仓库根） | **网盘链接、提取码**、介绍正文、特性 | `merge.mjs`（链接来自你填的 `links.txt`） |
| `redesign/curation.json` | 展示名、分类、一句话定位、slug、收录状态 | `merge.mjs` |
| `redesign/data/github.json` | 仓库地址、Star、协议、包名、核实备注 | `merge.mjs` |
| `redesign/assets/icons/<slug>.png` | 图标文件 | `merge.mjs` 从 `_daily\<日期>\icons\` 拷过来 |

四个都齐了，条目才会出现在网站上；缺一个就会被跳过或降级显示（比如没图标就显示首字标记）。

### 生成哪些页面

```
redesign/dist/
├── index.html              首页（全部软件 + 分类筛选）
├── apps/<slug>.html        每个 App 一个详情页 ← 你的网盘链接最终显示在这里
├── category/<分类>.html    6 个分类页
├── about.html              关于本站
├── 404.html
├── sitemap.xml             ← 新增条目会自动进 sitemap
└── assets/                 样式、脚本、图标
```

### 完整链路（从你粘贴链接开始）

```
你：把链接粘进 _daily\<日期>\links.txt
        │
        │  node redesign\tools\daily\publish.mjs --date=<日期>
        ▼
① 解析 links.txt ──→ 写回 _daily\<日期>\bundle.json（唯一事实来源）
② 校验：链接格式 / 重复链接 / 提取码
③ merge.mjs：三处数据 + 一个图标
        │
        ▼
   .kb-raw.json + curation.json + data/github.json + assets/icons/
        │
        │  node redesign\build.mjs
        ▼
   redesign\dist\  （全部 HTML 直出）
        │
        │  node redesign\tools\check-dist.js   ← 本地校验：死链 / SEO / 图标存在性
        ▼
   ✋ 你：把 dist\ 传到线上（publish 会帮你打开文件夹并列好清单）
        │
        │  node redesign\tools\daily\verify-live.mjs   ← 线上核对：真的生效了吗
        ▼
   ✓ 访客能看到新页面了
```

### 为什么是「一条命令」而不是四步

`publish.mjs` 把「解析 → 校验 → 合并 → 建站 → 校验产物」串起来了，
所以你不必记住 `merge` / `build` / `check` 三个脚本和它们的顺序，
也不会出现「合并了但忘了重建」这种半生效状态。

如果你想分步做，等价于：

```powershell
node redesign\tools\daily\merge.mjs --date=<日期>   # 只合并数据
node redesign\build.mjs                             # 只重建站点
node redesign\tools\check-dist.js                   # 只校验产物
```

### 唯一剩下的手工步骤：部署

重建出来的 `redesign\dist\` 是本地文件，只有把它推到线上，访客才看得到新页面。
你的方式是**手动上传**，所以这一步必须你操作（仓库里没有任何部署配置，`dist` 也被 `.gitignore` 排除了）。

`publish` 跑完会直接把 `dist` 文件夹打开并列出上传清单，比如：

```
════════════════ 最后一步：部署 ════════════════
本地已经重建好了，但访客还看不到 —— 需要你把下面这个目录传上去（覆盖旧文件）：
  D:\vitepress\redesign\dist
  （81 个文件，共 2.3 MB）
传完之后核对一下：
  node redesign\tools\daily\verify-live.mjs
```

（不想每次自动弹文件夹：加 `--no-open`。）

### 部署完一定要核对：`verify-live.mjs`

**本地 build 成功 ≠ 线上更新了。** 忘了部署、传错目录、CDN 没刷新，
这三种情况本地完全看不出来。所以部署完跑一次：

```powershell
node redesign\tools\daily\verify-live.mjs
```

它直接抓线上真实页面，用本地数据当基准，报三件事：

1. **条目集合对比**：本地该有的线上有没有（缺了 = 部署没生效）；
   线上有没有多出来的（比如本地已排除、但旧版本还留在线上）
2. **逐个打开详情页**：HTTP 200 吗？页面里确实带着那个网盘链接吗？
3. **首页软件数**和本地是否一致

只核对刚发的几个（更快）：

```powershell
node redesign\tools\daily\verify-live.mjs --only=antennapod,amazefilemanager
node redesign\tools\daily\verify-live.mjs --limit=5
```

站点地址从 `dist\sitemap.xml` 里读，也可以用 `--base=` 覆盖。
有问题时退出码为 1，可以直接接进别的脚本里判断。

> **2026-09-17 实测记录**：第一次跑它查出线上首页写着「35 款软件」而本地只有 33 款 ——
> 多出来的正是 `loop` 和 `cuppa` 两个已被标记 `exclude` 的条目。
> 也就是说**线上部署落后于仓库**：你下次部署 `dist` 时首页会从 35 款变成 33 款，
> 这两个条目会消失（这是预期行为，不是出错）。

---

## 六、产物长什么样

```
_daily\2026-09-16\
├── draft.md                     审核表（每天第一眼看这个）
├── 上传说明.md                  当天这一批的操作步骤与注意事项
├── links.txt                    ← 分享链接登记表：你只需要填这个
├── bundle.json                  机器可读的完整结果（含文案字段供填写）
├── log.txt                      本次运行日志
├── upload\<slug>\               ← 这个目录整个上传到网盘
│   ├── <slug>-<version>.apk
│   ├── README.txt               来源/协议/源码/哈希 —— 分发合规凭据，别删
│   └── LICENSE.txt              （GitHub 通道会附协议原文）
├── icons\<slug>.png             图标（merge 时会自动拷进站点 assets/icons/）
├── licenses\                    协议原文
└── _backup-data\                publish/merge 写盘前的自动备份，可用来撤销
```

网盘目录结构：`/XihaoUC/<日期>/<slug>/`，每个 App 单独建分享链接。

> `upload.ps1` 只在 `netdisk.mode = "auto"` 时才会生成（它是 BaiduPCS-Go 的命令行补传方案）。
> 手动上传模式下刻意不生成，免得你以为是必做步骤。

`README.txt` 里写了这些（这既是合规最低要求，也是你日后自查的凭据）：

```
开源仓库 / 开源协议 / 发行页面 / 源码压缩包地址
APK 文件 / 文件大小 / SHA-256 / 下载通道 / 采集日期
来源索引(F-Droid) / 包名 / 版本 / CPU 架构
```

---

## 七、命令速查

```powershell
# 正常跑（默认今天、配额取 config.json）
npm run daily

# 常用参数
node redesign\tools\daily\collect.mjs --quota=5          # 临时改手机 App 数量
node redesign\tools\daily\collect.mjs --no-netdisk       # 跳过网盘环节
node redesign\tools\daily\collect.mjs --no-download      # 只出清单，不下安装包
node redesign\tools\daily\collect.mjs --github-only      # 只走 GitHub 通道
node redesign\tools\daily\collect.mjs --fdroid-only      # 只走 F-Droid 通道
node redesign\tools\daily\collect.mjs --refresh-index    # 强制刷新 F-Droid 索引
node redesign\tools\daily\collect.mjs --only=owner/repo  # 只处理指定仓库（调试，两个通道都认）
node redesign\tools\daily\collect.mjs --fresh            # 忽略历史，重新检查

# 电脑软件通道（独立配额，默认执行）
node redesign\tools\daily\collect.mjs --desktop-quota=1  # 临时改电脑软件数量（不占手机名额）
node redesign\tools\daily\collect.mjs --no-desktop       # 本轮不跑电脑软件通道
node redesign\tools\daily\collect.mjs --desktop-only     # 只跑电脑软件通道

# 电脑软件资产选择 / 应用判定的回归测试（改判定逻辑后必跑）
npm.cmd run desktop:test                                 # 15 用例资产选择 + 8 用例应用判定

# ★ 把你粘贴来的链接对号入座（当你要把链接丢给我、或列表里混着不规律的格式时用）
node redesign\tools\daily\apply-links.mjs --date=2026-09-16 --file=links-in.txt
node redesign\tools\daily\apply-links.mjs --date=2026-09-16 --dry-run     # 只出对照表，不写

# ★ 发布（你日常真正要跑的就是这一条）
node redesign\tools\daily\publish.mjs --date=2026-09-16
node redesign\tools\daily\publish.mjs --date=2026-09-16 --dry-run        # 只演示不写盘
node redesign\tools\daily\publish.mjs --date=2026-09-16 --allow-missing  # 只发已填链接的
node redesign\tools\daily\publish.mjs --date=2026-09-16 --skip-build     # 只改数据
node redesign\tools\daily\publish.mjs --date=2026-09-16 --no-open        # 不自动弹出 dist 文件夹

# ★ 部署后核对线上是否真的生效
node redesign\tools\daily\verify-live.mjs
node redesign\tools\daily\verify-live.mjs --only=antennapod,amazefilemanager
node redesign\tools\daily\verify-live.mjs --limit=5
node redesign\tools\daily\verify-live.mjs --base=https://www.xihaouc.top

# 分步等价物（publish 已经把它们串起来了，一般不用单独跑）
node redesign\tools\daily\merge.mjs --date=2026-09-16 --dry-run
node redesign\build.mjs
node redesign\tools\check-dist.js

# APK 解析器自检（拿真实 Release 的真 APK 跑一遍）
npm run daily:selftest
npm run daily:selftest -- cyb3rko/flashdim Predidit/Kazumi

# 单个 APK 结构速查（某个包解析不出包名/图标时排障用）
node redesign\tools\daily\inspect-apk.mjs "_daily\2026-09-16\upload\antennapod\antennapod-3.12.1.apk"
node redesign\tools\daily\inspect-apk.mjs <apk路径> .png     # 只看含 .png 的条目
```

配置都集中在 `redesign/tools/daily/config.json`，改配置不用改代码。

---

## 八、设计取舍与实测记录

这一节记录的都是**实测**结论，避免以后重复踩坑。

### 网络通道（2026-09 本机实测）

| 目标 | 结果 |
| --- | --- |
| `api.github.com` | ✅ 可达 |
| `raw.githubusercontent.com` | ❌ 超时 |
| `release-assets.githubusercontent.com` | ❌ 超时（Release 资产真正所在的域） |
| `cdn.jsdelivr.net` / `f-droid.org` | ❌ 超时 |
| `ghfast.top` | ✅ 6.3 MB/s |
| `gh-proxy.com` | ✅ 2.0 MB/s |
| `ghproxy.net` | ✅ 0.8 MB/s（慢 8 倍） |
| `mirrors.tuna.tsinghua.edu.cn/fdroid/repo` | ✅ 索引与 APK 均可用（**但不镜像图标**） |

所以：API 直连、文件下载走镜像，并按**实测吞吐量自动排序**（记录在 `state/mirror-stats.json`）。
单通道超时设得偏短（240s）+ 静默检测（25s），让慢通道尽早让位给快通道；换通道时用 Range 断点续传。

### 为什么自己写 APK 解析器

站点工程的原则是「只有 Node 内置模块」，而沙箱环境下 Node 的管道 stdio 被禁，
无法用 `Expand-Archive` 之类的工具绕过。所以 zip 读取、二进制 AndroidManifest、
`resources.arsc` 全部自己实现（`apk.mjs` / `arsc.mjs` / `axmlpool.mjs`）。

踩过的两个坑，都记在代码注释里了：

1. **二进制 XML 的属性偏移**。属性起始位置是 `chunk起点 + headerSize(16) + attributeStart`，
   一开始写成 `+ 8 + attributeStart`，症状很迷惑：**元素名读得对，属性全都读不到**
   （包名/版本/权限为空，但 activity 数得对）。
2. **图标不能靠文件名找**。实测 FlashDim 的 APK 开了资源混淆，图标是 `res/NU.png`，
   文件名里根本没有 `launcher` 字样。权威做法是按 `application@icon` 的资源 ID 反查 `resources.arsc`，
   既不怕混淆，还能顺带解出 **App 的真实显示名**和多密度里最清晰的那张。

### 文件编码：三条硬约束（都踩过坑，改文件时别破坏）

这三条看起来琐碎，但每一条都真实地把流水线搞挂过：

| 文件类型 | 约束 | 违反后的症状 |
| --- | --- | --- |
| `.cmd`（`run-daily.cmd`） | **纯 ASCII + CRLF 行尾** | LF 行尾会让整行被拆坏（`'/d' is not recognized`）；中文被 cmd 按 GBK 解码成乱码指令（`'了问题' is not recognized`），脚本静默不干活但退出码仍是 0 |
| `.ps1`（`install-task.ps1`、生成的 `upload.ps1`） | **UTF-8 **带 BOM** + CRLF** | Windows PowerShell 5.1 读无 BOM 的 UTF-8 脚本时按 ANSI 解码，中文变乱码导致语法错误，且报错行号完全对不上真实位置 |
| `.json`（`bundle.json` 等） | **UTF-8 **不带 BOM**** | `JSON.parse` 遇到 BOM 会直接抛错 |

`run-daily.cmd` 因此被刻意写成全英文注释 —— 别为了"好看"往里加中文。
生成的 `upload.ps1` 由 `netdisk.mjs` 主动写入 BOM（`'\uFEFF' + ...`）。

### 状态文件与「采集了但没发布」

`state/seen.json` 是在**采集成功时**就把包名/仓库记为 `accepted`，
所以第二天不会再推荐同一批 —— 否则你会天天看到同样几个 App。

这带来一个副作用：如果你某天没发布（没建分享链接），那批 App 不会自动回来。
两道保险：
- 每次运行开头会检查最近 7 天的产物，把「采集了但还没有分享链接」的条目列出来提醒你；
- 那批 APK 一直留在 `_daily\<日期>\upload\` 里，随时可以补传。

确认不要了，就从 `state\seen.json` 里删掉对应条目，让它们重新进入候选池。

### 手动上传这块的两条硬要求（都踩过坑）

**一、提取码宁可留空，绝不猜。**
百度分享的提取码是 4 位字母数字，所以「从任意文本里抓一个 4 位字母数字」看起来很容易 ——
但这正是最危险的做法。实测踩到：`https://pan.baidu.com/s/1NoPwdHere` 里含有 `Pwd`，
关键词不加词边界就会把后面的 `Here` 当成提取码；写进站点后**访客拿着错的提取码根本打不开链接**，
比留空严重得多。现在只有两种情况才取值：

- `提取码:` 那一行整行就是一个 4 位码
- 行内明确带「提取码 / 密码 / 访问密码 / pwd」字样，且该关键词前后有边界

认不出就留空，由 `publish` 明确报出来让你补。

**二、`--dry-run` 必须真的 dry，而且演示结果必须等于真实结果。**
两个坑都踩过：
- `merge` 的 dry-run 一开始照样把图标拷进了 `assets/icons/`（已修）
- `publish` 的 dry-run 不写 `bundle.json`（这是对的），但 `merge` 又从磁盘重读，
  于是读到还没填链接的旧内容，报告「可写入 0 个」—— 演示结果完全失真
  （现在 publish 把内存里的 bundle 直接传给 merge）

### 已知限制

- **纯矢量自适应图标抠不出位图**。实测 `xLexip/Adaptive-Theme` 的 APK 里 **0 张 PNG**，
  图标是 VectorDrawable。不解矢量就不可能栅格化。此时会退到源码仓库找图标，
  再失败就在审核表里标「缺图标」交人工 —— 站点会退化成首字标记（`build.mjs` 的既定行为，不是错误）。
- **F-Droid 没有 Star 数**。脚本会对分数最高的候选查 GitHub 拿 Star 复核（每次 1 次核心 API 调用）。
  `fdroid.minStars` 默认 0，因为很多好用的 F-Droid 应用只有几百星。想只收高星就调高它。
- **文案例外**。脚本不写中文卖点文案，这是刻意的（见第一节）。

---

## 九、状态文件（可随时删，删了会重新学习）

| 文件 | 作用 |
| --- | --- |
| `state/seen.json` | 处理过的仓库/包名与结论，避免重复收录、省 API 配额 |
| `state/pending.json` | 已确认有 APK 但当天配额满了的候选，下次零 API 成本交付 |
| `state/fdroid-index.json` | F-Droid 索引瘦身缓存（默认 3 天过期） |
| `state/mirror-stats.json` | 各镜像实测吞吐量，用于自动排序 |
| `state/github-token.txt` | 你的 GitHub Token（**不要提交**，已在 .gitignore） |

---

## 十、合规与风险（请认真看一遍）

1. **只分发明确许可的开源软件**。没有协议（`NOASSERTION`/`Other`）一律不收；
   带 `NC`/`ND` 条款的一律不收。这是脚本里的硬规则。
2. **协议义务不是可选项**。GPL/AGPL/LGPL 要求向接收者提供对应源码，
   所以上传目录里的 `README.txt` 会写明源码与源码压缩包地址。别把它删了。
3. **内容聚合类 App 风险最高**。站内 `legado`（阅读3.0）已有作者因侵权承担法律责任的先例，
   策展层里记着原话。脚本会对命中「影视/追番/磁力/破解/去广告/IPTV…」等关键词的条目打
   **内容风险**标记，但**收不收由你决定**，脚本不做主。
4. **百度网盘对 APK 分享敏感**。批量上传和批量建分享可能触发风控，
   分享链接也可能被和谐。建议留一份 `_daily` 本地备份，定期抽查分享链接是否还有效。
5. **权利人异议**。`README.txt` 里已写明「如你是权利人并认为此处分发不妥，请联系本站删除」。
