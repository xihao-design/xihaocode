# 西浩资源库 · 站点工程

把 GitHub 等公开渠道上值得用的开源资源，整理成中文条目并以网盘方式交付的资源站。
**纯静态生成，零第三方依赖** —— 只有 Node 内置模块，不需要 `npm install`。

## 目录

```
redesign/
├── build.mjs              站点生成器：读数据 → 直出全部 HTML
├── site.config.json       站点配置：品牌 / 域名 / 备案 / 联系方式 / 导航 / 频道 / 站长验证 / 主题色
├── curation.json          编辑策展层（展示名 / 分类 / 一句话定位 / 收录状态 / 正文覆盖）
├── content/
│   ├── tags.json          标签规则：只按条目自身数据归类，命中不足 minItems 不产出页面
│   └── topics.json        专题合集：人工策展的跨分类清单，成员用 slug 引用（写错会被构建报出来）
├── data/
│   ├── github.json        联网核实结果：仓库 / Star / 协议 / 图标直链
│   └── _candidates.json   核实器抓回的候选，留作审计
├── src/
│   ├── styles/            设计系统，按文件名顺序拼接成单文件
│   │   ├── 00-tokens.css      设计令牌（浅色纸感 / 深色玻璃两套）
│   │   ├── 10-base.css        重置、排版、焦点、滚动条、动效开关
│   │   ├── 20-layout.css      容器、顶栏、hero、区块、粘性工具条、页脚
│   │   ├── 30-components.css  卡片、频道卡、Bento、按钮、搜索、Tweaks
│   │   └── 40-utilities.css   工具类、打印、reduce-motion 收敛
│   ├── app.js             客户端增强：主题三态 / 筛选 / 搜索 / 复制 / 外观
│   └── og.html            OG 分享图模板（深色玻璃版）
├── live/                  从线上取回的原产物 + 本工程的增量（构建的真源，见「线上产物与增量」）
│   ├── styles.css         线上样式表，**逐字节不动**（sha256 可与线上比对）
│   ├── app.js             线上脚本，**逐字节不动**
│   ├── addon.css          样式增量：只新增类，追加在线上样式之后
│   └── app-delta.js       脚本增量：登记式替换（脚本没法追加，见文件头注释）
├── assets/
│   ├── icons/             真实应用图标（本地落地，不热链）
│   └── og.png             分享图产物（由 src/og.html 渲染）
├── tools/
│   ├── extract-kb.ps1     从 xlsx 抽取原始条目
│   ├── verify-repos.mjs   走 GitHub Search API 核实仓库
│   ├── fetch-icons.mjs    抓图标（魔数校验 + jsDelivr 兜底）
│   ├── check-dist.js      产物校验（死链 / SEO / 图标 / 旧品牌残留 / sitemap 覆盖 / 脚本增量等式）
│   ├── check-facets.mjs   筛选核对：把产物里的筛选器拿出来真的点一遍（多值取或 / 空结果 / 复位）
│   ├── check-sections.mjs 区块结构核对：首页模块先后与落点、官方出品/运营指南归属、AI 分类导航（需浏览器）
│   ├── check-margins.mjs  版心与左右留白核对：所有页面里最靠左的内容块不得贴到视口边缘（需浏览器）
│   ├── smoke.mjs          运行时冒烟测试（真浏览器加载，验证主题状态机）
│   ├── chrome.mjs         无头浏览器封装（截图与 dump-dom 共用）
│   ├── make-og.mjs        渲染 OG 分享图
│   ├── shots.mjs          视觉核对截图（明/暗 × 桌面/真机宽度）
│   └── daily/             每日采集流水线（见 tools/daily/README.md）
└── dist/                  ← 部署产物，整个目录上传到 EdgeOne Pages
                              index.html · apps/ · category/ · tag/ · topic/ · ai/ · skills/ ·
                              desktop/ · guides/ · products/ · 合规页 · sitemap.xml
```

## 标签与专题：页面数量是怎么做上去的

流量天花板是「可索引页面数 × 每页长尾词」，所以除了 61 个详情页，还产出了标签页与专题页。
两条硬规矩：

1. **标签必须跨分类**。分类（影音播放/系统工具）与标签（无广告/离线可用/支持桌面端）维度重合，
   就等于自己跟自己制造重复内容。标签一律选分类切不出来的角度。
