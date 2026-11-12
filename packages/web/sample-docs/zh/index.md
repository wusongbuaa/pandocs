---
title: Pandocs 文档
pageType: home
hero:
  name: Pandocs
  image:
    src: /logo.svg
    alt: Pandocs
  text: 人和智能体，同页协作
  tagline: 一份带版本的文档，两个入口：人在网页上协作，智能体通过文件和工具协作。
  actions:
    - theme: brand
      text: 五分钟上手
      link: ./start
    - theme: alt
      text: 看看内容块
      link: ./writing/blocks
features:
  - title: 改完就生效的文档站
    details: 写的是 Markdown，不用重新构建。页面从服务端出来就是完整的，有真正的 404、站点地图和分享卡片。
    icon: 📄
    link: ./writing/blocks
    span: 4
  - title: 在页面上协作
    details: 划词评论、提修改建议、逐条接受，每个版本都能回看。多人编辑同一页时共用一份草稿。
    icon: 💬
    link: ./collaboration/comments
    span: 4
  - title: 也为智能体而做
    details: MCP、命令行、接口和 llms.txt。智能体能读、能评论、能提建议，保存由人决定，权限不超过它的主人。
    icon: 🤖
    link: ./agents/connect
    span: 4
  - title: 从文档里找答案
    details: 智能问答按提问人的权限查找和阅读页面，回答都链接到来源。不需要向量库，任何支持工具调用的模型都能用。
    icon: 🔎
    link: ./ai
    span: 4
  - title: 有文件，但只有一个事实源
    details: 把空间同步到本地修改再提交回来，或发布到共享文件系统给沙箱只读挂载。数据库里的才算数。
    icon: 🗂️
    link: ./agents/files
    span: 4
  - title: 部署在你的环境里
    details: 只需要 PostgreSQL 和兼容 S3 接口的存储。支持 OIDC 和 OAuth2 登录，副本可以直接横向扩容。
    icon: 🚀
    link: ./running/deploy
    span: 4
---
