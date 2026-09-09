import { useState, useEffect } from "react";
import { fetchPipelines, pushPipelines, publishToGlobal } from "./github-api";
import "./index.css";

const REPO_OWNER = "kedharvishnu20";
const REPO_NAME  = "Verquill_Market_place";

function scrubCredentials(pipeline) {
  const copy = JSON.parse(JSON.stringify(pipeline));
  (copy.steps || []).forEach(step => {
    if (step.type === "SESSION")     step.cookies = [];
    if (step.type === "SET_HEADERS") step.headers = [];
  });
  delete copy.source;
  delete copy._displayId;
  return copy;
}

export default function App() {
  const [route, setRoute] = useState("registry");
  const [pipelines, setPipelines]   = useState([]);
  const [loading,   setLoading]     = useState(true);
  const [q,          setQ]          = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [sortBy,     setSortBy]     = useState("name");
  const [pat,        setPat]        = useState("");
  const [repoUrl,    setRepoUrl]    = useState(`https://github.com/${REPO_OWNER}/${REPO_NAME}.git`);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsLoaded,  setSettingsLoaded]  = useState(false);
  const [reviewModal,  setReviewModal]  = useState(false);
  const [reviewJson,   setReviewJson]   = useState("");
  const [reviewJsonErr, setReviewJsonErr] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace(/^#\//, "") || "registry";
      setRoute(hash.split("/")[0]);
    };
    window.addEventListener("hashchange", handleHash);
    handleHash();
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  useEffect(() => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get(["fs_github_pat", "fs_github_repo"], (res) => {
        if (res.fs_github_pat)  setPat(res.fs_github_pat);
        if (res.fs_github_repo) setRepoUrl(res.fs_github_repo);
        setSettingsLoaded(true);
      });
    } else {
      setSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (settingsLoaded) loadData(pat, repoUrl);
  }, [settingsLoaded]);

  const loadData = async (effectivePat = pat, effectiveRepo = repoUrl) => {
    setLoading(true);
    const all = [];

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get(null);
        Object.keys(stored)
          .filter(k => k.startsWith("fs_active_pipeline"))
          .forEach(k => {
            const p = stored[k];
            if (p && typeof p === "object" && Array.isArray(p.steps)) {
              if (!p.id)   p.id   = k;
              if (!p.name) p.name = "Untitled Pipeline";
              const short = p.id.replace(/^(local_)?fs_active_pipeline_?/, "");
              p._displayId = short ? `#${short.slice(-6)}` : "#local";
              p.source = "local";
              if (!all.find(x => x.id === p.id)) all.push(p);
            }
          });
      } catch (_) {}
    }

    if (effectivePat && effectiveRepo) {
      try {
        const github = await fetchPipelines(effectiveRepo, effectivePat);
        github.forEach(p => {
          p.source = "github";
          p._displayId = p.id;
          if (!all.find(x => x.id === p.id && x.source === "github")) all.push(p);
        });
      } catch (e) {
        console.warn("GitHub fetch failed:", e.message);
      }
    }

    try {
      const globalUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/global/registry.json`;
      const res = await fetch(globalUrl);
      if (res.ok) {
        const global = await res.json();
        global.forEach(p => {
          p.source = "global";
          p._displayId = p.id;
          if (!all.find(x => x.id === p.id && x.source === "global")) all.push(p);
        });
      }
    } catch (_) {}

    setPipelines(all);
    setLoading(false);
  };

  const saveSettings = () => {
    setSavingSettings(true);
    const done = () => { setSavingSettings(false); loadData(pat, repoUrl); };
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ fs_github_pat: pat, fs_github_repo: repoUrl }, done);
    } else {
      setTimeout(done, 400);
    }
  };

  const handleLoad = (p) => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const copy = scrubCredentials(p);
      chrome.storage.local.set({ fs_marketplace_load: copy }, () => showToast("Pipeline loaded into sidepanel."));
    } else {
      showToast("Load only works inside the Chrome Extension.", "err");
    }
  };

  const handlePushToGitHub = async (p) => {
    if (!repoUrl || !pat) return showToast("Configure GitHub in Sync Settings first.", "err");
    try {
      const current = await fetchPipelines(repoUrl, pat);
      const copy = scrubCredentials(p);
      const idx = current.findIndex(x => x.id === copy.id);
      if (idx >= 0) current[idx] = copy; else current.push(copy);
      await pushPipelines(repoUrl, pat, current);
      showToast(`"${p.name}" pushed to GitHub.`);
      loadData(pat, repoUrl);
    } catch (e) {
      showToast("Push failed: " + e.message, "err");
    }
  };

  const handleSaveLocally = (p) => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const copy = scrubCredentials(p);
      const key  = `fs_active_pipeline_saved_${copy.id || Date.now()}`;
      chrome.storage.local.set({ [key]: copy }, () => {
        showToast("Saved locally.");
        loadData(pat, repoUrl);
      });
    } else {
      showToast("Only works inside the Chrome Extension.", "err");
    }
  };

  const handleRemove = async (p) => {
    if (!window.confirm(`Remove "${p.name}" from your GitHub library?`)) return;
    if (!repoUrl || !pat) return showToast("Configure GitHub in Sync Settings first.", "err");
    try {
      const current = await fetchPipelines(repoUrl, pat);
      await pushPipelines(repoUrl, pat, current.filter(x => x.id !== p.id));
      showToast(`"${p.name}" removed.`);
      loadData(pat, repoUrl);
    } catch (e) {
      showToast("Remove failed: " + e.message, "err");
    }
  };

  const openPublishModal = (p) => {
    if (!pat) return showToast("Configure GitHub in Sync Settings first.", "err");
    setReviewJson(JSON.stringify(scrubCredentials(p), null, 2));
    setReviewJsonErr(null);
    setReviewModal(true);
  };

  const confirmPublish = async () => {
    let parsed;
    try { parsed = JSON.parse(reviewJson); setReviewJsonErr(null); }
    catch (e) { setReviewJsonErr("Invalid JSON: " + e.message); return; }
    try {
      setReviewModal(false);
      showToast("Opening Pull Request...");
      await publishToGlobal(REPO_OWNER, REPO_NAME, pat, parsed);
      showToast("Pull Request created successfully.");
    } catch (e) {
      showToast("Publish failed: " + e.message, "err");
    }
  };

  const sourceOrder = { local: 0, github: 1, global: 2 };
  const display = pipelines
    .filter(p => {
      if (sourceFilter !== "all" && p.source !== sourceFilter) return false;
      if (!q) return true;
      const s = q.toLowerCase();
      return (p.name || "").toLowerCase().includes(s) ||
             (p.id   || "").toLowerCase().includes(s) ||
             (p.author || "").toLowerCase().includes(s) ||
             (p.description || p.desc || "").toLowerCase().includes(s);
    })
    .sort((a, b) => {
      if (sortBy === "source") return (sourceOrder[a.source] ?? 9) - (sourceOrder[b.source] ?? 9);
      if (sortBy === "steps")  return (b.steps?.length || 0) - (a.steps?.length || 0);
      return (a.name || "").localeCompare(b.name || "");
    });

  const SOURCE_LABEL = { local: "LOCAL", github: "GITHUB", global: "GLOBAL" };

  return (
    <>
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 2000,
          fontFamily: "var(--mono)", fontSize: "12px", padding: "10px 16px",
          background: toast.type === "err" ? "#ef5350" : "var(--panel)",
          color: toast.type === "err" ? "#fff" : "var(--ink)",
          border: "1px solid var(--line)", letterSpacing: "0.06em",
          boxShadow: "var(--shadow-fly)",
        }}>{toast.msg}</div>
      )}

      {reviewModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.9)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--line)", background: "var(--panel)", display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--amber)", flex: 1 }}>
              Review Pipeline · Confirm Before Publishing
            </span>
            <button className="btn" onClick={() => setReviewModal(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={confirmPublish}>Confirm Publish</button>
          </div>
          <div style={{ padding: "10px 24px", background: "rgba(239,83,80,0.08)", borderBottom: "1px solid rgba(239,83,80,0.25)", fontFamily: "var(--mono)", fontSize: "11px", color: "#ef5350", letterSpacing: "0.04em" }}>
            Caution · We tried our best to strip credentials. Verify the JSON below and remove anything sensitive before confirming.
          </div>
          {reviewJsonErr && (
            <div style={{ padding: "6px 24px", background: "rgba(239,83,80,0.15)", fontFamily: "var(--mono)", fontSize: "11px", color: "#ef5350" }}>{reviewJsonErr}</div>
          )}
          <textarea
            value={reviewJson}
            onChange={e => { setReviewJson(e.target.value); setReviewJsonErr(null); }}
            spellCheck={false}
            style={{ flex: 1, width: "100%", resize: "none", fontFamily: "var(--mono)", fontSize: "13px", lineHeight: 1.65, background: "var(--void)", color: "var(--ink)", border: "none", outline: "none", padding: "20px 24px", tabSize: 2 }}
          />
          <div style={{ padding: "14px 24px", borderTop: "1px solid var(--line)", background: "var(--panel)", display: "flex", justifyContent: "flex-end", gap: 12 }}>
            <button className="btn" onClick={() => setReviewModal(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={confirmPublish}>Confirm Publish</button>
          </div>
        </div>
      )}

      <header className="masthead">
        <div className="masthead-in">
          <a className="wordmark" href="#/registry"><b>VERQUILL</b><span>Registry</span></a>
          <nav className="mainnav" id="nav">
            <a href="#/registry" className={route === "registry" ? "on" : ""}>Marketplace</a>
            <a href="#/settings" className={route === "settings" ? "on" : ""}>Sync Settings</a>
          </nav>
        </div>
      </header>

      <main>
        {route === "registry" ? (
          <>
            <div className="head">
              <div className="eyebrow">Marketplace</div>
              <h1>Manage your <em>pipelines</em>.</h1>
              <p className="lede">All pipelines across local storage, your GitHub library, and the global community.</p>
            </div>

            <div className="toolbar" style={{ marginTop: 18 }}>
              <input className="field" id="q" placeholder="Search name, author, or id" value={q} onChange={e => setQ(e.target.value)} />
              <div className="chipset">
                {[["all","All"],["local","Local"],["github","My GitHub"],["global","Global"]].map(([val, label]) => (
                  <button key={val} className={`chip ${sourceFilter === val ? "on" : ""}`} onClick={() => setSourceFilter(val)}>{label}</button>
                ))}
              </div>
              <select className="btn" value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ cursor: "pointer" }}>
                <option value="name">Sort: Name</option>
                <option value="source">Sort: Source</option>
                <option value="steps">Sort: Steps</option>
              </select>
              <button className="btn" onClick={() => loadData(pat, repoUrl)}>Refresh</button>
            </div>

            <div className="rows-head">
              <div>Source</div><div>Pipeline</div><div></div><div>Actions</div>
            </div>
            <div className="rows">
              {loading ? (
                <div className="empty">Loading...</div>
              ) : display.length === 0 ? (
                <div className="empty" style={{ textAlign: "center", padding: "48px 0" }}>
                  <div style={{ marginBottom: 10 }}>No pipelines found.</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 360, margin: "0 auto", lineHeight: 1.7 }}>
                    {sourceFilter === "local" ? "Build a pipeline in the Verquill sidepanel — it will appear here automatically."
                    : sourceFilter === "github" ? "Configure your GitHub token in Sync Settings to load your personal repository."
                    : sourceFilter === "global" ? "The global community registry is empty or unreachable."
                    : "Build a pipeline in the sidepanel, or configure GitHub sync to see your library here."}
                  </div>
                </div>
              ) : display.map(p => (
                <div key={`${p.source}::${p.id}`} className="row">
                  <div className="partno">
                    <div style={{ fontFamily: "var(--mono)", fontSize: "9px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--dim)", marginBottom: 4 }}>
                      {SOURCE_LABEL[p.source] || p.source}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--muted)", wordBreak: "break-all" }}>
                      {p._displayId || p.id}
                    </div>
                  </div>
                  <div>
                    <div className="row-name">{p.name || "Untitled Pipeline"}</div>
                    {(p.description || p.desc) && <div className="row-meta">{p.description || p.desc}</div>}
                    {p.author && <div className="row-meta" style={{ marginTop: 3 }}>by {p.author}</div>}
                    {p.steps?.length > 0 && <div className="row-meta" style={{ marginTop: 3 }}>{p.steps.length} step{p.steps.length !== 1 ? "s" : ""}</div>}
                  </div>
                  <div />
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {p.source === "local" && <>
                      <button className="btn btn-primary" onClick={() => handleLoad(p)}>Load</button>
                      <button className="btn" onClick={() => handlePushToGitHub(p)}>Push to GitHub</button>
                      <button className="btn" onClick={() => openPublishModal(p)}>Publish</button>
                    </>}
                    {p.source === "github" && <>
                      <button className="btn btn-primary" onClick={() => handleLoad(p)}>Run Now</button>
                      <button className="btn" onClick={() => openPublishModal(p)}>Publish</button>
                      <button className="btn" onClick={() => handleRemove(p)}>Remove</button>
                    </>}
                    {p.source === "global" && <>
                      <button className="btn btn-primary" onClick={() => handleLoad(p)}>Run Now</button>
                      <button className="btn" onClick={() => handlePushToGitHub(p)}>Save to GitHub</button>
                      <button className="btn" onClick={() => handleSaveLocally(p)}>Save Locally</button>
                    </>}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : route === "settings" ? (
          <div style={{ padding: "40px 0", maxWidth: 440 }}>
            <div className="eyebrow" style={{ marginBottom: 20 }}>Sync Settings</div>
            <h2 style={{ fontSize: 20, marginBottom: 8 }}>GitHub Configuration</h2>
            <p className="prose" style={{ marginBottom: 24 }}>
              Connect your personal GitHub repository to push and pull your pipelines.
              Requires a Fine-Grained PAT with <strong>Contents: Read &amp; Write</strong> and <strong>Pull Requests: Read &amp; Write</strong>.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ fontFamily: "var(--mono)", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--dim)" }}>Personal Access Token</label>
              <input type="password" className="field" value={pat} onChange={e => setPat(e.target.value)} placeholder="github_pat_xxxxxxxxxxxxxxxx" style={{ width: "100%" }} />
              <label style={{ fontFamily: "var(--mono)", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--dim)", marginTop: 8 }}>Repository URL</label>
              <input type="text" className="field" value={repoUrl} onChange={e => setRepoUrl(e.target.value)} placeholder="https://github.com/username/repo.git" style={{ width: "100%" }} />
              <button className="btn btn-primary" onClick={saveSettings} disabled={savingSettings} style={{ marginTop: 16, alignSelf: "flex-start" }}>
                {savingSettings ? "Saving..." : "Save & Sync"}
              </button>
            </div>
          </div>
        ) : <div className="empty">Not found.</div>}
      </main>

      <footer>
        <span>Verquill Registry · pipelines are reviewed, not trusted</span>
        <span>MIT · no account · no tracking</span>
      </footer>
    </>
  );
}
