/* QuickMail settings popup
 * Lets the user save their OpenAI API key into chrome.storage.sync.
 * The key is never logged; the input is masked by default.
 */
(function () {
  "use strict";

  const input = document.getElementById("apiKey");
  const saveBtn = document.getElementById("saveKey");
  const toggleBtn = document.getElementById("toggleVisibility");
  const status = document.getElementById("status");

  function setStatus(message, isError) {
    status.textContent = message || "";
    status.classList.toggle("quickmail-error", !!isError);
  }

  // Load any existing settings on open.
  chrome.storage.sync.get(["openaiApiKey"], (result) => {
    if (result && result.openaiApiKey) {
      input.value = result.openaiApiKey;
      setStatus("Settings are already saved.", false);
    }
  });

  toggleBtn.addEventListener("click", () => {
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    toggleBtn.textContent = isHidden ? "Hide" : "Show";
  });

  saveBtn.addEventListener("click", () => {
    const key = input.value.trim();

    if (!key) {
      setStatus("Please enter an API key.", true);
      return;
    }
    if (!key.startsWith("sk-")) {
      setStatus('That doesn\'t look like an OpenAI key (it should start with "sk-").', true);
      return;
    }

    chrome.storage.sync.set(
      { openaiApiKey: key },
      () => {
        if (chrome.runtime.lastError) {
          setStatus("Could not save settings. Please try again.", true);
          return;
        }
        setStatus("Saved! You're ready to write with AI in Gmail.", false);
      }
    );
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveBtn.click();
    }
  });
})();
