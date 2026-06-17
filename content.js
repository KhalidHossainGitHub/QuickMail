/* QuickMail content script
 * Injects a "Write with AI" button into Gmail compose toolbars,
 * reads the visible thread for context, and asks OpenAI for a reply.
 *
 * Security notes:
 * - The OpenAI API key is read from chrome.storage.sync immediately before
 *   each request and is never logged or written to the DOM.
 * - All user- and model-provided text is inserted via DOM text nodes
 *   (never innerHTML), so it cannot inject markup or scripts.
 */
(function () {
  "use strict";

  const PROCESSED_FLAG = "data-quickmail-ready";
  const LOGO_URL = chrome.runtime.getURL("public/QuickMail-icon.png");
  const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
  const MODEL = "gpt-4o";
  const MAX_CONTEXT_CHARS = 6000;

  function createLogo(sizeClass) {
    const img = document.createElement("img");
    img.className = "quickmail-logo" + (sizeClass ? " " + sizeClass : "");
    img.src = LOGO_URL;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.draggable = false;
    return img;
  }

  function createSubjectIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("quickmail-subject-icon");

    const titleLine = document.createElementNS(ns, "path");
    titleLine.setAttribute("d", "M6 7.5h12");
    titleLine.setAttribute("fill", "none");
    titleLine.setAttribute("stroke", "currentColor");
    titleLine.setAttribute("stroke-linecap", "round");
    titleLine.setAttribute("stroke-width", "1.8");

    const bodyLineOne = document.createElementNS(ns, "path");
    bodyLineOne.setAttribute("d", "M6 12h9");
    bodyLineOne.setAttribute("fill", "none");
    bodyLineOne.setAttribute("stroke", "currentColor");
    bodyLineOne.setAttribute("stroke-linecap", "round");
    bodyLineOne.setAttribute("stroke-width", "1.8");

    const bodyLineTwo = document.createElementNS(ns, "path");
    bodyLineTwo.setAttribute("d", "M6 16.5h6");
    bodyLineTwo.setAttribute("fill", "none");
    bodyLineTwo.setAttribute("stroke", "currentColor");
    bodyLineTwo.setAttribute("stroke-linecap", "round");
    bodyLineTwo.setAttribute("stroke-width", "1.8");

    const sparkle = document.createElementNS(ns, "path");
    sparkle.setAttribute("d", "M18 13.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8.8-1.7z");
    sparkle.setAttribute("fill", "currentColor");

    svg.appendChild(titleLine);
    svg.appendChild(bodyLineOne);
    svg.appendChild(bodyLineTwo);
    svg.appendChild(sparkle);
    return svg;
  }

  function autoResizeTextarea(textarea, maxHeight) {
    const limit = maxHeight || 180;
    const minHeight = 40;
    textarea.style.height = "0px";
    const nextHeight = Math.max(textarea.scrollHeight, minHeight);
    const height = Math.min(nextHeight, limit);
    textarea.style.height = height + "px";
    textarea.style.overflowY = nextHeight > limit ? "auto" : "hidden";
  }

  function repositionPopover(popover, anchorButton) {
    if (!popover || !anchorButton || !anchorButton.isConnected) return;

    const rect = anchorButton.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let top = rect.top - popRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    let left = rect.left;
    if (left + popRect.width > window.innerWidth - 8) {
      left = window.innerWidth - popRect.width - 8;
    }
    if (left < 8) left = 8;
    popover.style.top = top + "px";
    popover.style.left = left + "px";
  }

  function isAnchorInViewport(anchorButton) {
    if (!anchorButton || !anchorButton.isConnected) return false;
    const rect = anchorButton.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  /* ----------------------------- key storage ----------------------------- */

  function getQuickMailSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(["openaiApiKey"], (result) => {
          resolve({
            apiKey: (result && result.openaiApiKey) || "",
          });
        });
      } catch (e) {
        resolve({ apiKey: "" });
      }
    });
  }

  /* --------------------------- thread extraction -------------------------- */

  function getThreadContext() {
    const parts = [];

    const subjectEl = document.querySelector("h2.hP");
    if (subjectEl && subjectEl.textContent.trim()) {
      parts.push("Subject: " + subjectEl.textContent.trim());
    }

    // Gmail renders each message body inside ".a3s".
    const messages = document.querySelectorAll("div.a3s");
    messages.forEach((msg) => {
      const text = (msg.innerText || msg.textContent || "").trim();
      if (text) parts.push(text);
    });

    let context = parts.join("\n\n---\n\n").trim();
    if (context.length > MAX_CONTEXT_CHARS) {
      // Keep the most recent content (end of the thread) which is most relevant.
      context = context.slice(context.length - MAX_CONTEXT_CHARS);
    }
    return context;
  }

  /* --------------------------- compose helpers ---------------------------- */

  const COMPOSE_BODY_SELECTORS = [
    'div[aria-label="Message Body"][contenteditable="true"]',
    'div[g_editable="true"][contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][g_editable="true"]',
    'div.Am[contenteditable="true"]',
  ].join(", ");

  const SUBJECT_INPUT_SELECTORS = [
    'input[name="subjectbox"]',
    'input[aria-label="Subject"]',
    'input[placeholder="Subject"]',
  ].join(", ");

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isSendButton(el) {
    if (!el) return false;
    const role = el.getAttribute("role");
    const tag = el.tagName;
    if (role !== "button" && tag !== "BUTTON") return false;
    const label = (
      el.getAttribute("aria-label") ||
      el.getAttribute("data-tooltip") ||
      el.textContent ||
      ""
    ).trim();
    return /^Send(\s|$)/i.test(label) && !/schedule/i.test(label);
  }

  function findSendButton(root) {
    if (!root) return null;
    const nodes = root.querySelectorAll('[role="button"], button, [data-tooltip]');
    for (let i = 0; i < nodes.length; i++) {
      if (isSendButton(nodes[i])) return nodes[i];
    }
    return null;
  }

  function findComposeRoot(body) {
    let node = body.parentElement;
    while (node && node !== document.body) {
      const sendBtn = findSendButton(node);
      if (sendBtn) return { root: node, sendBtn: sendBtn, body: body };
      node = node.parentElement;
    }
    return null;
  }

  function findComposeBodies() {
    const seen = new Set();
    const bodies = [];
    document.querySelectorAll(COMPOSE_BODY_SELECTORS).forEach((el) => {
      if (seen.has(el) || !isVisible(el)) return;
      seen.add(el);
      bodies.push(el);
    });
    return bodies;
  }

  function cleanParticipantText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/^To\s*/i, "")
      .trim();
  }

  function nameFromParticipant(value) {
    const rawText = cleanParticipantText(value).replace(/["<>]/g, "").trim();
    if (!rawText) return "";

    const withoutEmail = rawText
      .replace(/\([^)]*@[a-z0-9.-]+\.[a-z]{2,}[^)]*\)/gi, "")
      .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "")
      .trim();

    const text = (withoutEmail || rawText)
      .replace(/["<>]/g, "")
      .replace(/\([^)]*\)/g, "")
      .trim();

    if (!text) return "";

    const candidate = text.replace(/[,:;]+$/g, "").trim();
    if (!candidate || candidate.includes("@")) return "";

    return candidate;
  }

  function firstNameFrom(value) {
    const name = nameFromParticipant(value);
    if (name) return name.split(/\s+/)[0].replace(/[^a-zA-Z'-]/g, "");

    const emailMatch = String(value || "").match(
      /([a-z0-9._%+-]+)@[a-z0-9.-]+\.[a-z]{2,}/i
    );
    if (!emailMatch) return "";

    const localPart = emailMatch[1].split(/[._+-]/)[0];
    if (!localPart) return "";
    return localPart.charAt(0).toUpperCase() + localPart.slice(1);
  }

  function getComposeRootFromBody(composeBody) {
    const ctx = findComposeRoot(composeBody);
    return (
      composeBody.closest('[role="dialog"]') ||
      composeBody.closest("div.btC") ||
      (ctx && ctx.root) ||
      composeBody.parentElement
    );
  }

  function getComposeSubjectInput(composeBody) {
    const root = getComposeRootFromBody(composeBody);
    if (!root) return null;

    const input = root.querySelector(SUBJECT_INPUT_SELECTORS);
    return input && isVisible(input) ? input : null;
  }

  function getComposeSubject(composeBody) {
    const input = getComposeSubjectInput(composeBody);
    return input ? input.value.trim() : "";
  }

  function insertSubjectIntoCompose(composeBody, subject) {
    const input = getComposeSubjectInput(composeBody);
    const cleanSubject = String(subject || "").trim();
    if (!input || !cleanSubject) return;

    input.focus();
    input.value = cleanSubject;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getComposeMode(composeBody) {
    return getComposeSubjectInput(composeBody) ? "new_compose" : "reply";
  }

  function addUniqueParticipant(list, value) {
    const cleaned = cleanParticipantText(value);
    const name = nameFromParticipant(cleaned);
    if (!cleaned && !name) return;

    const normalized = (name || cleaned).toLowerCase();
    if (list.some((item) => item.normalized === normalized)) return;

    list.push({
      display: name || cleaned,
      firstName: firstNameFrom(name || cleaned),
      normalized: normalized,
    });
  }

  function getParticipantTextFromElement(el) {
    const visibleText = cleanParticipantText(el.textContent);
    if (nameFromParticipant(visibleText)) return visibleText;

    const ariaLabel = el.getAttribute("aria-label");
    if (nameFromParticipant(ariaLabel)) return ariaLabel;

    return (
      el.getAttribute("email") ||
      el.getAttribute("data-hovercard-id") ||
      ariaLabel ||
      visibleText
    );
  }

  function getComposeRecipients(composeBody) {
    const root = getComposeRootFromBody(composeBody);
    const recipients = [];
    if (!root) return recipients;

    const toFields = root.querySelectorAll('textarea[name="to"], input[name="to"]');
    toFields.forEach((field) => {
      addUniqueParticipant(recipients, field.value || field.textContent);

      const toRegion =
        field.closest('[aria-label^="To"]') ||
        field.closest("tr") ||
        field.closest("table") ||
        field.parentElement;

      if (!toRegion) return;

      toRegion
        .querySelectorAll('[email], [data-hovercard-id*="@"], [aria-label*="@"]')
        .forEach((el) => {
          addUniqueParticipant(recipients, getParticipantTextFromElement(el));
        });
    });

    if (!recipients.length) {
      root
        .querySelectorAll('[email], [data-hovercard-id*="@"], [aria-label*="@"]')
        .forEach((el) => {
          addUniqueParticipant(recipients, getParticipantTextFromElement(el));
        });
    }

    return recipients.map(({ display, firstName }) => ({ display, firstName }));
  }

  function getGmailAccountName() {
    const accountEl = document.querySelector(
      '[aria-label^="Google Account"], [aria-label*="Google Account:"]'
    );
    const label = accountEl && accountEl.getAttribute("aria-label");
    if (!label) return "";

    return label
      .replace(/^Google Account:?/i, "")
      .replace(/\([^)]*@[^)]*\)/g, "")
      .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "")
      .trim();
  }

  function getComposeParticipants(composeBody) {
    const recipients = getComposeRecipients(composeBody);
    const senderName = getGmailAccountName();

    return {
      recipients: recipients,
      recipientNames: recipients
        .map((recipient) => recipient.firstName)
        .filter(Boolean),
      primaryRecipientName:
        (recipients[0] && recipients[0].display) || "",
      primaryRecipientFirstName:
        (recipients[0] && recipients[0].firstName) || "",
      senderName: nameFromParticipant(senderName),
    };
  }

  function insertIntoCompose(composeBody, text) {
    if (!composeBody) return;
    composeBody.focus();

    const fragment = document.createDocumentFragment();
    const lines = String(text).split("\n");
    lines.forEach((line, index) => {
      if (index > 0) fragment.appendChild(document.createElement("br"));
      // Text nodes only -> no markup is ever interpreted.
      fragment.appendChild(document.createTextNode(line));
    });

    composeBody.innerHTML = "";
    composeBody.appendChild(fragment);

    // Let Gmail know the field changed.
    composeBody.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* ------------------------------ OpenAI call ----------------------------- */

  const SYSTEM_PROMPT =
    "You draft email replies for the user inside Gmail. Write like a thoughtful human colleague—not like AI, a chatbot, or corporate marketing.\n\n" +
    "Always use this structure:\n" +
    "1. Greeting: \"Hello [Recipient First Name],\" — prefer the Primary recipient first name from compose metadata. If that is unavailable, use another recipient first name from metadata. If no recipient name is available, use \"Hello,\" only.\n" +
    "2. Opening: One brief, natural sentence that connects to the conversation (especially for replies).\n" +
    "3. Body: One or more short paragraphs that fully address the user's instruction. Be clear and complete—not terse, not padded. Say what needs to be said.\n" +
    "4. Closing: One short, natural sentence before the sign-off (e.g. \"Happy to discuss further if helpful.\")\n" +
    "5. Sign-off: \"Best regards,\" on its own line, then the sender's full name on the next line. Use the exact Sender name from compose metadata when available. Do not shorten it to only the first name. If no sender name is available, end with \"Best regards,\" and omit the name.\n\n" +
    "Output rules:\n" +
    "- If compose metadata says Subject generation is \"enabled\", start with one line formatted exactly as: Subject: <clear subject line>. Then add one blank line, then the email body.\n" +
    "- If compose metadata says Subject generation is \"disabled\", return only the email body. Do not include or change a subject line.\n" +
    "- When subject generation is enabled, write a short, specific subject line that fits the user's instruction. If an existing subject is provided, improve or preserve it rather than changing the meaning.\n" +
    "- If compose metadata says Draft mode is \"reply\", return only the email body. No subject line.\n" +
    "- No markdown, headings, or labels other than the required Subject line for new compose drafts.\n" +
    "- Separate paragraphs with a blank line.\n" +
    "- Do not use filler or AI-sounding phrases such as: \"I hope this email finds you well\", \"Certainly!\", \"I'd be happy to\", \"Please don't hesitate to reach out\", \"Thank you for reaching out\", \"Look forward to hearing from you\" (unless the thread already uses that tone).\n" +
    "- Use contractions and varied sentence length where natural.\n" +
    "- Match the thread's formality, but stay professional and warm.\n" +
    "- Never invent facts, dates, attachments, or commitments the user did not imply.";

  function parseGeneratedDraft(text, shouldIncludeSubject) {
    const output = String(text || "").trim();
    if (!shouldIncludeSubject) {
      return {
        subject: "",
        body: output.replace(/^Subject:\s*.+?(?:\r?\n){2,}/i, "").trim(),
      };
    }

    const match = output.match(/^Subject:\s*(.+?)\s*(?:\n{2,}|\r\n\r\n)([\s\S]*)$/i);
    if (!match) return { subject: "", body: output.replace(/^Subject:\s*/i, "") };

    return {
      subject: match[1].trim(),
      body: match[2].trim(),
    };
  }

  async function generateReply(userPrompt, threadContext, participants, composeMeta) {
    const settings = await getQuickMailSettings();
    const apiKey = settings.apiKey;
    if (!apiKey) {
      throw new Error(
        "No OpenAI API key found. Click the QuickMail icon in the toolbar to add one."
      );
    }

    const participantInfo = participants || {};

    const recipientLines =
      participantInfo.recipients && participantInfo.recipients.length
        ? participantInfo.recipients
            .map((recipient) => "- " + recipient.display)
            .join("\n")
        : "- Unknown";

    const senderLine =
      participantInfo.senderName ? participantInfo.senderName : "Unknown";

    const recipientFirstNames =
      participantInfo.recipientNames && participantInfo.recipientNames.length
        ? participantInfo.recipientNames.join(", ")
        : "Unknown";

    const primaryRecipientName =
      participantInfo.primaryRecipientName || "Unknown";
    const primaryRecipientFirstName =
      participantInfo.primaryRecipientFirstName || "Unknown";
    const draftMode =
      composeMeta && composeMeta.mode === "new_compose" ? "new_compose" : "reply";
    const existingSubject =
      composeMeta && composeMeta.subject ? composeMeta.subject : "None";
    const shouldGenerateSubject =
      draftMode === "new_compose" && !!(composeMeta && composeMeta.generateSubject);

    const userContent =
      "Use the compose metadata first for names. Use the thread for context and tone.\n\n" +
      "--- COMPOSE METADATA ---\n" +
      "Draft mode:\n" +
      draftMode +
      "\nSubject generation:\n" +
      (shouldGenerateSubject ? "enabled" : "disabled") +
      "\nExisting subject:\n" +
      existingSubject +
      "\n" +
      "Recipients:\n" +
      recipientLines +
      "\nPrimary recipient:\n" +
      primaryRecipientName +
      "\nPrimary recipient first name:\n" +
      primaryRecipientFirstName +
      "\nRecipient first names:\n" +
      recipientFirstNames +
      "\nSender name:\n" +
      senderLine +
      "\n--- END METADATA ---\n\n" +
      "--- EMAIL THREAD ---\n" +
      (threadContext || "(No prior thread. Draft from the instruction below.)") +
      "\n--- END THREAD ---\n\n" +
      "Write a reply that accomplishes this:\n" +
      userPrompt;

    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.65,
      }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        const errData = await response.json();
        detail = (errData && errData.error && errData.error.message) || "";
      } catch (e) {
        /* ignore parse errors */
      }
      throw new Error(
        "OpenAI request failed (" + response.status + ")" +
          (detail ? ": " + detail : "")
      );
    }

    const data = await response.json();
    const reply =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (!reply) throw new Error("OpenAI returned an empty response.");
    return parseGeneratedDraft(reply, shouldGenerateSubject);
  }

  /* ------------------------------- popover -------------------------------- */

  let activePopover = null;
  let activeAnchor = null;
  let popoverPositionFrame = null;

  function updateActivePopoverPosition() {
    popoverPositionFrame = null;

    if (!activePopover || !activeAnchor) return;
    if (!isAnchorInViewport(activeAnchor)) {
      closePopover();
      return;
    }

    repositionPopover(activePopover, activeAnchor);
  }

  function scheduleActivePopoverPosition() {
    if (popoverPositionFrame) return;
    popoverPositionFrame = window.requestAnimationFrame(updateActivePopoverPosition);
  }

  function startPopoverTracking() {
    document.addEventListener("scroll", scheduleActivePopoverPosition, true);
    window.addEventListener("resize", scheduleActivePopoverPosition);
  }

  function stopPopoverTracking() {
    document.removeEventListener("scroll", scheduleActivePopoverPosition, true);
    window.removeEventListener("resize", scheduleActivePopoverPosition);
    if (popoverPositionFrame) {
      window.cancelAnimationFrame(popoverPositionFrame);
      popoverPositionFrame = null;
    }
  }

  function closePopover() {
    if (activePopover && activePopover.parentElement) {
      activePopover.parentElement.removeChild(activePopover);
    }
    activePopover = null;
    if (activeAnchor) {
      activeAnchor.classList.remove("quickmail-trigger-active");
      activeAnchor = null;
    }
    document.removeEventListener("mousedown", onOutsideClick, true);
    stopPopoverTracking();
  }

  function onOutsideClick(event) {
    if (activePopover && !activePopover.contains(event.target)) {
      closePopover();
    }
  }

  function openPopover(anchorButton, composeBody) {
    closePopover();

    const popover = document.createElement("div");
    popover.className = "quickmail-popover";

    const header = document.createElement("div");
    header.className = "quickmail-popover-header";
    popover.appendChild(header);

    header.appendChild(createLogo("quickmail-logo-md"));

    const title = document.createElement("div");
    title.className = "quickmail-title";
    title.textContent = "QuickMail";
    header.appendChild(title);

    const promptLabel = document.createElement("label");
    promptLabel.className = "quickmail-popover-label";
    promptLabel.setAttribute("for", "quickmail-prompt");
    promptLabel.textContent = "What should this message say?";
    popover.appendChild(promptLabel);

    const input = document.createElement("textarea");
    input.id = "quickmail-prompt";
    input.className = "quickmail-input";
    input.rows = 1;
    input.placeholder =
      "Describe what you want to write.";
    popover.appendChild(input);

    const status = document.createElement("div");
    status.className = "quickmail-status";

    const spinner = document.createElement("span");
    spinner.className = "quickmail-spinner";
    spinner.style.display = "none";
    status.appendChild(spinner);

    const statusText = document.createElement("span");
    statusText.className = "quickmail-status-text";
    status.appendChild(statusText);

    popover.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "quickmail-actions";
    popover.appendChild(actions);

    const primaryActions = document.createElement("div");
    primaryActions.className = "quickmail-action-group";
    actions.appendChild(primaryActions);

    const generateBtn = document.createElement("button");
    generateBtn.className = "quickmail-btn quickmail-btn-primary";
    generateBtn.textContent = "Create Draft";
    primaryActions.appendChild(generateBtn);

    const regenerateBtn = document.createElement("button");
    regenerateBtn.className = "quickmail-btn quickmail-btn-secondary";
    regenerateBtn.textContent = "Regenerate";
    regenerateBtn.style.display = "none";
    primaryActions.appendChild(regenerateBtn);

    const subjectInput = getComposeSubjectInput(composeBody);
    let shouldGenerateSubject =
      !!subjectInput && getComposeSubject(composeBody).length === 0;
    let subjectToggleWasChanged = false;

    const subjectBtn = document.createElement("button");
    subjectBtn.type = "button";
    subjectBtn.className = "quickmail-subject-toggle";
    subjectBtn.appendChild(createSubjectIcon());
    subjectBtn.style.display = subjectInput ? "inline-flex" : "none";
    actions.appendChild(subjectBtn);

    function updateSubjectToggle() {
      subjectBtn.classList.toggle(
        "quickmail-subject-toggle-active",
        shouldGenerateSubject
      );
      subjectBtn.setAttribute("aria-pressed", shouldGenerateSubject ? "true" : "false");
      subjectBtn.setAttribute(
        "aria-label",
        shouldGenerateSubject
          ? "Subject Generation: ON"
          : "Subject Generation: OFF"
      );
      subjectBtn.title = shouldGenerateSubject
        ? "Subject Generation: ON"
        : "Subject Generation: OFF";
    }

    updateSubjectToggle();

    subjectBtn.addEventListener("click", () => {
      shouldGenerateSubject = !shouldGenerateSubject;
      subjectToggleWasChanged = true;
      updateSubjectToggle();
    });

    function setLoading(isLoading) {
      spinner.style.display = isLoading ? "inline-block" : "none";
      generateBtn.disabled = isLoading;
      regenerateBtn.disabled = isLoading;
      subjectBtn.disabled = isLoading;
      input.disabled = isLoading;
      updateStatusVisibility();
    }

    function setStatus(message, isError) {
      statusText.textContent = message || "";
      status.classList.toggle("quickmail-error", !!isError);
      updateStatusVisibility();
    }

    function updateStatusVisibility() {
      const isVisible =
        spinner.style.display !== "none" || statusText.textContent.length > 0;
      status.classList.toggle("quickmail-status-visible", isVisible);
    }

    async function runGeneration() {
      const prompt = input.value.trim();
      if (!prompt) {
        setStatus("Please describe what you want to say.", true);
        input.focus();
        return;
      }
      setStatus("Generating...", false);
      setLoading(true);
      try {
        const threadContext = getThreadContext();
        const participants = getComposeParticipants(composeBody);
        const currentSubject = getComposeSubject(composeBody);
        const composeMeta = {
          mode: getComposeMode(composeBody),
          subject: currentSubject,
          generateSubject:
            shouldGenerateSubject && (!currentSubject || subjectToggleWasChanged),
        };
        const draft = await generateReply(
          prompt,
          threadContext,
          participants,
          composeMeta
        );

        if (
          composeMeta.mode === "new_compose" &&
          composeMeta.generateSubject &&
          draft.subject
        ) {
          insertSubjectIntoCompose(composeBody, draft.subject);
        }
        insertIntoCompose(composeBody, draft.body);
        setStatus("Inserted into your email.", false);
        regenerateBtn.style.display = "inline-block";
      } catch (err) {
        setStatus(err && err.message ? err.message : "Something went wrong.", true);
      } finally {
        setLoading(false);
      }
    }

    generateBtn.addEventListener("click", runGeneration);
    regenerateBtn.addEventListener("click", runGeneration);
    input.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        runGeneration();
      }
    });
    input.addEventListener("input", () => {
      autoResizeTextarea(input);
      repositionPopover(popover, anchorButton);
    });

    document.body.appendChild(popover);
    activePopover = popover;
    activeAnchor = anchorButton;
    anchorButton.classList.add("quickmail-trigger-active");

    autoResizeTextarea(input);

    // Position above the anchor button, kept within the viewport.
    repositionPopover(popover, anchorButton);
    startPopoverTracking();

    input.focus();
    // Defer so the opening click doesn't immediately close the popover.
    setTimeout(() => {
      document.addEventListener("mousedown", onOutsideClick, true);
    }, 0);
  }

  /* --------------------------- button injection --------------------------- */

  function createAiButton(composeBody) {
    const button = document.createElement("div");
    button.className = "quickmail-trigger";
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.setAttribute("aria-label", "Write with AI");

    button.appendChild(createLogo("quickmail-logo-sm"));

    const label = document.createElement("span");
    label.className = "quickmail-trigger-label";
    label.textContent = "Write with AI";
    button.appendChild(label);

    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activePopover) {
        closePopover();
      } else {
        openPopover(button, composeBody);
      }
    });
    button.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        button.click();
      }
    });
    return button;
  }

  function mountButton(composeBody, sendBtn) {
    const scope =
      sendBtn.closest('[role="dialog"]') ||
      sendBtn.closest("div.btC") ||
      findComposeRoot(composeBody)?.root ||
      sendBtn.parentElement;

    if (scope && scope.querySelector(".quickmail-wrapper")) return;

      const wrapper = document.createElement("div");
      wrapper.className = "quickmail-wrapper quickmail-wrapper-enter";
      wrapper.setAttribute(PROCESSED_FLAG, "1");
      wrapper.appendChild(createAiButton(composeBody));

    // Gmail toolbars use table cells (td.gU) in inline reply and pop-out compose.
    const sendCell = sendBtn.closest("td.gU") || sendBtn.closest("td");
    if (sendCell && sendCell.parentElement) {
      const hostCell = document.createElement("td");
      hostCell.className = "gU";
      hostCell.appendChild(wrapper);
      sendCell.insertAdjacentElement("afterend", hostCell);
      return;
    }

    const sendWrap = sendBtn.closest("div.gU") || sendBtn.parentElement;
    if (sendWrap && sendWrap.parentElement) {
      sendWrap.insertAdjacentElement("afterend", wrapper);
      return;
    }

    sendBtn.insertAdjacentElement("afterend", wrapper);
  }

  function findComposeBodyForSend(sendBtn) {
    let node = sendBtn.parentElement;
    while (node && node !== document.body) {
      const body = node.querySelector(COMPOSE_BODY_SELECTORS);
      if (body && isVisible(body)) return body;
      node = node.parentElement;
    }
    return null;
  }

  function injectIntoToolbars() {
    // Primary: find visible compose bodies, then locate the Send row in the same panel.
    findComposeBodies().forEach((body) => {
      const ctx = findComposeRoot(body);
      if (ctx) mountButton(ctx.body, ctx.sendBtn);
    });

    // Fallback: walk each Send button and pair it with the nearest compose body.
    document.querySelectorAll('[role="button"], button, [data-tooltip]').forEach((el) => {
      if (!isSendButton(el) || !isVisible(el)) return;

      const root =
        el.closest('[role="dialog"]') ||
        el.closest("div.btC") ||
        el.parentElement?.parentElement?.parentElement;

      if (root && root.querySelector(".quickmail-wrapper")) return;

      const body = findComposeBodyForSend(el);
      if (!body) return;

      mountButton(body, el);
    });
  }

  /* ------------------------------ bootstrap ------------------------------- */

  let injectTimer = null;
  function scheduleInject() {
    if (injectTimer) clearTimeout(injectTimer);
    injectTimer = setTimeout(function () {
      injectTimer = null;
      injectIntoToolbars();
    }, 120);
  }

  const observer = new MutationObserver(scheduleInject);
  observer.observe(document.body, { childList: true, subtree: true });

  scheduleInject();
})();
