---
title: Pandocs docs
pageType: home
hero:
  name: Pandocs
  image:
    src: /logo.svg
    alt: Pandocs
  text: People and agents, on the same page
  tagline: One versioned source with two ways in. People work on the web, agents work with files and tools.
  actions:
    - theme: brand
      text: Five-minute start
      link: ./start
    - theme: alt
      text: See the blocks
      link: ./writing/blocks
features:
  - title: A site that is live when you save
    details: Write Markdown, with nothing to rebuild. Pages leave the server finished, with a real 404, a sitemap and share cards.
    icon: 📄
    link: ./writing/blocks
    span: 4
  - title: Collaboration on the page
    details: Select text to comment, suggest edits, accept them piece by piece, and go back through every version. Everyone editing a page shares one draft.
    icon: 💬
    link: ./collaboration/comments
    span: 4
  - title: Made for agents too
    details: MCP, a command line, an API and llms.txt. Agents read, comment and propose while a person decides, and never get more than their owner.
    icon: 🤖
    link: ./agents/connect
    span: 4
  - title: Answers from your documents
    details: Ask AI finds and reads pages with the permissions of whoever is asking, and links what it says to them. No vector database, and any model with tool calls.
    icon: 🔎
    link: ./ai
    span: 4
  - title: Files, without a second source of truth
    details: Sync a space to disk and commit edits back, or publish to a shared file system for sandboxes to mount. What is in the database is what counts.
    icon: 🗂️
    link: ./agents/files
    span: 4
  - title: Runs where you run things
    details: PostgreSQL plus anything speaking the S3 API. Sign in through OIDC or OAuth2, and scale out by adding replicas.
    icon: 🚀
    link: ./running/deploy
    span: 4
---
