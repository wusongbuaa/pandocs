---
title: 导入文件
---

页面的事实源是 Markdown，因为这样才能逐行评论、让智能体读懂、也能合并。其他文件进来时转成 Markdown，原文件留在页面上。

在空间的**导入导出**页面上传，或者用命令行：

```bash
pandocs import handbook returns.docx                       # 生成一份待确认的草稿
pandocs import handbook returns.docx --publish --as policies/returns
pandocs import handbook q3.pdf --publish --to reports/q3   # 作为页面的新版本
```

发布之后它和普通页面一样，能搜索、能评论、能提建议、有版本。要更新时，把新文件导入到同一个页面，历史里会留着之前的文字和文件。

有编辑权限的人可以发布。其他人和智能体导入的内容，会等有权限的人确认。

## 能转换什么

| 格式 | 得到什么 |
| --- | --- |
| Word（`.docx`） | 标题、列表、强调、表格和图片 |
| Excel（`.xlsx`） | 每个工作表一张表格，每张最多 5000 行 |
| PowerPoint（`.pptx`） | 每张幻灯片一节，只有文字，没有图片和版式 |
| PDF | 按页提取文字，没有版式和图片 |
| HTML | 标题、列表、链接和表格 |
| CSV、TSV | 一张表格 |

扫描版 PDF 没有文字，会变成只有原文件的页面，导入结果会说明。旧版 Office 格式（`.doc`、`.xls`、`.ppt`）会被拒绝，并提示另存为新格式。这两种文件可以交给下面的转换服务。

转换在单独的线程里运行，有时间和内存限制，一个异常的文件只会让它自己导入失败。

## 接入更好的转换服务

内置转换处理不了扫描件和旧版 Office 文件。Pandocs 自带一个转换服务（仓库里的 `deploy/converter`）：旧版 Office 文件先用 LibreOffice 存成新格式，再交给 Docling 或 MarkItDown 转成 Markdown。

| 引擎 | 适合 | 代价 |
| --- | --- | --- |
| Docling | 识别扫描件里的文字，中文英文都可以；PDF 的标题、表格和图片 | 要多运行一个服务，镜像约 7 GB |
| MarkItDown | 只需要处理旧版 Office 文件 | 已经包含在转换服务里 |

用 Docker Compose 时，在 `.env` 里加上下面几行，再运行 `docker compose up -d`：

```bash
COMPOSE_PROFILES=converter,docling        # 不要 Docling 时只写 converter
DOCLING_URL=http://docling:5001           # 不要 Docling 时去掉这一行
PANDOCS_EXTRACT_URL=http://converter:8090/convert
PANDOCS_EXTRACT_FALLBACK=true             # 只把内置转换处理不了的文件交给它
```

设了 `PANDOCS_EXTRACT_FALLBACK=true`，只有扫描件和旧版 Office 文件交给转换服务，其他文件仍然用更快的内置转换。不设的话所有文件都交给它，适合希望每个 PDF 都认出标题和表格的情况。

### 自己写转换服务

请求体是文件内容，`Content-Type` 是文件类型，文件名经过 URL 编码放在 `X-Filename` 里，`Accept-Language` 是导入人的语言。服务返回 Markdown 文本，或者这样的 JSON：

```json
{
  "markdown": "# 标题\n\n![示意图](assets/<sha256>.png)",
  "title": "可选的标题",
  "warnings": ["可选的提示"],
  "files": [{ "path": "assets/<sha256>.png", "data": "<Base64 编码的图片>" }]
}
```

`files` 是从文件里取出的图片，名字要用图片内容的 SHA-256，Pandocs 会核对。返回 `4xx` 表示这个文件不可能成功，回答里 `error` 字段写的原因会告诉导入的人。其他失败会重试。
