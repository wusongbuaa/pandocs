这一段有 `inline code`、[站内链接](/parity/second)、[外部链接](https://rspress.rs)、**粗体**、*斜体*、~~删除线~~，还有中文**粗体**紧贴标点，例如“**这样**”。

## 列表和引用

- 无序一
- 无序二
  - 嵌套一
  - 嵌套二

1. 有序一
2. 有序二

- [x] 已完成
- [ ] 未完成

> 这是一段引用，里面有 **粗体** 和 `code`。

## 表格

| 名称 | 说明 | 数量 |
| --- | --- | ---: |
| 甲 | 第一行 | 1 |
| 乙 | 第二行有 `code` 和 [链接](https://rspress.rs) | 22 |
| 丙 | 第三行比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长 | 333 |

---

## 容器

:::note 备注
note，里面有 `code` 和 [链接](https://rspress.rs)。
:::

:::tip 提示
tip，里面有 `code` 和 [链接](https://rspress.rs)。
:::

:::info 说明
info。
:::

:::important 重要
important。
:::

:::warning 注意
warning。
:::

:::caution 警告
caution。
:::

:::danger 危险
danger。
:::

:::details 展开查看
details 的内容。
:::

## 代码块

```ts title="demo.ts"
export function add(a: number, b: number) {
  // 注释
  return a + b;
}
```

```ts {2}
const a = 1;
const b = 2;
const c = 3;
```

```diff
- old line
+ new line
```

```bash
pnpm install
```

```json
{ "name": "pandocs", "private": true }
```

```text
纯文本
```

## 流程图

```mermaid
flowchart LR
  A[开始] --> B[结束]
```

## 标题层级

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题

结束。