2. **有核实字段就用核实字段**。`tags.json` 里两种归类来源，页面上分开写明：
   - `kw`：按条目自身介绍文本归类（无广告、离线可用、轻量简洁、隐私友好、可自建服务）——
     标签页写明「按条目官方介绍里的说法归类」，把出处讲清楚；
   - `license` / `platform`：按 `github.json` 核实到的字段归类（协议系列、支持平台）。
     实测有条目介绍写「兼容 Android 和桌面平台」而核实到的平台只有 Android，所以平台类标签
     一律走核实字段，不采信文案。

**命中条目数低于 `minItems`（默认 3）的标签不产出页面** —— 一个标签页只挂一两条属于薄内容。
每次构建都会打印「哪个标签命中几条、哪些因不够门槛被跳过」，改 `tags.json` 后看构建输出就能调。

专题（`topics.json`）是人工策展的跨分类清单，和标签的区别是「按需求串起来」而不是「按数据切」。
成员用 slug 引用，引用了不存在的条目会被构建报成警告并从页面剔除。


## 常用命令

```bash
npm run build     # 生成 dist/
npm run check     # 产物校验 + 筛选核对：死链 / SEO / 图标 / 旧品牌残留 / sitemap / 脚本增量等式（提交前必跑）
npm run facets:check  # 只跑筛选核对（多值取或 / 多平台卡片 / 空结果 / 复位 / 技能库回归）
npm run smoke     # 运行时冒烟：真浏览器加载 13 个页面，验证主题状态机
npm run urls      # URL 稳定性：线上 sitemap 已有的地址，本地是否全部保留
npm run shots     # 视觉核对截图 → _preview/v2/（明/暗 × 桌面/真机宽度）
npm run sections  # 区块结构核对：首页模块先后与落点、官方出品/运营指南归属、AI 分类导航（需浏览器）
npm run margins   # 版心与左右留白核对：所有页面（需浏览器）
npm run og        # 由 src/og.html 渲染 assets/og.png（1200×630）
npm run token     # GitHub Token 体检：实际配额 / 授权范围 / 形态（只打印掩码）
npm run topics    # GitHub topic 探测：采集源选型前先量仓库量与可用量
npm run icons     # 补齐缺失图标（--force 覆盖已有）
npm run verify    # 重新核实仓库信息
npm run extract   # 从「GitHub开源软件分享知识库.xlsx」重新抽取数据
```

`shots` 与 `smoke` 需要系统里有 Chrome 或 Edge（可用 `CHROME_PATH` 指定）。
`token` 与 `topics` 需要联网；`topics` 未配 Token 时会被 GitHub Search 的 10 次/分钟限速卡住。
`facets:check` 不需要浏览器：它把产物里的筛选函数取出来、配 DOM 桩真的点一遍，
所以「筛选行为」这件事在没浏览器的机器上也有守门。

### 如果 PowerShell 里 `npm` 报「因为在此系统中禁止运行脚本」

```
npm : 无法加载文件 C:\Program Files\nodejs\npm.ps1，因为在此系统中禁止运行脚本。
```

这不是项目问题：PowerShell 里敲 `npm` 优先解析到 `npm.ps1`，而 Windows 客户端的默认执行策略是
`Restricted`（禁止运行任何脚本），所以任何 `npm run *` 都会被拦。

**不改设置也能用**（三选一）：

```powershell
npm.cmd run token                  # 走 .cmd 入口，不经过 .ps1
node redesign\tools\check-token.mjs # 直接调脚本，完全不涉及 npm
cmd /c npm run token
```

**一次修好**（只影响当前账户，不需要管理员）：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
Get-ExecutionPolicy -Scope CurrentUser    # 应显示 RemoteSigned
```

`RemoteSigned` = 本地脚本可以直接跑（`npm.ps1` 属于本地文件），从网上下载的脚本必须有签名。
这是微软对开发机的推荐档位；`AllSigned` 会让 `npm.ps1` 也跑不了，别选。

**注意**：每日采集不受影响 —— `daily\run-daily.cmd` 是 `.cmd`，直接调 `node collect.mjs`，
既不走 npm 也不走 PowerShell，执行策略管不到它。`build`/`extract`/`daily:task` 里调用 PowerShell 的地方
已经带了 `-ExecutionPolicy Bypass`，同样不受影响。

## 数据流

```
GitHub开源软件分享知识库.xlsx
        │  tools/extract-kb.ps1
        ▼
   .kb-raw.json  ──┐
