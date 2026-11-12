# 上游来源

这个目录是 [shadcn/ui](https://github.com/shadcn-ui/ui) CLI 生成的原样输出。

- CLI 版本：`shadcn@4.23.0`，`--base base --preset nova`（底层是 Base UI）
- 许可证：MIT（见 `LICENSE`）

| 这里 | 来源 |
| --- | --- |
| `components/ui/*.tsx` | `npx shadcn@4.23.0 add <组件名>` 的输出 |
| `tailwind.css` | `shadcn` 包的 `dist/tailwind.css`（CLI 本身不进依赖） |
| `components.json` | CLI 的配置，只用来重新生成 |

## 规则

不改这里的文件，升级时才能整体替换。外观都通过 `src/styles/kit.css` 里的变量映射到主题的 `--rp-*`，产品自己的封装放在 `src/ui/`。

这些组件带 Tailwind 的 CSS 和类名合并的代码，只能放在按需加载的分块里。阅读页首屏不能用，`test/first-load.test.ts` 会检查；首屏的菜单、浮层和提示在 `src/ui/menu.tsx`、`popover.tsx`、`tooltip.tsx`，直接用 Base UI 加普通 CSS。

## 升级

在仓库外的空目录里：

1. 建一个 Vite 加 Tailwind 4 的项目，运行 `npx shadcn@<版本> init --base base --preset nova`。已有 `components.json` 时预设不会变，要先删掉。
2. 运行 `npx shadcn@<版本> add` 加上 `components/ui` 里现有的组件。
3. 用生成的 `src/components/ui` 整体替换这里，再复制 `node_modules/shadcn/dist/tailwind.css`。
4. 运行 `pnpm exec vitest run --project web -u` 更新校验清单，确认差异都来自上游。
