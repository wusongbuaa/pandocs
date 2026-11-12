---
title: 页面布局
---

页面布局写在 Markdown 开头的元数据里，用法和 Rspress 一样。只读取下面这些字段，字段里的尖括号和危险链接会被去掉，所以第三方和智能体写的内容也是安全的。

编辑器里看不到开头的元数据，改它要用**编辑 Markdown 源码**。普通编辑不会动它，保存时原样写回。

| 字段 | 作用 |
| --- | --- |
| `pageType` | `home` 首页布局，`doc` 普通文档，`doc-wide` 加宽文档 |
| `hero` | 首页顶部：`name`、`text`、`tagline`、`badge`、`image`、`actions` |
| `features` | 首页的卡片：`title`、`details`、`icon`、`link`、`span` |
| `outline` | 是否显示右侧大纲 |
| `sidebar` | 是否显示左侧目录 |
| `footer` | 是否显示页脚的上一页和下一页 |
| `navbar` | 是否显示顶栏 |
| `readingTime` | 设为 `false` 不显示阅读时长 |
| `description` | 分享卡片和搜索引擎看到的描述 |

## 首页

路径为 `index` 的页面就是空间的首页。这个空间的首页是这样写的：

```yaml
---
pageType: home
hero:
  name: Pandocs
  text: 人和智能体，同页协作
  actions:
    - theme: brand
      text: 五分钟上手
      link: ./start
features:
  - title: 在页面上协作
    details: 划词评论、提修改建议、逐条接受。
    icon: 💬
    link: ./collaboration/comments
    span: 4
---
```

## 只放接口参考的页面

如果一个页面只有一个 `::openapi` 块，它会自动占满整个宽度，并使用接口参考自己的导航。看[接口参考](../agents/api-reference.md)。

## 演示

任何页面都可以当幻灯片放。在页面上方**复制 Markdown** 旁边的菜单里选**演示**，或者在地址后面加 `?view=slides`。

幻灯片按标题分页，`---` 分隔线也会分页，一节内容太长时会按下一级标题再分。方向键翻页，Esc 退出。可以用这一页试试。
