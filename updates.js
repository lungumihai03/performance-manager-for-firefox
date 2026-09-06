(async () => {
  const el = document.querySelector("#updates");
  try {
    const data = await fetch("updates.json").then((r) => r.json());
    el.innerHTML = data.releases
      .map(
        (r, i) =>
          `<article class="release ${i === 0 ? "latest" : ""}"><div class="release-meta"><span>v${r.version}</span><time>${new Date(r.date + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</time>${i === 0 ? "<b>Latest</b>" : ""}</div><h2>${r.title}</h2><p>${r.summary}</p><ul>${r.changes.map((c) => `<li>${c}</li>`).join("")}</ul></article>`,
      )
      .join("");
  } catch (e) {
    el.innerHTML = "<p>Unable to load the update history.</p>";
  }
})();
