# @pandocs/embed

Puts a Pandocs page inside another web app, with reading, comments and suggestions working as they do on the site.

```ts
import "@pandocs/embed";

const page = document.createElement("pandocs-doc");
page.setAttribute("server", "https://docs.example.com");
page.setAttribute("app", "helpdesk");
page.setAttribute("space", "handbook");
page.setAttribute("path", "getting-started");
page.getToken = async () => (await fetch("/your/pandocs-token")).text();
document.body.append(page);
```

In React:

```tsx
import { PandocsDoc } from "@pandocs/embed/react";

<PandocsDoc server="https://docs.example.com" app="helpdesk" space="handbook" path="getting-started" getToken={getToken} style={{ height: 600 }} />;
```

`getToken` asks your own server, which trades your app's secret for a short-lived token for this person. See [Embedding pages in another system](https://github.com/wusongbuaa/pandocs/blob/main/docs/embedding.md) for how to set that up.
