const vscode = require("vscode");
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
exports.activate = (context) => {
  const changed = new vscode.EventEmitter();
  const origin = () => {
    const url = new URL(
      vscode.workspace.getConfiguration("caelogram").get("serviceUrl"),
    );
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      throw new Error("Remote Caelogram services require HTTPS");
    return url.origin;
  };
  // Credentials are bound to an origin; changing workspace configuration cannot exfiltrate a previous service token.
  const key = () => "caelogram.token:" + origin();
  const request = async (path, body) => {
    const token = await context.secrets.get(key());
    if (!token) throw new Error("Run Caelogram: Connect session");
    const response = await fetch(origin() + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Caelogram returned " + response.status);
    return response.json();
  };
  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (r) => {
      const item = new vscode.TreeItem(
        r.name,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = r.files + " files · " + r.revision.slice(0, 8);
      item.command = {
        command: "caelogram.inspect",
        title: "Inspect repository",
        arguments: [r],
      };
      return item;
    },
    getChildren: async () => {
      try {
        return await request("/api/tools/list_repositories", {});
      } catch {
        return [];
      }
    },
  };
  context.subscriptions.push(
    changed,
    vscode.window.registerTreeDataProvider("caelogram.repositories", provider),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("caelogram.login", async () => {
      try {
        const token = await vscode.window.showInputBox({
          prompt: "Caelogram access token for " + origin(),
          password: true,
          ignoreFocusOut: true,
        });
        if (!token) return;
        await context.secrets.store(key(), token);
        await request("/api/tools/list_repositories", {});
        changed.fire();
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("caelogram.refresh", () => changed.fire()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("caelogram.inspect", async (repo) => {
      try {
        const map = await request("/api/tools/repository_map", {
            repoId: repo.id,
          }),
          history = await request(
            "/api/history/" + encodeURIComponent(repo.id),
          );
        const panel = vscode.window.createWebviewPanel(
          "caelogram.inspector",
          "Caelogram · " + repo.name,
          vscode.ViewColumn.Beside,
          { enableScripts: false, localResourceRoots: [] },
        );
        const link = origin() + "/?repo=" + encodeURIComponent(repo.id);
        panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:14px system-ui;padding:24px;line-height:1.7;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}h1{font-size:25px}h2{margin-top:30px}code{overflow-wrap:anywhere}article{border-top:1px solid var(--vscode-panel-border);padding:14px 0}a{color:var(--vscode-textLink-foreground)}</style></head><body><h1>${escape(repo.name)}</h1><p>${escape(repo.branch)} · <code>${escape(map.revision)}</code></p><p>${map.files} files · ${map.symbols} symbols · ${map.relationships} module relationships</p><a href="${escape(link)}">Open galaxy console ↗</a><h2>Tasks</h2>${history.tasks.map((t) => `<article><b>${escape(t.prompt)}</b><p>${t.estimatedTokens} estimated context tokens · ${escape(t.base.slice(0, 8))}</p></article>`).join("") || "<p>No tasks yet.</p>"}<h2>Changesets</h2>${history.changes.map((c) => `<article><b>${escape(c.title)}</b> · ${escape(c.status)}<p>${escape((c.paths || []).join(", "))}</p>${c.validation ? `<p>Static validation: ${c.validation.passed ? "passed" : "failed"}</p><p>${escape(c.validation.warnings.join(" "))}</p>` : ""}${c.pr ? `<p>Pull request #${Number(c.pr.number)}</p>` : ""}</article>`).join("") || "<p>No changesets yet.</p>"}<h2>Evidence limits</h2>${map.warnings.map((w) => `<p>${escape(w)}</p>`).join("")}</body></html>`;
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    }),
  );
};
