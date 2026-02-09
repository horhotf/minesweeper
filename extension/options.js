const SETTINGS_KEY = "ms-helper-settings";
const DEFAULT_SETTINGS = {
  efficiencyMode: false,
};

const efficiencyToggle = document.getElementById("efficiencyMode");

const loadSettings = async () => {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  efficiencyToggle.checked = settings.efficiencyMode;
};

const saveSettings = async () => {
  const settings = {
    efficiencyMode: efficiencyToggle.checked,
  };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
};

efficiencyToggle.addEventListener("change", saveSettings);

loadSettings();
