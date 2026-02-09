const STORAGE_KEY = "efficiencyMode";

const toggle = document.getElementById("efficiencyToggle");

chrome.storage.sync.get({ [STORAGE_KEY]: false }, (data) => {
  toggle.checked = Boolean(data[STORAGE_KEY]);
});

toggle.addEventListener("change", () => {
  chrome.storage.sync.set({ [STORAGE_KEY]: toggle.checked });
});
