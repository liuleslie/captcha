const statusEl = document.getElementById("status");

document.getElementById("accept-btn").addEventListener("click", async () => {
  await browser.storage.local.set({ consented: true });
  statusEl.textContent = "Consent saved. You can close this tab.";
  statusEl.style.display = "block";
  statusEl.style.color = "#16a34a";
});

document.getElementById("decline-btn").addEventListener("click", async () => {
  await browser.storage.local.set({ consented: false });
  statusEl.textContent = "Recording disabled. Click the toolbar button to revisit this choice.";
  statusEl.style.display = "block";
  statusEl.style.color = "#b45309";
});