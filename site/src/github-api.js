// github-api.js

function getRepoInfo(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) throw new Error("Invalid GitHub URL");
  return { owner: match[1], repo: match[2] };
}

export async function fetchPipelines(repoUrl, pat) {
  if (!repoUrl) return [];
  const { owner, repo } = getRepoInfo(repoUrl);
  const headers = { "Accept": "application/vnd.github.v3+json" };
  if (pat) headers["Authorization"] = `token ${pat}`;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/registry.json`, { headers });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return JSON.parse(atob(data.content.replace(/\s/g, "")));
}

export async function pushPipelines(repoUrl, pat, pipelines) {
  if (!repoUrl || !pat) throw new Error("Repo URL and PAT required to push");
  const { owner, repo } = getRepoInfo(repoUrl);
  const headers = {
    "Accept": "application/vnd.github.v3+json",
    "Authorization": `token ${pat}`,
    "Content-Type": "application/json"
  };
  let sha;
  const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/registry.json`, { headers });
  if (getRes.ok) sha = (await getRes.json()).sha;
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(pipelines, null, 2))));
  const body = { message: "Update registry.json from Verquill extension", content };
  if (sha) body.sha = sha;
  const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/registry.json`, {
    method: "PUT", headers, body: JSON.stringify(body)
  });
  if (!putRes.ok) {
    const err = await putRes.json();
    throw new Error(err.message || "Push failed");
  }
  return putRes.json();
}

/**
 * Publish directly to global/registry.json in the same repo.
 * No fork needed — the user owns this repo.
 */
export async function publishToGlobal(repoOwner, repoName, pat, pipeline) {
  const headers = {
    "Accept": "application/vnd.github.v3+json",
    "Authorization": `token ${pat}`,
    "Content-Type": "application/json"
  };

  // 1. Get caller identity
  const userRes = await fetch("https://api.github.com/user", { headers });
  if (!userRes.ok) throw new Error("Could not verify GitHub identity. Check your PAT.");
  const user = await userRes.json();
  pipeline.author = user.login;

  // 2. Fetch existing global/registry.json (404 is fine — first publish)
  let sha;
  let registry = [];
  const getRes = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/contents/global/registry.json`,
    { headers }
  );
  if (getRes.ok) {
    const d = await getRes.json();
    sha = d.sha;
    registry = JSON.parse(atob(d.content.replace(/\s/g, "")));
  } else if (getRes.status !== 404) {
    throw new Error("Could not read global registry. Check repo permissions (Contents: Read & Write required).");
  }

  // 3. Upsert pipeline
  const idx = registry.findIndex(p => p.id === pipeline.id);
  if (idx >= 0) registry[idx] = pipeline; else registry.push(pipeline);

  // 4. Commit
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(registry, null, 2))));
  const body = { message: `Publish pipeline: ${pipeline.name} by @${user.login}`, content };
  if (sha) body.sha = sha;

  const putRes = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/contents/global/registry.json`,
    { method: "PUT", headers, body: JSON.stringify(body) }
  );
  if (!putRes.ok) {
    const err = await putRes.json();
    throw new Error(err.message || "Failed to publish to global registry");
  }
  return putRes.json();
}
