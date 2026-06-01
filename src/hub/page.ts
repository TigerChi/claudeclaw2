export function hubPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ClaudeClaw Hub</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 12px 20px;
      border-bottom: 1px solid #30363d;
      display: flex;
      align-items: center;
      gap: 16px;
      background: #161b22;
    }
    header h1 { margin: 0; font-size: 16px; font-weight: 600; }
    header .status { color: #8b949e; font-size: 12px; }
    main { display: flex; flex: 1; overflow: hidden; }
    aside {
      width: 320px;
      border-right: 1px solid #30363d;
      overflow-y: auto;
      background: #0d1117;
    }
    aside h2 {
      margin: 0;
      padding: 12px 16px;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8b949e;
      border-bottom: 1px solid #30363d;
    }
    .agent {
      padding: 10px 16px;
      border-bottom: 1px solid #21262d;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .agent:hover { background: #161b22; }
    .agent.active { background: #1f2937; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: #f85149;
    }
    .dot.alive { background: #3fb950; }
    .agent .meta { flex: 1; min-width: 0; }
    .agent .path { font-size: 12px; color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent .sub { font-size: 11px; color: #8b949e; }
    .vbadge {
      display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px;
      margin-left: 4px; vertical-align: middle; font-weight: 600; letter-spacing: 0.3px;
    }
    .vbadge.v-v1 { background: #30363d; color: #8b949e; }
    .vbadge.v-v3 { background: #1f6feb; color: #fff; }
    section.detail {
      flex: 1;
      padding: 24px;
      overflow-y: auto;
    }
    .panel {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .panel h3 { margin: 0 0 8px; font-size: 13px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.04em; }
    .row { display: flex; gap: 16px; margin: 6px 0; }
    .row .label { width: 120px; color: #8b949e; font-size: 12px; }
    .row .value { color: #e6edf3; font-size: 13px; word-break: break-all; }
    button {
      background: #21262d;
      color: #e6edf3;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      margin-right: 8px;
    }
    button:hover { background: #30363d; }
    button.primary { background: #238636; border-color: #2ea043; }
    button.primary:hover { background: #2ea043; }
    button.danger { background: #6e2222; border-color: #8b3232; }
    button.danger:hover { background: #8b3232; }
    .empty { color: #8b949e; padding: 40px 20px; text-align: center; }
    .auth-prompt {
      max-width: 480px;
      margin: 80px auto;
      padding: 24px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
    }
    .auth-prompt input {
      width: 100%;
      padding: 8px 12px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      font-family: monospace;
      margin: 8px 0 12px;
    }
    pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; color: #8b949e; }
    code { background: #0d1117; padding: 2px 6px; border-radius: 4px; }
    .toolbar { margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
    .pair-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .pair-code {
      background: #161b22;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 13px;
      color: #58a6ff;
      letter-spacing: 0.5px;
    }
    .copy-btn { font-size: 11px; padding: 2px 10px; }
    .action-msg {
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 12px;
      transition: opacity 0.4s ease;
    }
    .action-msg.ok { background: #133626; color: #3fb950; border: 1px solid #1f6c40; }
    .action-msg.error { background: #3a1a1a; color: #f85149; border: 1px solid #6e2222; }
    .action-msg.fade { opacity: 0; }
    .header-msg {
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 6px;
      background: #133626;
      color: #3fb950;
      border: 1px solid #1f6c40;
    }
    .header-msg.error { background: #3a1a1a; color: #f85149; border-color: #6e2222; }
    .header-msg:empty { display: none; }

    /* Mobile: stack sidebar above detail, smaller header */
    @media (max-width: 768px) {
      header {
        flex-wrap: wrap;
        padding: 10px 14px;
        gap: 8px;
      }
      header h1 { font-size: 14px; }
      header .status { font-size: 11px; }
      header button { padding: 5px 10px; font-size: 11px; }
      main { flex-direction: column; }
      aside {
        width: 100%;
        max-height: 35vh;
        border-right: none;
        border-bottom: 1px solid #30363d;
      }
      section.detail { padding: 14px; }
      .row .label { width: 84px; font-size: 11px; }
      .row .value { font-size: 12px; }
      .toolbar { flex-wrap: wrap; }
      .toolbar .open-daemon { margin-left: 0 !important; }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
  (function () {
    // URL token bootstrap: if the page was opened with ?token=<plaintext>,
    // promote it to localStorage and strip from the URL so it doesn't linger
    // in browser history / referer headers. Pairs with the server's cookie+302
    // path (in case localStorage is unavailable / cleared).
    try {
      const params = new URLSearchParams(location.search);
      const urlToken = params.get("token");
      if (urlToken) {
        localStorage.setItem("claudeclaw_hub_token", urlToken);
        params.delete("token");
        const cleanQuery = params.toString();
        history.replaceState({}, "", location.pathname + (cleanQuery ? "?" + cleanQuery : ""));
      }
    } catch (e) { /* private mode / no localStorage — fall through */ }

    const state = {
      token: localStorage.getItem("claudeclaw_hub_token") || "",
      agents: [],
      selectedId: null,
      detail: null,
      error: null,
    };

    const root = document.getElementById("app");

    function authHeaders() {
      return state.token ? { Authorization: "Bearer " + state.token } : {};
    }

    async function api(path, opts) {
      opts = opts || {};
      const res = await fetch(path, {
        method: opts.method || "GET",
        headers: Object.assign({}, authHeaders(), opts.headers || {}),
        body: opts.body,
      });
      if (res.status === 401) {
        state.token = "";
        localStorage.removeItem("claudeclaw_hub_token");
        render();
        throw new Error("unauthorized");
      }
      return res;
    }

    async function refreshAgents() {
      try {
        const res = await api("/api/agents");
        const data = await res.json();
        state.agents = data.agents || [];
        if (!state.selectedId && state.agents.length > 0) {
          state.selectedId = state.agents[0].id;
        }
        await refreshDetail();
      } catch (e) {
        // ignore
      }
    }

    async function refreshDetail() {
      if (!state.selectedId) {
        state.detail = null;
        render();
        return;
      }
      const agent = state.agents.find((a) => a.id === state.selectedId);
      if (!agent || !agent.alive) {
        state.detail = { agent, state: null, jobs: null };
        render();
        return;
      }
      try {
        const [stateRes, jobsRes] = await Promise.all([
          api("/api/agents/" + agent.id + "/proxy/api/state"),
          api("/api/agents/" + agent.id + "/proxy/api/jobs"),
        ]);
        const stateData = stateRes.ok ? await stateRes.json() : null;
        const jobsData = jobsRes.ok ? await jobsRes.json() : null;
        state.detail = { agent, state: stateData, jobs: jobsData };
      } catch (e) {
        state.detail = { agent, state: null, jobs: null, error: String(e) };
      }
      render();
    }

    async function selectAgent(id) {
      state.selectedId = id;
      await refreshDetail();
    }

    async function actOnAgent(id, action, btn) {
      if (action === "copy-pair") {
        const text = btn ? btn.getAttribute("data-text") : "";
        await copyText(text, "✓ Pair code copied", "Copy your LINE pair code:");
        return;
      }
      const verb = action === "stop" ? "Stopping…" : action === "start" ? "Starting…" : "Restarting…";
      const orig = btn ? btn.textContent : "";
      // Disable all toolbar buttons while one is in flight
      const all = document.querySelectorAll(".toolbar [data-act]");
      all.forEach((b) => (b.disabled = true));
      if (btn) btn.textContent = verb;

      try {
        const res = await api("/api/agents/" + id + "/" + action, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        let msg;
        if (action === "stop") {
          msg = data.alreadyStopped
            ? "Already stopped"
            : "✓ Stopped" + (data.pid ? " (PID " + data.pid + ")" : "");
        } else if (action === "start") {
          msg = data.alreadyRunning
            ? "Already running" + (data.pid ? " (PID " + data.pid + ")" : "")
            : "✓ Started" + (data.pid ? " — PID " + data.pid : "");
        } else {
          msg = "✓ Restarted" + (data.pid ? " — new PID " + data.pid : "");
        }
        showActionMsg(msg, "ok");
        await refreshAgents();
      } catch (e) {
        showActionMsg("✗ Failed: " + (e && e.message ? e.message : e), "error");
      } finally {
        all.forEach((b) => (b.disabled = false));
        if (btn) btn.textContent = orig;
      }
    }

    function showActionMsg(text, kind) {
      const el = document.getElementById("action-msg");
      if (!el) return;
      el.className = "action-msg " + kind;
      el.textContent = text;
      // fade after 3s, clear after fade
      setTimeout(() => {
        if (el.textContent !== text) return;
        el.classList.add("fade");
        setTimeout(() => {
          if (el.textContent === text) {
            el.textContent = "";
            el.className = "action-msg";
          }
        }, 400);
      }, 3000);
    }

    function showHeaderMsg(text, kind) {
      const el = document.getElementById("header-msg");
      if (!el) return;
      el.className = "header-msg" + (kind === "error" ? " error" : "");
      el.textContent = text;
      setTimeout(() => {
        if (el.textContent === text) el.textContent = "";
      }, 3000);
    }

    async function restartAll() {
      const total = state.agents.length;
      if (total === 0) {
        showHeaderMsg("No agents to restart");
        return;
      }
      if (!window.confirm("Restart all " + total + " agent(s)? This may take 10–30 seconds.")) return;
      const btn = document.getElementById("restart-all");
      const orig = btn ? btn.textContent : "";
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Restarting…";
      }
      showHeaderMsg("Restarting all agents… (this may take a while)");
      try {
        const res = await api("/api/agents/restart-all", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        const results = data.results || [];
        const okCount = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok);
        if (failed.length === 0) {
          showHeaderMsg("✓ Restarted " + okCount + "/" + results.length);
        } else {
          showHeaderMsg("⚠ " + okCount + "/" + results.length + " ok, " + failed.length + " failed", "error");
        }
        await refreshAgents();
      } catch (e) {
        showHeaderMsg("✗ Failed: " + (e && e.message ? e.message : e), "error");
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = orig;
        }
      }
    }

    // Modern Clipboard API requires a secure context (https or localhost).
    // Tailscale plain HTTP isn't "secure" so we always carry a textarea
    // fallback, with window.prompt as a last-resort manual-copy.
    async function copyText(text, successMsg, promptLabel) {
      if (!text) return;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          showHeaderMsg(successMsg);
          return;
        }
      } catch (e) { /* fall through */ }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showHeaderMsg(successMsg);
      } catch (e) {
        window.prompt(promptLabel, text);
      }
    }

    async function copyToken() {
      await copyText(state.token, "✓ Token copied", "Copy your hub token:");
    }

    function fmtCountdown(ms) {
      if (ms <= 0) return "now";
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (h > 0) return h + "h " + m + "m";
      if (m > 0) return m + "m";
      return (s % 60) + "s";
    }

    // Each messaging channel reports as { configured: boolean, allowedUserCount: number }.
    // The previous truthy check on the object itself was always "on".
    function channelStatus(c) {
      if (!c || !c.configured) return "off";
      const n = c.allowedUserCount || 0;
      if (n === 0) return "on (all users)";
      return "on (" + n + " user" + (n !== 1 ? "s" : "") + ")";
    }

    function renderAuthPrompt() {
      root.innerHTML =
        '<div class="auth-prompt">' +
        '<h2>ClaudeClaw Hub</h2>' +
        '<p>Bearer token required. Run <code>claudeclaw hub init</code> on the host to generate one.</p>' +
        '<input id="tok" type="password" placeholder="Bearer token" />' +
        '<button class="primary" id="signin">Sign in</button>' +
        '</div>';
      document.getElementById("signin").onclick = () => {
        const v = document.getElementById("tok").value.trim();
        if (!v) return;
        state.token = v;
        localStorage.setItem("claudeclaw_hub_token", v);
        refreshAgents();
      };
      document.getElementById("tok").onkeydown = (e) => {
        if (e.key === "Enter") document.getElementById("signin").click();
      };
    }

    function render() {
      if (!state.token) {
        renderAuthPrompt();
        return;
      }

      const agents = state.agents;
      let aside = '<h2>Agents (' + agents.length + ')</h2>';
      if (agents.length === 0) {
        aside += '<div class="empty">No agents discovered.<br/>Start one with <code>claudeclaw start --detach</code> in any project.</div>';
      } else {
        for (const a of agents) {
          const name = (a.path || "").split("/").filter(Boolean).pop() || a.path;
          // Tag the daemon's plugin source; v3 (tmux engine) stands out vs
          // v1 default so it's obvious which agents have migrated.
          const version = a.version || "v1";
          const vBadge =
            '<span class="vbadge v-' + version + '" title="plugin source: ' + version + '">' + version + '</span>';
          aside +=
            '<div class="agent ' + (a.id === state.selectedId ? "active" : "") + '" data-id="' + a.id + '">' +
            '<span class="dot ' + (a.alive ? "alive" : "") + '"></span>' +
            '<div class="meta">' +
            '<div class="path" title="' + a.path + '">' + name + ' ' + vBadge + '</div>' +
            '<div class="sub">' + (a.alive ? ("PID " + a.pid + (a.web ? " — :" + a.web.port : "")) : "stopped") + '</div>' +
            '</div></div>';
        }
      }

      let detail = '';
      if (state.detail) {
        const { agent, state: agentState, jobs } = state.detail;
        const now = Date.now();
        detail =
          '<div class="toolbar">' +
          '<button class="primary" data-act="restart" data-id="' + agent.id + '">Restart</button>' +
          (agent.alive
            ? '<button class="danger" data-act="stop" data-id="' + agent.id + '">Stop</button>'
            : '<button data-act="start" data-id="' + agent.id + '">Start</button>') +
          '<div id="action-msg" class="action-msg"></div>' +
          (agent.alive && agent.web
            ? '<a target="_blank" class="open-daemon" href="/api/agents/' + agent.id + '/proxy/" style="margin-left:auto"><button>Open per-daemon UI</button></a>'
            : '') +
          '</div>' +
          '<div class="panel"><h3>Agent</h3>' +
          row("Path", agent.path) +
          row("ID", agent.id) +
          row("Version", agent.version || "v1") +
          row("Status", agent.alive ? "running" : "stopped") +
          row("PID", agent.pid != null ? String(agent.pid) : "—") +
          row("Web", agent.web ? agent.web.host + ":" + agent.web.port : "—") +
          row("Started", agent.startedAt ? new Date(agent.startedAt).toLocaleString() : "—") +
          '</div>';

        if (agent.linePairing) {
          const lp = agent.linePairing;
          const codeAttr = escapeAttr(lp.code);
          const codeHtml = escapeAttr(lp.code);
          const portPart = lp.webhookPort ? ":" + lp.webhookPort : "";
          const webhook = portPart + escapeAttr(lp.webhookPath || "");
          detail +=
            '<div class="panel"><h3>LINE Pairing</h3>' +
            '<div class="row"><div class="label">Code</div>' +
              '<div class="value pair-line">' +
                '<code class="pair-code">' + codeHtml + '</code>' +
                '<button class="copy-btn" data-act="copy-pair" data-id="' + agent.id + '" data-text="' + codeAttr + '">Copy</button>' +
              '</div>' +
            '</div>' +
            (webhook ? row("Webhook", '<code>' + webhook + '</code>') : "") +
            '</div>';
        }

        if (agentState) {
          const sec = agentState.security ? agentState.security.level || agentState.security : "";
          const hb = agentState.heartbeat;
          detail +=
            '<div class="panel"><h3>Heartbeat</h3>' +
            (hb && hb.enabled
              ? row("Status", "every " + (hb.intervalMinutes || hb.interval || "?") + "m") +
                row("Next", hb.nextAt ? fmtCountdown(hb.nextAt - now) : "—")
              : row("Status", "disabled")) +
            '</div>';

          detail +=
            '<div class="panel"><h3>Session</h3>' +
            row("Security", sec) +
            row("Telegram", channelStatus(agentState.telegram)) +
            row("Discord", channelStatus(agentState.discord)) +
            row("Slack", channelStatus(agentState.slack)) +
            row("LINE", channelStatus(agentState.line)) +
            '</div>';
        }

        if (jobs && jobs.jobs) {
          let jobRows = '';
          if (jobs.jobs.length === 0) jobRows = '<div class="row"><div class="value">No jobs configured.</div></div>';
          else {
            for (const j of jobs.jobs) {
              jobRows += row(j.name, (j.schedule || "") + " — " + (j.promptPreview || ""));
            }
          }
          detail += '<div class="panel"><h3>Cron Jobs (' + jobs.jobs.length + ')</h3>' + jobRows + '</div>';
        }

        if (!agent.alive) {
          detail += '<div class="panel"><h3>Notice</h3><div class="row"><div class="value">Daemon is stopped. Click Start to spawn it detached.</div></div></div>';
        }
      } else {
        detail = '<div class="empty">Select an agent on the left.</div>';
      }

      root.innerHTML =
        '<header>' +
        '<h1>🦞 ClaudeClaw Hub</h1>' +
        '<span class="status">' + agents.filter((a) => a.alive).length + ' alive / ' + agents.length + ' total</span>' +
        '<span id="header-msg" class="header-msg"></span>' +
        '<button id="restart-all" style="margin-left:auto" title="Stop and re-spawn every listed agent">↻ Restart all</button>' +
        '<button id="copy-token" title="Copy hub token to clipboard for sharing">🔑 Token</button>' +
        '<button id="refresh">Refresh</button>' +
        '<button id="signout">Sign out</button>' +
        '</header>' +
        '<main><aside>' + aside + '</aside><section class="detail">' + detail + '</section></main>';

      document.querySelectorAll(".agent").forEach((el) => {
        el.onclick = () => selectAgent(el.getAttribute("data-id"));
      });
      document.querySelectorAll("[data-act]").forEach((el) => {
        el.onclick = () => actOnAgent(el.getAttribute("data-id"), el.getAttribute("data-act"), el);
      });
      // Per-daemon UI opens in a new tab; browser navigation can't carry the
      // Authorization header, so plant a cookie that the hub server reads as
      // a fallback. SameSite=Lax is enough for same-origin top-level navigation.
      document.querySelectorAll(".open-daemon").forEach((el) => {
        el.addEventListener("click", () => {
          document.cookie = "claudeclaw_hub_token=" + encodeURIComponent(state.token) +
            "; path=/; SameSite=Lax";
        });
      });
      const refreshBtn = document.getElementById("refresh");
      if (refreshBtn) refreshBtn.onclick = () => refreshAgents();
      const signOut = document.getElementById("signout");
      if (signOut) signOut.onclick = () => {
        state.token = "";
        localStorage.removeItem("claudeclaw_hub_token");
        render();
      };
      const copyBtn = document.getElementById("copy-token");
      if (copyBtn) copyBtn.onclick = () => copyToken();
      const restartAllBtn = document.getElementById("restart-all");
      if (restartAllBtn) restartAllBtn.onclick = () => restartAll();
    }

    function row(label, value) {
      return '<div class="row"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
    }

    function escapeAttr(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    if (state.token) refreshAgents();
    render();
    setInterval(() => { if (state.token) refreshAgents(); }, 5000);
  })();
  </script>
</body>
</html>`;
}