redesign/curation.json ──┤  build.mjs  ──▶  dist/
redesign/data/github.json ┘        ▲
redesign/assets/icons/ ────────────┘
redesign/site.config.json ─────────┘（品牌与站点级配置）
```

## 线上产物与增量

视觉与客户端脚本以**线上产物**为真源（`live/styles.css`、`live/app.js`），两个文件都**逐字节不动** ——
这样它们的 sha256 能一直和线上比对，出问题时能立刻判断是「被改了」还是「内容变了」。
新内容需要的增量另写在增量文件里，构建时拼装：

| | 线上产物（逐字节不动） | 增量 | 产物 |
| --- | --- | --- | --- |
| 样式 | `live/styles.css` | `live/addon.css`：只新增类，不覆盖线上已有的类 | 线上 + 追加 |
| 脚本 | `live/app.js` | `live/app-delta.js`：登记式替换，每处必须命中恰好一次 | 线上 + 替换 |

脚本不能像样式那样「追加」：脚本的改动是**修改线上已有的函数**（筛选器的分面匹配），
追加在文件末尾够不着 IIFE 里的内部函数，把那段逻辑复制一份出来又正是本工程最反对的事。
所以脚本的增量登记成精确替换，`npm run check` 会断言「产物脚本 **逐字节等于** 线上脚本 + 已登记增量」：
换回一份新的线上产物、或某一处替换对不上，构建与校验都直接失败 —— 不会静默上线一版行为不对的脚本。

## 四条维护原则

1. **不编造**。`github.json` 里凡未亲自打开页面确认过的字段一律 `null`，宁缺毋滥。
2. **缺失就退让**。没有图标就显示首字标记，没有仓库就不显示开源信息——不用假数据凑。
3. **改内容改 curation**。展示名、分类、一句话定位、收录状态、正文覆盖都在 `curation.json`；
   `status` 支持 `ok` / `review`（收录但标注待确认）/ `exclude`（不收录）。
4. **改品牌改 site.config**。站名、域名、备案、联系方式、导航、频道入口、承诺条目、站长平台验证码都在
   `site.config.json` —— 改名不该改代码。

站长平台验证码（百度 / 搜狗 / 360）**只输出在首页**，因为三个平台验证的都是站点根地址。
`check-dist` 会断言「配置里写了验证码、产物里就必须有」—— 这东西丢了没有任何可见症状，
只会在平台后台悄悄变成「验证失败」。

## 设计系统

**两套主题是两套独立设计，不是同一批色值的明暗反转。**

| | 浅色｜暖色纸感 | 深色｜深空玻璃感 |
| --- | --- | --- |
| 底 | 象牙纸 `#FAF9F5` | 深空分层 `#0B0C10`，靠层级不用描边分块 |
| 强调 | 珊瑚 `#D97757`（悬停更深） | 提亮珊瑚 `#FF8E6A`（悬停更亮） |
| 玻璃 | 半透明白 + 细描边 + 顶部高光 | 半透明深底 + 高光描边，更像真玻璃 |
| 光晕 | 几乎不用 | hero 柔光（珊瑚 + 冷蓝），只用于 hero |

**主题状态机**：`<html data-theme="light|dark" data-theme-source="auto|light|dark">`。
三态由顶栏按钮循环切换，写入 `localStorage`；首屏由 `<head>` 内联脚本在绘制前写入，
避免闪白。`?theme=dark|light|auto` 是**预览用**的临时覆盖，不写存储 —— 截图核对与分享都靠它。

**毛玻璃只给少量元素**：顶栏、工具条、下载面板、外观面板、返回顶部。
一页 60 张卡片逐个做 `backdrop-filter` 是移动端掉帧主因，卡片只用半透明表面 + 顶部高光表达玻璃质感。
三条降级路径（浏览器不支持 / 系统「减弱透明度」/ 移动端）都在 `00-tokens.css` 里。

刻意规避：紫粉渐变、emoji、左侧色条卡片、虚构数据。
字体使用系统中文字体栈 —— **国内不可依赖 Google Fonts**，用了会白屏降级。

## 视觉核对的三个坑（都踩过）

1. **锚点截图会飘**：无头浏览器 + `#fragment` 的截图起点不可靠 → 改成注入 CSS 把前面的区块隐藏，
   让目标区块顶到最上面（`shots.mjs` 的 `css` 选项）。
2. **Chrome 有最小窗口宽度**（约 500px）：直接开 390px 窗口会被裁掉右侧，看着像布局崩了，
   其实是截图的锅 → 改成用 390px 宽的 `iframe` 包一层，iframe 内部视口才是真机宽度。
3. **不能抢默认浏览器配置目录**：调用无头浏览器时不指定 `--user-data-dir` 会去争用你正在用的
   Chrome 配置目录，轻则变慢重则卡住 → `chrome.mjs` 统一用临时目录并在结束时清理。

注入的复核页写在 `dist/` 根目录（否则相对路径全断），跑完立即删除，不留垃圾在部署目录里。
