# XihaoUC 站点工程

精选 GitHub 开源软件的资源站。**纯静态生成，零第三方依赖**——只有 Node 内置模块，不需要 `npm install`。

## 目录

```
redesign/
├── build.mjs              站点生成器：读数据 → 直出全部 HTML
├── curation.json          编辑策展层（改这个文件就能改站）
├── data/
│   ├── github.json        联网核实结果：仓库 / Star / 协议 / 图标直链
│   └── _candidates.json    核实器抓回的候选，留作审计
├── src/
│   ├── styles.css         设计系统（Claude 风格）
│   ├── app.js             客户端增强：筛选 / 搜索 / 复制 / Tweaks
│   └── og.html            OG 分享图模板
├── assets/
│   ├── icons/             真实应用图标（本地落地，不热链）
│   └── og.png             分享图产物
├── tools/
│   ├── extract-kb.ps1     从 xlsx 抽取原始条目
│   ├── verify-repos.mjs   走 GitHub Search API 核实仓库
│   ├── fetch-icons.mjs    抓图标（魔数校验 + jsDelivr 兜底）
│   └── check-dist.js      产物校验（死链 / SEO / 图标存在性 / 排除项）
└── dist/                  ← 部署产物，整个目录上传到 EdgeOne Pages
```

## 常用命令

```bash
npm run build     # 生成 dist/
npm run check     # 校验产物（提交前必跑）
npm run icons     # 补齐缺失图标（--force 覆盖已有）
npm run verify    # 重新核实 37 个项目的仓库信息
npm run extract   # 从「GitHub开源软件分享知识库.xlsx」重新抽取数据
```

## 数据流

```
GitHub开源软件分享知识库.xlsx
        │  tools/extract-kb.ps1
        ▼
   .kb-raw.json  ──┐
redesign/curation.json ──┤  build.mjs  ──▶  dist/
redesign/data/github.json ┘
redesign/assets/icons/ ───┘
```

## 三条维护原则

1. **不编造**。`github.json` 里凡未亲自打开页面确认过的字段一律 `null`，宁缺毋滥。
2. **缺失就退让**。没有图标就显示首字标记，没有仓库就不显示开源信息——不用假数据凑。
3. **改内容改 curation**。展示名、分类、一句话定位、收录状态、正文覆盖都在 `curation.json`；
   `status` 支持 `ok` / `review`（收录但标注待确认）/ `exclude`（不收录）。

## 设计系统

暖象牙纸底 `#FAF9F5` + 墨色文字 + 唯一珊瑚强调色 `#D97757`，6 个沉稳大地色分类色调。
刻意规避：渐变背景、紫粉配色、emoji、左侧色条卡片、虚构数据。
字体使用系统中文字体栈——**国内不可依赖 Google Fonts**，用了会白屏降级。
