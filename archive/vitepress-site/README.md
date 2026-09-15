# 已归档：旧 VitePress 站点

**这个目录是历史存档，不再维护，也不再部署。**

2026-09-15 起，站点从 VitePress 迁移为 `redesign/` 下的零依赖静态站。
旧站曾在 www.xihaouc.top 上线（最后构建：2025-11-29），内容为 9 个夸克网盘资源页
（宝藏软件 / 设计创意 / 教育 / AI工具 / 书籍 / 自媒体 / 职场 / 壁纸 / 游戏）。

## 为什么下线

新站定位收敛为「只做 GitHub 开源软件分享」，与内容以网盘转存为主的旧站不再匹配。
迁移时另有两项硬原因：

1. **合规**：旧站含「阅读3.0 (Legado)」条目。该项目作者已删除全部项目内容并公开公告
   「本项目涉及侵权行为的违法，也为此承担了相应的法律责任……不要再效仿、从事、传播各类侵权活动」。
   对一个已备案的公开站，继续分发风险过高。该条目已从新站排除。
2. **事实错误**：旧站部分条目的功能描述与项目实际情况不符（如把 FlashDim 的手电筒亮度
   写成屏幕亮度、把 Android 时钟 App Chrono 与同名 C++ 物理仿真引擎混为一条）。
   这些问题在新站已逐条核实更正。

## 目录内容

```
docs/              VitePress 站点源码（含 9 个资源页与自定义主题）
.vitepress/        Vue 类型声明
package.json       旧依赖声明（vitepress / vue / typescript）
pnpm-lock.yaml     旧依赖锁定
tsconfig.json      旧 TypeScript 配置
dist-backup-线上旧版.zip   线上旧版部署产物的字节级备份
```

> 注意：`dist-backup-线上旧版.zip` 是**唯一**能还原线上旧版产物的东西。
> 旧站的源码与它构建出的产物并不一致（`docs/index.md` 的 SEO meta 曾被模板占位符覆盖），
> 所以无法靠重新构建还原线上版本——要保留旧版就留着这个 zip。

## 如果要重新运行

```bash
cd archive/vitepress-site
pnpm install          # 或 npm install
npx vitepress dev docs
```

仅作查看历史之用。新站见仓库根目录的 `redesign/README.md`。
